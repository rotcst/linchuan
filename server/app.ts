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
import { createSecureLan, securePortFor } from './secure-lan.js';

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
  handoffTtlMs?: number;
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
const normalizePrivateLanUrl = (value: string, port: number) => {
  try {
    const url = new URL(value);
    const octets = url.hostname.split('.').map(Number);
    const privateIp =
      url.protocol === 'http:' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.port === String(port) &&
      octets.length === 4 &&
      octets.every(
        (part) => Number.isInteger(part) && part >= 0 && part <= 255,
      ) &&
      (octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
    return privateIp ? url.origin + '/' : null;
  } catch {
    return null;
  }
};
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
  const handoffTtlMs = options.handoffTtlMs ?? 10 * 60 * 1000;
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
  const networkIdentity = storage.loadOrCreateNetworkIdentity();
  const removeHandoffStaging = (handoffId: string) => {
    if (!/^[A-Za-z0-9_-]+$/.test(handoffId))
      throw new Error('移交临时目录标识无效。');
    const dataRoot = path.resolve(options.dataDir);
    const root = path.join(dataRoot, `.handoff-${handoffId}`);
    const rootParent = path.dirname(root);
    const parentStat = fs.lstatSync(rootParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink())
      throw new Error('移交临时目录父目录无效。');
    if (!fs.existsSync(root)) return;
    const pending = [root];
    while (pending.length) {
      const current = pending.pop()!;
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()))
        throw new Error('移交临时目录包含不安全文件。');
      if (stat.isDirectory())
        for (const child of fs.readdirSync(current))
          pending.push(path.join(current, child));
    }
    fs.rmSync(root, { recursive: true, force: true });
  };
  const retiredAtStartup = storage.getMetadata('host.retired') === '1';
  const activatedAtStartup = storage.getMetadata('handoff.activated') === '1';
  if (!retiredAtStartup || activatedAtStartup) {
    storage.deleteHandoffBrowserTicketsAfter(networkIdentity.hostGeneration);
    for (const name of fs.readdirSync(options.dataDir)) {
      if (!/^\.handoff-[A-Za-z0-9_-]+$/.test(name)) continue;
      try {
        removeHandoffStaging(name.slice('.handoff-'.length));
      } catch {
        // Never delete a staging tree that contains a reparse or special node.
      }
    }
  }
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
  const networkProbeAttempts = new Map<string, { count: number; at: number }>();
  const capabilities = new Map<
    string,
    {
      publicKey: string;
      version: string;
      receivePort: number;
      lanUrls: string[];
      updatedAt: number;
    }
  >();
  const socketTickets = new Map<
    string,
    { session: Session; expiresAt: number }
  >();
  const browserTickets = new Map<
    string,
    { session: Session; expiresAt: number }
  >();
  let secureLan: ReturnType<typeof createSecureLan> | null = null;
  type Handoff = {
    id: string;
    targetDeviceId: string;
    generation: number;
    targetPublicKey: string;
    receivePort: number;
    startedAt: number;
    expiresAt: number;
    frozen: boolean;
    committed: boolean;
    activated: boolean;
    ready: boolean;
    snapshotPath?: string;
    chunksPath?: string;
    files?: Array<{
      index: number;
      path: string;
      size: number;
      sha256: string;
      source: string;
    }>;
    chunkBytes: number;
    nextChunk: number;
    chunkQuota: number;
    activeChunkRequests: number;
    redirectUrls?: string[];
    browserTickets?: Array<{
      sessionHash: string;
      deviceId: string;
      value: string;
    }>;
    offer?: {
      envelope: string;
      envelopeJson: string;
      totalChunks: number;
      totalBytes: number;
      sha256: string;
      signature: string;
    };
  };
  let handoff: Handoff | null = null;
  let handoffTimer: ReturnType<typeof setTimeout> | undefined;
  const retired = () => storage.getMetadata('host.retired') === '1';
  const scheduleHandoffExpiry = (candidate: Handoff) => {
    clearTimeout(handoffTimer);
    const delay = Math.max(50, candidate.expiresAt - Date.now() + 50);
    handoffTimer = setTimeout(() => {
      if (handoff !== candidate || candidate.committed) return;
      if (candidate.activeChunkRequests > 0) {
        candidate.expiresAt = Date.now() + handoffTtlMs;
        scheduleHandoffExpiry(candidate);
        return;
      }
      if (candidate.expiresAt > Date.now()) {
        scheduleHandoffExpiry(candidate);
        return;
      }
      try {
        if (candidate.snapshotPath) removeHandoffStaging(candidate.id);
      } catch {
        // Never recursively delete a staging tree that failed safety checks.
      }
      storage.deleteHandoffBrowserTickets(candidate.generation);
      handoff = null;
    }, delay);
    handoffTimer.unref?.();
  };
  const renewHandoff = (candidate = handoff) => {
    if (
      candidate &&
      handoff === candidate &&
      !candidate.committed &&
      candidate.expiresAt > Date.now()
    ) {
      candidate.expiresAt = Date.now() + handoffTtlMs;
      scheduleHandoffExpiry(candidate);
    }
  };
  const committedMetadata = () => {
    const id = storage.getMetadata('handoff.id');
    if (!id) return null;
    let urls: string[] = [];
    try {
      urls = JSON.parse(storage.getMetadata('handoff.urls') ?? '[]');
    } catch {
      /* invalid metadata is empty */
    }
    return {
      id,
      generation: Number(storage.getMetadata('handoff.generation') ?? 0),
      targetDeviceId: storage.getMetadata('handoff.targetDeviceId') ?? '',
      activated: storage.getMetadata('handoff.activated') === '1',
      urls,
    };
  };
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
          origin.host !== hostValue &&
          !isConfiguredPublicCrossOrigin(request)
        )
          return false;
        if (
          origin.host === hostValue &&
          (hostname === (publicUrl ? new URL(publicUrl).hostname : null)
            ? origin.origin !== publicUrl
            : origin.protocol !== 'http:' &&
              !secureLan
                ?.urls()
                .some((url) => new URL(url).origin === origin.origin))
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
  const lanUrls = () =>
    ownUrls().filter((url) => {
      try {
        return !['localhost', '127.0.0.1', '::1'].includes(
          new URL(url).hostname,
        );
      } catch {
        return false;
      }
    });
  const crossOriginPaths = (pathname: string) =>
    pathname === '/ws' ||
    pathname === '/api/info' ||
    pathname === '/api/session' ||
    pathname === '/api/device' ||
    pathname === '/api/logout' ||
    pathname.startsWith('/api/network') ||
    pathname.startsWith('/api/messages') ||
    pathname.startsWith('/api/transfers') ||
    pathname.startsWith('/api/media');
  const isConfiguredPublicCrossOrigin = (request: http.IncomingMessage) => {
    if (
      !publicUrl ||
      !request.headers.origin ||
      !crossOriginPaths(request.url?.split('?')[0] ?? '')
    )
      return false;
    try {
      const origin = new URL(request.headers.origin);
      const hostValue = request.headers.host;
      return (
        origin.origin === publicUrl &&
        !!hostValue &&
        ownHosts().has(
          new URL(`http://${hostValue}`).hostname.replace(/^\[|\]$/g, ''),
        )
      );
    } catch {
      return false;
    }
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
    [...devices.values()].map((device) => ({
      ...device,
      ...(capabilities.get(device.id)
        ? { canHostVersion: capabilities.get(device.id)!.version }
        : {}),
    }));
  const forgetEmptyDevice = (id: string) => {
    if (
      sockets.get(id)?.size ||
      secureLan?.hasDevice(id) ||
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
    secureLan?.emit(null, payload);
  };
  const deliver = (message: Message) => {
    const recipients =
      message.to === 'all' ? [...devices.keys()] : [message.from, message.to];
    const payload = JSON.stringify({ type: 'message', message });
    for (const id of new Set(recipients)) {
      for (const socket of sockets.get(id) ?? []) sendSocket(socket, payload);
      secureLan?.emit(id, payload);
    }
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
      `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ${[...ownUrls().map((value) => value.replace(/^http:/, 'ws:')), ...(publicUrl ? [publicUrl.replace(/^https:/, 'wss:')] : [])].join(' ')}; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`,
    );
    if (isConfiguredPublicCrossOrigin(request)) {
      response.setHeader('Access-Control-Allow-Origin', publicUrl!);
      response.setHeader(
        'Access-Control-Allow-Methods',
        'GET,POST,PUT,DELETE,OPTIONS',
      );
      response.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization,Content-Type',
      );
      response.setHeader('Access-Control-Allow-Credentials', 'false');
      response.setHeader('Vary', 'Origin');
      if (request.method === 'OPTIONS') {
        const method = request.headers['access-control-request-method'];
        const requested = (
          request.headers['access-control-request-headers'] ?? ''
        )
          .split(',')
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (
          method &&
          !['GET', 'POST', 'PUT', 'DELETE'].includes(method.toUpperCase())
        )
          return response.status(405).end();
        if (
          requested.some(
            (value) => !['authorization', 'content-type'].includes(value),
          )
        )
          return response.status(403).end();
        return response.status(204).end();
      }
    }
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
    if (handoff && handoff.expiresAt <= Date.now() && !handoff.committed) {
      if (handoff.snapshotPath) {
        try {
          fs.rmSync(path.dirname(handoff.snapshotPath), {
            recursive: true,
            force: true,
          });
        } catch {
          /* best effort cleanup */
        }
      }
      storage.deleteHandoffBrowserTickets(handoff.generation);
      handoff = null;
    }
    const writeDuringHandoff =
      ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
      ![
        '/api/session',
        '/api/network/socket-ticket',
        '/api/network/browser-ticket',
        '/api/network/browser-restore',
        '/api/handoff/ready',
        '/api/handoff/activated',
      ].includes(request.path);
    const frozenOrRetired = handoff?.frozen || retired();
    if (frozenOrRetired && writeDuringHandoff)
      return response.status(409).json({
        error: retired()
          ? '此服务已完成主机移交，请使用新的服务入口。'
          : '主机移交进行中，暂时不能修改组数据。',
      });
    if (
      !frozenOrRetired &&
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
  const handleUpgrade = (
    request: http.IncomingMessage,
    socket: import('node:stream').Duplex,
    head: Buffer,
  ) => {
    // A client may close the TLS/HTTP socket before the upgrade decision
    // completes.  Keep that transport error from becoming an uncaught event.
    socket.on('error', () => {});
    try {
      if (!validateOrigin(request) || closing) throw new Error();
      const url = new URL(request.url ?? '', `http://${request.headers.host}`);
      const queryToken = url.searchParams.get('token') ?? '';
      const socketTicket = url.searchParams.get('ticket') ?? '';
      const cookieToken = request.headers.cookie?.match(
        /(?:^|;\s*)linchuan_session=([^;]+)/,
      )?.[1];
      let session = resolveSession(queryToken || cookieToken || '');
      if (!queryToken && !cookieToken && socketTicket) {
        const record = socketTickets.get(socketTicket);
        socketTickets.delete(socketTicket);
        if (
          record &&
          record.expiresAt > Date.now() &&
          sessionValid(record.session)
        )
          session = record.session;
      }
      if (url.pathname !== '/ws' || !session || !sessionValid(session))
        throw new Error();
      wss.handleUpgrade(request, socket, head, (connection) =>
        wss.emit('connection', connection, session),
      );
    } catch {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    }
  };
  secureLan = createSecureLan({
    app,
    server,
    host,
    fixedPort: port !== 0,
    identity: networkIdentity,
    auth,
    sessionOf,
    sessionValid,
    addresses: () =>
      [
        ...(host === '127.0.0.1' ? ['127.0.0.1'] : []),
        ...ownUrls().map((url) => new URL(url).hostname),
      ]
        .filter((address, index, all) => all.indexOf(address) === index)
        .filter(
          (address) =>
            address === '127.0.0.1' ||
            /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(address),
        ),
    onPresence: (deviceId) => {
      const device = devices.get(deviceId);
      if (!device) return;
      device.online =
        !!sockets.get(deviceId)?.size ||
        secureLan?.hasDevice(deviceId) === true;
      device.lastSeen = Date.now();
      if (!handoff?.frozen && !retired()) storage.saveDevice(device);
      broadcastPresence();
    },
    onReady: (deviceId) => ({
      type: 'ready',
      deviceId,
      devices: publicDevices(),
    }),
    onUpgrade: handleUpgrade,
  });
  app.get('/api/info', (_request, response) =>
    response.json({
      serverName: '邻传',
      urls: [...ownUrls(), ...(publicUrl ? [publicUrl] : [])],
      expiresHours: Number.isFinite(expiryMs) ? expiryMs / 3600000 : null,
      persistent: true,
      maxFileBytes: options.maxFileBytes ?? null,
      maxStorageBytes: options.maxStorageBytes ?? null,
      publicUrl,
      desktopApi: 3,
    }),
  );
  app.get('/api/network', auth, (_request, response) =>
    response.json({
      protocol: 1,
      groupId: networkIdentity.groupId,
      publicKey: networkIdentity.publicKey,
      hostGeneration: networkIdentity.hostGeneration,
      hostDeviceId: hostDeviceId() ?? null,
      lanUrls: committedMetadata()?.urls ?? secureLan?.urls() ?? [],
      httpLanUrls:
        committedMetadata()?.urls?.map((value) => {
          const url = new URL(value);
          return `http://${url.hostname}:${Math.max(1, Number(url.port) - 1)}`;
        }) ?? lanUrls(),
      publicUrl,
      internet: options.hostStatus?.()?.internet ?? 'disabled',
    }),
  );
  app.get('/api/network/probe', (request, response) => {
    if (retired())
      return response.status(410).json({ error: '服务已完成主机移交。' });
    const nonce =
      typeof request.query.nonce === 'string' ? request.query.nonce : '';
    if (!/^[0-9a-f]{64}$/.test(nonce))
      throw new HttpError(400, '网络探测 nonce 无效。');
    checkRate(
      networkProbeAttempts,
      request.ip || request.socket.remoteAddress || 'unknown',
      120,
    );
    const payload = `linchuan-network-v1\n${networkIdentity.groupId}\n${nonce}`;
    const key = crypto.createPrivateKey({
      key: Buffer.from(networkIdentity.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(payload, 'utf8'), {
        key,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      })
      .toString('base64');
    response.json({
      protocol: 1,
      groupId: networkIdentity.groupId,
      nonce,
      signature,
    });
  });
  const issueNetworkTicket = (
    request: Request,
    map: Map<string, { session: Session; expiresAt: number }>,
    ttlMs: number,
  ) => {
    checkRate(
      networkProbeAttempts,
      `ticket:${request.ip || request.socket.remoteAddress || 'unknown'}:${sessionOf(request).deviceId}`,
      20,
    );
    for (const [value, ticket] of map)
      if (ticket.expiresAt <= Date.now()) map.delete(value);
    const value = token(32);
    map.set(value, {
      session: sessionOf(request),
      expiresAt: Date.now() + ttlMs,
    });
    return value;
  };
  app.post('/api/network/socket-ticket', auth, (request, response) =>
    response.json({
      protocol: 1,
      ticket: issueNetworkTicket(request, socketTickets, 15000),
      expiresInMs: 15000,
    }),
  );
  app.post('/api/network/browser-ticket', auth, (request, response) =>
    response.json({
      protocol: 1,
      ticket: issueNetworkTicket(request, browserTickets, 30000),
      expiresInMs: 30000,
    }),
  );
  app.post('/api/network/browser-restore', (request, response) => {
    const value =
      typeof request.body?.ticket === 'string' ? request.body.ticket : '';
    const record = browserTickets.get(value);
    browserTickets.delete(value);
    let session: Session | undefined;
    if (
      record &&
      record.expiresAt > Date.now() &&
      sessionValid(record.session) &&
      !handoff?.frozen &&
      !retired()
    ) {
      session = record.session;
    } else if (!record && !handoff?.frozen && !retired()) {
      const consumed = storage.consumeHandoffBrowserTicket(
        hashToken(value),
        networkIdentity.hostGeneration,
      );
      if (consumed) {
        const oldHash = consumed.sessionHash;
        const oldSession = sessions.get(oldHash);
        if (oldSession && oldSession.deviceId === consumed.deviceId) {
          sessions.delete(oldHash);
          storage.deleteSession(oldHash);
          oldSession.token = token();
          sessions.set(hashToken(oldSession.token), oldSession);
          storage.saveSession(
            hashToken(oldSession.token),
            oldSession.deviceId,
            oldSession.expiresAt,
          );
          session = oldSession;
        }
      }
    }
    if (!session) throw new HttpError(401, '浏览器恢复票据无效或已过期。');
    response.setHeader('Set-Cookie', cookieFor(session, request));
    response.json({
      protocol: 1,
      token: session.token,
      device: devices.get(session.deviceId),
      devices: publicDevices(),
      expiresAt: session.expiresAt,
    });
  });
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
  const desktopHostOnly = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    hostOnly(request, response, () => {
      if (request.get('origin'))
        throw new HttpError(403, '桌面身份接口不接受浏览器 Origin。');
      next();
    });
  };
  const nativeOnly = (
    request: Request,
    response: Response,
    next: NextFunction,
  ) => {
    if (request.get('origin'))
      throw new HttpError(403, '原生身份接口不接受浏览器 Origin。');
    auth(request, response, next);
  };
  const hostDeviceId = () => storage.getMetadata('host.deviceId');
  const versionAtLeast = (value: string, minimum: string) => {
    const parse = (text: string) =>
      text
        .split('.')
        .slice(0, 3)
        .map((part) => Number(part));
    const a = parse(value);
    const b = parse(minimum);
    if (a.length !== 3 || a.some((part) => !Number.isInteger(part) || part < 0))
      return false;
    for (let index = 0; index < 3; index++) {
      if (a[index] > b[index]) return true;
      if (a[index] < b[index]) return false;
    }
    return true;
  };
  app.post('/api/native/capabilities', nativeOnly, (request, response) => {
    const body = request.body ?? {};
    const session = sessionOf(request);
    if (
      !devices.get(session.deviceId) ||
      devices.get(session.deviceId)!.type !== 'computer'
    )
      throw new HttpError(403, '只有电脑设备可以注册主机能力。');
    if (
      typeof body.publicKey !== 'string' ||
      body.publicKey.length < 300 ||
      body.publicKey.length > 1000
    )
      throw new HttpError(400, '主机公钥无效。');
    try {
      const key = crypto.createPublicKey({
        key: Buffer.from(body.publicKey, 'base64'),
        format: 'der',
        type: 'spki',
      });
      if (
        key.asymmetricKeyType !== 'rsa' ||
        (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
      )
        throw new Error();
    } catch {
      throw new HttpError(400, '主机公钥无效。');
    }
    if (
      typeof body.version !== 'string' ||
      !/^\d+\.\d+\.\d+$/.test(body.version) ||
      !versionAtLeast(body.version, '1.2.0')
    )
      throw new HttpError(400, '主机版本过低。');
    if (
      !Number.isInteger(body.receivePort) ||
      body.receivePort < 1 ||
      body.receivePort > 65535 ||
      !Array.isArray(body.lanUrls) ||
      body.lanUrls.length > 8
    )
      throw new HttpError(400, '主机接收地址无效。');
    const lanUrls = body.lanUrls.map((value: unknown) =>
      typeof value === 'string'
        ? normalizePrivateLanUrl(value, body.receivePort)
        : null,
    );
    if (lanUrls.some((value: string | null): value is null => value === null))
      throw new HttpError(400, '主机局域网地址无效。');
    const normalizedUrls = lanUrls as string[];
    const previous = capabilities.get(session.deviceId);
    const changed =
      !previous ||
      previous.publicKey !== body.publicKey ||
      previous.version !== body.version ||
      previous.receivePort !== body.receivePort ||
      previous.lanUrls.join('|') !== normalizedUrls.join('|');
    capabilities.set(session.deviceId, {
      publicKey: body.publicKey,
      version: body.version,
      receivePort: body.receivePort,
      lanUrls: normalizedUrls,
      updatedAt: Date.now(),
    });
    if (changed) broadcastPresence();
    response.json({ registered: true, hostDeviceId: hostDeviceId() ?? null });
  });
  app.post('/api/host/owner', desktopHostOnly, (request, response) => {
    const deviceId =
      typeof request.body?.deviceId === 'string' ? request.body.deviceId : '';
    const device = devices.get(deviceId);
    if (!device || device.type !== 'computer')
      throw new HttpError(400, '主机设备不存在。');
    storage.setMetadata('host.deviceId', deviceId);
    response.json({ hostDeviceId: deviceId });
  });
  app.post('/api/host/handoff/prepare', hostOnly, (request, response) => {
    if (retired()) throw new HttpError(409, '此服务已完成主机移交。');
    if (handoff) throw new HttpError(409, '已有主机移交事务。');
    if (activeUploads.size)
      throw new HttpError(409, '仍有活动传输，暂不能移交。');
    const targetDeviceId =
      typeof request.body?.targetDeviceId === 'string'
        ? request.body.targetDeviceId
        : '';
    const target = devices.get(targetDeviceId);
    const capability = capabilities.get(targetDeviceId);
    if (
      !target ||
      target.type !== 'computer' ||
      !target.online ||
      !capability ||
      capability.updatedAt + 20000 < Date.now() ||
      !versionAtLeast(capability.version, '1.2.0')
    )
      throw new HttpError(409, '目标电脑未在线或不支持主机移交。');
    const id = token(24);
    const root = path.join(options.dataDir, `.handoff-${id}`);
    const snapshotPath = path.join(root, 'linchuan.sqlite');
    const chunksPath = path.join(root, 'chunks');
    fs.mkdirSync(root, { recursive: true });
    const browserTickets = [...sessions.entries()]
      .filter(([, session]) => sessionValid(session))
      .map(([sessionHash, session]) => ({
        sessionHash,
        deviceId: session.deviceId,
        value: token(32),
      }));
    const browserTicketExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    for (const ticket of browserTickets)
      storage.saveHandoffBrowserTicket(
        hashToken(ticket.value),
        ticket.sessionHash,
        ticket.deviceId,
        networkIdentity.hostGeneration + 1,
        browserTicketExpiresAt,
      );
    handoff = {
      id,
      targetDeviceId,
      generation: networkIdentity.hostGeneration + 1,
      targetPublicKey: capability.publicKey,
      receivePort: capability.receivePort,
      startedAt: Date.now(),
      expiresAt: Date.now() + handoffTtlMs,
      frozen: true,
      committed: false,
      activated: false,
      ready: false,
      snapshotPath,
      chunksPath,
      chunkBytes: 0,
      nextChunk: 0,
      chunkQuota: 16 * 1024 * 1024,
      activeChunkRequests: 0,
      browserTickets,
    };
    scheduleHandoffExpiry(handoff);
    fs.mkdirSync(chunksPath, { recursive: true });
    try {
      storage.snapshotInto(snapshotPath);
      storage.patchSnapshotHandoff(
        snapshotPath,
        handoff.generation,
        targetDeviceId,
      );
      const exportFiles: Array<{
        index: number;
        path: string;
        size: number;
        sha256: string;
        source: string;
      }> = [
        {
          index: 0,
          path: 'linchuan.sqlite',
          size: fs.statSync(snapshotPath).size,
          sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(snapshotPath))
            .digest('hex'),
          source: snapshotPath,
        },
      ];
      let index = 1;
      for (const file of files.values()) {
        if (!fs.existsSync(file.path)) continue;
        const relative = path.join('uploads', file.ref.id);
        const target = path.join(root, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(file.path, target);
        const stat = fs.statSync(target);
        exportFiles.push({
          index: index++,
          path: relative.replaceAll('\\', '/'),
          size: stat.size,
          sha256: crypto
            .createHash('sha256')
            .update(fs.readFileSync(target))
            .digest('hex'),
          source: target,
        });
      }
      handoff.files = exportFiles;
      handoff.chunkQuota =
        exportFiles.reduce((sum, file) => sum + file.size, 0) +
        exportFiles.length * 512 +
        16 * 1024 * 1024;
    } catch (error) {
      handoff = null;
      storage.deleteHandoffBrowserTickets(networkIdentity.hostGeneration + 1);
      try {
        removeHandoffStaging(id);
      } catch {
        // Preserve an unsafe tree for explicit recovery rather than deleting it recursively.
      }
      throw new HttpError(
        409,
        `无法创建主机移交快照：${error instanceof Error ? error.message : '未知错误'}`,
      );
    }
    response.json({
      id,
      groupId: networkIdentity.groupId,
      generation: handoff.generation,
      targetDeviceId,
      targetPublicKey: capability.publicKey,
      receivePort: capability.receivePort,
      expiresAt: handoff.expiresAt,
    });
  });
  app.get('/api/host/handoff/export', hostOnly, (_request, response) => {
    renewHandoff();
    if (
      !handoff?.frozen ||
      !handoff.snapshotPath ||
      !fs.existsSync(handoff.snapshotPath)
    )
      throw new HttpError(404, '没有可导出的移交快照。');
    response.json({
      id: handoff.id,
      groupId: networkIdentity.groupId,
      generation: handoff.generation,
      files: (handoff.files ?? []).map(({ source: _source, ...file }) => file),
      totalBytes: (handoff.files ?? []).reduce(
        (sum, file) => sum + file.size,
        0,
      ),
    });
  });
  app.get('/api/host/handoff/file/:index', hostOnly, (request, response) => {
    renewHandoff();
    const index = Number(request.params.index);
    const exportFile = handoff?.files?.find((file) => file.index === index);
    if (!exportFile || !fs.existsSync(exportFile.source))
      throw new HttpError(404, '移交文件不存在。');
    response.type('application/octet-stream');
    const stream = fs.createReadStream(exportFile.source);
    stream.once('error', () => {
      if (!response.headersSent) response.status(404).end();
      else response.destroy();
    });
    stream.pipe(response);
  });
  app.put(
    '/api/host/handoff/chunks/:index',
    hostOnly,
    async (request, response) => {
      renewHandoff();
      if (!handoff?.frozen || !handoff.chunksPath)
        throw new HttpError(404, '没有活动移交事务。');
      const current = handoff;
      const chunksPath = current.chunksPath!;
      const index = Number(request.params.index);
      const length = Number(request.headers['content-length'] ?? 0);
      if (
        !Number.isInteger(index) ||
        index !== current.nextChunk ||
        !Number.isSafeInteger(length) ||
        length < 16 ||
        length > 8 * 1024 * 1024 ||
        current.chunkBytes + length > current.chunkQuota
      )
        throw new HttpError(400, '移交分块无效。');
      let received = 0;
      let claimed = false;
      let fileDescriptor: number | undefined;
      let output: fs.WriteStream | undefined;
      current.activeChunkRequests += 1;
      const leaseInterval = setInterval(
        () => renewHandoff(current),
        Math.max(10, Math.min(30000, Math.floor(handoffTtlMs / 3))),
      );
      leaseInterval.unref?.();
      try {
        const disk = await diskStatfs();
        if (disk.bavail * disk.bsize < BigInt(length) + 16n * 1024n * 1024n)
          throw new HttpError(413, '磁盘空间不足。');
      } catch (error) {
        clearInterval(leaseInterval);
        current.activeChunkRequests = Math.max(
          0,
          current.activeChunkRequests - 1,
        );
        if (error instanceof HttpError) throw error;
        throw new HttpError(413, '无法确认磁盘空间。');
      }
      const file = path.join(chunksPath, `${index}.part`);
      request.on('data', (part: Buffer) => {
        received += part.length;
      });
      try {
        // Claim the exact path before streaming.  If wx loses a race, this
        // request must never remove the other uploader's part file.
        // openSync closes the race without yielding while the request body is
        // already flowing; an async open here could lose buffered bytes.
        fileDescriptor = fs.openSync(file, 'wx');
        claimed = true;
        output = fs.createWriteStream(file, {
          fd: fileDescriptor,
          autoClose: true,
        });
        await pipeline(request, output);
        if (received !== length) throw new Error('移交分块长度不一致。');
      } catch (error) {
        // A disconnected sender must not leave an owned `.part` that blocks
        // the same ordered index on retry.
        if (claimed) await fsp.rm(file, { force: true }).catch(() => {});
        throw error;
      } finally {
        if (fileDescriptor !== undefined && !output)
          try {
            fs.closeSync(fileDescriptor);
          } catch {
            /* best effort */
          }
        clearInterval(leaseInterval);
        current.activeChunkRequests = Math.max(
          0,
          current.activeChunkRequests - 1,
        );
      }
      if (handoff !== current || current.committed || !current.frozen) {
        if (claimed) await fsp.rm(file, { force: true }).catch(() => {});
        throw new HttpError(409, '移交事务已结束。');
      }
      current.chunkBytes += length;
      current.nextChunk += 1;
      response.status(204).end();
    },
  );
  app.post('/api/host/handoff/seal', hostOnly, (request, response) => {
    if (!handoff?.frozen || !handoff.chunksPath)
      throw new HttpError(404, '没有活动移交事务。');
    const { envelopeJson, totalChunks, totalBytes, sha256 } =
      request.body ?? {};
    if (
      typeof envelopeJson !== 'string' ||
      envelopeJson.length > 16 * 1024 ||
      !Number.isInteger(totalChunks) ||
      totalChunks < 0 ||
      totalChunks > 1_000_000 ||
      !Number.isSafeInteger(totalBytes) ||
      totalBytes < 0 ||
      totalChunks !== handoff.nextChunk ||
      totalBytes !== handoff.chunkBytes ||
      typeof sha256 !== 'string' ||
      !/^[0-9a-f]{64}$/.test(sha256)
    )
      throw new HttpError(400, '移交封装无效。');
    let envelope: unknown;
    try {
      envelope = JSON.parse(envelopeJson);
    } catch {
      throw new HttpError(400, '移交封装 JSON 无效。');
    }
    if (!envelope || typeof envelope !== 'object')
      throw new HttpError(400, '移交封装无效。');
    const signaturePayload = `linchuan-handoff-v1\n${handoff.id}\n${networkIdentity.groupId}\n${handoff.generation}\n${handoff.targetDeviceId}\n${totalChunks}\n${totalBytes}\n${sha256}\n${crypto.createHash('sha256').update(envelopeJson).digest('hex')}`;
    const privateKey = crypto.createPrivateKey({
      key: Buffer.from(networkIdentity.privateKey, 'base64'),
      format: 'der',
      type: 'pkcs8',
    });
    const signature = crypto
      .sign('RSA-SHA256', Buffer.from(signaturePayload), {
        key: privateKey,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      })
      .toString('base64');
    handoff.offer = {
      envelope: envelopeJson,
      envelopeJson,
      totalChunks,
      totalBytes,
      sha256,
      signature,
    };
    handoff.chunkQuota = totalBytes + totalChunks * 512 + 16 * 1024 * 1024;
    response.status(204).end();
  });
  const targetHandoff = (request: Request) => {
    const session = sessionOf(request);
    if (
      !handoff ||
      handoff.expiresAt <= Date.now() ||
      session.deviceId !== handoff.targetDeviceId
    )
      throw new HttpError(404, '没有可用的主机移交。');
    return handoff;
  };
  app.get('/api/handoff/inbox', auth, (request, response) => {
    renewHandoff();
    const current = targetHandoff(request);
    if (!current.offer) return response.json({ offer: null });
    response.json({
      offer: {
        id: current.id,
        groupId: networkIdentity.groupId,
        generation: current.generation,
        targetDeviceId: current.targetDeviceId,
        targetPublicKey: current.targetPublicKey,
        receivePort: current.receivePort,
        state: current.ready ? 'ready' : 'sealed',
        urls: current.redirectUrls ?? [],
        ...current.offer,
      },
    });
  });
  app.get('/api/handoff/chunks/:index', auth, (request, response) => {
    renewHandoff();
    const current = targetHandoff(request);
    const index = Number(request.params.index);
    const file =
      current.chunksPath && path.join(current.chunksPath, `${index}.part`);
    if (!file || !Number.isInteger(index) || index < 0)
      throw new HttpError(404, '移交分块不存在。');
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(file);
    } catch {
      throw new HttpError(404, '移交分块不存在。');
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw new HttpError(404, '移交分块不存在。');
    response.type('application/octet-stream');
    const stream = fs.createReadStream(file);
    stream.once('error', () => {
      if (!response.headersSent) response.status(404).end();
      else response.destroy();
    });
    request.once('aborted', () => {
      if (!stream.destroyed) stream.destroy();
    });
    stream.pipe(response);
  });
  app.post('/api/handoff/ready', auth, (request, response) => {
    renewHandoff();
    const current = targetHandoff(request);
    const submittedUrls = request.body?.urls;
    // Native clients may enumerate more interfaces at ready time than fit in
    // their capability advertisement.  The capability's first eight entries
    // are the authenticated allowlist; never propagate later candidates.
    const urls = Array.isArray(submittedUrls)
      ? submittedUrls.slice(0, 8)
      : null;
    const capability = capabilities.get(current.targetDeviceId);
    const allowedUrls = capability?.lanUrls ?? [];
    const normalizedUrls =
      urls && capability
        ? urls.map((value) =>
            typeof value === 'string'
              ? normalizePrivateLanUrl(value, capability.receivePort)
              : null,
          )
        : null;
    if (
      !normalizedUrls?.length ||
      normalizedUrls.some(
        (value) => value === null || !allowedUrls.includes(value),
      )
    )
      throw new HttpError(400, '新主机地址无效。');
    const validUrls = normalizedUrls as string[];
    current.ready = true;
    current.redirectUrls = validUrls.map((value) => {
      const url = new URL(value);
      return `https://${url.hostname}:${securePortFor(Number(url.port))}`;
    });
    response.json({ ready: true });
  });
  app.get('/api/handoff/status', auth, (request, response) => {
    renewHandoff();
    const id = typeof request.query.id === 'string' ? request.query.id : '';
    if (!handoff || handoff.id !== id) {
      const persisted = committedMetadata();
      if (
        !persisted ||
        persisted.id !== id ||
        sessionOf(request).deviceId !== persisted.targetDeviceId
      )
        return response.status(404).json({ error: '移交不存在。' });
      return response.json({
        id: persisted.id,
        state: 'committed',
        generation: persisted.generation,
        targetDeviceId: persisted.targetDeviceId,
        urls: persisted.urls,
        activated: persisted.activated,
      });
    }
    if (sessionOf(request).deviceId !== handoff.targetDeviceId)
      throw new HttpError(403, '无权读取此移交。');
    response.json({
      id: handoff.id,
      generation: handoff.generation,
      targetDeviceId: handoff.targetDeviceId,
      state: handoff.committed
        ? 'committed'
        : handoff.ready
          ? 'ready'
          : handoff.offer
            ? 'offered'
            : 'preparing',
      activated: handoff.activated,
      redirectUrls: handoff.redirectUrls ?? [],
    });
  });
  app.get('/api/host/handoff/status', hostOnly, (request, response) => {
    renewHandoff();
    const id = typeof request.query.id === 'string' ? request.query.id : '';
    if (!handoff || handoff.id !== id) {
      const persisted = committedMetadata();
      if (!persisted || persisted.id !== id)
        return response.status(404).json({ error: '移交不存在。' });
      return response.json({
        id: persisted.id,
        state: 'committed',
        generation: persisted.generation,
        targetDeviceId: persisted.targetDeviceId,
        urls: persisted.urls,
        activated: persisted.activated,
      });
    }
    response.json({
      id: handoff.id,
      generation: handoff.generation,
      targetDeviceId: handoff.targetDeviceId,
      state: handoff.committed
        ? 'committed'
        : handoff.ready
          ? 'ready'
          : handoff.offer
            ? 'offered'
            : 'preparing',
      activated: handoff.activated,
      redirectUrls: handoff.redirectUrls ?? [],
    });
  });
  app.post('/api/handoff/activated', auth, (request, response) => {
    const current = handoff && handoff.id === request.body?.id ? handoff : null;
    if (current && sessionOf(request).deviceId !== current.targetDeviceId)
      throw new HttpError(403, '无权确认此主机移交。');
    const persisted = committedMetadata();
    if (current) {
      if (!current.committed) throw new HttpError(409, '移交尚未提交。');
      // Remove only this committed transaction's staging tree.  This must
      // finish before the activated marker and ACK become observable.
      removeHandoffStaging(current.id);
      current.activated = true;
    } else if (
      !persisted ||
      persisted.id !== request.body?.id ||
      persisted.targetDeviceId !== sessionOf(request).deviceId
    )
      throw new HttpError(409, '移交尚未提交。');
    else {
      // An ACK retry after a source restart is idempotent, but remains scoped
      // to the committed target and exact staging directory.
      removeHandoffStaging(persisted.id);
    }
    storage.setMetadata('handoff.activated', '1');
    response.json({ activated: true });
  });
  app.post('/api/host/handoff/commit', hostOnly, (request, response) => {
    if (
      !handoff ||
      handoff.id !== request.body?.id ||
      !handoff.ready ||
      !handoff.offer
    )
      throw new HttpError(409, '目标主机尚未准备好。');
    const current = handoff;
    const nextGeneration = networkIdentity.hostGeneration + 1;
    storage.setMetadataMany([
      ['network.hostGeneration', String(nextGeneration)],
      ['host.deviceId', current.targetDeviceId],
      ['host.retired', '1'],
      ['handoff.id', current.id],
      ['handoff.generation', String(nextGeneration)],
      ['handoff.targetDeviceId', current.targetDeviceId],
      ['handoff.urls', JSON.stringify(current.redirectUrls ?? [])],
      ['handoff.activated', '0'],
    ]);
    networkIdentity.hostGeneration = nextGeneration;
    current.committed = true;
    current.frozen = true;
    for (const group of sockets.values()) {
      for (const socket of group) {
        sendSocket(
          socket,
          JSON.stringify({
            type: 'handoff',
            state: 'committed',
            browserTicket: current.browserTickets?.find(
              (ticket) =>
                ticket.sessionHash ===
                hashToken(socketSessions.get(socket)?.token ?? ''),
            )?.value,
            redirectUrls: current.redirectUrls ?? [],
            network: {
              protocol: 1,
              groupId: networkIdentity.groupId,
              publicKey: networkIdentity.publicKey,
              hostGeneration: nextGeneration,
              hostDeviceId: current.targetDeviceId,
              lanUrls: current.redirectUrls ?? [],
              publicUrl,
            },
          }),
        );
        secureLan?.emit(
          socketSessions.get(socket)?.deviceId ?? null,
          JSON.stringify({
            type: 'handoff',
            state: 'committed',
            browserTicket: current.browserTickets?.find(
              (ticket) =>
                ticket.sessionHash ===
                hashToken(socketSessions.get(socket)?.token ?? ''),
            )?.value,
            redirectUrls: current.redirectUrls ?? [],
            network: {
              protocol: 1,
              groupId: networkIdentity.groupId,
              publicKey: networkIdentity.publicKey,
              hostGeneration: nextGeneration,
              hostDeviceId: current.targetDeviceId,
              lanUrls: current.redirectUrls ?? [],
              publicUrl,
            },
          }),
        );
      }
    }
    response.json({
      id: current.id,
      state: 'committed',
      hostGeneration: nextGeneration,
      redirectUrls: current.redirectUrls ?? [],
    });
  });
  app.post('/api/host/handoff/abort', hostOnly, (request, response) => {
    if (!handoff || handoff.id !== request.body?.id || handoff.committed)
      throw new HttpError(409, '移交不存在或已提交。');
    if (handoff.snapshotPath) removeHandoffStaging(handoff.id);
    handoff = null;
    storage.deleteHandoffBrowserTickets(networkIdentity.hostGeneration + 1);
    clearTimeout(handoffTimer);
    response.status(204).end();
  });
  app.get('/api/host', hostOnly, (_request, response) =>
    response.json({
      code: joinCode,
      joinLocked: storage.joinFailures() >= maxJoinFailures,
      localUrl: `http://127.0.0.1:${boundPort()}`,
      ...(publicUrl ? { publicUrl } : {}),
      ...options.hostStatus?.(),
    }),
  );
  app.get('/api/host/devices', desktopHostOnly, (_request, response) =>
    response.json({
      devices: [...devices.values()]
        .filter((device) => device.type === 'computer')
        .map((device) => ({ ...device })),
    }),
  );
  app.post(
    '/api/host/desktop-session',
    desktopHostOnly,
    (request, response) => {
      if (handoff?.frozen || retired())
        throw new HttpError(409, '主机移交进行中，暂时不能建立新会话。');
      checkRate(joinAttempts, `desktop:${request.ip || 'unknown'}`, 20);
      checkRate(joinAttempts, 'global-desktop-attempts', 30);
      if (storage.joinFailures() >= maxJoinFailures)
        throw new HttpError(429, '加入已暂停，请在服务电脑刷新连接码。');
      const { deviceId, code } = request.body ?? {};
      const validCode =
        typeof code === 'string' &&
        /^\d{6}$/.test(code) &&
        crypto.timingSafeEqual(Buffer.from(code), Buffer.from(joinCode));
      const device =
        typeof deviceId === 'string' ? devices.get(deviceId) : undefined;
      if (!validCode || !device || device.type !== 'computer') {
        storage.incrementJoinFailures();
        throw new HttpError(401, '连接码或电脑设备不正确。');
      }
      if (
        [...sessions.values()].filter((item) => item.expiresAt > Date.now())
          .length >= 128
      )
        throw new HttpError(429, '已连接设备过多，请退出暂时不用的设备。');
      const session: Session = {
        token: token(),
        deviceId: device.id,
        expiresAt: Date.now() + sessionExpiryMs,
      };
      sessions.set(hashToken(session.token), session);
      storage.saveSession(
        hashToken(session.token),
        device.id,
        session.expiresAt,
      );
      if (!hostDeviceId()) storage.setMetadata('host.deviceId', device.id);
      response.setHeader('Set-Cookie', cookieFor(session, request));
      response.json({
        token: session.token,
        device,
        devices: publicDevices(),
        messages: [],
      });
    },
  );
  app.post('/api/host/code', hostOnly, (_request, response) => {
    if (handoff?.frozen || retired())
      throw new HttpError(409, '主机移交进行中，暂时不能刷新连接码。');
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
    if (request.query.format === 'png') {
      response
        .type('png')
        .send(await QRCode.toBuffer(value, { type: 'png', margin: 1 }));
    } else {
      response
        .type('svg')
        .send(await QRCode.toString(value, { type: 'svg', margin: 1 }));
    }
  });
  app.post('/api/join', (request, response) => {
    if (handoff?.frozen || retired())
      throw new HttpError(409, '主机移交进行中，暂时不能加入服务。');
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
    if (!handoff?.frozen && !retired()) storage.saveDevice(device);
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
    if (!handoff?.frozen && !retired()) storage.saveDevice(device);
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
    secureLan?.emit(requester, payload);
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
  server.on('upgrade', handleUpgrade);
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
    if (!handoff?.frozen && !retired()) storage.saveDevice(device);
    let alive = true;
    socket.on('error', () => socket.terminate());
    socket.on('pong', () => {
      alive = true;
    });
    sendSocket(
      socket,
      JSON.stringify({
        type: 'ready',
        deviceId: session.deviceId,
        devices: publicDevices(),
      }),
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
      if (!group.size && !secureLan?.hasDevice(session.deviceId)) {
        sockets.delete(session.deviceId);
        device.online = false;
        device.lastSeen = Date.now();
        if (!handoff?.frozen && !retired()) storage.saveDevice(device);
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
    try {
      await secureLan?.start();
    } catch (error) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  };
  let closeJob: Promise<void> | undefined;
  const close = () =>
    (closeJob ??= (async () => {
      closing = true;
      clearInterval(interval);
      for (const cancel of activeUploads.values()) cancel();
      await secureLan?.close();
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
    getSecureUrls: () => secureLan?.urls() ?? [],
    getSecurePort: () => {
      const url = secureLan?.urls()[0];
      return url ? Number(new URL(url).port) : 0;
    },
    devices,
    messages,
    files,
  };
}
