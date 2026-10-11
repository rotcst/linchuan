import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createLanServer, Message } from '../server/app.js';

test('createLanServer 关闭后同 dataDir 重启保留 session、消息和文件，默认不按 24h 删除', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-restart-'));
  const first = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  const cleanup: { close?: () => Promise<void> } = {};
  t.after(async () => {
    await cleanup.close?.();
    await first.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await first.start();
  const base = `http://127.0.0.1:${first.getPort()}`;
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
  const a = await join('a');
  const b = await join('b');
  const c = await join('c');
  const send = async (body: unknown) =>
    (await (
      await fetch(`${base}/api/messages`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${a.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
      })
    ).json()) as Message;
  await send({
    to: 'all',
    text: 'public-before-restart',
    clientId: 'public-persist',
  });
  const privateMessage = await send({
    to: b.device.id,
    text: 'private-before-restart',
    clientId: 'private-persist',
  });
  const form = new FormData();
  form.append('file', new Blob(['persistent-bytes']), 'persistent.txt');
  const uploaded = (await (
    await fetch(`${base}/api/files?to=${b.device.id}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}` },
      body: form,
    })
  ).json()) as Message;
  assert.equal(uploaded.kind, 'file');
  await first.close();
  const db = new DatabaseSync(path.join(dir, 'linchuan.sqlite'));
  db.exec('UPDATE messages SET created_at=1; UPDATE files SET created_at=1;');
  db.close();
  const second = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  cleanup.close = () => second.close();
  await second.start();
  const base2 = `http://127.0.0.1:${second.getPort()}`;
  assert.equal(
    (
      await fetch(`${base2}/api/session`, {
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    200,
  );
  const bHistory = (await (
    await fetch(`${base2}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${b.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.ok(bHistory.messages.some((m) => m.id === privateMessage.id));
  const cHistory = (await (
    await fetch(`${base2}/api/messages?to=${a.device.id}`, {
      headers: { authorization: `Bearer ${c.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.equal(
    cHistory.messages.some((m) => m.id === privateMessage.id),
    false,
  );
  const publicHistory = (await (
    await fetch(`${base2}/api/messages`, {
      headers: { authorization: `Bearer ${c.token}` },
    })
  ).json()) as { messages: Message[] };
  assert.ok(
    publicHistory.messages.some((m) => m.clientId === 'public-persist'),
  );
  const file = await fetch(`${base2}/api/files/${uploaded.file!.id}`, {
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(file.status, 200);
  assert.equal(await file.text(), 'persistent-bytes');
});
