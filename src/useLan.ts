import { translate as t } from './i18n';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, randomId } from './api';
import { uploadFile } from './upload';
import type { Connection, Device, Message, Session, Upload } from './types';
import {
  networkMode,
  localConnected,
  onLocalEvent,
  followHost,
  onNetworkChange,
  selectNetwork,
  socketUrl,
} from './network';

export function useLan(session: Session, onExpired: () => void) {
  const [devices, setDevices] = useState<Device[]>(session.devices);
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [unread, setUnread] = useState<Record<string, number>>({});
  const [target, setTarget] = useState('all');
  const [connection, setConnection] = useState<Connection>('connecting');
  const [network, setNetwork] = useState(networkMode);
  const [error, setError] = useState('');
  const [uploads, setUploads] = useState<Upload[]>([]);
  type History = {
    messages: Message[];
    hasMore: boolean;
    before?: number;
    beforeId?: string;
  };
  const [cursors, setCursors] = useState<
    Record<string, Omit<History, 'messages'>>
  >({});
  const cursorRef = useRef(cursors);
  cursorRef.current = cursors;
  const [loadingHistory, setLoadingHistory] = useState(false);
  const deleted = useRef(new Set<string>());
  const selected = useRef(target);
  const uploadRequests = useRef(new Map<string, AbortController>());
  const uploadQueue = useRef<Promise<void>>(Promise.resolve());
  const cancelled = useRef(new Set<string>());
  const seen = useRef(new Set<string>());
  const historyGeneration = useRef(0);
  const alive = useRef(true);
  const expiredCallback = useRef(onExpired);
  expiredCallback.current = onExpired;

  const conversationOf = useCallback(
    (message: Message) =>
      message.to === 'all'
        ? 'all'
        : message.from === session.device.id
          ? message.to
          : message.from,
    [session.device.id],
  );

  const addMessage = useCallback(
    (message: Message, countUnread = false) => {
      if (seen.current.has(message.id) || deleted.current.has(message.id))
        return;
      seen.current.add(message.id);
      const conversation = conversationOf(message);
      setMessages((current) => ({
        ...current,
        [conversation]: [...(current[conversation] || []), message],
      }));
      if (
        countUnread &&
        message.from !== session.device.id &&
        (selected.current !== conversation || document.hidden)
      ) {
        setUnread((current) => ({
          ...current,
          [conversation]: (current[conversation] || 0) + 1,
        }));
      }
    },
    [conversationOf, session.device.id],
  );

  const loadHistory = useCallback(
    async (conversation: string, older = false) => {
      const generation = ++historyGeneration.current;
      const requestedAt = Date.now();
      const cursor = cursorRef.current[conversation];
      setLoadingHistory(true);
      try {
        const params = new URLSearchParams({ to: conversation });
        if (older && cursor?.before !== undefined) {
          params.set('before', String(cursor.before));
          if (cursor.beforeId) params.set('beforeId', cursor.beforeId);
        }
        const data = await api<History>(
          `/api/messages?${params}`,
          {},
          session.token,
        );
        if (!alive.current || generation !== historyGeneration.current) return;
        data.messages.forEach((message) => seen.current.add(message.id));
        setCursors((current) => ({
          ...current,
          [conversation]: {
            hasMore: data.hasMore,
            before: data.before,
            beforeId: data.beforeId,
          },
        }));
        setMessages((current) => {
          const merged = new Map(
            [
              ...data.messages,
              ...(current[conversation] || []).filter(
                (message) =>
                  older || new Date(message.createdAt).getTime() >= requestedAt,
              ),
            ]
              .filter((message) => !deleted.current.has(message.id))
              .map((message) => [message.id, message]),
          );
          return {
            ...current,
            [conversation]: Array.from(merged.values()).sort(
              (a, b) =>
                new Date(a.createdAt).getTime() -
                  new Date(b.createdAt).getTime() || a.id.localeCompare(b.id),
            ),
          };
        });
      } catch (cause) {
        if (!alive.current) return;
        if ((cause as { status?: number }).status === 401)
          expiredCallback.current();
        else if (alive.current) setError((cause as Error).message);
      } finally {
        if (alive.current && generation === historyGeneration.current)
          setLoadingHistory(false);
      }
    },
    [session.token],
  );

  useEffect(() => {
    selected.current = target;
    setUnread((current) => ({ ...current, [target]: 0 }));
    void loadHistory(target);
  }, [target, loadHistory]);

  useEffect(() => {
    let socket: WebSocket;
    let timer: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let stopped = false;
    let connecting = false;
    const connect = async () => {
      if (stopped) return;
      if (connecting) return;
      connecting = true;
      try {
        await selectNetwork();
        const url = await socketUrl();
        if (stopped) return;
        socket = new WebSocket(url);
      } catch {
        if (!stopped) {
          setConnection('reconnecting');
          timer = setTimeout(() => void connect(), 2000);
        }
        return;
      } finally {
        connecting = false;
      }
      socket.onopen = () => {
        attempt = 0;
        setConnection('connected');
        setError('');
        void loadHistory(selected.current);
      };
      socket.onmessage = (event) => {
        try {
          receive(JSON.parse(event.data));
        } catch {
          setError(t('收到的消息格式异常，请刷新页面。'));
        }
      };
      socket.onclose = async (event) => {
        if (stopped) return;
        setConnection(localConnected() ? 'connected' : 'reconnecting');
        if ((event.code === 4001 || event.code === 1008) && !localConnected()) {
          expiredCallback.current();
          return;
        }
        try {
          await api('/api/session', {}, session.token);
        } catch (cause) {
          if (
            (cause as { status?: number }).status === 401 &&
            !localConnected()
          ) {
            if (!stopped) expiredCallback.current();
            return;
          }
        }
        if (stopped) return;
        timer = setTimeout(
          () => void connect(),
          Math.min(1000 * 2 ** attempt++, 10000),
        );
      };
      socket.onerror = () => socket.close();
    };
    const receive = (value: unknown) => {
      try {
        const data = value as {
          type: string;
          devices: Device[];
          message: Message;
          id: string;
          network: Parameters<typeof followHost>[0];
          browserTicket?: string;
        };
        if (data.type === 'presence') {
          setDevices(data.devices);
          setTarget((current) =>
            current !== 'all' &&
            !data.devices.some((device: Device) => device.id === current)
              ? 'all'
              : current,
          );
        }
        if (data.type === 'message') addMessage(data.message, true);
        if (data.type === 'message-deleted') {
          deleted.current.add(data.id);
          setMessages((current) =>
            Object.fromEntries(
              Object.entries(current).map(([key, items]) => [
                key,
                items.filter((item) => item.id !== data.id),
              ]),
            ),
          );
        }
        if (data.type === 'handoff') {
          setConnection('reconnecting');
          followHost(data.network, data.browserTicket);
        }
      } catch {
        setError(t('收到的消息格式异常，请刷新页面。'));
      }
    };
    const resume = () => {
      if (socket?.readyState === WebSocket.CLOSED) {
        clearTimeout(timer);
        void connect();
      } else if (socket?.readyState === WebSocket.OPEN)
        void loadHistory(selected.current);
    };
    const visible = () => {
      if (!document.hidden) {
        setUnread((current) => ({ ...current, [selected.current]: 0 }));
        resume();
      }
    };
    void connect();
    const monitor = setInterval(() => {
      void selectNetwork();
    }, 15000);
    const unsubscribe = onNetworkChange(() => {
      setNetwork(networkMode());
      setConnection(
        localConnected() || socket?.readyState === WebSocket.OPEN
          ? 'connected'
          : 'reconnecting',
      );
      if (localConnected()) void loadHistory(selected.current);
      else resume();
    });
    const unsubscribeEvents = onLocalEvent(receive);
    window.addEventListener('online', resume);
    document.addEventListener('visibilitychange', visible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearInterval(monitor);
      unsubscribe();
      unsubscribeEvents();
      socket?.close();
      window.removeEventListener('online', resume);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [session.token, addMessage, loadHistory]);

  useEffect(() => {
    alive.current = true;
    const requests = uploadRequests.current;
    return () => {
      alive.current = false;
      for (const request of requests.values()) request.abort();
    };
  }, []);

  const send = async (text: string, clientId: string) => {
    const message = await api<Message>(
      '/api/messages',
      { method: 'POST', body: JSON.stringify({ to: target, text, clientId }) },
      session.token,
    );
    addMessage(message);
  };

  const cancelUpload = (id: string) => {
    cancelled.current.add(id);
    uploadRequests.current.get(id)?.abort();
    setUploads((current) =>
      current.map((upload) =>
        upload.id === id ? { ...upload, state: 'cancelled' } : upload,
      ),
    );
  };

  const uploadFiles = (files: File[]) => {
    const to = target;
    for (const file of files) {
      const id = randomId();
      setUploads((current) => [
        ...current,
        {
          id,
          to,
          name: file.name,
          size: file.size,
          progress: 0,
          state: 'queued',
        },
      ]);
      uploadQueue.current = uploadQueue.current
        .catch(() => {})
        .then(async () => {
          if (!alive.current || cancelled.current.has(id)) return;
          const controller = new AbortController();
          uploadRequests.current.set(id, controller);
          const update = (patch: Partial<Upload>) => {
            if (alive.current)
              setUploads((current) =>
                current.map((upload) =>
                  upload.id === id ? { ...upload, ...patch } : upload,
                ),
              );
          };
          update({ state: 'uploading' });
          try {
            const message = await uploadFile(
              file,
              to,
              id,
              session.token,
              controller.signal,
              (progress) => update({ progress }),
            );
            addMessage(message);
            update({ state: 'done', progress: 100 });
          } catch (cause) {
            update(
              controller.signal.aborted
                ? { state: 'cancelled' }
                : { state: 'error', error: (cause as Error).message },
            );
          } finally {
            uploadRequests.current.delete(id);
          }
        });
    }
  };
  return {
    devices,
    messages: messages[target] || [],
    unread,
    target,
    setTarget,
    connection,
    network,
    error,
    setError,
    send,
    deleteMessage: async (id: string) => {
      await api(
        `/api/messages/${encodeURIComponent(id)}`,
        { method: 'DELETE' },
        session.token,
      );
      deleted.current.add(id);
      setMessages((current) =>
        Object.fromEntries(
          Object.entries(current).map(([key, items]) => [
            key,
            items.filter((item) => item.id !== id),
          ]),
        ),
      );
    },
    hasMore: cursors[target]?.hasMore ?? false,
    loadingHistory,
    loadMore: () => loadHistory(target, true),
    uploadFiles,
    uploads: uploads.filter(
      (upload) => upload.to === target && upload.state !== 'done',
    ),
    cancelUpload,
    dismissUpload: (id: string) =>
      setUploads((current) => current.filter((upload) => upload.id !== id)),
  };
}
