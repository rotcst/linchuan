type Pending = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  controller?: ReadableStreamDefaultController<Uint8Array>;
  noBody?: boolean;
  credit?: number;
  ended?: boolean;
  finish: () => void;
};

// WebRTC provides DTLS encryption and ICE connectivity; the authenticated origin supplies its SDP.
export class LocalChannel {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private active = 0;
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private epoch = 0;
  private heartbeat?: ReturnType<typeof setInterval>;
  constructor(
    private readonly change: () => void,
    private readonly event: (data: unknown) => void,
  ) {}
  get connected() {
    return this.channel?.readyState === 'open';
  }
  async connect(token: string, groupId: string) {
    this.close();
    if (typeof RTCPeerConnection === 'undefined' || !window.isSecureContext)
      return false;
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    const channel = peer.createDataChannel('linchuan-api', { ordered: true });
    this.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = ({ data }) => this.receive(data);
    channel.onclose = () => {
      if (this.peer === peer) this.close();
    };
    peer.onconnectionstatechange = () => {
      if (
        ['failed', 'closed', 'disconnected'].includes(peer.connectionState) &&
        this.peer === peer
      )
        this.close();
    };
    try {
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await Promise.race([
        new Promise<void>((resolve) => {
          if (peer.iceGatheringState === 'complete') resolve();
          else
            peer.onicegatheringstatechange = () => {
              if (peer.iceGatheringState === 'complete') resolve();
            };
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 1200)),
      ]);
      const result = await fetch('/api/network/rtc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(peer.localDescription),
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(3500),
      });
      if (!result.ok) throw new Error('RTC unavailable');
      const answer = await result.json();
      if (
        answer.protocol !== 1 ||
        answer.groupId !== groupId ||
        this.peer !== peer
      )
        throw new Error('RTC group mismatch');
      await peer.setRemoteDescription(answer.answer);
      await Promise.race([
        new Promise<void>((resolve, reject) => {
          if (channel.readyState === 'open') resolve();
          else {
            channel.onopen = () => resolve();
            channel.onerror = () => reject(new Error('RTC unavailable'));
          }
        }),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('RTC timeout')), 3500),
        ),
      ]);
      if (this.peer !== peer) return false;
      this.heartbeat = setInterval(() => {
        if (channel.readyState === 'open')
          channel.send(JSON.stringify({ type: 'ping' }));
      }, 2000);
      this.change();
      return true;
    } catch {
      if (this.peer === peer) this.close();
      return false;
    }
  }
  private async slot(signal?: AbortSignal | null) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    if (this.active >= 2)
      await new Promise<void>((resolve, reject) => {
        const remove = () => signal?.removeEventListener('abort', abort);
        const queued = {
          resolve: () => {
            remove();
            resolve();
          },
          reject: (error: Error) => {
            remove();
            reject(error);
          },
        };
        const abort = () => {
          const index = this.queue.indexOf(queued);
          if (index >= 0) this.queue.splice(index, 1);
          queued.reject(new DOMException('Cancelled', 'AbortError'));
        };
        this.queue.push(queued);
        signal?.addEventListener('abort', abort, { once: true });
      });
    else this.active++;
  }
  private release() {
    const next = this.queue.shift();
    if (next) next.resolve();
    else this.active--;
  }
  async fetch(path: string, options: RequestInit = {}) {
    const epoch = this.epoch;
    await this.slot(options.signal);
    let registered = false;
    try {
      const channel = this.channel;
      if (!channel || channel.readyState !== 'open')
        throw new Error('Local connection unavailable');
      const id = this.nextId++;
      if (id > 0xffffffff) throw new Error('Local connection expired');
      const body = options.body;
      const bytes =
        body instanceof Blob
          ? new Uint8Array(await body.arrayBuffer())
          : typeof body === 'string'
            ? new TextEncoder().encode(body)
            : body instanceof ArrayBuffer
              ? new Uint8Array(body)
              : body == null
                ? new Uint8Array()
                : null;
      if (epoch !== this.epoch || !bytes || bytes.byteLength > 8 * 1024 * 1024)
        throw new Error('Unsupported local request');
      const method = (options.method || 'GET').toUpperCase();
      const headers = new Headers(options.headers);
      const response = new Promise<Response>((resolve, reject) => {
        const abort = () => this.close();
        options.signal?.addEventListener('abort', abort, { once: true });
        const timeout = setTimeout(() => this.close(), 300000);
        this.pending.set(id, {
          resolve,
          reject,
          finish: () => {
            clearTimeout(timeout);
            options.signal?.removeEventListener('abort', abort);
            this.release();
          },
        });
        registered = true;
      });
      void response.catch(() => {}); // Sending may fail before this response promise is returned.
      if (options.signal?.aborted) {
        this.close();
        return response;
      }
      channel.send(
        JSON.stringify({
          type: 'request',
          id,
          method,
          path,
          size: bytes.length,
          contentType:
            headers.get('Content-Type') ||
            (typeof body === 'string' ? 'application/json' : ''),
          range: headers.get('Range') || '',
        }),
      );
      for (let offset = 0; offset < bytes.length; offset += 16384) {
        while (channel.bufferedAmount > 256 * 1024) {
          if (channel.readyState !== 'open')
            throw new Error('Local connection lost');
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const part = bytes.subarray(offset, offset + 16384);
        const packet = new Uint8Array(4 + part.length);
        new DataView(packet.buffer).setUint32(0, id);
        packet.set(part, 4);
        channel.send(packet);
      }
      channel.send(JSON.stringify({ type: 'request-end', id }));
      return response;
    } catch (error) {
      if (registered) this.close();
      else this.release();
      throw error;
    }
  }
  private receive(value: string | ArrayBuffer) {
    try {
      if (value instanceof ArrayBuffer) {
        if (value.byteLength < 4 || value.byteLength > 16388) throw new Error();
        const id = new DataView(value).getUint32(0);
        const pending = this.pending.get(id);
        const amount = value.byteLength - 4;
        if (
          !pending?.controller ||
          pending.noBody ||
          pending.ended ||
          amount > (pending.credit || 0)
        )
          throw new Error();
        pending.credit = (pending.credit || 0) - amount;
        pending.controller.enqueue(new Uint8Array(value.slice(4)));
        return;
      }
      if (value.length > 128 * 1024) throw new Error();
      const message = JSON.parse(value);
      if (message.type === 'pong') return;
      if (message.type === 'event') {
        this.event(message.data);
        return;
      }
      const pending = this.pending.get(message.id);
      if (!pending) throw new Error();
      if (message.type === 'headers') {
        if (pending.controller || message.window !== 128 * 1024)
          throw new Error();
        pending.noBody = [204, 205, 304].includes(message.status);
        pending.credit = 0;
        const grant = (
          controller: ReadableStreamDefaultController<Uint8Array>,
        ) => {
          if (pending.ended || pending.noBody || !this.connected) return;
          const amount = Math.floor(
            (controller.desiredSize || 0) - (pending.credit || 0),
          );
          if (amount > 0) {
            pending.credit = (pending.credit || 0) + amount;
            this.channel!.send(
              JSON.stringify({ type: 'credit', id: message.id, bytes: amount }),
            );
          }
        };
        const stream = new ReadableStream<Uint8Array>(
          {
            start: (controller) => {
              pending.controller = controller;
              grant(controller);
            },
            pull: grant,
            cancel: () => this.close(),
          },
          { highWaterMark: message.window, size: (chunk) => chunk.byteLength },
        );
        pending.resolve(
          new Response(pending.noBody ? null : stream, {
            status: message.status,
            headers: message.headers,
          }),
        );
      } else if (message.type === 'end') {
        pending.ended = true;
        pending.controller?.close();
        pending.finish();
        this.pending.delete(message.id);
      } else if (message.type === 'error') {
        pending.ended = true;
        const error = new Error('Local request interrupted');
        pending.controller?.error(error);
        pending.reject(error);
        pending.finish();
        this.pending.delete(message.id);
      } else throw new Error();
    } catch {
      this.close();
    }
  }
  close() {
    this.epoch++;
    const peer = this.peer;
    clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    if (this.channel?.readyState === 'open') {
      try {
        this.channel.send(JSON.stringify({ type: 'bye' }));
      } catch {
        /* Connection may already be unavailable. */
      }
    }
    this.peer = null;
    this.channel = null;
    peer?.close();
    const error = new Error('Local connection interrupted');
    for (const queued of this.queue.splice(0)) queued.reject(error);
    for (const pending of this.pending.values()) {
      pending.ended = true;
      pending.controller?.error(error);
      pending.reject(error);
      pending.finish();
    }
    this.pending.clear();
    this.change();
  }
}
