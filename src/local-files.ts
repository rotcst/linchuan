type LocalFetch = (path: string, options?: RequestInit) => Promise<Response>;
export function installLocalFiles(
  connected: () => boolean,
  request: LocalFetch,
) {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const port = event.ports[0];
    const { type, path, range } = event.data || {};
    if (
      !port ||
      type !== 'linchuan-file' ||
      typeof path !== 'string' ||
      !/^\/api\/files\/[\w-]+(?:\/(?:media|thumbnail|preview))?$/.test(path) ||
      typeof range !== 'string' ||
      (range && !/^bytes=\d*-\d*$/.test(range))
    ) {
      port?.close();
      return;
    }
    if (!connected()) {
      port.postMessage({ type: 'fallback' });
      port.close();
      return;
    }
    void (async () => {
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let busy = false;
      let idle: ReturnType<typeof setTimeout>;
      const close = () => {
        clearTimeout(idle);
        port.close();
      };
      try {
        const response = await request(path, {
          headers: range ? { Range: range } : {},
        });
        reader = response.body?.getReader();
        const headers = Object.fromEntries(response.headers.entries());
        port.onmessage = ({ data }) => {
          if (data.type === 'cancel') {
            void reader?.cancel().catch(() => {});
            close();
            return;
          }
          if (data.type !== 'pull' || busy) return;
          busy = true;
          clearTimeout(idle);
          void (async () => {
            try {
              const item = await reader?.read();
              if (!item || item.done) {
                port.postMessage({ type: 'end' });
                close();
              } else {
                const bytes = item.value.slice().buffer;
                port.postMessage({ type: 'chunk', bytes }, [bytes]);
                idle = setTimeout(() => {
                  void reader?.cancel().catch(() => {});
                  close();
                }, 35000);
              }
            } catch {
              port.postMessage({ type: 'error' });
              close();
            } finally {
              busy = false;
            }
          })();
        };
        port.postMessage({ type: 'headers', status: response.status, headers });
        idle = setTimeout(() => {
          void reader?.cancel().catch(() => {});
          close();
        }, 35000);
      } catch {
        port.postMessage({ type: 'fallback' });
        close();
      }
    })();
  });
  void navigator.serviceWorker
    .register('/lan-files.js', { scope: '/' })
    .catch(() => {});
}
