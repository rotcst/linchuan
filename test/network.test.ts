import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { createLanServer } from '../server/app.js';
import { WebSocket } from 'ws';

test('network public URL persists in metadata without enabling internet', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-network-public-`);
  const first = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    publicUrl: 'https://transfer.example.test/path',
  });
  await first.start();
  await first.close();
  const second = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  t.after(async () => {
    await second.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  await second.start();
  const info = (await (
    await fetch(`http://127.0.0.1:${second.getPort()}/api/info`)
  ).json()) as { publicUrl: string; urls: string[] };
  assert.equal(info.publicUrl, 'https://transfer.example.test');
  assert.ok(info.urls.includes(info.publicUrl));
});

test('explicit public URL overrides metadata and empty value clears it', async (t) => {
  const dir = await fs.mkdtemp(
    `${os.tmpdir()}\\linchuan-network-public-clear-`,
  );
  let active: ReturnType<typeof createLanServer> | undefined;
  t.after(async () => {
    await active?.close().catch(() => {});
    await fs.rm(dir, { recursive: true, force: true });
  });
  const first = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    publicUrl: 'https://first.example.test',
  });
  await first.start();
  await first.close();
  active = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    publicUrl: 'https://second.example.test/path',
  });
  await active.start();
  await active.close();
  active = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    publicUrl: '',
  });
  await active.start();
  const info = (await (
    await fetch(`http://127.0.0.1:${active!.getPort()}/api/info`)
  ).json()) as { publicUrl: string | null };
  assert.equal(info.publicUrl, null);
});

test('network identity persists and probe signature binds group and nonce', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-network-`);
  const first = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await first.start();
  const base = `http://127.0.0.1:${first.getPort()}`;
  const joined = (await (
    await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        deviceId: 'network-test',
        name: 'network-test',
        type: 'computer',
      }),
    })
  ).json()) as { token: string };
  const nonce = '0123456789abcdef'.repeat(4);
  const network = (await (
    await fetch(`${base}/api/network`, {
      headers: { authorization: `Bearer ${joined.token}` },
    })
  ).json()) as {
    groupId: string;
    publicKey: string;
    hostGeneration: string;
    protocol: number;
  };
  assert.equal(network.protocol, 1);
  assert.match(network.groupId, /^[0-9a-f-]{36}$/);
  assert.equal(network.hostGeneration, 1);
  const probe = (await (
    await fetch(`${base}/api/network/probe?nonce=${nonce}`)
  ).json()) as { groupId: string; nonce: string; signature: string };
  assert.equal(probe.groupId, network.groupId);
  assert.equal(probe.nonce, nonce);
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(network.publicKey, 'base64'),
    format: 'der',
    type: 'spki',
  });
  assert.equal(
    crypto.verify(
      'RSA-SHA256',
      Buffer.from(`linchuan-network-v1\n${probe.groupId}\n${nonce}`),
      { key: publicKey, padding: crypto.constants.RSA_PKCS1_PADDING },
      Buffer.from(probe.signature, 'base64'),
    ),
    true,
  );
  assert.equal(
    (await fetch(`${base}/api/network/probe?nonce=bad`)).status,
    400,
  );
  await first.close();
  const second = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await second.start();
  t.after(async () => {
    await second.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const joinedAgain = (await (
    await fetch(`http://127.0.0.1:${second.getPort()}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        deviceId: 'network-test-2',
        name: 'network-test-2',
        type: 'computer',
      }),
    })
  ).json()) as { token: string };
  const persisted = (await (
    await fetch(`http://127.0.0.1:${second.getPort()}/api/network`, {
      headers: { authorization: `Bearer ${joinedAgain.token}` },
    })
  ).json()) as typeof network;
  assert.deepEqual(
    { groupId: persisted.groupId, publicKey: persisted.publicKey },
    { groupId: network.groupId, publicKey: network.publicKey },
  );
});

test('network CORS is restricted and host API remains loopback-only', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-network-cors-`);
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
    publicUrl: 'https://transfer.example.test',
  });
  await lan.start();
  t.after(async () => {
    await lan.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const allowed = await fetch(
    `${base}/api/network/probe?nonce=${'a'.repeat(64)}`,
    { headers: { origin: 'https://transfer.example.test' } },
  );
  assert.equal(allowed.status, 200);
  assert.equal(
    allowed.headers.get('access-control-allow-origin'),
    'https://transfer.example.test',
  );
  const unknown = await fetch(
    `${base}/api/network/probe?nonce=${'b'.repeat(64)}`,
    { headers: { origin: 'https://other.example.test' } },
  );
  assert.equal(unknown.status, 403);
  const host = await fetch(`${base}/api/host`, {
    headers: {
      origin: 'https://transfer.example.test',
      host: '127.0.0.1',
      'x-linchuan-host': '1',
    },
  });
  assert.equal(host.status, 403);
});

test('network tickets are bound, short-lived, and single-use', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-network-ticket-`);
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
  const joined = (await (
    await fetch(`${base}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        deviceId: 'ticket-device',
        name: 'ticket-device',
        type: 'computer',
      }),
    })
  ).json()) as { token: string; device: { id: string } };
  const auth = { authorization: `Bearer ${joined.token}` };
  const ticketResponse = (await (
    await fetch(`${base}/api/network/socket-ticket`, {
      method: 'POST',
      headers: auth,
    })
  ).json()) as { ticket: string };
  assert.match(ticketResponse.ticket, /^[A-Za-z0-9_-]{40,}$/);
  const ws = await new Promise<{ opened: boolean }>((resolve) => {
    const socket = new WebSocket(
      `${base.replace('http', 'ws')}/ws?ticket=${ticketResponse.ticket}`,
    );
    socket.once('open', () => {
      socket.close();
      resolve({ opened: true });
    });
    socket.once('error', () => resolve({ opened: false }));
  });
  assert.equal(ws.opened, true);
  const reused = await fetch(
    `${base.replace('http', 'ws')}/ws?ticket=${ticketResponse.ticket}`,
  ).then(
    () => false,
    () => true,
  );
  assert.equal(reused, true);
  const browser = (await (
    await fetch(`${base}/api/network/browser-ticket`, {
      method: 'POST',
      headers: auth,
    })
  ).json()) as { ticket: string };
  const restored = await fetch(`${base}/api/network/browser-restore`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ticket: browser.ticket }),
  });
  assert.equal(restored.status, 200);
  const restoredBody = (await restored.json()) as {
    token: string;
    device: { id: string };
  };
  assert.equal(restoredBody.token, joined.token);
  assert.equal(restoredBody.device.id, joined.device.id);
  assert.equal(
    (
      await fetch(`${base}/api/network/browser-restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ticket: browser.ticket }),
      })
    ).status,
    401,
  );
});
