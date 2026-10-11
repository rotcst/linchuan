import { translate as t, translateError } from './i18n';
import { api } from './api';
import type { Message } from './types';

export async function uploadFile(
  file: File,
  to: string,
  clientId: string,
  token: string,
  signal: AbortSignal,
  progress: (percent: number) => void,
) {
  const metadata = {
    name: file.name,
    size: file.size,
    mime: file.type,
    to,
    clientId,
  };
  const created = await api<{
    id: string;
    offset: number;
    chunkBytes: number;
    message?: Message;
  }>(
    '/api/transfers',
    { method: 'POST', body: JSON.stringify(metadata), signal },
    token,
  );
  if (created.message) return created.message;
  let completed = false;
  try {
    let offset = created.offset;
    let failures = 0;
    while (offset < file.size) {
      if (signal.aborted) throw new DOMException(t('已取消上传'), 'AbortError');
      const start = offset;
      const blob = file.slice(start, start + created.chunkBytes);
      try {
        const result = await new Promise<{ offset: number }>(
          (resolve, reject) => {
            const request = new XMLHttpRequest();
            request.open('PUT', `/api/transfers/${created.id}?offset=${start}`);
            request.setRequestHeader('Authorization', `Bearer ${token}`);
            request.setRequestHeader(
              'Content-Type',
              'application/octet-stream',
            );
            request.timeout = 180000;
            const abort = () => request.abort();
            signal.addEventListener('abort', abort, { once: true });
            const finish = () => signal.removeEventListener('abort', abort);
            request.upload.onprogress = (event) =>
              progress(
                Math.min(
                  99,
                  Math.round(((start + event.loaded) / file.size) * 100),
                ),
              );
            request.onload = () => {
              finish();
              try {
                const data = JSON.parse(request.responseText);
                if (request.status >= 200 && request.status < 300)
                  resolve(data);
                else
                  reject(
                    Object.assign(
                      new Error(translateError(data.error, request.status)),
                      {
                        status: request.status,
                      },
                    ),
                  );
              } catch (cause) {
                reject(cause);
              }
            };
            request.onerror = () => {
              finish();
              reject(new Error(t('网络中断，分块未上传完成。')));
            };
            request.ontimeout = () => {
              finish();
              reject(new Error(t('上传超时，请检查网络。')));
            };
            request.onabort = () => {
              finish();
              reject(new DOMException(t('已取消上传'), 'AbortError'));
            };
            if (signal.aborted) {
              finish();
              reject(new DOMException(t('已取消上传'), 'AbortError'));
              return;
            }
            request.send(blob);
          },
        );
        if (
          !Number.isSafeInteger(result.offset) ||
          result.offset <= start ||
          result.offset > file.size
        )
          throw new Error(t('服务器返回的上传进度异常。'));
        offset = result.offset;
        failures = 0;
      } catch (cause) {
        if (
          signal.aborted ||
          ++failures > 3 ||
          [401, 403, 404, 413].includes(
            (cause as { status?: number }).status || 0,
          )
        )
          throw cause;
        const state = await api<{ offset: number }>(
          `/api/transfers/${created.id}`,
          { signal },
          token,
        );
        if (
          !Number.isSafeInteger(state.offset) ||
          state.offset < start ||
          state.offset > file.size
        )
          throw cause;
        offset = state.offset;
        await new Promise<void>((resolve, reject) => {
          const stop = () => {
            clearTimeout(timer);
            reject(new DOMException(t('已取消上传'), 'AbortError'));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener('abort', stop);
            resolve();
          }, failures * 700);
          signal.addEventListener('abort', stop, { once: true });
        });
      }
    }
    const message = await api<Message>(
      `/api/transfers/${created.id}/complete`,
      { method: 'POST', signal },
      token,
    );
    completed = true;
    progress(100);
    return message;
  } finally {
    if (!completed)
      await api(
        `/api/transfers/${created.id}`,
        { method: 'DELETE' },
        token,
      ).catch(() => {});
  }
}
