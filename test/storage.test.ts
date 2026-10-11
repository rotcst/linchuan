import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage, sessionHash } from '../server/storage.js';
import type { Device, Message } from '../server/app.js';

const device = (id: string): Device => ({
  id,
  name: id,
  type: 'computer',
  online: true,
  lastSeen: Date.now(),
});

test('deleteDevice 保护接收方引用，孤立设备可删除', async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-storage-device-'),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Storage(dir);
  store.saveDevice(device('sender'));
  store.saveDevice(device('receiver'));
  store.saveDevice(device('empty'));
  store.saveMessage(text('received', 'sender', 'receiver', Date.now()));
  store.deleteDevice('receiver');
  store.deleteDevice('empty');
  assert.ok(store.loadDevices().some((item) => item.id === 'receiver'));
  assert.equal(
    store.loadDevices().some((item) => item.id === 'empty'),
    false,
  );
  store.close();
});
const text = (
  id: string,
  from: string,
  to: string,
  createdAt: number,
): Message => ({
  id,
  from,
  to,
  text: id,
  createdAt,
  kind: 'text',
  clientId: `client-${id}`,
});

test('Storage 重启后恢复设备、session hash、消息、文件和私聊分页', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-storage-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const first = new Storage(dir);
  first.saveDevice(device('a'));
  first.saveDevice(device('b'));
  first.saveDevice(device('c'));
  const raw = 'secret-session-token';
  first.saveSession(sessionHash(raw), 'a', Date.now() + 100000);
  const filePath = path.join(dir, 'uploads', 'f1');
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, 'abc');
  first.saveMessage(text('public', 'a', 'all', 1));
  first.saveMessage(text('private', 'a', 'b', 2), {
    ref: { id: 'f1', name: 'safe.txt', size: 3, mime: 'text/plain' },
    path: filePath,
    from: 'a',
    to: 'b',
    createdAt: 2,
  });
  first.saveMessage(text('third', 'a', 'c', 3));
  first.close();
  const second = new Storage(dir);
  assert.equal(second.loadDevices().length, 3);
  assert.deepEqual(second.loadSessions(), [
    {
      hash: sessionHash(raw),
      deviceId: 'a',
      expiresAt: second.loadSessions()[0].expiresAt,
    },
  ]);
  assert.equal(second.loadFiles()[0].ref.name, 'safe.txt');
  assert.equal(second.loadRecentMessages().length, 3);
  assert.equal(second.findByClientId('a', 'client-private')?.id, 'private');
  const own = second.history('b', 'a', undefined, 200);
  assert.deepEqual(
    own.messages.map((m) => m.id),
    ['private'],
  );
  const third = second.history('c', 'b', undefined, 200);
  assert.equal(third.messages.length, 0);
  const publicHistory = second.history('c', 'all');
  assert.deepEqual(
    publicHistory.messages.map((m) => m.id),
    ['public'],
  );
  second.close();
});

test('Storage history before 分页与删除权限', async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-storage-page-'),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Storage(dir);
  store.saveDevice(device('a'));
  store.saveDevice(device('b'));
  for (let i = 0; i < 5; i++) store.saveMessage(text(`m${i}`, 'a', 'b', i + 1));
  const page = store.history('b', 'a', undefined, 2);
  assert.equal(page.messages.length, 2);
  assert.equal(page.hasMore, true);
  assert.equal(store.history('b', 'a', page.before, 2).messages.length, 2);
  assert.equal(store.deleteMessage('m0', 'b'), true);
  assert.equal(store.deleteMessage('m1', 'c'), false);
  assert.deepEqual(
    store.history('b', 'a').messages.map((message) => message.id),
    ['m1', 'm2', 'm3', 'm4'],
  );
  assert.deepEqual(
    store.history('a', 'b').messages.map((message) => message.id),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
  );
  store.deleteFile('missing');
  store.close();
  const reopened = new Storage(dir);
  assert.deepEqual(
    reopened.history('b', 'a').messages.map((message) => message.id),
    ['m1', 'm2', 'm3', 'm4'],
  );
  assert.deepEqual(
    reopened.history('a', 'b').messages.map((message) => message.id),
    ['m0', 'm1', 'm2', 'm3', 'm4'],
  );
  reopened.close();
});

test('同毫秒消息使用 beforeId 游标不会丢失，公共历史无伪参数', async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), 'linchuan-storage-cursor-'),
  );
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const store = new Storage(dir);
  store.saveDevice(device('a'));
  store.saveDevice(device('b'));
  const same = Date.now();
  for (let i = 0; i < 5; i++)
    store.saveMessage(text(`same-${i}`, 'a', 'b', same));
  store.saveMessage(text('public-same', 'a', 'all', same));
  const first = store.history('b', 'a', undefined, 2);
  assert.equal(first.messages.length, 2);
  assert.ok(first.beforeId);
  const second = store.history('b', 'a', first.before, 2, first.beforeId);
  assert.equal(second.messages.length, 2);
  assert.ok(second.messages.every((m) => m.id !== first.messages[0].id));
  const third = store.history('b', 'a', second.before, 2, second.beforeId);
  assert.equal(third.messages.length, 1);
  assert.equal(store.history('b', 'all').messages.length, 1);
  assert.equal(store.findById('same-0')?.id, 'same-0');
  store.close();
});
