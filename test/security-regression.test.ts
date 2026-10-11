import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createLanServer } from '../server/app.js';

async function server(publicUrl?: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-sec-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    publicUrl,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  return {
    dir,
    lan,
    base,
    close: async () => {
      await lan.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('未登录不能上传文件、读取历史或下载文件', async (t) => {
  const x = await server();
  t.after(x.close);
  assert.equal((await fetch(`${x.base}/api/messages`)).status, 401);
  assert.equal((await fetch(`${x.base}/api/files/nope`)).status, 401);
  const form = new FormData();
  form.append('file', new Blob(['x']), 'x.txt');
  assert.equal(
    (await fetch(`${x.base}/api/files?to=all`, { method: 'POST', body: form }))
      .status,
    401,
  );
});

test('恶意 Host 不能访问本机管理 API', async (t) => {
  const x = await server();
  t.after(x.close);
  const status = await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: x.lan.getPort(),
        path: '/api/host',
        headers: { host: 'evil.example', 'x-linchuan-host': '1' },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('本机 HTTP Cookie 不带 Secure，公网 HTTPS Cookie 带 Secure', async (t) => {
  const local = await server();
  t.after(local.close);
  const localJoin = await fetch(`${local.base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'local',
      name: 'local',
      type: 'computer',
    }),
  });
  assert.ok(!(localJoin.headers.get('set-cookie') ?? '').includes('; Secure'));
  const publicServer = await server('https://transfer.example.test');
  t.after(publicServer.close);
  const body = JSON.stringify({
    code: '123456',
    deviceId: 'public',
    name: 'public',
    type: 'computer',
  });
  const publicCookie = await new Promise<string>((resolve, reject) => {
    const parsed = new URL(publicServer.base);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: '/api/join',
        method: 'POST',
        headers: {
          host: 'transfer.example.test',
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        response.once('end', () =>
          resolve(String(response.headers['set-cookie']?.[0] ?? '')),
        );
      },
    );
    request.once('error', reject);
    request.end(body);
  });
  assert.ok(publicCookie.includes('; Secure'));
});

test('错误连接码达到每 IP 限额后返回 429，正确码可在独立实例加入', async (t) => {
  const x = await server();
  t.after(x.close);
  for (let i = 0; i < 20; i++) {
    const response = await fetch(`${x.base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '000000',
        deviceId: `bad-${i}`,
        name: 'bad',
        type: 'computer',
      }),
    });
    assert.equal(response.status, 401);
  }
  const limited = await fetch(`${x.base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '000000',
      deviceId: 'bad-final',
      name: 'bad',
      type: 'computer',
    }),
  });
  assert.equal(limited.status, 429);
  const clean = await server();
  t.after(clean.close);
  const valid = await fetch(`${clean.base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'good',
      name: 'good',
      type: 'computer',
    }),
  });
  assert.equal(valid.status, 200);
});

test('连接码累计错误跨 IP 和重启保持锁定，仅本机刷新后恢复', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-join-guard-'));
  const first = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await first.start();
  const base = `http://127.0.0.1:${first.getPort()}`;
  const join = (code: string, address: string, id: string) =>
    new Promise<number>((resolve, reject) => {
      const body = JSON.stringify({
        code,
        deviceId: id,
        name: id,
        type: 'computer',
      });
      const request = http.request(
        {
          hostname: '127.0.0.1',
          localAddress: address,
          port: first.getPort(),
          path: '/api/join',
          method: 'POST',
          headers: {
            host: `127.0.0.1:${first.getPort()}`,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
          },
        },
        (response) => {
          response.resume();
          response.once('end', () => resolve(response.statusCode ?? 0));
        },
      );
      request.once('error', reject);
      request.end(body);
    });
  t.after(async () => {
    await first.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const originalJoin = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'original',
      name: 'original',
      type: 'computer',
    }),
  });
  assert.equal(originalJoin.status, 200);
  const originalToken = (await originalJoin.json()).token as string;
  for (let i = 0; i < 20; i++)
    assert.equal(
      await join('000000', i % 2 ? '127.0.0.2' : '127.0.0.1', `bad-${i}`),
      401,
    );
  const locked = await fetch(`${base}/api/host`, {
    headers: { host: `localhost:${first.getPort()}`, 'x-linchuan-host': '1' },
  });
  assert.equal(locked.status, 200);
  assert.equal((await locked.json()).joinLocked, true);
  const old = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '000000',
      deviceId: 'old',
      name: 'old',
      type: 'computer',
    }),
  });
  assert.equal(old.status, 429);
  await first.close();
  const second = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await second.start();
  const secondBase = `http://127.0.0.1:${second.getPort()}`;
  const oldSession = await fetch(`${secondBase}/api/session`, {
    headers: { authorization: `Bearer ${originalToken}` },
  });
  assert.equal(oldSession.status, 200);
  const hostCall = (route: string, host: string) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const request = http.request(
        {
          hostname: '127.0.0.1',
          port: second.getPort(),
          path: route,
          method: 'POST',
          headers: { host, 'x-linchuan-host': '1' },
        },
        (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.once('end', () =>
            resolve({
              status: response.statusCode ?? 0,
              body: Buffer.concat(chunks).toString(),
            }),
          );
        },
      );
      request.once('error', reject);
      request.end();
    });
  const stillLocked = await fetch(`${secondBase}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'new',
      name: 'new',
      type: 'computer',
    }),
  });
  assert.equal(stillLocked.status, 429);
  const remoteRefresh = await hostCall(
    '/api/host/code',
    `evil.example:${second.getPort()}`,
  );
  assert.equal(remoteRefresh.status, 403);
  const refreshed = await hostCall(
    '/api/host/code',
    `localhost:${second.getPort()}`,
  );
  assert.equal(refreshed.status, 200);
  const newCode = (JSON.parse(refreshed.body) as { code: string }).code;
  assert.match(newCode, /^\d{6}$/);
  const joined = await fetch(`${secondBase}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: newCode,
      deviceId: 'new',
      name: 'new',
      type: 'computer',
    }),
  });
  assert.equal(joined.status, 200);
  await second.close();
});

test('不完整 JSON 请求按绝对 body 截止时间断开，正常请求仍可用', async (t) => {
  const x = await server();
  await x.lan.close();
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: x.dir,
    joinCode: '123456',
    jsonBodyTimeoutMs: 50,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  t.after(async () => {
    await lan.close();
    await fs.rm(x.dir, { recursive: true, force: true });
  });
  const timedOut = await new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        hostname: '127.0.0.1',
        port: lan.getPort(),
        path: '/api/join',
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': 20 },
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.write('{"code":');
  });
  assert.equal(timedOut, 408);
  const healthy = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'healthy',
      name: 'healthy',
      type: 'computer',
    }),
  });
  assert.equal(healthy.status, 200);
});

test('并发分块预留分别保护物理磁盘和逻辑配额', async (t) => {
  const directories: string[] = [];
  t.after(async () => {
    await Promise.all(
      directories.map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
  for (const scenario of [
    {
      name: 'physical',
      free: 257n * 1024n ** 2n,
      maxStorageBytes: Number.MAX_SAFE_INTEGER,
      expectedError: '服务电脑的磁盘空间不足',
    },
    {
      name: 'logical',
      free: 512n * 1024n ** 2n,
      maxStorageBytes: 1024 * 1024,
      expectedError: '暂存空间不足',
    },
  ]) {
    const dir = await fs.mkdtemp(
      path.join(os.tmpdir(), `linchuan-${scenario.name}-guard-`),
    );
    directories.push(dir);
    const lan = createLanServer({
      port: 0,
      host: '127.0.0.1',
      dataDir: dir,
      joinCode: '123456',
      maxFileBytes: 1024 * 1024,
      maxStorageBytes: scenario.maxStorageBytes,
      diskStatfs: async () => ({ bavail: scenario.free, bsize: 1n }),
    });
    await lan.start();
    try {
      const base = `http://127.0.0.1:${lan.getPort()}`;
      const join = async (id: string) => {
        const response = await fetch(`${base}/api/join`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            code: '123456',
            deviceId: id,
            name: id,
            type: 'computer',
          }),
        });
        assert.equal(response.status, 200);
        return (await response.json()).token as string;
      };
      const [firstToken, secondToken] = await Promise.all([
        join(`${scenario.name}-a`),
        join(`${scenario.name}-b`),
      ]);
      const start = (authorization: string, clientId: string) =>
        fetch(`${base}/api/transfers`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${authorization}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            name: `${clientId}.bin`,
            size: 1024 * 1024,
            mime: 'application/octet-stream',
            to: 'all',
            clientId,
          }),
        });
      const results = await Promise.all([
        start(firstToken, `${scenario.name}-a-transfer`),
        start(secondToken, `${scenario.name}-b-transfer`),
      ]);
      assert.deepEqual(
        results.map((response) => response.status).sort((a, b) => a - b),
        [201, 413],
      );
      const successfulIndex = results.findIndex(
        (response) => response.status === 201,
      );
      const failedIndex = 1 - successfulIndex;
      const successful = results[successfulIndex];
      const failed = results[failedIndex];
      const successfulTransfer = (await successful.json()) as { id: string };
      assert.match(await failed.text(), new RegExp(scenario.expectedError));
      const successfulToken = successfulIndex === 0 ? firstToken : secondToken;
      const failedToken = failedIndex === 0 ? firstToken : secondToken;
      const cancelled = await fetch(
        `${base}/api/transfers/${successfulTransfer.id}`,
        {
          method: 'DELETE',
          headers: { authorization: `Bearer ${successfulToken}` },
        },
      );
      assert.equal(cancelled.status, 204);
      const retry = await start(failedToken, `${scenario.name}-retry`);
      assert.equal(retry.status, 201);
    } finally {
      await lan.close();
    }
  }
});

test('legacy 上传写入期间磁盘水位下降会清理半成品并允许后续上传', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-disk-drop-'));
  let statfsCalls = 0;
  let low = false;
  let recovered = false;
  let maxObservedBytes = 0;
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    maxFileBytes: 4 * 1024 * 1024,
    diskStatfs: async () => {
      statfsCalls += 1;
      const names = await fs.readdir(path.join(dir, 'uploads')).catch(() => []);
      for (const name of names.filter((entry) => entry.endsWith('.part'))) {
        const stat = await fs.stat(path.join(dir, 'uploads', name));
        maxObservedBytes = Math.max(maxObservedBytes, stat.size);
      }
      if (!recovered && statfsCalls >= 3) low = true;
      return {
        bavail: low && !recovered ? 256n * 1024n ** 2n : 257n * 1024n ** 2n,
        bsize: 1n,
      };
    },
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  t.after(async () => {
    await lan.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const joined = await fetch(`${base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'disk-drop',
      name: 'disk-drop',
      type: 'computer',
    }),
  });
  const token = (await joined.json()).token as string;
  const form = new FormData();
  form.append(
    'file',
    new Blob([Buffer.alloc(2 * 1024 * 1024, 7)]),
    'dynamic.bin',
  );
  const rejected = await fetch(`${base}/api/files?to=all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: form,
  });
  assert.equal(rejected.status, 413);
  assert.ok(statfsCalls >= 3);
  assert.ok(maxObservedBytes > 0);
  const uploads = await fs.readdir(path.join(dir, 'uploads'));
  assert.equal(uploads.filter((name) => name.endsWith('.part')).length, 0);
  recovered = true;
  low = false;
  const retryForm = new FormData();
  retryForm.append(
    'file',
    new Blob([Buffer.alloc(2 * 1024 * 1024, 7)]),
    'dynamic.bin',
  );
  const retry = await fetch(`${base}/api/files?to=all`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: retryForm,
  });
  assert.equal(retry.status, 201);
  assert.ok(statfsCalls >= 4);
});

test('同源 WebSocket 可使用 HttpOnly 会话 Cookie，错误来源仍被拒绝', async (t) => {
  const x = await server();
  t.after(x.close);
  const joined = await fetch(`${x.base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'cookie-ws',
      name: 'cookie-ws',
      type: 'computer',
    }),
  });
  assert.equal(joined.status, 200);
  const cookie = joined.headers.get('set-cookie');
  assert.ok(cookie);
  const ws = new WebSocket(`${x.base.replace('http', 'ws')}/ws`, {
    headers: { Cookie: cookie!.split(';', 1)[0], Origin: x.base },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  ws.close();
  await new Promise<void>((resolve) => ws.once('close', () => resolve()));

  const denied = new WebSocket(`${x.base.replace('http', 'ws')}/ws`, {
    headers: {
      Cookie: cookie!.split(';', 1)[0],
      Origin: 'http://evil.example',
    },
  });
  await new Promise<void>((resolve) => {
    denied.once('error', () => resolve());
    denied.once('close', () => resolve());
  });
  assert.equal(denied.readyState, WebSocket.CLOSED);
});
