import { translate as t, translateError } from './i18n';
import type { DeviceType, Session } from './types';

export const TOKEN_KEY = 'linchuan.token';
export const PROFILE_KEY = 'linchuan.profile';

export function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

export async function api<T>(
  path: string,
  options: RequestInit = {},
  token?: string,
): Promise<T> {
  const headers = new Headers(options.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (options.body && typeof options.body === 'string')
    headers.set('Content-Type', 'application/json');
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: 'same-origin',
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(
      translateError(data.error || data.message, response.status),
    );
    Object.assign(error, { status: response.status });
    throw error;
  }
  return data as T;
}

export function savedProfile(): {
  name: string;
  type: DeviceType;
  deviceId: string;
} {
  try {
    const saved = JSON.parse(localStorage.getItem(PROFILE_KEY) || 'null');
    if (saved?.name && saved?.deviceId) return saved;
  } catch {
    /* Recreate corrupt browser storage. */
  }
  const phone = /Android|iPhone|iPod/i.test(navigator.userAgent);
  const tablet = /iPad/i.test(navigator.userAgent);
  return {
    name: tablet ? t('我的平板') : phone ? t('我的手机') : t('我的电脑'),
    type: tablet ? 'tablet' : phone ? 'phone' : 'computer',
    deviceId: randomId(),
  };
}

export async function restoreSession(): Promise<Session | null> {
  const token = localStorage.getItem(TOKEN_KEY);
  if (!token) return null;
  const session = await api<Omit<Session, 'token'>>('/api/session', {}, token);
  return { ...session, token };
}

export function formatSize(size: number) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 ** 2) return `${(size / 1024).toFixed(1)} KB`;
  if (size < 1024 ** 3) return `${(size / 1024 ** 2).toFixed(1)} MB`;
  return `${(size / 1024 ** 3).toFixed(1)} GB`;
}

export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* Local HTTP can require manual copying. */
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    /* Show a selectable fallback. */
  }
  textarea.remove();
  return copied;
}
