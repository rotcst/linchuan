import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express, Request, RequestHandler } from 'express';
import type { Message, FileRef } from './app.js';
import { HttpError } from './errors.js';

type Session = { token: string; deviceId: string; expiresAt: number };
type Transfer = {
  id: string;
  owner: Session;
  to: string;
  clientId?: string;
  name: string;
  mime: string;
  size: number;
  offset: number;
  path: string;
  touchedAt: number;
  busy: boolean;
  cancelled: boolean;
  diskReserved: number;
  stop?: () => void;
};
type TransferOptions = {
  auth: RequestHandler;
  sessionOf: (request: Request) => Session;
  sessionValid: (session: Session) => boolean;
  checkTarget: (value: unknown) => string;
  checkClientId: (value: unknown) => string | undefined;
  findMessage: (owner: string, clientId: string) => Message | undefined;
  isMessageHidden?: (messageId: string, owner: string) => boolean;
  ensureCapacity: (size: number) => Promise<void>;
  reserve: (size: number) => void;
  release: (size: number) => void;
  reserveDisk: (size: number) => Promise<void>;
  releaseDisk: (size: number) => Promise<void>;
  activeUploads: Map<string, () => void>;
  uploadDir: string;
  maxFileBytes: number;
  commit: (
    file: FileRef,
    filePath: string,
    owner: string,
    to: string,
    clientId?: string,
  ) => Message;
};
const CHUNK_BYTES = 8 * 1024 ** 2;
const randomId = () => crypto.randomBytes(24).toString('base64url');
const filename = (value: string) =>
  value
    .replace(/[\\/\0\r\n<>:"|?*]/g, '_')
    .trim()
    .slice(0, 180) || '未命名文件';

export function mountTransfers(app: Express, options: TransferOptions) {
  const transfers = new Map<string, Transfer>();
  const cleanupJobs = new Set<Promise<void>>();
  const remove = async (transfer: Transfer) => {
    if (transfers.get(transfer.id) !== transfer) return;
    transfer.cancelled = true;
    transfer.stop?.();
    if (transfer.busy) return;
    transfers.delete(transfer.id);
    options.activeUploads.delete(transfer.owner.deviceId);
    options.release(transfer.size);
    if (transfer.diskReserved) {
      await options.releaseDisk(transfer.diskReserved);
      transfer.diskReserved = 0;
    }
    await fsp.rm(transfer.path, { force: true });
  };
  const cancel = (transfer: Transfer) => {
    const job = remove(transfer)
      .catch(() => {
        console.error('取消文件传输时清理失败。');
      })
      .finally(() => cleanupJobs.delete(job));
    cleanupJobs.add(job);
  };
  const lookup = (request: Request) => {
    const transfer = transfers.get(String(request.params.id));
    if (
      !transfer ||
      transfer.owner.deviceId !== options.sessionOf(request).deviceId ||
      transfer.cancelled
    )
      throw new HttpError(404, '上传任务不存在或已经取消。');
    return transfer;
  };
  app.post('/api/transfers', options.auth, async (request, response) => {
    const owner = options.sessionOf(request);
    const {
      name,
      size,
      mime,
      to: value,
      clientId: clientValue,
    } = request.body ?? {};
    const to = options.checkTarget(value);
    const clientId = options.checkClientId(clientValue);
    if (
      typeof name !== 'string' ||
      !name ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > options.maxFileBytes
    )
      throw new HttpError(413, '文件大小无效或超过服务配置的上限。');
    const old = clientId && options.findMessage(owner.deviceId, clientId);
    if (old) {
      if (options.isMessageHidden?.(old.id, owner.deviceId))
        throw new HttpError(410, '这条文件消息已从当前设备隐藏。');
      if (
        old.kind !== 'file' ||
        old.to !== to ||
        !old.file ||
        old.file.size !== size ||
        old.file.name !== filename(name)
      )
        throw new HttpError(409, '消息标识已经用于其他文件。');
      return response.json({ message: old });
    }
    if (options.activeUploads.has(owner.deviceId))
      throw new HttpError(429, '当前设备已有文件正在上传。');
    await options.ensureCapacity(size);
    if (options.activeUploads.has(owner.deviceId))
      throw new HttpError(429, '当前设备已有文件正在上传。');
    const id = randomId();
    const transfer: Transfer = {
      id,
      owner,
      to,
      clientId,
      name: filename(name),
      mime:
        typeof mime === 'string'
          ? mime.slice(0, 200)
          : 'application/octet-stream',
      size,
      offset: 0,
      path: path.join(options.uploadDir, `${id}.part`),
      touchedAt: Date.now(),
      busy: false,
      cancelled: false,
      diskReserved: 0,
    };
    await options.reserveDisk(size);
    if (options.activeUploads.has(owner.deviceId)) {
      await options.releaseDisk(size);
      throw new HttpError(429, '当前设备已有文件正在上传。');
    }
    transfer.diskReserved = size;
    try {
      options.reserve(size);
    } catch (cause) {
      transfer.diskReserved = 0;
      await options.releaseDisk(size);
      throw cause;
    }
    transfers.set(id, transfer);
    options.activeUploads.set(owner.deviceId, () => cancel(transfer));
    try {
      await fsp.writeFile(transfer.path, '', { flag: 'wx' });
    } catch {
      await remove(transfer);
      throw new HttpError(500, '无法创建文件，请检查磁盘空间。');
    }
    response.status(201).json({ id, offset: 0, chunkBytes: CHUNK_BYTES });
  });
  app.get('/api/transfers/:id', options.auth, (request, response) => {
    const transfer = lookup(request);
    response.json({
      id: transfer.id,
      offset: transfer.offset,
      size: transfer.size,
      chunkBytes: CHUNK_BYTES,
    });
  });
  app.put('/api/transfers/:id', options.auth, async (request, response) => {
    const transfer = lookup(request);
    const offset = Number(request.query.offset);
    if (!Number.isSafeInteger(offset) || offset !== transfer.offset)
      return response
        .status(409)
        .json({ error: '上传位置不一致，请重试。', offset: transfer.offset });
    if (transfer.busy) throw new HttpError(429, '上一个文件分块仍在保存。');
    const length = Number(request.headers['content-length']);
    if (
      Number.isFinite(length) &&
      (length > CHUNK_BYTES || transfer.offset + length > transfer.size)
    )
      throw new HttpError(413, '文件分块超出允许范围。');
    transfer.busy = true;
    transfer.touchedAt = Date.now();
    let bytes = 0;
    const output = fs.createWriteStream(transfer.path, { flags: 'a' });
    const counter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > CHUNK_BYTES || offset + bytes > transfer.size)
          return callback(new HttpError(413, '文件分块超出允许范围。'));
        callback(null, chunk);
      },
    });
    transfer.stop = () => counter.destroy(new HttpError(400, '上传已取消。'));
    const timeout = () =>
      counter.destroy(new HttpError(408, '网络长时间没有响应。'));
    request.setTimeout(120000, timeout);
    try {
      await pipeline(request, counter, output);
      if (transfer.cancelled || !options.sessionValid(transfer.owner))
        throw new HttpError(401, '连接已过期或上传已取消。');
      transfer.offset += bytes;
      if (bytes) {
        await options.releaseDisk(bytes);
        transfer.diskReserved -= bytes;
      }
      transfer.touchedAt = Date.now();
      response.json({ offset: transfer.offset });
    } catch (cause) {
      await fsp.truncate(transfer.path, offset).catch(() => {});
      throw cause instanceof HttpError
        ? cause
        : new HttpError(400, '分块上传中断，请重试。');
    } finally {
      transfer.busy = false;
      transfer.stop = undefined;
      request.off('timeout', timeout);
      request.setTimeout(0);
      if (transfer.cancelled) await remove(transfer);
    }
  });
  app.post(
    '/api/transfers/:id/complete',
    options.auth,
    async (request, response) => {
      const transfer = lookup(request);
      if (transfer.busy || transfer.offset !== transfer.size)
        throw new HttpError(409, '文件尚未上传完整。');
      transfer.busy = true;
      const id = crypto.randomBytes(16).toString('base64url');
      const finalPath = path.join(options.uploadDir, id);
      try {
        await fsp.rename(transfer.path, finalPath);
        const ref: FileRef = {
          id,
          name: transfer.name,
          size: transfer.size,
          mime: transfer.mime,
        };
        const message = options.commit(
          ref,
          finalPath,
          transfer.owner.deviceId,
          transfer.to,
          transfer.clientId,
        );
        transfers.delete(transfer.id);
        options.activeUploads.delete(transfer.owner.deviceId);
        options.release(transfer.size);
        if (transfer.diskReserved) {
          await options.releaseDisk(transfer.diskReserved);
          transfer.diskReserved = 0;
        }
        response.status(201).json(message);
      } catch (cause) {
        transfer.busy = false;
        await fsp.rm(finalPath, { force: true });
        await remove(transfer);
        throw cause;
      }
    },
  );
  app.delete('/api/transfers/:id', options.auth, async (request, response) => {
    const transfer = lookup(request);
    await remove(transfer);
    response.status(204).end();
  });
  const timer = setInterval(() => {
    for (const transfer of transfers.values())
      if (
        transfer.touchedAt + 10 * 60000 < Date.now() ||
        !options.sessionValid(transfer.owner)
      )
        cancel(transfer);
  }, 30000);
  timer.unref();
  return {
    close: async () => {
      clearInterval(timer);
      for (const transfer of transfers.values()) cancel(transfer);
      await Promise.allSettled(cleanupJobs);
    },
  };
}
