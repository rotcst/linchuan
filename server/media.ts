import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Express, Request, RequestHandler } from 'express';
import sharp from 'sharp';
import pLimit from 'p-limit';
import type { FileRef } from './app.js';

type MediaFile = { ref: FileRef; path: string };
type MediaOptions = {
  auth: RequestHandler;
  getFile: (request: Request) => MediaFile | undefined;
  dataDir: string;
};
const imageMime = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
]);
const videoMime = new Set(['video/mp4', 'video/quicktime', 'video/webm']);
const signature = (
  bytes: Buffer,
  refMime: string,
): 'image' | 'video' | undefined => {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return 'image';
  if (
    bytes.length >= 3 &&
    bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
  )
    return 'image';
  if (
    bytes.length >= 6 &&
    (bytes.subarray(0, 6).toString() === 'GIF87a' ||
      bytes.subarray(0, 6).toString() === 'GIF89a')
  )
    return 'image';
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString() === 'RIFF' &&
    bytes.subarray(8, 12).toString() === 'WEBP'
  )
    return 'image';
  if (bytes.length >= 12 && bytes.subarray(4, 8).toString() === 'ftyp') {
    const brand = bytes.subarray(8, 12).toString();
    if (brand === 'avif' || brand === 'avis') return 'image';
    if (refMime.startsWith('video/')) return 'video';
  }
  if (
    bytes.length >= 4 &&
    bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))
  )
    return 'video';
  return undefined;
};

export function mountMedia(app: Express, options: MediaOptions) {
  const previewDir = path.resolve(options.dataDir, 'previews');
  fsSync.mkdirSync(previewDir, { recursive: true });
  const limit = pLimit(2);
  const jobs = new Set<Promise<unknown>>();
  const inFlight = new Map<string, Promise<string>>();
  const readHead = async (filePath: string) => {
    const handle = await fs.open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(32);
      const result = await handle.read(buffer, 0, 32, 0);
      return buffer.subarray(0, result.bytesRead);
    } finally {
      await handle.close();
    }
  };
  const run = <T>(job: () => Promise<T>) => {
    if (limit.pendingCount >= 40)
      return Promise.reject(
        Object.assign(new Error('预览队列已满。'), { status: 429 }),
      );
    const promise = limit(job);
    jobs.add(promise);
    promise.then(
      () => jobs.delete(promise),
      () => jobs.delete(promise),
    );
    return promise;
  };
  app.get('/api/files/:id/preview', options.auth, async (request, response) => {
    const file = options.getFile(request);
    if (!file || !imageMime.has(file.ref.mime))
      return response.status(404).json({ error: '图片不存在。' });
    const bytes = await readHead(file.path).catch(() => Buffer.alloc(0));
    if (signature(bytes, file.ref.mime) !== 'image')
      return response.status(415).json({ error: '文件不是受支持的图片。' });
    const large = request.query.large === '1';
    const cache = path.join(
      previewDir,
      `${file.ref.id}-${large ? 'large' : 'thumb'}.webp`,
    );
    let task = inFlight.get(cache);
    if (!task) {
      task = run(async () => {
        try {
          await fs.access(cache);
          return cache;
        } catch {
          const temp = `${cache}.${crypto.randomBytes(6).toString('hex')}.part`;
          try {
            await sharp(file.path, { limitInputPixels: 64 * 1024 * 1024 })
              .rotate()
              .resize(large ? 2048 : 640, large ? 2048 : 640, {
                fit: 'inside',
                withoutEnlargement: true,
              })
              .webp({ quality: 82 })
              .timeout({ seconds: 30 })
              .toFile(temp);
            await fs.rename(temp, cache);
            return cache;
          } finally {
            await fs.rm(temp, { force: true });
          }
        }
      });
      inFlight.set(cache, task);
      task.then(
        () => inFlight.delete(cache),
        () => inFlight.delete(cache),
      );
    }
    try {
      await task;
    } catch (error) {
      const status = (error as { status?: number }).status;
      return response
        .status(status === 429 ? 429 : 415)
        .json({ error: status === 429 ? '预览队列已满。' : '图片无法解码。' });
    }
    response.setHeader('Content-Type', 'image/webp');
    response.setHeader('Cache-Control', 'private, max-age=86400');
    return response.sendFile(cache);
  });
  app.get('/api/files/:id/media', options.auth, async (request, response) => {
    const file = options.getFile(request);
    if (
      !file ||
      (!videoMime.has(file.ref.mime) && !imageMime.has(file.ref.mime))
    )
      return response.status(404).json({ error: '媒体不存在。' });
    const head = await readHead(file.path).catch(() => Buffer.alloc(0));
    if (
      signature(head, file.ref.mime) !==
      (imageMime.has(file.ref.mime) ? 'image' : 'video')
    )
      return response
        .status(415)
        .json({ error: '文件不是受支持的图片或视频。' });
    response.setHeader('Content-Type', file.ref.mime);
    response.setHeader(
      'Content-Disposition',
      `inline; filename*=UTF-8''${encodeURIComponent(file.ref.name)}`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    return response.sendFile(file.path);
  });
  return {
    close: async () => {
      await Promise.allSettled([...jobs]);
      limit.clearQueue();
    },
    remove: async (id: string) => {
      await Promise.allSettled(
        [...inFlight.entries()]
          .filter(([name]) => name.includes(`${id}-`))
          .map(([, job]) => job),
      );
      await Promise.allSettled([
        fs.rm(path.join(previewDir, `${id}-thumb.webp`), { force: true }),
        fs.rm(path.join(previewDir, `${id}-large.webp`), { force: true }),
      ]);
    },
  };
}
