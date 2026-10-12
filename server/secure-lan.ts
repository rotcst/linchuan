import https from 'node:https';
import 'reflect-metadata';
import http from 'node:http';
import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Express, Request, RequestHandler } from 'express';
import * as x509 from '@peculiar/x509';
import { RTCPeerConnection, type RTCDataChannel } from 'werift';
import { HttpError } from './errors.js';

type Identity = { groupId: string; publicKey: string; privateKey: string };
type Session = { token: string; deviceId: string; expiresAt: number };
type Options = {
  app: Express;
  server: http.Server;
  host: string;
  fixedPort: boolean;
  identity: Identity;
  auth: RequestHandler;
  sessionOf: (request: Request) => Session;
  sessionValid: (session: Session) => boolean;
  addresses: () => string[];
  onPresence: (deviceId: string) => void;
  onReady: (deviceId: string) => unknown;
  onUpgrade: UpgradeHandler;
};
type UpgradeHandler = (
  request: http.IncomingMessage,
  socket: import('node:stream').Duplex,
  head: Buffer,
) => void;
type Peer = {
  pc: RTCPeerConnection;
  session: Session;
  channel?: RTCDataChannel;
  controllers: Set<AbortController>;
};
const maxBody = 8 * 1024 * 1024;
const responseWindow = 128 * 1024;
const maxCredit = 1024 * 1024;
const privateIp = (ip: string) =>
  /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) &&
  ip.split('.').length === 4 &&
  ip.split('.').every((x) => /^\d{1,3}$/.test(x) && Number(x) <= 255);
const localIp = (ip: string) => privateIp(ip) || ip === '127.0.0.1';
export const securePortFor = (port: number) =>
  port === 65535 ? 65534 : port + 1;
export function allowedRtcPath(value: string) {
  if (
    value.length > 2048 ||
    !value.startsWith('/api/') ||
    /[\\\r\n]/.test(value)
  )
    return false;
  const url = new URL(value, 'http://127.0.0.1');
  return (
    url.origin === 'http://127.0.0.1' &&
    /^(\/api\/(info|session|device|logout)|\/api\/messages(?:\/[\w-]+)?|\/api\/files(?:\/[\w-]+(?:\/(media|preview))?)?|\/api\/transfers(?:\/[\w-]+(?:\/complete)?)?|\/api\/media\/[\w-]+(?:\/(thumbnail|preview))?)$/.test(
      url.pathname,
    )
  );
}
export function createSecureLan(options: Options) {
  let tls: https.Server | null = null;
  const peers = new Set<Peer>();
  const devicePeers = (id: string) =>
    [...peers].filter(
      (peer) =>
        peer.session.deviceId === id &&
        peer.channel?.readyState === 'open' &&
        options.sessionValid(peer.session),
    );
  const emit = (id: string | null, payload: string) => {
    for (const peer of peers)
      if (
        (!id || peer.session.deviceId === id) &&
        peer.channel?.readyState === 'open' &&
        options.sessionValid(peer.session) &&
        peer.channel.bufferedAmount < 256 * 1024
      )
        peer.channel.send(
          JSON.stringify({ type: 'event', data: JSON.parse(payload) }),
        );
  };
  const closePeer = async (peer: Peer) => {
    if (!peers.delete(peer)) return;
    for (const controller of peer.controllers) controller.abort();
    await peer.pc.close();
    options.onPresence(peer.session.deviceId);
  };
  async function send(channel: RTCDataChannel, value: string | Buffer) {
    const started = Date.now();
    while (channel.bufferedAmount > 256 * 1024) {
      if (channel.readyState !== 'open' || Date.now() - started > 30000)
        throw new Error('RTC channel unavailable');
      await delay(5);
    }
    if (channel.readyState !== 'open')
      throw new Error('RTC channel unavailable');
    channel.send(value);
  }
  options.app.post(
    '/api/network/rtc',
    options.auth,
    async (request, response) => {
      const session = options.sessionOf(request);
      if (
        [...peers].filter((peer) => peer.session.deviceId === session.deviceId)
          .length >= 2 ||
        peers.size >= 16
      )
        throw new HttpError(429, '局域网直连繁忙，请稍后重试。');
      const offer = request.body;
      if (
        offer?.type !== 'offer' ||
        typeof offer.sdp !== 'string' ||
        offer.sdp.length > 32768 ||
        /m=(audio|video)/.test(offer.sdp)
      )
        throw new HttpError(400, '局域网协商数据无效。');
      // Only local host candidates are used; there is no STUN/TURN or arbitrary public relay.
      const candidates = offer.sdp
        .split('\r\n')
        .filter((line: string) => line.startsWith('a=candidate:'));
      if (
        candidates.length > 64 ||
        candidates.some((line: string) => {
          const fields = line.split(' ');
          const port = Number(fields[5]);
          return (
            fields[2]?.toLowerCase() !== 'udp' ||
            !Number.isInteger(port) ||
            port < 1024 ||
            port > 65535 ||
            !(
              localIp(fields[4]) ||
              /^[a-zA-Z0-9-]{1,100}\.local$/.test(fields[4])
            )
          );
        })
      )
        throw new HttpError(400, '只允许局域网直连候选地址。');
      const pc = new RTCPeerConnection({
        iceServers: [],
        iceUseIpv6: false,
        iceUseTcp: false,
        ...(options.fixedPort
          ? {
              icePortRange: (() => {
                const base = (
                  options.server.address() as import('node:net').AddressInfo
                ).port;
                const start = base >= 65501 ? 65501 : base + 2;
                return [start, Math.min(65532, start + 31)] as [number, number];
              })(),
            }
          : {}),
        iceAdditionalHostAddresses: options.addresses().filter(localIp),
      });
      const peer: Peer = { pc, session, controllers: new Set() };
      peers.add(peer);
      const deadline = setTimeout(() => {
        if (!peer.channel || peer.channel.readyState !== 'open')
          void closePeer(peer);
      }, 10000);
      deadline.unref();
      pc.connectionStateChange.subscribe((state) => {
        if (state === 'failed' || state === 'closed') void closePeer(peer);
      });
      pc.onDataChannel.subscribe((channel) => {
        if (peer.channel || channel.label !== 'linchuan-api') {
          void closePeer(peer);
          return;
        }
        peer.channel = channel;
        const requests = new Map<
          number,
          {
            method: string;
            path: string;
            contentType: string;
            range: string;
            size: number;
            received: number;
            parts: Buffer[];
            timer: ReturnType<typeof setTimeout>;
          }
        >();
        const activeIds = new Set<number>();
        const completedIds = new Set<number>();
        let lastActivity = Date.now();
        let heartbeat: ReturnType<typeof setInterval> | undefined;
        const rememberCompleted = (id: number) => {
          completedIds.add(id);
          if (completedIds.size > 128)
            completedIds.delete(completedIds.values().next().value!);
        };
        const flows = new Map<
          number,
          { credit: number; closed: boolean; wake?: () => void }
        >();
        const waitCredit = async (id: number, amount: number) => {
          const flow = flows.get(id);
          if (!flow) throw new Error('RTC response unavailable');
          while (!flow.closed && flow.credit === 0)
            await new Promise<void>((resolve) => {
              flow.wake = resolve;
            });
          if (flow.closed || flow.credit === 0)
            throw new Error('RTC response unavailable');
          const granted = Math.min(amount, flow.credit);
          flow.credit -= granted;
          return granted;
        };
        channel.stateChanged.subscribe((state) => {
          if (state === 'open') {
            clearTimeout(deadline);
            heartbeat = setInterval(() => {
              if (Date.now() - lastActivity > 8000) void closePeer(peer);
            }, 2000);
            heartbeat.unref();
            options.onPresence(session.deviceId);
            channel.send(
              JSON.stringify({
                type: 'event',
                data: options.onReady(session.deviceId),
              }),
            );
          }
          if (state === 'closed') {
            if (heartbeat) clearInterval(heartbeat);
            for (const pending of requests.values())
              clearTimeout(pending.timer);
            requests.clear();
            for (const flow of flows.values()) {
              flow.closed = true;
              flow.wake?.();
            }
            flows.clear();
            void closePeer(peer);
          }
        });
        const execute = async (id: number) => {
          const pending = requests.get(id);
          if (!pending) return;
          requests.delete(id);
          activeIds.add(id);
          clearTimeout(pending.timer);
          if (
            pending.received !== pending.size ||
            !options.sessionValid(session)
          ) {
            void closePeer(peer);
            return;
          }
          const controller = new AbortController();
          peer.controllers.add(controller);
          const timeout = setTimeout(() => controller.abort(), 300000);
          timeout.unref();
          try {
            const address =
              options.server.address() as import('node:net').AddressInfo;
            const headers: Record<string, string> = {
              Authorization: `Bearer ${session.token}`,
            };
            if (pending.contentType)
              headers['Content-Type'] = pending.contentType;
            if (pending.range) headers.Range = pending.range;
            const result = await fetch(
              new URL(pending.path, `http://127.0.0.1:${address.port}`),
              {
                method: pending.method,
                headers,
                body: pending.size ? Buffer.concat(pending.parts) : undefined,
                redirect: 'error',
                signal: controller.signal,
              },
            );
            flows.set(id, { credit: 0, closed: false });
            await send(
              channel,
              JSON.stringify({
                type: 'headers',
                id,
                status: result.status,
                window: responseWindow,
                headers: Object.fromEntries(
                  [
                    ['Content-Type', result.headers.get('content-type')],
                    ['Content-Length', result.headers.get('content-length')],
                    [
                      'Content-Disposition',
                      result.headers.get('content-disposition'),
                    ],
                    ['Accept-Ranges', result.headers.get('accept-ranges')],
                    ['Content-Range', result.headers.get('content-range')],
                  ].filter((entry): entry is [string, string] =>
                    Boolean(entry[1]),
                  ),
                ),
              }),
            );
            // The client sends the initial credit after receiving headers.
            if (result.body)
              for await (const part of result.body) {
                for (let offset = 0; offset < part.length;) {
                  const amount = await waitCredit(
                    id,
                    Math.min(16384, part.length - offset),
                  );
                  const data = Buffer.allocUnsafe(4 + amount);
                  data.writeUInt32BE(id);
                  Buffer.from(part).copy(data, 4, offset, offset + amount);
                  offset += amount;
                  await send(channel, data);
                }
              }
            await send(channel, JSON.stringify({ type: 'end', id }));
          } catch {
            if (channel.readyState === 'open')
              channel.send(JSON.stringify({ type: 'error', id }));
          } finally {
            rememberCompleted(id);
            activeIds.delete(id);
            const flow = flows.get(id);
            if (flow) {
              flow.closed = true;
              flow.wake?.();
              flows.delete(id);
            }
            clearTimeout(timeout);
            peer.controllers.delete(controller);
          }
        };
        channel.onMessage.subscribe((data) => {
          lastActivity = Date.now();
          if (!options.sessionValid(session)) {
            void closePeer(peer);
            return;
          }
          try {
            if (Buffer.isBuffer(data)) {
              if (data.length < 4 || data.length > 16388) throw new Error();
              const pending = requests.get(data.readUInt32BE(0));
              if (!pending) throw new Error();
              pending.received += data.length - 4;
              if (pending.received > pending.size) throw new Error();
              pending.parts.push(Buffer.from(data.subarray(4)));
              return;
            }
            if (data.length > 8192) throw new Error();
            const message = JSON.parse(data);
            if (message.type === 'ping') {
              if (channel.readyState === 'open')
                channel.send(JSON.stringify({ type: 'pong' }));
              return;
            }
            if (message.type === 'bye') {
              void closePeer(peer);
              return;
            }
            if (
              !Number.isInteger(message.id) ||
              message.id < 1 ||
              message.id > 0xffffffff
            )
              throw new Error();
            if (message.type === 'request') {
              const requestUrl =
                typeof message.path === 'string'
                  ? new URL(message.path, 'http://127.0.0.1')
                  : null;
              const filePath =
                requestUrl?.origin === 'http://127.0.0.1' &&
                /^\/api\/files\/[\w-]+(?:\/(media|preview))?$/.test(
                  requestUrl.pathname,
                );
              const rangeValid =
                message.range === undefined ||
                message.range === '' ||
                (typeof message.range === 'string' &&
                  message.range.length <= 128 &&
                  /^bytes=\d*-\d*$/.test(message.range));
              if (
                requests.size + activeIds.size >= 2 ||
                requests.has(message.id) ||
                activeIds.has(message.id) ||
                completedIds.has(message.id) ||
                !['GET', 'POST', 'PUT', 'DELETE'].includes(message.method) ||
                typeof message.path !== 'string' ||
                !allowedRtcPath(message.path) ||
                !Number.isInteger(message.size) ||
                message.size < 0 ||
                message.size > maxBody ||
                typeof message.contentType !== 'string' ||
                !['', 'application/json', 'application/octet-stream'].includes(
                  message.contentType,
                ) ||
                (message.method === 'GET' && message.size) ||
                !rangeValid ||
                (message.range && (message.method !== 'GET' || !filePath))
              )
                throw new Error();
              const timer = setTimeout(() => {
                requests.delete(message.id);
                void closePeer(peer);
              }, 60000);
              timer.unref();
              requests.set(message.id, {
                method: message.method,
                path: message.path,
                contentType: message.contentType,
                range: message.range ?? '',
                size: message.size,
                received: 0,
                parts: [],
                timer,
              });
            } else if (message.type === 'request-end') void execute(message.id);
            else if (message.type === 'credit') {
              if (
                !Number.isSafeInteger(message.bytes) ||
                message.bytes < 1 ||
                message.bytes > maxCredit
              )
                throw new Error();
              const flow = flows.get(message.id);
              if (!flow && completedIds.has(message.id)) return;
              if (
                !flow ||
                flow.closed ||
                flow.credit + message.bytes > maxCredit
              )
                throw new Error();
              flow.credit += message.bytes;
              const wake = flow.wake;
              flow.wake = undefined;
              wake?.();
            } else throw new Error();
          } catch {
            void closePeer(peer);
          }
        });
      });
      try {
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());
        response.json({
          protocol: 1,
          groupId: options.identity.groupId,
          answer: pc.localDescription,
        });
      } catch {
        await closePeer(peer);
        throw new HttpError(400, '局域网协商失败，请使用公网连接。');
      }
    },
  );
  return {
    emit,
    hasDevice: (id: string) => devicePeers(id).length > 0,
    async start() {
      const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      x509.cryptoProvider.set(crypto.webcrypto as unknown as Crypto);
      const publicKey = (await crypto.webcrypto.subtle.importKey(
        'spki',
        Buffer.from(options.identity.publicKey, 'base64'),
        alg,
        true,
        ['verify'],
      )) as unknown as CryptoKey;
      const privateKey = (await crypto.webcrypto.subtle.importKey(
        'pkcs8',
        Buffer.from(options.identity.privateKey, 'base64'),
        alg,
        true,
        ['sign'],
      )) as unknown as CryptoKey;
      const cert = await x509.X509CertificateGenerator.createSelfSigned({
        serialNumber: crypto.randomBytes(16).toString('hex'),
        name: 'CN=' + options.identity.groupId,
        notBefore: new Date(Date.now() - 86400000),
        notAfter: new Date(Date.now() + 365 * 86400000),
        signingAlgorithm: alg,
        keys: { publicKey, privateKey },
        extensions: [
          new x509.BasicConstraintsExtension(false),
          new x509.KeyUsagesExtension(
            x509.KeyUsageFlags.digitalSignature |
              x509.KeyUsageFlags.keyEncipherment,
          ),
          new x509.ExtendedKeyUsageExtension(['1.3.6.1.5.5.7.3.1']),
        ],
      });
      tls = https.createServer(
        {
          cert: cert.toString('pem'),
          key: crypto
            .createPrivateKey({
              key: Buffer.from(options.identity.privateKey, 'base64'),
              format: 'der',
              type: 'pkcs8',
            })
            .export({ format: 'pem', type: 'pkcs8' }),
          minVersion: 'TLSv1.2',
        },
        options.app,
      );
      tls.on('upgrade', options.onUpgrade);
      const address =
        options.server.address() as import('node:net').AddressInfo;
      await new Promise<void>((resolve, reject) => {
        tls!.once('error', reject);
        tls!.listen(
          options.fixedPort ? securePortFor(address.port) : 0,
          options.host,
          resolve,
        );
      });
    },
    urls: () =>
      tls?.listening
        ? options
            .addresses()
            .filter(localIp)
            .map(
              (ip) =>
                `https://${ip}:${(tls!.address() as import('node:net').AddressInfo).port}`,
            )
        : [],
    async close() {
      for (const peer of [...peers]) await closePeer(peer);
      if (tls) {
        tls.closeAllConnections();
        await new Promise<void>((resolve) => tls!.close(() => resolve()));
        tls = null;
      }
    },
  };
}
