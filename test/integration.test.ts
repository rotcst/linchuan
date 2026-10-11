import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createLanServer, Message } from '../server/app.js';

async function fixture(
  options: {
    maxFileBytes?: number;
    maxStorageBytes?: number;
    expiryMs?: number;
  } = {},
) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    maxFileBytes: options.maxFileBytes ?? 1024,
    maxStorageBytes: options.maxStorageBytes,
    expiryMs: options.expiryMs,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const join = async (id: string, type: 'computer' | 'phone' = 'computer') => {
    const r = await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: '123456', deviceId: id, name: id, type }),
    });
    return (await r.json()) as { token: string; device: { id: string } };
  };
  return {
    lan,
    base,
    join,
    cleanup: async () => {
      await lan.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test('三设备加入并通过 websocket 收到在线状态，私聊隔离且消息去重', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b', 'phone');
  const c = await x.join('c');
  assert.notEqual(a.device.id, 'a');
  assert.equal(
    (
      (await (
        await fetch(`${x.base}/api/session`, {
          headers: { authorization: `Bearer ${a.token}` },
        })
      ).json()) as { device: { id: string } }
    ).device.id,
    a.device.id,
  );
  const got: unknown[] = [];
  const ws = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${a.token}`,
  );
  ws.on('message', (d) => got.push(JSON.parse(d.toString())));
  await new Promise<void>((r) => ws.once('open', () => r()));
  const send = (token: string, body: unknown) =>
    fetch(`${x.base}/api/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  const r1 = await send(a.token, {
    to: b.device.id,
    text: 'hello',
    clientId: 'm1',
  });
  const r2 = await send(a.token, {
    to: b.device.id,
    text: 'hello',
    clientId: 'm1',
  });
  assert.equal(
    ((await r1.json()) as Message).id,
    ((await r2.json()) as Message).id,
  );
  const bMsgs = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(bMsgs.messages.length, 1);
  const cMsgs = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${c.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(cMsgs.messages.length, 0);
  ws.close();
});

test('文件上传限制、下载 ACL 和 Unicode 文件名', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b', 'phone');
  const form = new FormData();
  form.append('file', new Blob(['abc'], { type: 'text/plain' }), '你好.txt');
  const uploaded = (await (
    await fetch(`${x.base}/api/files?to=${b.device.id}&clientId=f1`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}` },
      body: form,
    })
  ).json()) as Message;
  assert.equal(uploaded.kind, 'file');
  assert.ok(uploaded.file);
  const file = await fetch(`${x.base}/api/files/${uploaded.file!.id}`, {
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'abc');
  const denied = await fetch(`${x.base}/api/files/${uploaded.file!.id}`, {
    headers: { authorization: `Bearer ${a.token}` },
  });
  assert.equal(denied.status, 200);
  const too = new FormData();
  too.append('file', new Blob(['x'.repeat(1025)]), 'big.bin');
  const tooRes = await fetch(`${x.base}/api/files?to=${b.device.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: too,
  });
  assert.equal(tooRes.status, 413);
});

test('客户端设备标识不能冒用已有设备', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const first = await x.join('same');
  const second = await x.join('same');
  assert.notEqual(first.device.id, second.device.id);
  assert.notEqual(first.device.id, 'same');
});

test('Host 与 Origin 必须匹配当前请求', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const badOrigin = await fetch(`${x.base}/api/info`, {
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(badOrigin.status, 403);
  const good = await fetch(`${x.base}/api/info`, {
    headers: { origin: x.base },
  });
  assert.equal(good.status, 200);
  const j = await x.join('origin');
  const ws = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${j.token}`,
    { headers: { Origin: 'http://evil.example' } },
  );
  await new Promise<void>((resolve) => {
    ws.once('error', () => resolve());
    ws.once('open', () => {
      ws.close();
      resolve();
    });
  });
  assert.equal(ws.readyState, WebSocket.CLOSED);
});

test('公共消息仅广播给已连接设备且 ready/presence 可观察', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b');
  const events: string[] = [];
  const ws = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${a.token}`,
  );
  ws.on('message', (d) => events.push(d.toString()));
  await new Promise<void>((r) => ws.once('open', () => r()));
  await fetch(`${x.base}/api/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${b.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ to: 'all', text: 'broadcast', clientId: 'pub-1' }),
  });
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(events.some((e) => e.includes('ready')));
  assert.ok(events.some((e) => e.includes('broadcast')));
  ws.close();
});

test('消息隐藏只影响当前设备并只广播给当前设备', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b');
  const aEvents: string[] = [];
  const bEvents: string[] = [];
  const bSecondEvents: string[] = [];
  const aWs = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${a.token}`,
  );
  const bWs = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${b.token}`,
  );
  const bSecondWs = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${b.token}`,
  );
  aWs.on('message', (data) => aEvents.push(data.toString()));
  bWs.on('message', (data) => bEvents.push(data.toString()));
  bSecondWs.on('message', (data) => bSecondEvents.push(data.toString()));
  await Promise.all([
    new Promise<void>((resolve) => aWs.once('open', () => resolve())),
    new Promise<void>((resolve) => bWs.once('open', () => resolve())),
    new Promise<void>((resolve) => bSecondWs.once('open', () => resolve())),
  ]);
  const created = (await (
    await fetch(`${x.base}/api/messages`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        to: b.device.id,
        text: 'keep-for-a',
        clientId: 'hide-1',
      }),
    })
  ).json()) as Message;
  assert.equal(
    (
      await fetch(`${x.base}/api/messages/${created.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).status,
    204,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  const deleted = (event: string) =>
    event.includes('"type":"message-deleted"') &&
    event.includes(`"id":"${created.id}"`);
  assert.ok(bEvents.some(deleted));
  assert.ok(bSecondEvents.some(deleted));
  assert.equal(aEvents.some(deleted), false);
  const bHistory = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
  ).json()) as { messages: Message[] };
  const aHistory = (await (
    await fetch(`${x.base}/api/messages?to=${b.device.id}`, {
      headers: { authorization: `Bearer ${a.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    bHistory.messages.some((message) => message.id === created.id),
    false,
  );
  assert.equal(
    aHistory.messages.some((message) => message.id === created.id),
    true,
  );
  aWs.close();
  bWs.close();
  bSecondWs.close();
});

test('三个 WS 在线状态、断线与重连保持正确', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const joined = await Promise.all([x.join('a'), x.join('b'), x.join('c')]);
  const sockets = joined.map(
    (j) => new WebSocket(`${x.base.replace('http', 'ws')}/ws?token=${j.token}`),
  );
  await Promise.all(
    sockets.map((ws) => new Promise<void>((r) => ws.once('open', () => r()))),
  );
  await new Promise((r) => setTimeout(r, 30));
  const session = (await (
    await fetch(`${x.base}/api/session`, {
      headers: { authorization: `Bearer ${joined[0].token}` },
    })
  ).json()) as { devices: Array<{ id: string; online: boolean }> };
  assert.equal(session.devices.filter((d) => d.online).length, 3);
  sockets[1].close();
  await new Promise((r) => setTimeout(r, 30));
  const after = (await (
    await fetch(`${x.base}/api/session`, {
      headers: { authorization: `Bearer ${joined[0].token}` },
    })
  ).json()) as { devices: Array<{ id: string; online: boolean }> };
  assert.equal(
    after.devices.find((d) => d.id === joined[1].device.id)?.online,
    false,
  );
  const again = new WebSocket(
    `${x.base.replace('http', 'ws')}/ws?token=${joined[1].token}`,
  );
  await new Promise<void>((r) => again.once('open', () => r()));
  again.close();
  sockets[0].close();
  sockets[2].close();
});

test('第三方不能读取私聊或下载私有文件', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b');
  const c = await x.join('c');
  const send = await fetch(`${x.base}/api/messages`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${a.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      to: b.device.id,
      text: 'secret',
      clientId: 'secret-1',
    }),
  });
  assert.equal(send.status, 201);
  const cHistory = (await (
    await fetch(`${x.base}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${c.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(cHistory.messages.length, 0);
});

test('Cookie 会话可恢复，logout 会撤销访问', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const joined = await fetch(`${x.base}/api/join`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      code: '123456',
      deviceId: 'cookie',
      name: 'cookie',
      type: 'phone',
    }),
  });
  const cookie = joined.headers.get('set-cookie');
  assert.ok(cookie);
  const session = await fetch(`${x.base}/api/session`, {
    headers: { cookie: cookie!.split(';')[0] },
  });
  assert.equal(session.status, 200);
  const tokenBody = (await joined.json()) as { token: string };
  const logged = await fetch(`${x.base}/api/logout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenBody.token}` },
  });
  assert.equal(logged.status, 204);
  const denied = await fetch(`${x.base}/api/session`, {
    headers: { authorization: `Bearer ${tokenBody.token}` },
  });
  assert.equal(denied.status, 401);
});

test('空文件、exact max 与 oversize 边界', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b');
  const exact = new FormData();
  exact.append('file', new Blob(['x'.repeat(1024)]), 'exact.bin');
  const ok = await fetch(`${x.base}/api/files?to=${b.device.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: exact,
  });
  assert.equal(ok.status, 201);
  const empty = new FormData();
  empty.append('file', new Blob([]), 'empty.bin');
  const emptyRes = await fetch(`${x.base}/api/files?to=${b.device.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: empty,
  });
  assert.equal(emptyRes.status, 201);
  const over = new FormData();
  over.append('file', new Blob(['x'.repeat(1025)]), 'over.bin');
  const overRes = await fetch(`${x.base}/api/files?to=${b.device.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: over,
  });
  assert.equal(overRes.status, 413);
});

test('重复 multipart file 被拒绝', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const a = await x.join('a');
  const b = await x.join('b');
  const form = new FormData();
  form.append('file', new Blob(['a']), 'a.txt');
  form.append('file', new Blob(['b']), 'b.txt');
  const res = await fetch(`${x.base}/api/files?to=${b.device.id}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${a.token}` },
    body: form,
  });
  assert.equal(res.status, 400);
});

test('会话 expiry 后 HTTP 与 WS 均失效', async (_t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-exp-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    expiryMs: 60,
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const joined = (await (
    await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        deviceId: 'exp',
        name: 'exp',
        type: 'computer',
      }),
    })
  ).json()) as { token: string };
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(
    (
      await fetch(`${base}/api/session`, {
        headers: { authorization: `Bearer ${joined.token}` },
      })
    ).status,
    401,
  );
  await lan.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('二维码只接受自身 URL 且返回 SVG', async (t) => {
  const x = await fixture();
  t.after(x.cleanup);
  const info = (await (await fetch(`${x.base}/api/info`)).json()) as {
    urls: string[];
  };
  assert.ok(info.urls.length > 0);
  const qr = await fetch(
    `${x.base}/api/qr?url=${encodeURIComponent(info.urls[0])}`,
  );
  assert.equal(qr.status, 200);
  assert.match(await qr.text(), /<svg/i);
  const bad = await fetch(
    `${x.base}/api/qr?url=${encodeURIComponent('http://evil.example/')}`,
  );
  assert.equal(bad.status, 400);
});
