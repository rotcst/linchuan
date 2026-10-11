import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { mountMedia } from '../server/media.js';
import { createLanServer } from '../server/app.js';
import type { FileRef, Message } from '../server/app.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-media-'));
  const upload = path.join(dir, 'uploads');
  await fs.mkdir(upload);
  const ref: FileRef = {
    id: 'img1',
    name: 'photo.png',
    size: 0,
    mime: 'image/png',
  };
  const filePath = path.join(upload, ref.id);
  await sharp({
    create: {
      width: 900,
      height: 500,
      channels: 3,
      background: { r: 20, g: 80, b: 160 },
    },
  })
    .png()
    .toFile(filePath);
  ref.size = (await fs.stat(filePath)).size;
  const files = new Map([['img1', { ref, path: filePath }]]);
  const app = express();
  const auth = (
    request: express.Request,
    response: express.Response,
    next: express.NextFunction,
  ) => {
    if (request.get('authorization') !== 'Bearer good')
      return response.status(401).end();
    next();
  };
  const media = mountMedia(app, {
    auth,
    dataDir: dir,
    getFile: (request) =>
      request.get('authorization') === 'Bearer good'
        ? files.get(String(request.params.id))
        : undefined,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  return {
    dir,
    filePath,
    ref,
    base,
    media,
    close: async () => {
      await media.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('PNG 预览生成 webp、尺寸受限且原字节不变', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const original = await fs.readFile(x.filePath);
  const response = await fetch(`${x.base}/api/files/img1/preview`, {
    headers: { authorization: 'Bearer good' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/webp');
  const metadata = await sharp(
    Buffer.from(await response.arrayBuffer()),
  ).metadata();
  assert.ok((metadata.width ?? 0) <= 640);
  assert.ok((metadata.height ?? 0) <= 640);
  assert.deepEqual(await fs.readFile(x.filePath), original);
});

test('真实 app 集成：私聊 PNG 预览 ACL、Cookie 下载和删除后缓存清理', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-media-app-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await lan.start();
  t.after(async () => {
    await lan.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const join = async (id: string) =>
    (await (
      await fetch(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: '123456',
          deviceId: id,
          name: id,
          type: 'computer',
        }),
      })
    ).json()) as { token: string; device: { id: string } };
  const sender = await join('sender');
  const recipient = await join('recipient');
  const third = await join('third');
  const png = await sharp({
    create: { width: 30, height: 20, channels: 3, background: 'green' },
  })
    .png()
    .toBuffer();
  const form = new FormData();
  form.append('file', new Blob([png], { type: 'image/png' }), '真实图片.png');
  const message = (await (
    await fetch(
      `${base}/api/files?to=${recipient.device.id}&clientId=media-app-1`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${sender.token}` },
        body: form,
      },
    )
  ).json()) as Message;
  assert.ok(message.file);
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}/media`, {
        headers: { authorization: `Bearer ${recipient.token}` },
      })
    ).status,
    200,
  );
  const originalMedia = await fetch(
    `${base}/api/files/${message.file!.id}/media`,
    { headers: { authorization: `Bearer ${recipient.token}` } },
  );
  assert.equal(originalMedia.headers.get('content-type'), 'image/png');
  assert.equal(
    Buffer.compare(Buffer.from(await originalMedia.arrayBuffer()), png),
    0,
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}/media`, {
        headers: { authorization: `Bearer ${third.token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${third.token}` },
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}/preview`, {
        headers: { authorization: `Bearer ${third.token}` },
      })
    ).status,
    404,
  );
  const sessionResponse = await fetch(`${base}/api/session`, {
    headers: { authorization: `Bearer ${recipient.token}` },
  });
  const sessionCookie =
    sessionResponse.headers.get('set-cookie')?.split(';')[0] ?? '';
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}/preview`, {
        headers: { cookie: sessionCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}`, {
        headers: { cookie: sessionCookie },
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await fetch(`${base}/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${recipient.token}` },
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}/preview`, {
        headers: { authorization: `Bearer ${recipient.token}` },
      })
    ).status,
    200,
  );
  const senderStillHasFile = await fetch(
    `${base}/api/files/${message.file!.id}/media`,
    { headers: { authorization: `Bearer ${sender.token}` } },
  );
  assert.equal(senderStillHasFile.status, 200);
  assert.deepEqual(Buffer.from(await senderStillHasFile.arrayBuffer()), png);
  const recipientHistory = (await (
    await fetch(`${base}/api/messages?to=${sender.device.id}`, {
      headers: { authorization: `Bearer ${recipient.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    recipientHistory.messages.some((item) => item.id === message.id),
    false,
  );
  const senderHistory = (await (
    await fetch(`${base}/api/messages?to=${recipient.device.id}`, {
      headers: { authorization: `Bearer ${sender.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    senderHistory.messages.some((item) => item.id === message.id),
    true,
  );
  assert.equal(
    (
      await fetch(`${base}/api/files/${message.file!.id}`, {
        headers: { authorization: `Bearer ${sender.token}` },
      })
    ).status,
    200,
  );
});

test('SVG 伪图片拒绝，第三方 ACL 拒绝', async (t) => {
  const x = await fixture();
  t.after(x.close);
  await fs.writeFile(x.filePath, '<svg><script>alert(1)</script></svg>');
  const bad = await fetch(`${x.base}/api/files/img1/preview`, {
    headers: { authorization: 'Bearer good' },
  });
  assert.equal(bad.status, 415);
  const denied = await fetch(`${x.base}/api/files/img1/preview`, {
    headers: { authorization: 'Bearer other' },
  });
  assert.equal(denied.status, 401);
});

test('MP4 ftyp 媒体支持 inline 与 Range 206', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const videoPath = x.filePath;
  await fs.writeFile(
    videoPath,
    Buffer.concat([
      Buffer.alloc(4),
      Buffer.from('ftypisom'),
      Buffer.alloc(32, 7),
    ]),
  );
  x.ref.mime = 'video/mp4';
  x.ref.size = (await fs.stat(videoPath)).size;
  const appFile = express();
  const auth = (
    _req: express.Request,
    _res: express.Response,
    next: express.NextFunction,
  ) => next();
  const media = mountMedia(appFile, {
    auth,
    dataDir: x.dir,
    getFile: (request) =>
      request.params.id === 'img1'
        ? { ref: x.ref, path: videoPath }
        : undefined,
  });
  const server = http.createServer(appFile);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
  const response = await fetch(`${base}/api/files/img1/media`, {
    headers: { range: 'bytes=0-7' },
  });
  assert.equal(response.status, 206);
  assert.match(response.headers.get('content-disposition') ?? '', /inline/);
  await media.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('无效 JPEG 返回 415 后服务仍可处理请求，同图片并发只生成完整缓存', async (t) => {
  const x = await fixture();
  t.after(x.close);
  await fs.writeFile(x.filePath, Buffer.from([255, 216, 255, 0, 1]));
  const bad = await fetch(`${x.base}/api/files/img1/preview`, {
    headers: { authorization: 'Bearer good' },
  });
  assert.equal(bad.status, 415);
  const good = await sharp({
    create: { width: 12, height: 9, channels: 3, background: 'red' },
  })
    .png()
    .toBuffer();
  await fs.writeFile(x.filePath, good);
  const responses = await Promise.all(
    Array.from({ length: 4 }, () =>
      fetch(`${x.base}/api/files/img1/preview`, {
        headers: { authorization: 'Bearer good' },
      }),
    ),
  );
  assert.ok(responses.every((response) => response.status === 200));
  const cache = await fs.readFile(
    path.join(x.dir, 'previews', 'img1-thumb.webp'),
  );
  assert.ok(cache.length > 20);
  assert.equal((await sharp(cache).metadata()).format, 'webp');
});
