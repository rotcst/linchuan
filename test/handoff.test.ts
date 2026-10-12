import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLanServer } from '../server/app.js';

const json = async (url: string, init?: RequestInit) => {
  const response = await fetch(url, init);
  const body = await response.text();
  let value: unknown = null;
  try {
    value = body ? JSON.parse(body) : null;
  } catch {
    /* binary */
  }
  return { response, value };
};
const keyMaterial = () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: pair.publicKey
      .export({ type: 'spki', format: 'der' })
      .toString('base64'),
  };
};
const wsOnline = (base: string, token: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws?token=${token}`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });

const waitForPart = async (file: string, expectedSize: number | null) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    const stat = await fs.stat(file).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if ((stat?.size ?? null) === expectedSize) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`移交分块未达到预期大小 ${expectedSize}`);
};

test('handoff full server protocol freezes, exports, commits and survives restart', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-handoff-`);
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    handoffTtlMs: 2000,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const hostHeaders = { host: '127.0.0.1', 'x-linchuan-host': '1' };
  const join = async (id: string, type = 'computer') =>
    (
      await json(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: '123456', deviceId: id, name: id, type }),
      })
    ).value as { token: string; device: { id: string } };
  const source = await join('source');
  const target = await join('target');
  const phone = await join('phone', 'phone');
  const sourceWs = await wsOnline(base, source.token);
  const targetWs = await wsOnline(base, target.token);
  const phoneWs = await wsOnline(base, phone.token);
  const phoneMessages: Array<{ type?: string; browserTicket?: string }> = [];
  phoneWs.on('message', (data) => {
    try {
      phoneMessages.push(
        JSON.parse(data.toString()) as {
          type?: string;
          browserTicket?: string;
        },
      );
    } catch {
      /* unrelated socket payload */
    }
  });
  let lanClosed = false;
  t.after(async () => {
    sourceWs.terminate();
    targetWs.terminate();
    phoneWs.terminate();
    if (!lanClosed) {
      lanClosed = true;
      await lan.close().catch(() => {});
    }
  });
  const key = keyMaterial();
  const capability = {
    publicKey: key.publicKey,
    version: '1.2.0',
    receivePort: 40000,
    lanUrls: Array.from(
      { length: 8 },
      (_, index) => `http://192.168.1.${index + 2}:40000`,
    ),
  };
  assert.equal(
    (
      await json(`${base}/api/native/capabilities`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(capability),
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await json(`${base}/api/host/owner`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: source.device.id }),
      })
    ).response.status,
    200,
  );
  const transfer = (
    await json(`${base}/api/transfers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${source.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'nine.bin',
        size: 9 * 1024 * 1024,
        mime: 'application/octet-stream',
        to: phone.device.id,
        clientId: 'handoff-file',
      }),
    })
  ).value as { id: string };
  assert.equal(
    (
      await json(`${base}/api/host/handoff/prepare`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ targetDeviceId: target.device.id }),
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await fetch(`${base}/api/transfers/${transfer.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${source.token}` },
      })
    ).status,
    204,
  );
  const file = Buffer.alloc(9 * 1024 * 1024, 7);
  const created = (
    await json(`${base}/api/transfers`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${source.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'nine.bin',
        size: file.length,
        mime: 'application/octet-stream',
        to: phone.device.id,
        clientId: 'handoff-file-2',
      }),
    })
  ).value as { id: string; chunkBytes: number };
  for (let offset = 0; offset < file.length; offset += created.chunkBytes) {
    const chunk = file.subarray(
      offset,
      Math.min(offset + created.chunkBytes, file.length),
    );
    assert.equal(
      (
        await fetch(`${base}/api/transfers/${created.id}?offset=${offset}`, {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${source.token}`,
            'content-length': String(chunk.length),
          },
          body: chunk,
        })
      ).status,
      200,
    );
  }
  assert.equal(
    (
      await fetch(`${base}/api/transfers/${created.id}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${source.token}` },
      })
    ).status,
    201,
  );
  const prepared = (
    await json(`${base}/api/host/handoff/prepare`, {
      method: 'POST',
      headers: { ...hostHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ targetDeviceId: target.device.id }),
    })
  ).value as { id: string };
  assert.equal(
    (
      await json(`${base}/api/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${source.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: phone.device.id,
          text: 'frozen',
          clientId: 'frozen',
        }),
      })
    ).response.status,
    409,
  );
  const exported = (
    await json(`${base}/api/host/handoff/export`, { headers: hostHeaders })
  ).value as {
    files: Array<{ index: number; path: string; size: number; sha256: string }>;
    totalBytes: number;
  };
  assert.ok(exported.files.some((entry) => entry.path.startsWith('uploads/')));
  assert.ok(exported.totalBytes >= file.length);
  const chunk = Buffer.alloc(32, 9);
  const partPath = path.join(
    dir,
    `.handoff-${prepared.id}`,
    'chunks',
    '0.part',
  );
  const partialRequest = http.request({
    hostname: new URL(base).hostname,
    port: Number(new URL(base).port),
    path: '/api/host/handoff/chunks/0',
    method: 'PUT',
    headers: { ...hostHeaders, 'content-length': chunk.length },
  });
  partialRequest.on('error', () => {});
  const partialClosed = new Promise<void>((resolve) =>
    partialRequest.once('close', resolve),
  );
  try {
    partialRequest.write(chunk.subarray(0, 8));
    await waitForPart(partPath, 8);
    assert.deepEqual(await fs.readFile(partPath), chunk.subarray(0, 8));
  } finally {
    partialRequest.destroy();
  }
  await partialClosed;
  await waitForPart(partPath, null);
  assert.equal(
    (
      await fetch(`${base}/api/host/handoff/chunks/0`, {
        method: 'PUT',
        headers: { ...hostHeaders, 'content-length': String(chunk.length) },
        body: chunk,
      })
    ).status,
    204,
  );
  const envelopeJson = JSON.stringify({
    wrappedKey: 'x',
    noncePrefix: 'AAAAAAAAAAA=',
    credentialCipher: null,
  });
  assert.equal(
    (
      await fetch(`${base}/api/host/handoff/seal`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({
          envelopeJson,
          totalChunks: 1,
          totalBytes: chunk.length,
          sha256: crypto.createHash('sha256').update(chunk).digest('hex'),
        }),
      })
    ).status,
    204,
  );
  const downloadedChunk = await fetch(`${base}/api/handoff/chunks/0`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  assert.equal(downloadedChunk.status, 200);
  assert.deepEqual(Buffer.from(await downloadedChunk.arrayBuffer()), chunk);
  const exportedPayloads = new Map<number, Buffer>();
  await fs.stat(path.join(dir, `.handoff-${prepared.id}`, 'linchuan.sqlite'));
  for (const entry of exported.files) {
    const response = await fetch(
      `${base}/api/host/handoff/file/${entry.index}`,
      { headers: hostHeaders },
    );
    if (response.status !== 200)
      assert.fail(
        `导出文件 ${entry.index}:${entry.path} 下载失败 ${await response.text()}`,
      );
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.length, entry.size);
    assert.equal(
      crypto.createHash('sha256').update(body).digest('hex'),
      entry.sha256,
    );
    exportedPayloads.set(entry.index, body);
  }
  const inbox = (
    await json(`${base}/api/handoff/inbox`, {
      headers: { authorization: `Bearer ${target.token}` },
    })
  ).value as { offer: { id: string; state: string } };
  assert.equal(inbox.offer.id, prepared.id);
  assert.equal(inbox.offer.state, 'sealed');
  assert.equal(
    (
      await json(`${base}/api/handoff/ready`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          id: prepared.id,
          urls: ['http://192.168.1.99:40000/'],
        }),
      })
    ).response.status,
    400,
  );
  const ready = await json(`${base}/api/handoff/ready`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${target.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      id: prepared.id,
      urls: [...capability.lanUrls, 'http://192.168.1.250:40000'],
    }),
  });
  assert.equal(ready.response.status, 200);
  assert.equal(
    (
      await json(`${base}/api/host/handoff/commit`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ id: prepared.id }),
      })
    ).response.status,
    200,
  );
  await new Promise((resolve) => setTimeout(resolve, 25));
  const phoneTicket = phoneMessages.find(
    (value) => value.browserTicket,
  )?.browserTicket;
  assert.ok(
    phoneTicket,
    `手机移交票据未收到，消息类型=${phoneMessages.map((value) => value.type).join(',')}`,
  );
  assert.equal(
    (await fetch(`${base}/api/network/probe?nonce=${'a'.repeat(64)}`)).status,
    410,
  );
  assert.equal(
    (
      await json(`${base}/api/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${source.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: phone.device.id,
          text: 'retired',
          clientId: 'retired',
        }),
      })
    ).response.status,
    409,
  );
  assert.equal(
    (
      await json(`${base}/api/handoff/status?id=${prepared.id}`, {
        headers: { authorization: `Bearer ${target.token}` },
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await json(`${base}/api/handoff/activated`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ id: prepared.id }),
      })
    ).response.status,
    200,
  );
  await assert.rejects(
    fs.stat(path.join(dir, `.handoff-${prepared.id}`)),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
  const migratedDir = await fs.mkdtemp(
    `${os.tmpdir()}\\linchuan-handoff-target-`,
  );
  let migrated: ReturnType<typeof createLanServer> | undefined;
  t.after(async () => {
    await migrated?.close().catch(() => {});
    await fs.rm(migratedDir, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(migratedDir, 'uploads'), { recursive: true });
  for (const entry of exported.files) {
    const targetPath = path.join(migratedDir, entry.path);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    const body = exportedPayloads.get(entry.index);
    assert.ok(body);
    assert.equal(body.length, entry.size);
    assert.equal(
      crypto.createHash('sha256').update(body).digest('hex'),
      entry.sha256,
    );
    await fs.writeFile(targetPath, body);
  }
  migrated = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: migratedDir,
    joinCode: '123456',
  });
  await migrated.start();
  const migratedBase = `http://127.0.0.1:${migrated.getPort()}`;
  const restored = await json(`${migratedBase}/api/network/browser-restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: phoneTicket }),
  });
  assert.equal(restored.response.status, 200);
  assert.equal(
    (restored.value as { device: { id: string } }).device.id,
    phone.device.id,
  );
  assert.equal(
    (
      await json(`${migratedBase}/api/network/browser-restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: phoneTicket }),
      })
    ).response.status,
    401,
  );
  await migrated.close();
  migrated = undefined;
  await lan.close();
  lanClosed = true;
  const restarted = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await restarted.start();
  t.after(async () => {
    await restarted.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const status = (
    await json(
      `http://127.0.0.1:${restarted.getPort()}/api/handoff/status?id=${prepared.id}`,
      { headers: { authorization: `Bearer ${target.token}` } },
    )
  ).value as { state: string; activated: boolean };
  assert.equal(status.state, 'committed');
  assert.equal(status.activated, true);
});

test('handoff abort and expiry restore writes and remove staging', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-handoff-recovery-`);
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '654321',
    handoffTtlMs: 200,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const hostHeaders = { host: '127.0.0.1', 'x-linchuan-host': '1' };
  const join = async (id: string) =>
    (
      await json(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: '654321',
          deviceId: id,
          name: id,
          type: 'computer',
        }),
      })
    ).value as { token: string; device: { id: string } };
  const source = await join('source');
  const target = await join('target');
  const sourceWs = await wsOnline(base, source.token);
  const targetWs = await wsOnline(base, target.token);
  t.after(async () => {
    sourceWs.terminate();
    targetWs.terminate();
    await lan.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const key = keyMaterial();
  assert.equal(
    (
      await json(`${base}/api/native/capabilities`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${target.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          publicKey: key.publicKey,
          version: '1.2.0',
          receivePort: 40000,
          lanUrls: ['http://192.168.1.2:40000/'],
        }),
      })
    ).response.status,
    200,
  );
  assert.equal(
    (
      await json(`${base}/api/host/owner`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: source.device.id }),
      })
    ).response.status,
    200,
  );
  const prepared = (
    await json(`${base}/api/host/handoff/prepare`, {
      method: 'POST',
      headers: { ...hostHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ targetDeviceId: target.device.id }),
    })
  ).value as { id: string };
  const slowChunk = Buffer.alloc(32, 7);
  const slowUpload = new Promise<number>((resolve) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: Number(new URL(base).port),
        path: '/api/host/handoff/chunks/0',
        method: 'PUT',
        headers: { ...hostHeaders, 'content-length': slowChunk.length },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', () => resolve(0));
    request.write(slowChunk.subarray(0, 8));
    setTimeout(() => request.end(slowChunk.subarray(8)), 300);
  });
  await waitForPart(
    path.join(dir, `.handoff-${prepared.id}`, 'chunks', '0.part'),
    8,
  );
  const concurrent = await fetch(`${base}/api/host/handoff/chunks/0`, {
    method: 'PUT',
    headers: { ...hostHeaders, 'content-length': String(slowChunk.length) },
    body: slowChunk,
  });
  assert.notEqual(concurrent.status, 204);
  assert.equal(await slowUpload, 204);
  const preserved = await fetch(`${base}/api/handoff/chunks/0`, {
    headers: { authorization: `Bearer ${target.token}` },
  });
  assert.deepEqual(Buffer.from(await preserved.arrayBuffer()), slowChunk);
  assert.equal(
    (
      await json(`${base}/api/host/handoff/abort`, {
        method: 'POST',
        headers: { ...hostHeaders, 'content-type': 'application/json' },
        body: JSON.stringify({ id: prepared.id }),
      })
    ).response.status,
    204,
  );
  assert.equal(
    (
      await json(`${base}/api/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${source.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: target.device.id,
          text: 'after-abort',
          clientId: 'after-abort',
        }),
      })
    ).response.status,
    201,
  );
  const expired = (
    await json(`${base}/api/host/handoff/prepare`, {
      method: 'POST',
      headers: { ...hostHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ targetDeviceId: target.device.id }),
    })
  ).value as { id: string };
  await new Promise((resolve) => setTimeout(resolve, 320));
  assert.equal(
    (
      await json(`${base}/api/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${source.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: target.device.id,
          text: 'after-expiry',
          clientId: 'after-expiry',
        }),
      })
    ).response.status,
    201,
  );
  await assert.rejects(
    fs.stat(path.join(dir, `.handoff-${expired.id}`)),
    (error: NodeJS.ErrnoException) => error.code === 'ENOENT',
  );
});
