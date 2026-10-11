import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createLanServer, Message } from '../server/app.js';

async function fixture(maxFileBytes = 4096, maxStorageBytes?: number) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'linchuan-transfer-'));
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    maxFileBytes,
    maxStorageBytes,
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
    base,
    lan,
    join,
    close: async () => {
      await lan.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
const create = (
  base: string,
  token: string,
  to: string,
  size: number,
  clientId?: string,
) =>
  fetch(`${base}/api/transfers`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      name: 'x.bin',
      size,
      mime: 'application/octet-stream',
      to,
      clientId,
    }),
  });

test('分块 10MB 跨 8MB chunk 下载 hash 一致', async (t) => {
  const x = await fixture(20 * 1024 * 1024);
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const data = crypto.randomBytes(10 * 1024 * 1024);
  const start = (await (
    await create(x.base, a.token, b.device.id, data.length, 'large')
  ).json()) as { id: string; chunkBytes: number };
  let offset = 0;
  while (offset < data.length) {
    const end = Math.min(data.length, offset + start.chunkBytes);
    const r = (await (
      await fetch(`${x.base}/api/transfers/${start.id}?offset=${offset}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${a.token}`,
          'content-length': String(end - offset),
        },
        body: data.subarray(offset, end),
      })
    ).json()) as { offset: number };
    offset = r.offset;
  }
  const m = (await (
    await fetch(`${x.base}/api/transfers/${start.id}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${a.token}` },
    })
  ).json()) as Message;
  const got = Buffer.from(
    await (
      await fetch(`${x.base}/api/files/${m.file!.id}`, {
        headers: { authorization: `Bearer ${b.token}` },
      })
    ).arrayBuffer(),
  );
  assert.equal(got.length, data.length);
  assert.equal(
    crypto.createHash('sha256').update(got).digest('hex'),
    crypto.createHash('sha256').update(data).digest('hex'),
  );
});

test('同一会话并发创建分块任务只有一个成功', async (t) => {
  const x = await fixture(4096);
  t.after(x.close);
  const a = await x.join('same-owner');
  const [first, second] = await Promise.all([
    create(x.base, a.token, 'all', 1024, 'concurrent-a'),
    create(x.base, a.token, 'all', 1024, 'concurrent-b'),
  ]);
  assert.deepEqual(
    [first.status, second.status].sort((left, right) => left - right),
    [201, 429],
  );
});
test('offset、未完成 complete、chunk 超限返回错误', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const s = (await (await create(x.base, a.token, b.device.id, 4)).json()) as {
    id: string;
  };
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${s.id}?offset=1`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a.token}` },
        body: 'a',
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${s.id}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${s.id}?offset=0`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${a.token}` },
        body: '12345',
      })
    ).status,
    413,
  );
});
test('他人不能操作分块任务，取消清理任务', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const s = (await (await create(x.base, a.token, b.device.id, 3)).json()) as {
    id: string;
  };
  for (const method of ['GET', 'PUT', 'DELETE'] as const)
    assert.equal(
      (
        await fetch(`${x.base}/api/transfers/${s.id}`, {
          method,
          headers: { authorization: `Bearer ${b.token}` },
          body: method === 'PUT' ? 'x' : undefined,
        })
      ).status,
      404,
    );
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${s.id}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    204,
  );
});
test('同设备并发返回 429，clientId 改目标返回 409', async (t) => {
  const x = await fixture();
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const c = await x.join('c');
  const first = (await (
    await create(x.base, a.token, b.device.id, 1, 'busy')
  ).json()) as { id: string };
  assert.equal(
    (await create(x.base, a.token, c.device.id, 1, 'other')).status,
    429,
  );
  await fetch(`${x.base}/api/transfers/${first.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${a.token}` },
  });
  const second = (await (
    await create(x.base, a.token, b.device.id, 0, 'same')
  ).json()) as { id: string };
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${second.id}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    201,
  );
  assert.equal(
    (await create(x.base, a.token, c.device.id, 0, 'same')).status,
    409,
  );
});
test('总存储预算耗尽与空文件 complete', async (t) => {
  const x = await fixture(4096, 3);
  t.after(x.close);
  const a = await x.join('a');
  const b = await x.join('b');
  const empty = (await (
    await create(x.base, a.token, b.device.id, 0)
  ).json()) as { id: string };
  assert.equal(
    (
      await fetch(`${x.base}/api/transfers/${empty.id}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${a.token}` },
      })
    ).status,
    201,
  );
  assert.equal((await create(x.base, a.token, b.device.id, 4)).status, 413);
});
