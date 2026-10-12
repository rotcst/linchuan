/* global self, MessageChannel, Response, ReadableStream, fetch, URL, setTimeout, clearTimeout */
// Stream only this origin's authenticated file routes. Nothing is cached.
self.addEventListener('install', (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener('activate', (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (
    event.request.method !== 'GET' ||
    url.origin !== self.location.origin ||
    url.search ||
    !/^\/api\/files\/[\w-]+(?:\/(?:media|thumbnail|preview))?$/.test(
      url.pathname,
    )
  )
    return;
  event.respondWith(
    (async () => {
      const client = event.clientId
        ? await self.clients.get(event.clientId)
        : (await self.clients.matchAll({ type: 'window' })).find(
            (item) => item.visibilityState === 'visible',
          );
      if (!client) return fetch(event.request);
      const channel = new MessageChannel();
      const port = channel.port1;
      let done = false,
        controller,
        waiting,
        timer;
      const cleanup = () => {
        done = true;
        clearTimeout(timer);
        port.close();
      };
      const first = await new Promise((resolve) => {
        timer = setTimeout(() => {
          cleanup();
          resolve(null);
        }, 4000);
        port.onmessage = ({ data }) => {
          clearTimeout(timer);
          resolve(data);
        };
        try {
          client.postMessage(
            {
              type: 'linchuan-file',
              path: url.pathname,
              range: event.request.headers.get('range') || '',
            },
            [channel.port2],
          );
        } catch {
          cleanup();
          resolve(null);
        }
      });
      if (!first || first.type !== 'headers') {
        cleanup();
        return fetch(event.request);
      }
      const body = new ReadableStream(
        {
          start(value) {
            controller = value;
            port.onmessage = ({ data }) => {
              clearTimeout(timer);
              if (done) return;
              if (
                data.type === 'chunk' &&
                data.bytes instanceof ArrayBuffer &&
                data.bytes.byteLength <= 16384
              ) {
                controller.enqueue(new Uint8Array(data.bytes));
                waiting?.();
                waiting = null;
              } else if (data.type === 'end') {
                cleanup();
                controller.close();
                waiting?.();
              } else {
                cleanup();
                controller.error(
                  new Error('Local file connection interrupted'),
                );
                waiting?.();
              }
            };
          },
          pull() {
            if (done) return;
            return new Promise((resolve) => {
              waiting = resolve;
              timer = setTimeout(() => {
                port.postMessage({ type: 'cancel' });
                cleanup();
                controller.error(new Error('Local file timeout'));
                resolve();
              }, 30000);
              port.postMessage({ type: 'pull' });
            });
          },
          cancel() {
            port.postMessage({ type: 'cancel' });
            cleanup();
            waiting?.();
          },
        },
        { highWaterMark: 1 },
      );
      return new Response(
        [204, 205, 304].includes(first.status) ? null : body,
        { status: first.status, headers: first.headers },
      );
    })(),
  );
});
