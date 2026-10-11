import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform, Writable } from 'node:stream';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import Busboy from 'busboy';
import QRCode from 'qrcode';
import { HttpError } from './errors.js';
import { mountTransfers } from './transfers.js';
import { Storage } from './storage.js';
import { mountMedia } from './media.js';

export type DeviceType = 'computer' | 'phone' | 'tablet';
export type Device = {
  id: string;
  name: string;
  type: DeviceType;
  online: boolean;
  lastSeen: number;
};
export type FileRef = { id: string; name: string; size: number; mime: string };
export type Message = {
  id: string;
  clientId?: string;
  from: string;
  to: string;
  text?: string;
  createdAt: number;
  kind: 'text' | 'file';
  file?: FileRef;
};
export type LanServerOptions = {
  port?: number;
  host?: string;
  dataDir: string;
  joinCode?: string;
  publicDir?: string;
  expiryMs?: number;
  maxFileBytes?: number;
  maxStorageBytes?: number;
  jsonBodyTimeoutMs?: number;
  diskStatfs?: () => Promise<{ bavail: bigint; bsize: bigint }>;
  publicUrl?: string;
  hostStatus?: () => { internet: string };
  onStop?: () => void;
};
type Session = { token: string; deviceId: string; expiresAt: number };
type StoredFile = {
  ref: FileRef;
  path: string;
  from: string;
  to: string;
  createdAt: number;
};
type Orphan = { path: string; size: number; createdAt: number };
const token = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const safeName = (name: string) =>
  name
    .replace(/[\\/\0\r\n]/g, '_')
    .replace(/[<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180) || '未命名文件';
const sessionOf = (request: Request) =>
  (request as Request & { session: Session }).session;

export function createLanServer(options: LanServerOptions) {
  const port = options.port ?? 3939;
  const host = options.host ?? '0.0.0.0';
  const expiryMs = options.expiryMs ?? Infinity;
  const sessionExpiryMs = options.expiryMs ?? 30 * 24 * 3600000;
  const maxFileBytes = options.maxFileBytes ?? Number.MAX_SAFE_INTEGER;
  const maxStorageBytes = options.maxStorageBytes ?? Number.MAX_SAFE_INTEGER;
  const jsonBodyTimeoutMs = options.jsonBodyTimeoutMs ?? 15000;
  const diskStatfs =
    options.diskStatfs ?? (() => fsp.statfs(uploadDir, { bigint: true }));
  const publicUrl = options.publicUrl
    ? new URL(options.publicUrl).origin
    : null;
  if (publicUrl && !publicUrl.startsWith('https://'))
    throw new Error('互联网入口必须使用 HTTPS。');
  let joinCode =
    options.joinCode ??
    process.env.JOIN_CODE ??
    String(crypto.randomInt(100000, 1000000));
  if (!/^\d{6}$/.test(joinCode)) throw new Error('连接码必须是 6 位数字。');
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('端口必须在 0 到 65535 之间。');
  const uploadDir = path.resolve(options.dataDir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  if (fs.lstatSync(uploadDir).isSymbolicLink())
    throw new Error('上传目录不能是符号链接。');
  const storage = new Storage(options.dataDir);
  const maxJoinFailures = 20;
  const devices = new Map<string, Device>();
  const sessions = new Map<string, Session>();
  const messages: Message[] = [];
  const files = new Map<string, StoredFile>();
  const orphans = new Map<string, Orphan>();
  const sockets = new Map<string, Set<WebSocket>>();
  const socketSessions = new WeakMap<WebSocket, Session>();
  const activeUploads = new Map<string, () => void>();
  const joinAttempts = new Map<string, { count: number; at: number }>();
  const messageAttempts = new Map<string, { count: number; at: number }>();
  let storedBytes = 0;
  for (const device of storage.loadDevices()) devices.set(device.id, device);
  for (const session of storage.loadSessions())
    sessions.set(session.hash, {
      token: '',
      deviceId: session.deviceId,
      expiresAt: session.expiresAt,
    });
  for (const file of storage.loadFiles()) {
    files.set(file.ref.id, file);
    storedBytes += file.ref.size;
  }
  messages.push(...storage.loadRecentMessages());
  let pendingBytes = 0;
  let closing = false;
  let cleanupJob: Promise<void> | null = null;
  const app = express();
  app.disable('x-powered-by');
  const server = http.createServer(app);
  server.requestTimeout = 300000;
  server.headersTimeout = 30000;
  server.maxConnections = 512;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192 });
  const boundPort = () =>
    (server.address() as import('node:net').AddressInfo | null)?.port ?? port;
  const ownHosts = () =>
    new Set([
      'localhost',
      '127.0.0.1',
      '::1',
      ...Object.values(os.networkInterfaces()).flatMap((interfaces) =>
        (interfaces ?? []).map((item) => item.address),
      ),
    ]);
  const validateOrigin = (request: http.IncomingMessage) => {
    try {
      const hostValue = request.headers.host;
      if (!hostValue || /[\s\\/#?@]/.test(hostValue)) return false;
      const hostname = new URL(`http://${hostValue}`).hostname.replace(
        /^\[|\]$/g,
        '',
      );
      if (
        !ownHosts().has(hostname) &&
        hostname !== (publicUrl ? new URL(publicUrl).hostname : null)
      )
        return false;
      if (request.headers.origin) {
        const origin = new URL(request.headers.origin);
        if (
          origin.host !== hostValue ||
          (hostname === (publicUrl ? new URL(publicUrl).hostname : null)
            ? origin.origin !== publicUrl
            : origin.protocol !== 'http:')
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  };
  const ownUrls = () => {
    const entries = Object.entries(os.networkInterfaces()).flatMap(
      ([name, interfaces]) =>
        (interfaces ?? [])
          .filter(
            (item) =>
              item.family === 'IPv4' &&
              !item.internal &&
              !/^169\.254\./.test(item.address),
          )
          .map((item) => ({ name, address: item.address })),
    );
    entries.sort(
      (a, b) =>
        Number(
          /virtual|vethernet|wsl|hyper-v|docker|tun|tap|vpn/i.test(a.name),
        ) -
        Number(
          /virtual|vethernet|wsl|hyper-v|docker|tun|tap|vpn/i.test(b.name),
        ),
    );
    const urls = [
      ...new Set(
        entries.map((item) => `http://${item.address}:${boundPort()}`),
      ),
    ];
    return urls.length ? urls : [`http://127.0.0.1:${boundPort()}`];
  };
  const hashToken = (value: string) =>
    crypto.createHash('sha256').update(value).digest('hex');
  const resolveSession = (value: string) => {
    const session = sessions.get(hashToken(value));
    if (session) session.token = value;
    return session;
  };
  const sessionValid = (session?: Session): boolean =>
    !!session &&
    sessions.get(hashToken(session.token)) === session &&
    session.expiresAt > Date.now();
  const secureCookie = (request: Request) =>
    publicUrl && request.headers.host === new URL(publicUrl).host
      ? '; Secure'
      : '';
  const cookieFor = (session: Session, request: Request) =>
    `linchuan_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.max(1, Math.floor((session.expiresAt - Date.now()) / 1000))}${secureCookie(request)}`;
  const publicDevices = () =>
    [...devices.values()].map((device) => ({ ...device }));
  const forgetEmptyDevice = (id: string) => {
    if (
      sockets.get(id)?.size ||
      [...sessions.values()].some((session) => session.deviceId === id)
    )
      return;
    if (storage.deleteDevice(id)) devices.delete(id);
  };
  const sendSocket = (socket: WebSocket, payload: string) => {
    if (
      socket.readyState !== WebSocket.OPEN ||
      !sessionValid(socketSessions.get(socket))
    )
      return;
    if (socket.bufferedAmount > 1024 ** 2) {
      socket.terminate();
      return;
    }
    socket.send(payload, (error) => {
      if (error) socket.terminate();
    });
  };
  const broadcastPresence = () => {
    const payload = JSON.stringify({
      type: 'presence',
      devices: publicDevices(),
    });
    for (const group of sockets.values())
      for (const socket of group) sendSocket(socket, payload);
  };
  const deliver = (message: Message) => {
    const recipients =
      message.to === 'all' ? [...sockets.keys()] : [message.from, message.to];
    const payload = JSON.stringify({ type: 'message', message });
    for (const id of new Set(recipients))
      for (const socket of sockets.get(id) ?? []) sendSocket(socket, payload);
  };
  const remember = (message: Message) => {
    storage.saveMessage(
      message,
      message.file ? files.get(message.file.id) : undefined,
    );
    messages.push(message);
    if (messages.length > 10000) messages.splice(0, messages.length - 10000);
    deliver(message);
  };
  const purgeMessages = () => {
    const cutoff = Date.now() - expiryMs;
    while (messages.length && messages[0].createdAt <= cutoff) messages.shift();
  };
  const removeFile = async (id: string, file: StoredFile) => {
    await fsp.rm(file.path, { force: true });
    await media.remove(id);
    storage.deleteFile(id);
    if (files.get(id) === file) {
      files.delete(id);
      storedBytes = Math.max(0, storedBytes - file.ref.size);
    }
  };
  const cleanup = (): Promise<void> => {
    if (cleanupJob) return cleanupJob;
    cleanupJob = (async () => {
      const now = Date.now();
      for (const [value, session] of sessions)
        if (session.expiresAt <= now) {
          sessions.delete(value);
          storage.deleteSession(value);
          activeUploads.get(session.deviceId)?.();
          for (const socket of sockets.get(session.deviceId) ?? [])
            socket.close(4001, '会话已过期');
        }
      for (const [id, file] of files)
        if (file.createdAt + expiryMs <= now) await removeFile(id, file);
      for (const [name, orphan] of orphans)
        if (orphan.createdAt + expiryMs <= now) {
          await fsp.rm(orphan.path, { force: true });
          orphans.delete(name);
          storedBytes = Math.max(0, storedBytes - orphan.size);
        }
      for (const map of [joinAttempts, messageAttempts])
        for (const [key, attempt] of map)
          if (attempt.at + 60000 < now) map.delete(key);
      purgeMessages();
    })().finally(() => {
      cleanupJob = null;
    });
    return cleanupJob;
  };
  const initializeStorage = async () => {
    for (const entry of await fsp.readdir(uploadDir, { withFileTypes: true })) {
      if (
        !entry.isFile() ||
        !/^(?:[A-Za-z0-9_-]{22,48}|[A-Za-z0-9_-]{22,48}\.part)$/.test(
          entry.name,
        )
      )
        continue;
      const filePath = path.join(uploadDir, entry.name);
      if (files.has(entry.name)) continue;
      const stat = await fsp.lstat(filePath);
      if (!stat.isFile()) continue;
      if (entry.name.endsWith('.part') || stat.mtimeMs + expiryMs <= Date.now())
        await fsp.rm(filePath, { force: true });
      else {
        orphans.set(entry.name, {
          path: filePath,
          size: stat.size,
          createdAt: stat.mtimeMs,
        });
        storedBytes += stat.size;
      }
    }
  };
  const diskReserveBytes = 256n * 1024n ** 2n;
  let diskReservedBytes = 0n;
  let diskLock: Promise<void> = Promise.resolve();
  const withDiskLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    const previous = diskLock;
    let release!: () => void;
    diskLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
  const reserveDisk = (size: number) =>
    withDiskLock(async () => {
      try {
        const disk = await diskStatfs();
        const free = disk.bavail * disk.bsize;
        if (diskReservedBytes + BigInt(size) + diskReserveBytes > free)
          throw new HttpError(
            413,
            '服务电脑的磁盘空间不足，请先释放磁盘空间。',
          );
        diskReservedBytes += BigInt(size);
      } catch (cause) {
        if (cause instanceof HttpError) throw cause;
        throw new HttpError(
          413,
          '无法确认服务电脑的可用磁盘空间，请稍后重试。',
        );
      }
    });
  const releaseDisk = (size: number) =>
    withDiskLock(async () => {
      diskReservedBytes =
        diskReservedBytes > BigInt(size)
          ? diskReservedBytes - BigInt(size)
          : 0n;
    });
  const reserveLogical = (size: number) => {
    if (storedBytes + pendingBytes + size > maxStorageBytes)
      throw new HttpError(413, '暂存空间不足。');
    pendingBytes += size;
  };
  app.use((request, response, next) => {
    if (!validateOrigin(request))
      return response.status(403).json({ error: '请求来源不属于当前服务。' });
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader(
      'Content-Security-Policy',
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://${request.headers.host} wss://${request.headers.host}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (request.path.startsWith('/api'))
      response.setHeader('Cache-Control', 'no-store');
    next();
  });
  app.use((request, response, next) => {
    if (!request.is('application/json')) return next();
    const timer = setTimeout(() => {
      if (response.writableEnded || request.readableEnded) return;
      response.status(408).json({ error: '请求数据读取超时，请重试。' });
      request.destroy();
    }, jsonBodyTimeoutMs);
    response.once('finish', () => clearTimeout(timer));
    response.once('close', () => clearTimeout(timer));
    next();
  });
  app.use(express.json({ limit: '128kb' }));
  const auth = (request: Request, response: Response, next: NextFunction) => {
    const bearer = request.get('authorization');
    const cookie = request
      .get('cookie')
      ?.match(/(?:^|;\s*)linchuan_session=([^;]+)/)?.[1];
    const value = bearer?.startsWith('Bearer ')
      ? bearer.slice(7)
      : (cookie ?? '');
    const session = resolveSession(value);
    if (!session || !sessionValid(session))
      return response
        .status(401)
        .json({ error: '连接已过期，请重新输入连接码。' });
    (request as Request & { session: Session }).session = session;
    if (
      options.expiryMs === undefined &&
      session.expiresAt - Date.now() < 15 * 24 * 3600000
    ) {
      session.expiresAt = Date.now() + sessionExpiryMs;
      storage.saveSession(
        hashToken(value),
        session.deviceId,
        session.expiresAt,
      );
    }
    next();
  };
  const checkTarget = (value: unknown) => {
    if (typeof value !== 'string' || (value !== 'all' && !devices.has(value)))
      throw new HttpError(400, '目标设备不存在。');
    return value;
  };
  const checkClientId = (value: unknown) => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value || value.length > 128)
      throw new HttpError(400, '消息标识无效。');
    return value;
  };
  const checkRate = (
    map: Map<string, { count: number; at: number }>,
    key: string,
    limit: number,
  ) => {
    const now = Date.now();
    let attempt = map.get(key);
    if (!attempt || now - attempt.at >= 60000) {
      attempt = { count: 0, at: now };
      map.set(key, attempt);
    }
    if (++attempt.count > limit)
      throw new HttpError(429, '操作太频繁，请一分钟后再试。');
  };
  app.get('/api/info', (_request, response) =>
    response.json({
      serverName: '邻传',
      urls: [...ownUrls(), ...(publicUrl ? [publicUrl] : [])],
      expiresHours: Number.isFinite(expiryMs) ? expiryMs / 3600000 : null,
      persistent: true,
      maxFileBytes: options.maxFileBytes ?? null,
      maxStorageBytes: options.maxStorageBytes ?? null,
      publicUrl,
    }),
  );
  const hostOnly = (
    request: Request,
    _response: Response,
    next: NextFunction,
  ) => {
    const address = request.socket.remoteAddress;
    const hostname = new URL(`http://${request.headers.host}`).hostname;
    if (
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') ||
      !['localhost', '127.0.0.1', '[::1]'].includes(hostname) ||
      request.get('x-linchuan-host') !== '1' ||
      request.get('x-forwarded-for') ||
      request.get('cf-connecting-ip')
    )
      throw new HttpError(403, '此功能只能在服务电脑本机使用。');
    next();
  };
  app.get('/api/host', hostOnly, (_request, response) =>
    response.json({
      code: joinCode,
      joinLocked: storage.joinFailures() >= maxJoinFailures,
      ...options.hostStatus?.(),
    }),
  );
  app.post('/api/host/code', hostOnly, (_request, response) => {
    joinCode = String(crypto.randomInt(100000, 1000000));
    storage.resetJoinFailures();
    response.json({ code: joinCode, joinLocked: false });
  });
  app.post('/api/host/stop', hostOnly, (_request, response) => {
    if (!options.onStop)
      throw new HttpError(409, '当前启动方式不支持页面停止。');
    response.status(202).json({ stopping: true });
    setTimeout(() => options.onStop?.(), 100);
  });
  app.get('/api/qr', async (request, response) => {
    const value = String(request.query.url ?? '');
    if (
      ![
        ...ownUrls(),
        ...(publicUrl ? [publicUrl] : []),
        `http://127.0.0.1:${boundPort()}`,
        `http://localhost:${boundPort()}`,
      ].includes(value)
    )
      throw new HttpError(400, '只允许生成当前服务的二维码。');
    response
      .type('svg')
      .send(await QRCode.toString(value, { type: 'svg', margin: 1 }));
  });
  app.post('/api/join', (request, response) => {
    checkRate(joinAttempts, request.ip || 'unknown', 20);
    checkRate(joinAttempts, 'global-join-attempts', 30);
    if (storage.joinFailures() >= maxJoinFailures)
      throw new HttpError(429, '加入已暂停，请在服务电脑刷新连接码。');
    const { name, type, deviceId, code } = request.body ?? {};
    if (
      typeof code !== 'string' ||
      !/^\d{6}$/.test(code) ||
      !crypto.timingSafeEqual(Buffer.from(code), Buffer.from(joinCode))
    ) {
      storage.incrementJoinFailures();
      throw new HttpError(401, '连接码不正确，请查看服务电脑的邻传页面。');
    }
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 30 ||
      !['computer', 'phone', 'tablet'].includes(type) ||
      typeof deviceId !== 'string' ||
      !deviceId ||
      deviceId.length > 128
    )
      throw new HttpError(400, '请填写有效的设备名称和类型。');
    if (
      [...sessions.values()].filter((item) => item.expiresAt > Date.now())
        .length >= 128
    )
      throw new HttpError(429, '已连接设备过多，请退出暂时不用的设备。');
    const id = token(18);
    const device: Device = {
      id,
      name: name.trim(),
      type,
      online: false,
      lastSeen: Date.now(),
    };
    const session: Session = {
      token: token(),
      deviceId: id,
      expiresAt: Date.now() + sessionExpiryMs,
    };
    devices.set(id, device);
    sessions.set(hashToken(session.token), session);
    storage.saveDevice(device);
    storage.saveSession(hashToken(session.token), id, session.expiresAt);
    response.setHeader('Set-Cookie', cookieFor(session, request));
    broadcastPresence();
    response.json({
      token: session.token,
      device,
      devices: publicDevices(),
      messages: [],
    });
  });
  app.get('/api/session', auth, (request, response) => {
    const session = sessionOf(request);
    response.setHeader('Set-Cookie', cookieFor(session, request));
    response.json({
      device: devices.get(session.deviceId),
      devices: publicDevices(),
      expiresAt: session.expiresAt,
      maxFileBytes,
      maxStorageBytes,
    });
  });
  app.post('/api/logout', auth, (request, response) => {
    const session = sessionOf(request);
    sessions.delete(hashToken(session.token));
    storage.deleteSession(hashToken(session.token));
    forgetEmptyDevice(session.deviceId);
    activeUploads.get(session.deviceId)?.();
    for (const socket of sockets.get(session.deviceId) ?? [])
      socket.close(4001, '已退出当前设备');
    response.setHeader(
      'Set-Cookie',
      `linchuan_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secureCookie(request)}`,
    );
    response.status(204).end();
  });
  app.put('/api/device', auth, (request, response) => {
    const { name, type } = request.body ?? {};
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      name.trim().length > 30 ||
      !['computer', 'phone', 'tablet'].includes(type)
    )
      throw new HttpError(400, '设备名称或类型无效。');
    const device = devices.get(sessionOf(request).deviceId)!;
    device.name = name.trim();
    device.type = type;
    device.lastSeen = Date.now();
    storage.saveDevice(device);
    broadcastPresence();
    response.json({ device });
  });
  app.post('/api/messages', auth, (request, response) => {
    const session = sessionOf(request);
    const { text, to: value, clientId: clientValue } = request.body ?? {};
    const to = checkTarget(value);
    const clientId = checkClientId(clientValue);
    if (typeof text !== 'string' || !text.trim() || text.length > 20000)
      throw new HttpError(400, '消息不能为空，且不能超过 20000 个字符。');
    purgeMessages();
    const old = clientId
      ? storage.findByClientId(session.deviceId, clientId)
      : undefined;
    if (old) {
      if (old.kind !== 'text' || old.to !== to || old.text !== text)
        throw new HttpError(409, '消息标识已经用于其他内容。');
      if (storage.isHidden(old.id, session.deviceId))
        throw new HttpError(410, '这条消息已从当前设备隐藏。');
      return response.json(old);
    }
    checkRate(messageAttempts, session.deviceId, 120);
    const message: Message = {
      id: token(16),
      clientId,
      from: session.deviceId,
      to,
      text,
      createdAt: Date.now(),
      kind: 'text',
    };
    remember(message);
    response.status(201).json(message);
  });
  app.get('/api/messages', auth, (request, response) => {
    const session = sessionOf(request);
    const to = checkTarget(request.query.to ?? 'all');
    purgeMessages();
    const before =
      request.query.before === undefined
        ? undefined
        : Number(request.query.before);
    if (before !== undefined && (!Number.isFinite(before) || before < 0))
      throw new HttpError(400, '历史记录位置无效。');
    const beforeId = request.query.beforeId;
    if (
      beforeId !== undefined &&
      (typeof beforeId !== 'string' ||
        beforeId.length > 128 ||
        before === undefined)
    )
      throw new HttpError(400, '历史记录位置无效。');
    const history = storage.history(
      session.deviceId,
      to,
      before,
      200,
      beforeId,
    );
    response.json(
      Number.isFinite(expiryMs)
        ? {
            ...history,
            messages: history.messages.filter(
              (message) => message.createdAt + expiryMs > Date.now(),
            ),
          }
        : history,
    );
  });
  app.delete('/api/messages/:id', auth, async (request, response) => {
    const requester = sessionOf(request).deviceId;
    const message = storage.findById(String(request.params.id));
    if (
      !message ||
      (message.to !== 'all' &&
        message.from !== requester &&
        message.to !== requester)
    )
      throw new HttpError(404, '消息不存在，或不属于当前设备。');
    storage.deleteMessage(message.id, requester);
    const payload = JSON.stringify({ type: 'message-deleted', id: message.id });
    for (const socket of sockets.get(requester) ?? [])
      sendSocket(socket, payload);
    response.status(204).end();
  });
  app.post('/api/files', auth, async (request, response) => {
    const session = sessionOf(request);
    const to = checkTarget(request.query.to ?? 'all');
    const clientId = checkClientId(request.query.clientId);
    purgeMessages();
    const old = clientId
      ? storage.findByClientId(session.deviceId, clientId)
      : undefined;
    if (old) {
      if (old.kind !== 'file' || old.to !== to)
        throw new HttpError(409, '消息标识已经用于其他内容。');
      if (storage.isHidden(old.id, session.deviceId))
        throw new HttpError(410, '这条文件消息已从当前设备隐藏。');
      return response.json(old);
    }
    await cleanup();
    if (activeUploads.has(session.deviceId))
      throw new HttpError(429, '当前设备已有文件正在上传。');
    if (storedBytes + pendingBytes >= maxStorageBytes)
      throw new HttpError(413, '保存空间已满，请删除不再需要的文件。');
    await reserveDisk(0);
    let parser: ReturnType<typeof Busboy>;
    try {
      parser = Busboy({
        headers: request.headers,
        defParamCharset: 'utf8',
        limits: {
          files: 1,
          fields: 0,
          parts: 2,
          fileSize: Math.min(maxFileBytes + 1, Number.MAX_SAFE_INTEGER),
        },
      });
    } catch {
      throw new HttpError(400, '请选择一个有效文件。');
    }
    let temporary = '';
    let uploadedName = '';
    let uploadedMime = 'application/octet-stream';
    let size = 0;
    let acceptedBytes = 0;
    let failed: Error | null = null;
    let fileSeen = false;
    let writeJob: Promise<void> = Promise.resolve();
    let finishParser: () => void = () => {};
    let activeStream: Transform | null = null;
    let inFlightDiskReservation = 0;
    const parseJob = new Promise<void>((resolve) => {
      finishParser = resolve;
    });
    const stopUpload = (
      cause = new HttpError(400, '上传已取消或网络已中断。'),
    ) => {
      if (!failed) failed = cause;
      request.unpipe(parser);
      activeStream?.destroy(cause);
      parser.destroy();
      finishParser();
    };
    const onAbort = () => stopUpload();
    const onClose = () => {
      if (!response.writableEnded) stopUpload();
    };
    const onTimeout = () =>
      stopUpload(new HttpError(408, '上传长时间没有响应，请重试。'));
    activeUploads.set(session.deviceId, () => stopUpload());
    request.once('aborted', onAbort);
    response.once('close', onClose);
    request.setTimeout(120000, onTimeout);
    parser.on('file', (_field, stream, info) => {
      if (fileSeen) {
        failed = new HttpError(400, '一次只能上传一个文件。');
        stream.resume();
        return;
      }
      fileSeen = true;
      uploadedName = safeName(info.filename ?? '未命名文件');
      uploadedMime = info.mimeType;
      temporary = path.join(uploadDir, `${token(24)}.part`);
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          void (async () => {
            const nextSize = size + chunk.length;
            if (nextSize > maxFileBytes)
              throw new HttpError(413, '文件超过大小限制。');
            if (storedBytes + pendingBytes + chunk.length > maxStorageBytes)
              throw new HttpError(413, '暂存空间不足，文件未保存。');
            await reserveDisk(chunk.length);
            try {
              reserveLogical(chunk.length);
            } catch (cause) {
              await releaseDisk(chunk.length);
              throw cause;
            }
            inFlightDiskReservation += chunk.length;
            size = nextSize;
            acceptedBytes += chunk.length;
          })().then(
            () => callback(null, chunk),
            (cause: Error) => callback(cause),
          );
        },
      });
      activeStream = counter;
      let fileHandle: Awaited<ReturnType<typeof fsp.open>> | null = null;
      const output = new Writable({
        write(chunk: Buffer, _encoding, callback) {
          void fileHandle!
            .writeFile(chunk)
            .then(async () => {
              await releaseDisk(chunk.length);
              inFlightDiskReservation = Math.max(
                0,
                inFlightDiskReservation - chunk.length,
              );
              callback();
            })
            .catch(async (cause: Error) => {
              await releaseDisk(chunk.length).catch(() => {});
              inFlightDiskReservation = Math.max(
                0,
                inFlightDiskReservation - chunk.length,
              );
              callback(cause);
            });
        },
      });
      stream.once('limit', () => {
        failed = new HttpError(413, '文件超过大小限制。');
        activeStream?.destroy();
        stream.resume();
      });
      writeJob = (async () => {
        fileHandle = await fsp.open(temporary, 'wx');
        try {
          await pipeline(stream, counter, output);
        } finally {
          const opened = fileHandle;
          if (opened) await opened.close();
          fileHandle = null;
        }
      })().catch((cause: Error) => {
        stopUpload(
          cause instanceof HttpError
            ? cause
            : new HttpError(500, '文件保存失败，请检查服务电脑的磁盘空间。'),
        );
      });
    });
    parser.once('filesLimit', () => {
      failed = new HttpError(400, '一次只能上传一个文件。');
    });
    parser.once('fieldsLimit', () => {
      failed = new HttpError(400, '上传格式无效，请重新选择文件。');
    });
    parser.once('partsLimit', () => {
      failed = new HttpError(400, '上传格式无效。');
    });
    parser.once('error', () => {
      if (!failed) failed = new HttpError(400, '上传数据不完整，请重试。');
      finishParser();
    });
    parser.once('close', finishParser);
    try {
      request.pipe(parser);
      await parseJob;
      await writeJob;
      if (failed) throw failed;
      if (!fileSeen || !temporary) throw new HttpError(400, '没有收到文件。');
      if (!sessionValid(session))
        throw new HttpError(401, '连接已过期，文件未保存。');
      const id = token(16);
      const finalPath = path.join(uploadDir, id);
      await fsp.rename(temporary, finalPath);
      temporary = '';
      const ref: FileRef = { id, name: uploadedName, size, mime: uploadedMime };
      const file: StoredFile = {
        ref,
        path: finalPath,
        from: session.deviceId,
        to,
        createdAt: Date.now(),
      };
      files.set(id, file);
      storedBytes += size;
      const message: Message = {
        id: token(16),
        clientId,
        from: session.deviceId,
        to,
        createdAt: Date.now(),
        kind: 'file',
        file: ref,
      };
      remember(message);
      response.status(201).json(message);
    } finally {
      request.off('aborted', onAbort);
      response.off('close', onClose);
      request.off('timeout', onTimeout);
      request.setTimeout(0);
      activeUploads.delete(session.deviceId);
      pendingBytes = Math.max(0, pendingBytes - acceptedBytes);
      if (inFlightDiskReservation) await releaseDisk(inFlightDiskReservation);
      inFlightDiskReservation = 0;
      if (temporary) await fsp.rm(temporary, { force: true });
      if (!request.complete) request.resume();
    }
  });
  app.get('/api/files/:id', auth, async (request, response) => {
    const id = String(request.params.id);
    const file = files.get(id);
    const deviceId = sessionOf(request).deviceId;
    if (
      !file ||
      (file.to !== 'all' && file.from !== deviceId && file.to !== deviceId)
    )
      throw new HttpError(404, '文件不存在、已过期或没有访问权限。');
    if (file.createdAt + expiryMs <= Date.now()) {
      await removeFile(id, file);
      throw new HttpError(404, '文件已过期。');
    }
    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Content-Length', file.ref.size);
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(file.ref.name).replace(/'/g, '%27')}`,
    );
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; sandbox",
    );
    try {
      await pipeline(fs.createReadStream(file.path), response);
    } catch {
      if (!response.headersSent && !response.destroyed)
        response.status(404).end();
    }
  });
  const transfers = mountTransfers(app, {
    auth,
    sessionOf,
    sessionValid,
    checkTarget,
    checkClientId,
    uploadDir,
    maxFileBytes,
    activeUploads,
    findMessage: (owner, clientId) =>
      storage.findByClientId(owner, clientId) ||
      messages.find(
        (message) => message.from === owner && message.clientId === clientId,
      ),
    isMessageHidden: (messageId, owner) => storage.isHidden(messageId, owner),
    reserve: (size) => {
      reserveLogical(size);
    },
    release: (size) => {
      pendingBytes = Math.max(0, pendingBytes - size);
    },
    reserveDisk,
    releaseDisk,
    ensureCapacity: async (size) => {
      await cleanup();
      if (storedBytes + pendingBytes + size > maxStorageBytes)
        throw new HttpError(413, '暂存空间不足。');
    },
    commit: (ref, filePath, from, to, clientId) => {
      files.set(ref.id, {
        ref,
        path: filePath,
        from,
        to,
        createdAt: Date.now(),
      });
      storedBytes += ref.size;
      const message: Message = {
        id: token(16),
        clientId,
        from,
        to,
        createdAt: Date.now(),
        kind: 'file',
        file: ref,
      };
      remember(message);
      return message;
    },
  });
  const media = mountMedia(app, {
    auth,
    dataDir: options.dataDir,
    getFile: (request) => {
      const file = files.get(String(request.params.id));
      const id = sessionOf(request).deviceId;
      if (
        !file ||
        file.createdAt + expiryMs <= Date.now() ||
        (file.to !== 'all' && file.from !== id && file.to !== id)
      )
        return undefined;
      return file;
    },
  });
  if (options.publicDir && fs.existsSync(options.publicDir))
    app.use(
      express.static(options.publicDir, {
        index: 'index.html',
        dotfiles: 'deny',
      }),
    );
  app.use('/api', (_request, response) =>
    response.status(404).json({ error: '接口不存在。' }),
  );
  app.use(
    (
      cause: Error & { status?: number },
      _request: Request,
      response: Response,
      _next: NextFunction,
    ) => {
      if (response.headersSent || response.destroyed) return;
      const status =
        cause instanceof HttpError
          ? cause.status
          : cause.status && cause.status >= 400 && cause.status < 500
            ? cause.status
            : 500;
      response.status(status).json({
        error:
          cause instanceof HttpError
            ? cause.message
            : status < 500
              ? '请求格式不正确。'
              : '服务暂时无法完成请求，请重试。',
      });
    },
  );
  server.on('upgrade', (request, socket, head) => {
    try {
      if (!validateOrigin(request) || closing) throw new Error();
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);
      const queryToken = url.searchParams.get('token') ?? '';
      const cookieToken = request.headers.cookie?.match(
        /(?:^|;\s*)linchuan_session=([^;]+)/,
      )?.[1];
      // Same-origin browsers send the HttpOnly session cookie automatically.
      // Keep the query-token form for existing non-browser clients, but allow
      // cookie-only handshakes so credentials do not appear in WS URLs/logs.
      const session = resolveSession(queryToken || cookieToken || '');
      if (url.pathname !== '/ws' || !session || !sessionValid(session))
        throw new Error();
      wss.handleUpgrade(request, socket, head, (connection) =>
        wss.emit('connection', connection, session),
      );
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
  });
  wss.on('connection', (socket: WebSocket, session: Session) => {
    socketSessions.set(socket, session);
    let group = sockets.get(session.deviceId);
    if (!group) {
      group = new Set();
      sockets.set(session.deviceId, group);
    }
    group.add(socket);
    const device = devices.get(session.deviceId)!;
    device.online = true;
    device.lastSeen = Date.now();
    storage.saveDevice(device);
    let alive = true;
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => {
      alive = true;
    });
    sendSocket(
      socket,
      JSON.stringify({ type: 'ready', deviceId: session.deviceId }),
    );
    broadcastPresence();
    const heartbeat = setInterval(() => {
      if (!sessionValid(session)) {
        socket.close(4001, '连接已过期');
        return;
      }
      if (!alive) {
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, 30000);
    socket.once('close', () => {
      clearInterval(heartbeat);
      group.delete(socket);
      if (!group.size) {
        sockets.delete(session.deviceId);
        device.online = false;
        device.lastSeen = Date.now();
        storage.saveDevice(device);
        forgetEmptyDevice(session.deviceId);
      }
      broadcastPresence();
    });
  });
  const interval = setInterval(
    () => {
      void cleanup().catch(() => {
        console.error('过期文件清理失败，请检查磁盘权限。');
      });
    },
    Math.min(expiryMs, 60000),
  );
  interval.unref();
  const start = async () => {
    await initializeStorage();
    await new Promise<void>((resolve, reject) => {
      const error = (cause: Error) => {
        server.off('listening', ready);
        reject(cause);
      };
      const ready = () => {
        server.off('error', error);
        resolve();
      };
      server.once('error', error);
      server.once('listening', ready);
      server.listen(port, host);
    });
  };
  let closeJob: Promise<void> | undefined;
  const close = () =>
    (closeJob ??= (async () => {
      closing = true;
      clearInterval(interval);
      for (const cancel of activeUploads.values()) cancel();
      for (const socket of wss.clients) socket.terminate();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await transfers.close();
      await media.close();
      if (cleanupJob) await cleanupJob;
      storage.close();
    })());
  return {
    app,
    server,
    wss,
    start,
    close,
    getJoinCode: () => joinCode,
    getPort: () => boundPort(),
    getUrls: ownUrls,
    devices,
    messages,
    files,
  };
}
