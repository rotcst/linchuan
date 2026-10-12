import { LocalChannel } from './rtc';
import { installLocalFiles } from './local-files';

export interface GroupNetwork {
  protocol: number;
  groupId: string;
  publicKey: string;
  hostGeneration: number;
  hostDeviceId?: string;
  lanUrls: string[];
  httpLanUrls?: string[];
  publicUrl: string | null;
  internet?: string;
}
const storageKey = 'linchuan.network';
let group: GroupNetwork | null = null;
let pairedToken = '';
let selection: Promise<void> | null = null;
const listeners = new Set<() => void>();
const eventListeners = new Set<(data: unknown) => void>();
const rtc = new LocalChannel(
  () => listeners.forEach((fn) => fn()),
  (data) => eventListeners.forEach((fn) => fn(data)),
);
window.addEventListener('pagehide', () => rtc.close());
installLocalFiles(
  () => rtc.connected,
  (path, options) => rtc.fetch(path, options),
);
export function networkUrl(path: string) {
  return new URL(path, location.origin).href;
}
export function networkMode() {
  return rtc.connected || location.protocol === 'http:' ? 'lan' : 'internet';
}
export function localConnected() {
  return rtc.connected;
}
export function onNetworkChange(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function onLocalEvent(listener: (data: unknown) => void) {
  eventListeners.add(listener);
  return () => {
    eventListeners.delete(listener);
  };
}
export function resetNetwork() {
  group = null;
  pairedToken = '';
  rtc.close();
  localStorage.removeItem(storageKey);
}
export function privateLanUrl(value: string) {
  try {
    const url = new URL(value);
    const parts = url.hostname.split('.').map(Number);
    return (
      url.protocol === 'http:' &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash &&
      parts.length === 4 &&
      parts.every((x) => Number.isInteger(x) && x >= 0 && x <= 255) &&
      (parts[0] === 10 ||
        (parts[0] === 192 && parts[1] === 168) ||
        (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31))
    );
  } catch {
    return false;
  }
}
function validNetwork(identity: GroupNetwork) {
  return (
    identity.protocol === 1 &&
    /^[\da-f-]{36}$/i.test(identity.groupId) &&
    typeof identity.publicKey === 'string' &&
    identity.publicKey.length < 4096 &&
    Number.isSafeInteger(identity.hostGeneration) &&
    identity.hostGeneration >= 1 &&
    Array.isArray(identity.lanUrls) &&
    identity.lanUrls.length <= 8
  );
}
export async function selectNetwork() {
  if (!group || !pairedToken || !window.isSecureContext || rtc.connected)
    return;
  if (selection) return selection;
  const identity = group,
    token = pairedToken;
  selection = (async () => {
    await rtc.connect(token, identity.groupId);
    if (identity !== group || token !== pairedToken) rtc.close();
  })().finally(() => {
    selection = null;
  });
  return selection;
}
export async function startNetwork(token: string) {
  const response = await fetch('/api/network', {
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    redirect: 'error',
    signal: AbortSignal.timeout(4000),
  });
  if (response.status === 404) return;
  if (!response.ok)
    throw Object.assign(new Error('Network metadata unavailable'), {
      status: response.status,
    });
  const identity = (await response.json()) as GroupNetwork;
  if (!validNetwork(identity)) throw new Error('Invalid group metadata');
  let saved: GroupNetwork | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) || 'null');
  } catch {
    /* Replace corrupt public metadata. */
  }
  if (
    saved &&
    (saved.groupId !== identity.groupId ||
      saved.publicKey !== identity.publicKey ||
      identity.hostGeneration < saved.hostGeneration)
  )
    throw new Error('Group identity changed');
  group = identity;
  pairedToken = token;
  localStorage.setItem(storageKey, JSON.stringify(identity));
  await selectNetwork();
}
export async function networkFetch(path: string, options: RequestInit = {}) {
  // Authentication is bound to the SDP exchange. Browser traffic stays encrypted on both routes.
  if (
    rtc.connected &&
    /^\/api\/(?:info|session|device|logout|messages|files|transfers|media)(?:\/|\?|$)/.test(
      path,
    )
  ) {
    try {
      return await rtc.fetch(path, options);
    } catch (error) {
      if (
        options.signal?.aborted ||
        (options.method && options.method !== 'GET')
      )
        throw error;
    }
  }
  return fetch(networkUrl(path), {
    ...options,
    credentials: 'same-origin',
    redirect: 'error',
  });
}
export async function socketUrl() {
  const url = new URL('/ws', location.origin);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}
export async function bridgeToPublic(token: string) {
  if (
    !group?.publicUrl ||
    group.internet !== 'connected' ||
    location.protocol !== 'http:' ||
    !privateLanUrl(location.origin)
  )
    return false;
  const origin = new URL(group.publicUrl);
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  )
    return false;
  const response = await fetch('/api/network/browser-ticket', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    redirect: 'error',
  });
  if (!response.ok) return false;
  const { ticket } = await response.json();
  if (!/^[\w-]{20,128}$/.test(ticket)) return false;
  origin.hash = new URLSearchParams({ 'linchuan-join': ticket }).toString();
  location.replace(origin.href);
  return true;
}
export async function receiveBrowserTicket() {
  const ticket = new URLSearchParams(location.hash.slice(1)).get(
    'linchuan-join',
  );
  if (!ticket) return null;
  history.replaceState(null, '', location.pathname + location.search);
  if (!/^[\w-]{20,128}$/.test(ticket)) return null;
  // The tunnel may still be reconnecting after host activation; retain the ticket in memory during retries.
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('/api/network/browser-restore', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }),
        credentials: 'same-origin',
        redirect: 'error',
        signal: AbortSignal.timeout(4000),
      });
      if (response.ok) return await response.json();
      if ([400, 401, 403, 410].includes(response.status)) return null;
    } catch {
      /* Retry only this idempotent, single-use identity restoration. */
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return null;
}
export function followHost(identity: GroupNetwork, ticket?: string) {
  if (
    !group ||
    !validNetwork(identity) ||
    identity.groupId !== group.groupId ||
    identity.publicKey !== group.publicKey ||
    identity.hostGeneration <= group.hostGeneration
  )
    return;
  const old = group;
  group = identity;
  localStorage.setItem(storageKey, JSON.stringify(identity));
  rtc.close();
  if (location.protocol === 'https:') {
    setTimeout(() => location.reload(), 4000);
    return;
  }
  if (!ticket || !/^[\w-]{20,128}$/.test(ticket)) return;
  const publicUrl =
    identity.publicUrl && identity.publicUrl === old.publicUrl
      ? identity.publicUrl
      : null;
  const destination = publicUrl || identity.httpLanUrls?.find(privateLanUrl);
  if (!destination) return;
  const url = new URL(destination);
  if (
    url.protocol === 'https:' &&
    (url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash)
  )
    return;
  url.hash = new URLSearchParams({ 'linchuan-join': ticket }).toString();
  setTimeout(() => location.replace(url.href), 4000);
}
