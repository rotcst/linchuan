import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import {
  CheckCircle2,
  Copy,
  Download,
  FileArchive,
  FileText,
  MessagesSquare,
  MessageSquare,
  Paperclip,
  ImagePlus,
  Send,
  UserPlus,
  X,
  Trash2,
  Image as ImageIcon,
  Film,
} from 'lucide-react';
import { copyText, formatSize, randomId } from '../api';
import type { Connection, Device, Message, Upload } from '../types';
import { DeviceIcon } from './DeviceIcon';
import { MediaPreview } from './MediaPreview';
import { SaveToPhone } from './SaveToPhone';
import { isPhoneBrowser, mediaKind } from '../media';
import { currentLocale, localizeNotice } from '../i18n';

function MessageItem({
  message,
  self,
  devices,
  galleryFiles,
  onCopy,
  onDelete,
  onMediaLoad,
}: {
  message: Message;
  self: Device;
  devices: Device[];
  galleryFiles: NonNullable<Message['file']>[];
  onCopy: (text: string) => void;
  onDelete: (id: string) => Promise<void>;
  onMediaLoad: () => void;
}) {
  const { t } = useTranslation();

  const own = message.from === self.id;
  const sender = devices.find((device) => device.id === message.from);
  const archive = /\.(zip|rar|7z|tar|gz)$/i.test(message.file?.name || '');
  const kind = message.file ? mediaKind(message.file) : null;
  const FileIcon = archive
    ? FileArchive
    : kind === 'image'
      ? ImageIcon
      : kind === 'video'
        ? Film
        : FileText;
  return (
    <div className={`message-row ${own ? 'own' : ''}`}>
      <div className="avatar">
        <DeviceIcon type={sender?.type} />
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span>{own ? self.name : sender?.name || t('已离开的设备')}</span>
          <time dateTime={new Date(message.createdAt).toISOString()}>
            {new Date(message.createdAt).toLocaleTimeString(currentLocale(), {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </time>
        </div>
        {message.kind === 'file' && message.file ? (
          <div className="attachment">
            <MediaPreview
              file={message.file}
              galleryFiles={galleryFiles}
              onLoad={onMediaLoad}
            />
            <div className="file-footer">
              <div className="file-bubble">
                <div className="file-glyph">
                  <FileIcon size={25} />
                </div>
                <div className="file-info">
                  <strong title={message.file.name}>{message.file.name}</strong>
                  <small>{formatSize(message.file.size)}</small>
                </div>
              </div>
              <div className="file-actions">
                {isPhoneBrowser() && mediaKind(message.file) ? (
                  <SaveToPhone file={message.file} />
                ) : (
                  <a
                    className="outline-button download-button"
                    href={`/api/files/${encodeURIComponent(message.file.id)}`}
                    download={message.file.name}
                    aria-label={t('下载 {{name}}', { name: message.file.name })}
                  >
                    <Download size={16} />
                    <span>{t('下载')}</span>
                  </a>
                )}
                <button
                  className="icon-button message-delete"
                  aria-label={t('删除文件')}
                  title={t('仅从本设备删除')}
                  onClick={() => void onDelete(message.id)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </div>
          </div>
        ) : (
          <div className="text-bubble">
            <span className="message-text">
              {message.kind === 'file' ? t('文件已删除或已过期') : message.text}
            </span>
            <div className="message-actions">
              {message.kind !== 'file' && (
                <button
                  type="button"
                  className="message-copy icon-button"
                  onClick={() => onCopy(message.text || '')}
                  aria-label={t('复制消息')}
                  title={t('复制消息')}
                >
                  <Copy size={14} />
                </button>
              )}
              <button
                type="button"
                className="icon-button message-delete"
                aria-label={t(
                  message.kind === 'file' ? '删除文件' : '删除消息',
                )}
                title={t('仅从本设备删除')}
                onClick={() => void onDelete(message.id)}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </div>
        )}
        {own && (
          <div className="sent-label">
            <CheckCircle2 size={13} />
            {t('已发送')}
            {message.to !== 'all' &&
            !devices.find((device) => device.id === message.to)?.online
              ? t(' · 对方上线后可见')
              : ''}
          </div>
        )}
      </div>
    </div>
  );
}

export function Chat({
  self,
  devices,
  target,
  messages,
  uploads,
  connection,
  maxFileBytes,
  onInvite,
  onSend,
  onFiles,
  onCancel,
  onDismiss,
  notify,
  onDelete,
  hasMore,
  loadingHistory,
  onLoadMore,
}: {
  self: Device;
  devices: Device[];
  target: string;
  messages: Message[];
  uploads: Upload[];
  connection: Connection;
  maxFileBytes: number | null;
  onInvite: () => void;
  onSend: (text: string, clientId: string) => Promise<void>;
  onFiles: (files: File[]) => void;
  onCancel: (id: string) => void;
  onDismiss: (id: string) => void;
  notify: (text: string) => void;
  onDelete: (id: string) => Promise<void>;
  hasMore: boolean;
  loadingHistory: boolean;
  onLoadMore: () => Promise<void>;
}) {
  const { t } = useTranslation();

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [copyFallback, setCopyFallback] = useState('');
  const messageId = useRef<{ text: string; to: string; id: string } | null>(
    null,
  );
  const fileInput = useRef<HTMLInputElement>(null);
  const mediaInput = useRef<HTMLInputElement>(null);
  const draftInput = useRef<HTMLTextAreaElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const previousScroll = useRef<{ height: number; top: number } | null>(null);
  const dragDepth = useRef(0);
  const draft = drafts[target] || '';
  const peer = devices.find((device) => device.id === target);
  const title =
    target === 'all' ? t('公共聊天室') : peer?.name || t('设备私聊');
  const galleryFiles = messages.flatMap((message) =>
    message.kind === 'file' && message.file ? [message.file] : [],
  );

  useEffect(() => {
    const input = draftInput.current;
    if (!input) return;
    const resize = () => {
      input.style.height = '0px';
      const style = getComputedStyle(input);
      const minimum =
        parseFloat(style.lineHeight) +
        parseFloat(style.paddingTop) +
        parseFloat(style.paddingBottom);
      input.style.height = `${Math.min(parseFloat(style.maxHeight), Math.max(minimum, input.scrollHeight))}px`;
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [draft, target]);

  useEffect(() => {
    if (previousScroll.current && scrollArea.current) {
      const previous = previousScroll.current;
      scrollArea.current.scrollTop =
        previous.top + scrollArea.current.scrollHeight - previous.height;
      previousScroll.current = null;
      return;
    }
    stickToBottom.current = true;
  }, [target]);
  useEffect(() => {
    if (stickToBottom.current && scrollArea.current)
      scrollArea.current.scrollTop = scrollArea.current.scrollHeight;
  }, [messages, uploads, target]);

  const acceptFiles = (files: File[]) => {
    if (connection !== 'connected') {
      notify(t('请等待连接恢复后再发送文件。'));
      return;
    }
    const valid = files.filter(
      (file) => maxFileBytes === null || file.size <= maxFileBytes,
    );
    if (valid.length !== files.length)
      notify(t('部分文件超过当前服务配置的大小限制。'));
    if (valid.length > 20) {
      notify(t('一次最多选择 20 个文件。'));
      return;
    }
    onFiles(valid);
    stickToBottom.current = true;
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text || sending || connection !== 'connected') return;
    const to = target;
    if (messageId.current?.text !== text || messageId.current?.to !== to)
      messageId.current = { text, to, id: randomId() };
    setSending(true);
    try {
      await onSend(text, messageId.current.id);
      setDrafts((current) => ({
        ...current,
        [to]: current[to]?.trim() === text ? '' : current[to],
      }));
      messageId.current = null;
      stickToBottom.current = true;
    } catch (cause) {
      notify((cause as Error).message);
    } finally {
      setSending(false);
    }
  };

  let previousDay = '';
  return (
    <section
      className={`chat ${dragging ? 'dragging' : ''}`}
      aria-label={title}
      onDragEnter={(event) => {
        event.preventDefault();
        if (event.dataTransfer.types.includes('Files')) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        event.preventDefault();
        if (--dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        acceptFiles(Array.from(event.dataTransfer.files));
      }}
    >
      <header className="chat-header">
        <div className="chat-title-group">
          <span className="chat-title-icon">
            {target === 'all' ? (
              <MessageSquare size={28} />
            ) : (
              <DeviceIcon type={peer?.type} size={28} />
            )}
          </span>
          <div>
            <h1>{title}</h1>
            <p>
              {target === 'all'
                ? t('发给所有在线设备')
                : peer?.online
                  ? t('设备私聊 · 在线')
                  : t('设备私聊 · 对方离线，可留言')}
            </p>
          </div>
        </div>
        <button className="outline-button invite-button" onClick={onInvite}>
          <UserPlus size={19} />
          <span>{t('添加设备')}</span>
        </button>
      </header>
      {connection !== 'connected' && (
        <div className="connection-banner" role="status">
          {connection === 'connecting'
            ? t('正在连接服务…')
            : t('连接已中断，正在自动重连。请确认服务电脑仍在运行。')}
        </div>
      )}
      <div
        className="message-list"
        ref={scrollArea}
        role="log"
        aria-live="polite"
        aria-label={t('聊天消息')}
        onScroll={() => {
          const area = scrollArea.current;
          if (area)
            stickToBottom.current =
              area.scrollHeight - area.scrollTop - area.clientHeight < 80;
        }}
      >
        {hasMore && (
          <button
            className="history-more outline-button"
            disabled={loadingHistory}
            onClick={() => {
              if (scrollArea.current)
                previousScroll.current = {
                  height: scrollArea.current.scrollHeight,
                  top: scrollArea.current.scrollTop,
                };
              stickToBottom.current = false;
              void onLoadMore();
            }}
          >
            {loadingHistory ? t('正在加载…') : t('查看更早的消息')}
          </button>
        )}
        {!messages.length && !uploads.length && (
          <div className="empty-chat">
            <div className="empty-icon">
              <MessagesSquare size={40} strokeWidth={1.3} />
            </div>
            <h2>
              {target === 'all'
                ? t('把消息和文件，传到身边的设备')
                : t('和{{name}}聊一聊', { name: title })}
            </h2>
            <p>
              {target === 'all'
                ? t('发一句话，或把文件拖进来。')
                : t('消息和文件只有你们两个设备可以看到。')}
            </p>
            <button
              className="text-button"
              onClick={() => fileInput.current?.click()}
            >
              <Paperclip size={16} />
              {t('选择一个文件')}
            </button>
          </div>
        )}
        {messages.map((message) => {
          const day = new Date(message.createdAt).toLocaleDateString(
            currentLocale(),
          );
          const divider = day !== previousDay;
          previousDay = day;
          return (
            <div key={message.id}>
              {divider && (
                <div className="day-divider">
                  <span>
                    {day === new Date().toLocaleDateString(currentLocale())
                      ? t('今天')
                      : day}
                  </span>
                </div>
              )}
              <MessageItem
                message={message}
                self={self}
                devices={devices}
                galleryFiles={galleryFiles}
                onCopy={async (text) => {
                  if (await copyText(text)) notify(t('消息已复制'));
                  else setCopyFallback(text);
                }}
                onDelete={async (id) => {
                  if (
                    !window.confirm(
                      message.kind === 'file'
                        ? t(
                            '从本设备的聊天记录中删除此文件？其他设备的记录和文件会保留。',
                          )
                        : t(
                            '从本设备的聊天记录中删除此消息？其他设备的记录会保留。',
                          ),
                    )
                  )
                    return;
                  try {
                    await onDelete(id);
                  } catch (cause) {
                    notify((cause as Error).message);
                  }
                }}
                onMediaLoad={() => {
                  if (stickToBottom.current && scrollArea.current)
                    scrollArea.current.scrollTop =
                      scrollArea.current.scrollHeight;
                }}
              />
            </div>
          );
        })}
        {uploads.map((upload) => (
          <div className="upload-row" key={upload.id}>
            <FileText size={24} />
            <div className="upload-detail">
              <strong>{upload.name}</strong>
              <small>
                {upload.state === 'queued'
                  ? t('等待上传…')
                  : upload.state === 'uploading'
                    ? `${upload.progress}% · ${formatSize(upload.size)}${upload.progress === 99 ? t(' · 正在保存') : ''}`
                    : upload.state === 'cancelled'
                      ? t('已取消')
                      : localizeNotice(upload.error || '')}
              </small>
              {upload.state === 'uploading' && (
                <progress
                  value={upload.progress}
                  max="100"
                  aria-label={t('{{name}} 上传进度', { name: upload.name })}
                />
              )}
            </div>
            <button
              className="icon-button"
              aria-label={
                upload.state === 'uploading' || upload.state === 'queued'
                  ? t('取消上传 {{name}}', { name: upload.name })
                  : t('移除上传记录')
              }
              onClick={() =>
                upload.state === 'uploading' || upload.state === 'queued'
                  ? onCancel(upload.id)
                  : onDismiss(upload.id)
              }
            >
              <X size={18} />
            </button>
          </div>
        ))}
      </div>
      <div className="composer-area">
        <form
          className="composer"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <button
            type="button"
            className="attach-button icon-button"
            title={t('发送文件')}
            aria-label={t('选择文件')}
            disabled={connection !== 'connected'}
            onClick={() => fileInput.current?.click()}
          >
            <Paperclip size={24} />
          </button>
          <button
            type="button"
            className="attach-button icon-button media-button"
            title={t('选择照片或视频')}
            aria-label={t('选择照片或视频')}
            disabled={connection !== 'connected'}
            onClick={() => mediaInput.current?.click()}
          >
            <ImagePlus size={22} />
          </button>
          <textarea
            ref={draftInput}
            aria-label={t('输入消息')}
            value={draft}
            maxLength={20000}
            rows={1}
            onChange={(event) =>
              setDrafts((current) => ({
                ...current,
                [target]: event.target.value,
              }))
            }
            placeholder={
              isPhoneBrowser()
                ? t('输入消息…')
                : t('输入消息，或把文件拖到这里')
            }
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                !event.shiftKey &&
                !event.nativeEvent.isComposing &&
                !/Android|iPhone|iPad/i.test(navigator.userAgent)
              ) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <button
            type="submit"
            className="primary send-button"
            disabled={!draft.trim() || sending || connection !== 'connected'}
          >
            <span>{sending ? t('发送中') : t('发送')}</span>
            <Send size={17} />
          </button>
        </form>
        <p className="composer-hint">
          {t('Enter 发送 · Shift + Enter 换行')}
          <span>{t('不限制文件类型与大小')}</span>
        </p>
        <input
          ref={fileInput}
          className="visually-hidden"
          type="file"
          multiple
          aria-label={t('文件选择器')}
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
        <input
          ref={mediaInput}
          className="visually-hidden"
          type="file"
          accept="image/*,video/*"
          multiple
          aria-label={t('相册照片视频选择器')}
          onChange={(event) => {
            acceptFiles(Array.from(event.target.files || []));
            event.target.value = '';
          }}
        />
      </div>
      {dragging && (
        <div className="drop-overlay">
          <Paperclip size={44} />
          <strong>{t('松开即可发送文件')}</strong>
          <span>
            {t('发送到：')}
            {title}
          </span>
        </div>
      )}
      {copyFallback && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('复制消息')}
          >
            <button
              className="modal-close icon-button"
              aria-label={t('关闭复制消息')}
              onClick={() => setCopyFallback('')}
            >
              <X size={20} />
            </button>
            <h2>{t('长按或选中复制消息')}</h2>
            <textarea
              readOnly
              autoFocus
              value={copyFallback}
              onFocus={(event) => event.currentTarget.select()}
            />
            <button className="primary" onClick={() => setCopyFallback('')}>
              {t('完成')}
            </button>
          </section>
        </div>
      )}
    </section>
  );
}
