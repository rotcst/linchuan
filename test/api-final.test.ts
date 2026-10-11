import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createLanServer, Message } from '../server/app.js';

async function fixture() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-final-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await lan.start();
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
  return {
    dir,
    lan,
    base,
    join,
    close: async () => {
      await lan.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

const requestWithHost = (url: string, headers: Record<string, string>) =>
  new Promise<number>((resolve, reject) => {
    const parsed = new URL(url);
    const request = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        method: 'GET',
        headers,
      },
      (response) => {
        response.resume();
        response.once('end', () => resolve(response.statusCode ?? 0));
      },
    );
    request.once('error', reject);
    request.end();
  });
test('host 控制 API 只接受 loopback + 允许的 Host 标志', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const denied = await fetch(`${x.base}/api/host`);
  assert.equal(denied.status, 403);
  const allowed = await requestWithHost(`${x.base}/api/host`, {
    host: '127.0.0.1',
    'x-linchuan-host': '1',
  });
  assert.notEqual(allowed, 403);
  const host = (await (
    await fetch(`${x.base}/api/host`, {
      headers: { host: '127.0.0.1', 'x-linchuan-host': '1' },
    })
  ).json()) as { localUrl: string };
  assert.equal(host.localUrl, `http://127.0.0.1:${new URL(x.base).port}`);
  const wrong = await requestWithHost(`${x.base}/api/host`, {
    host: 'transfer.example.test',
    'x-linchuan-host': '1',
  });
  assert.equal(wrong, 403);
  const proxy = await requestWithHost(`${x.base}/api/host`, {
    host: '127.0.0.1',
    'x-linchuan-host': '1',
    'x-forwarded-for': '198.51.100.5',
  });
  assert.equal(proxy, 403);
});

test('host API 仅在本机返回实际 loopback、公网入口和通道状态', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-host-url-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    publicUrl: 'https://transfer.example.test',
    hostStatus: () => ({ internet: 'disabled' }),
  });
  await lan.start();
  t.after(async () => {
    await lan.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const response = await fetch(`${base}/api/host`, {
    headers: { host: '127.0.0.1', 'x-linchuan-host': '1' },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    code: '123456',
    joinLocked: false,
    localUrl: `http://127.0.0.1:${lan.getPort()}`,
    publicUrl: 'https://transfer.example.test',
    internet: 'disabled',
  });
});

test('发送方或接收方只隐藏自己的消息，第三方不能隐藏', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const c = await x.join('c');
  const send = (await (
    await fetch(`${x.base}/api/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: b.device.id,
        text: 'delete-me',
        clientId: 'del-1',
      }),
    })
  ).json()) as Message;
  assert.equal(
    (
      await fetch(`${x.base}/api/messages/${send.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${x.base}/api/messages/${send.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${c.token}` },
      })
    ).status,
    404,
  );
  const bHistory = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    bHistory.messages.some((message) => message.id === send.id),
    false,
  );
  const aHistory = (await (
    await fetch(`${x.base}/api/messages?to=${b.device.id}`, {
      headers: { authorization: `Bearer ${a.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    aHistory.messages.some((message) => message.id === send.id),
    true,
  );
  assert.equal(
    (
      await fetch(`${x.base}/api/messages/${send.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    204,
  );
  const retry = await fetch(`${x.base}/api/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${a.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      to: b.device.id,
      text: 'delete-me',
      clientId: 'del-1',
    }),
  });
  assert.equal(retry.status, 410);
});

test('API 分页 beforeId 可读取同毫秒消息且不重复', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  for (let i = 0; i < 4; i++)
    await fetch(`${x.base}/api/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: b.device.id,
        text: `m${i}`,
        clientId: `page-${i}`,
      }),
    });
  const first = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}&limit=2`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
  ).json()) as { messages: Message[]; before?: number; beforeId?: string };
  assert.ok(first.messages.length > 0);
  if (first.before !== undefined && first.beforeId) {
    const second = (await (
      await fetch(
        `${x.base}/api/messages?to=${a.device.id}&before=${first.before}&beforeId=${encodeURIComponent(first.beforeId)}`,
        { headers: { authorization: `Bearer ${b.token}` } },
      )
    ).json()) as { messages: Message[] };
    assert.equal(
      second.messages.some((m) => first.messages.some((f) => f.id === m.id)),
      false,
    );
  }
});

test('隐藏文件消息不删除原文件，另一方仍可下载', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const form = new FormData();
  form.append('file', new Blob(['delete-file']), 'delete.txt');
  const message = (await (
    await fetch(`${x.base}/api/files?to=${b.device.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}` },
      body: form,
    })
  ).json()) as Message;
  assert.ok(message.file);
  assert.equal(
    (
      await fetch(`${x.base}/api/messages/${message.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    204,
  );
  assert.equal(
    (
      await fetch(`${x.base}/api/files/${message.file!.id}`, {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).status,
    200,
  );
});
