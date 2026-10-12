import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs/promises';
import os from 'node:os';
import { WebSocket } from 'ws';
import { allowedRtcPath } from '../server/secure-lan.js';
import { createLanServer } from '../server/app.js';
import { RTCPeerConnection } from 'werift';

const get = (url: string) =>
  new Promise<{ body: string; certificate: tls.PeerCertificate }>(
    (resolve, reject) => {
      const request = https.get(
        url,
        { rejectUnauthorized: false },
        (response) => {
          const socket = response.socket as tls.TLSSocket | null;
          let body = '';
          response.setEncoding('utf8');
          response.on('data', (chunk) => (body += chunk));
          response.on('end', () =>
            resolve({
              body,
              certificate:
                socket?.getPeerCertificate(true) ?? ({} as tls.PeerCertificate),
            }),
          );
        },
      );
      request.on('error', reject);
    },
  );

test('secure LAN serves TLS with the group key and refuses unauthenticated RTC', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-secure-lan-`);
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
  const joined = (await (
    await fetch(`http://127.0.0.1:${lan.getPort()}/api/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        code: '123456',
        deviceId: 'secure-test',
        name: 'secure-test',
        type: 'computer',
      }),
    })
  ).json()) as { token: string };
  const network = (await (
    await fetch(`http://127.0.0.1:${lan.getPort()}/api/network`, {
      headers: { authorization: `Bearer ${joined.token}` },
    })
  ).json()) as { publicKey: string };
  const secureUrl = lan
    .getSecureUrls()
    .find((value) => value.startsWith('https://127.0.0.1:'));
  assert.ok(secureUrl);
  const tlsResponse = await get(`${secureUrl}/api/info`);
  assert.equal(JSON.parse(tlsResponse.body).desktopApi, 3);
  assert.ok(tlsResponse.certificate.raw);
  const certificateKey = new crypto.X509Certificate(
    tlsResponse.certificate.raw,
  ).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  assert.deepEqual(certificateKey, Buffer.from(network.publicKey, 'base64'));
  const secureSocket = new WebSocket(
    `${secureUrl.replace('https://', 'wss://')}/ws?token=${joined.token}`,
    { rejectUnauthorized: false },
  );
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WSS open timeout')), 5000);
    secureSocket.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    secureSocket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
  const ready = await new Promise<{ type?: string }>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('WSS ready timeout')),
      5000,
    );
    secureSocket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as { type?: string });
    });
  });
  assert.equal(ready.type, 'ready');
  secureSocket.close();
  const earlyClose = tls.connect({
    host: '127.0.0.1',
    port: Number(new URL(secureUrl).port),
    rejectUnauthorized: false,
  });
  earlyClose.destroy();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${lan.getPort()}/api/network/rtc`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'offer', sdp: 'm=video' }),
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await fetch(`http://127.0.0.1:${lan.getPort()}/api/network/rtc`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${joined.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ type: 'offer', sdp: 'm=video' }),
      })
    ).status,
    400,
  );
  assert.equal(allowedRtcPath('/api/messages'), true);
  assert.equal(allowedRtcPath('/api/host/stop'), false);
  assert.equal(allowedRtcPath('/api/network/rtc'), false);
  assert.equal(allowedRtcPath('/api/messages?to=all'), true);
  assert.equal(allowedRtcPath('/api/files/file-id/media'), true);
  assert.equal(allowedRtcPath('/api/files/file-id/preview'), true);
  assert.equal(allowedRtcPath('/api/files/file-id/thumbnail'), false);
  assert.equal(allowedRtcPath('/api/messages/../host/stop'), false);
});

test('werift RTC datachannel performs authenticated RPC and closes cleanly', async (t) => {
  const dir = await fs.mkdtemp(`${os.tmpdir()}\\linchuan-secure-rtc-`);
  const lan = createLanServer({
    port: 0,
    host: '127.0.0.1',
    dataDir: dir,
    joinCode: '123456',
  });
  await lan.start();
  const base = `http://127.0.0.1:${lan.getPort()}`;
  const join = async (deviceId: string) =>
    (await (
      await fetch(`${base}/api/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code: '123456',
          deviceId,
          name: deviceId,
          type: 'computer',
        }),
      })
    ).json()) as { token: string; device: { id: string } };
  const source = await join('rtc-source');
  const target = await join('rtc-target');
  const peer = new RTCPeerConnection({
    iceServers: [],
    iceUseIpv4: true,
    iceUseIpv6: false,
    iceUseTcp: false,
    iceAdditionalHostAddresses: ['127.0.0.1'],
  });
  const channel = peer.createDataChannel('linchuan-api');
  t.after(async () => {
    await peer.close();
    await lan.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await peer.setLocalDescription(await peer.createOffer());
  await (
    peer as unknown as { gatherCandidates: () => Promise<void> }
  ).gatherCandidates();
  const offer = peer.localDescription!;
  const offerSdp = offer.sdp
    .split(/\r?\n/)
    .filter((line) => {
      if (!line.startsWith('a=candidate:')) return true;
      const address = line.split(' ')[4] ?? '';
      return /^(10\.|127\.0\.0\.1$|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(
        address,
      );
    })
    .join('\r\n');
  const signal = await fetch(`${base}/api/network/rtc`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${source.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type: 'offer', sdp: offerSdp }),
  });
  if (signal.status !== 200)
    assert.fail(
      `${await signal.text()} sdp=${offerSdp.slice(0, 180)} candidates=${offerSdp
        .split(/\r?\n/)
        .filter((line) => line.startsWith('a=candidate:'))
        .map((line) => line.split(' ').slice(0, 7).join(' '))
        .join('|')}`,
    );
  const answer = (await signal.json()) as { answer: RTCSessionDescriptionInit };
  await peer.setRemoteDescription(answer.answer);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('RTC channel timeout')),
      10000,
    );
    channel.stateChanged.subscribe((state) => {
      if (state === 'open') {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  let nextId = 1;
  const rpc = (
    method: string,
    path: string,
    body?: Buffer,
    contentType = 'application/json',
  ) =>
    new Promise<{ status: number; body: Buffer }>((resolve, reject) => {
      const id = nextId++;
      const parts: Buffer[] = [];
      let status = 0;
      const timeout = setTimeout(
        () => reject(new Error(`RTC RPC timeout ${method} ${path}`)),
        10000,
      );
      const listener = (data: string | Buffer) => {
        if (Buffer.isBuffer(data)) {
          if (data.readUInt32BE(0) === id) {
            parts.push(Buffer.from(data.subarray(4)));
          }
          return;
        }
        const message = JSON.parse(data);
        if (message.id !== id) return;
        if (message.type === 'headers') {
          status = message.status;
          channel.send(
            JSON.stringify({ type: 'credit', id, bytes: message.window }),
          );
          // Replenish once with a bounded grant; the server still starts
          // every response at its 128 KiB window and never buffers beyond
          // the protocol's 1 MiB per-response credit cap.
          channel.send(
            JSON.stringify({ type: 'credit', id, bytes: 512 * 1024 }),
          );
        } else if (message.type === 'end') {
          clearTimeout(timeout);
          resolve({ status, body: Buffer.concat(parts) });
        } else if (message.type === 'error') {
          clearTimeout(timeout);
          reject(new Error('RTC RPC failed'));
        }
      };
      channel.onMessage.subscribe(listener);
      channel.send(
        JSON.stringify({
          type: 'request',
          id,
          method,
          path,
          size: body?.length ?? 0,
          contentType: body ? contentType : '',
        }),
      );
      if (body)
        for (let offset = 0; offset < body.length; offset += 16384) {
          const part = body.subarray(offset, offset + 16384);
          const frame = Buffer.alloc(4 + part.length);
          frame.writeUInt32BE(id);
          part.copy(frame, 4);
          channel.send(frame);
        }
      channel.send(JSON.stringify({ type: 'request-end', id }));
    });
  const result = await rpc(
    'POST',
    '/api/messages',
    Buffer.from(
      JSON.stringify({
        to: target.device.id,
        text: 'RTC ACL',
        clientId: 'rtc-acl',
      }),
    ),
  );
  assert.equal(result.status, 201);
  const history = (await (
    await fetch(`${base}/api/messages?to=${source.device.id}`, {
      headers: { authorization: `Bearer ${target.token}` },
    })
  ).json()) as { messages: Array<{ text?: string }> };
  assert.ok(history.messages.some((message) => message.text === 'RTC ACL'));
  const upload = Buffer.alloc(256 * 1024, 0x5a);
  const created = await rpc(
    'POST',
    '/api/transfers',
    Buffer.from(
      JSON.stringify({
        name: 'rtc.bin',
        size: upload.length,
        mime: 'application/octet-stream',
        to: target.device.id,
        clientId: 'rtc-file',
      }),
    ),
  );
  assert.equal(created.status, 201);
  const transfer = JSON.parse(created.body.toString()) as { id: string };
  assert.equal(
    (
      await rpc(
        'PUT',
        `/api/transfers/${transfer.id}?offset=0`,
        upload,
        'application/octet-stream',
      )
    ).status,
    200,
  );
  const completed = await rpc('POST', `/api/transfers/${transfer.id}/complete`);
  assert.equal(completed.status, 201);
  const committed = JSON.parse(completed.body.toString()) as {
    file?: { id?: string };
  };
  assert.ok(committed.file?.id);
  const downloaded = await rpc('GET', `/api/files/${committed.file!.id}`);
  assert.equal(downloaded.status, 200);
  assert.deepEqual(downloaded.body, upload);
  await peer.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
});
