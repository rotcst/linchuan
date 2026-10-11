import { localizeNotice } from './i18n';
import { useTranslation } from 'react-i18next';
import { SelectMenu } from './components/SelectMenu';
import { useCallback, useEffect, useState } from 'react';
import { LogOut, Menu, MessageCircle, X } from 'lucide-react';
import { api, PROFILE_KEY, restoreSession, TOKEN_KEY } from './api';
import { useLan } from './useLan';
import type { DeviceType, ServerInfo, Session } from './types';
import { JoinScreen } from './components/JoinScreen';
import { Sidebar } from './components/Sidebar';
import { InvitePanel } from './components/InvitePanel';
import { Chat } from './components/Chat';
import { Brand } from './components/Brand';
import { ThemeSelector } from './components/ThemeSelector';
import { LanguageSelector } from './components/LanguageSelector';

function Workspace({
  session: initialSession,
  info,
  onLeave,
}: {
  session: Session;
  info: ServerInfo | null;
  onLeave: (error?: string) => void;
}) {
  const { t } = useTranslation();

  const [session, setSession] = useState(initialSession);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inviteOpen, setInviteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [name, setName] = useState(session.device.name);
  const [type, setType] = useState<DeviceType>(session.device.type);
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');
  const expired = useCallback(
    () => onLeave(t('连接已过期或已退出，请重新输入连接码。')),
    [onLeave, t],
  );
  const lan = useLan(session, expired);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(''), 4000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    if (lan.error) setToast(lan.error);
  }, [lan.error]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        setSidebarOpen(false);
        setInviteOpen(false);
        setSettingsOpen(false);
      }
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, []);

  return (
    <main className="app-shell">
      <header className="app-header">
        <Brand />
        <div className="header-tools">
          <span className="header-connection">
            <span
              className={`presence-dot ${lan.connection === 'connected' ? 'online' : ''}`}
            />
            {lan.connection === 'connected' ? t('已连接') : t('正在连接…')}
          </span>
          <LanguageSelector />
          <ThemeSelector />
          <button
            className="outline-button mobile-only devices-toggle"
            aria-label={t('打开设备列表')}
            onClick={() => setSidebarOpen(true)}
          >
            <Menu size={18} />
            <span>{lan.devices.filter((device) => device.online).length}</span>
          </button>
        </div>
      </header>
      <div className="workspace-grid">
        <Sidebar
          devices={lan.devices}
          self={session.device}
          target={lan.target}
          unread={lan.unread}
          onSelect={(id) => {
            lan.setTarget(id);
            setSidebarOpen(false);
          }}
          onSettings={() => {
            setName(session.device.name);
            setType(session.device.type);
            setSettingsError('');
            setSettingsOpen(true);
          }}
          onClose={() => setSidebarOpen(false)}
          open={sidebarOpen}
        />
        <Chat
          self={session.device}
          devices={lan.devices}
          target={lan.target}
          messages={lan.messages}
          uploads={lan.uploads}
          connection={lan.connection}
          maxFileBytes={info?.maxFileBytes ?? null}
          onInvite={() => setInviteOpen(true)}
          onSend={lan.send}
          onFiles={lan.uploadFiles}
          onCancel={lan.cancelUpload}
          onDismiss={lan.dismissUpload}
          notify={setToast}
          onDelete={lan.deleteMessage}
          hasMore={lan.hasMore}
          loadingHistory={lan.loadingHistory}
          onLoadMore={lan.loadMore}
        />
        <aside className="invite-rail">
          <InvitePanel info={info} connection={lan.connection} />
        </aside>
      </div>
      {inviteOpen && (
        <div className="modal-backdrop" onClick={() => setInviteOpen(false)}>
          <section
            className="modal invite-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('添加设备')}
            onClick={(event) => event.stopPropagation()}
          >
            <button
              className="modal-close icon-button"
              onClick={() => setInviteOpen(false)}
              aria-label={t('关闭添加设备')}
            >
              <X size={20} />
            </button>
            <InvitePanel info={info} connection={lan.connection} />
          </section>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop">
          <form
            className="modal settings-modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('设备设置')}
            onSubmit={async (event) => {
              event.preventDefault();
              setSaving(true);
              setSettingsError('');
              try {
                const response = await api<{ device: Session['device'] }>(
                  '/api/device',
                  {
                    method: 'PUT',
                    body: JSON.stringify({ name: name.trim(), type }),
                  },
                  session.token,
                );
                setSession((current) => ({
                  ...current,
                  device: response.device,
                }));
                const profile = JSON.parse(
                  localStorage.getItem(PROFILE_KEY) || '{}',
                );
                localStorage.setItem(
                  PROFILE_KEY,
                  JSON.stringify({ ...profile, name: name.trim(), type }),
                );
                setSettingsOpen(false);
                setToast(t('设备信息已更新'));
              } catch (cause) {
                setSettingsError((cause as Error).message);
              } finally {
                setSaving(false);
              }
            }}
          >
            <button
              type="button"
              className="modal-close icon-button"
              aria-label={t('关闭设备设置')}
              onClick={() => setSettingsOpen(false)}
            >
              <X size={20} />
            </button>
            <h2>{t('设备设置')}</h2>
            <label htmlFor="settings-name">{t('设备名称')}</label>
            <input
              id="settings-name"
              required
              maxLength={30}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <label htmlFor="settings-type">{t('设备类型')}</label>
            <SelectMenu<DeviceType>
              id="settings-type"
              ariaLabel={t('设备类型')}
              className="device-type-selector"
              value={type}
              onValueChange={setType}
              options={[
                { value: 'computer', label: t('电脑') },
                { value: 'phone', label: t('手机') },
                { value: 'tablet', label: t('平板') },
              ]}
            />
            {settingsError && (
              <p className="form-error" role="alert">
                {localizeNotice(settingsError)}
              </p>
            )}
            <button className="primary" disabled={saving || !name.trim()}>
              {saving ? t('保存中…') : t('保存修改')}
            </button>
            <button
              type="button"
              className="leave-button"
              onClick={async () => {
                try {
                  await api('/api/logout', { method: 'POST' }, session.token);
                  onLeave();
                } catch (cause) {
                  setSettingsError((cause as Error).message);
                }
              }}
            >
              <LogOut size={16} />
              {t('退出当前设备')}
            </button>
          </form>
        </div>
      )}
      {toast && (
        <div className="toast" role="status">
          {localizeNotice(toast)}
          <button
            className="icon-button"
            onClick={() => setToast('')}
            aria-label={t('关闭提示')}
          >
            <X size={16} />
          </button>
        </div>
      )}
    </main>
  );
}

export default function App() {
  const { t } = useTranslation();

  const [session, setSession] = useState<Session | null>(null);
  const [info, setInfo] = useState<ServerInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadAttempt, setLoadAttempt] = useState(0);
  const leave = useCallback((reason = '') => {
    localStorage.removeItem(TOKEN_KEY);
    setSession(null);
    setError(reason);
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const initialize = async () => {
      try {
        const serverInfo = await api<ServerInfo>('/api/info');
        if (!active) return;
        setInfo(serverInfo);
        try {
          const restored = await restoreSession();
          if (active) setSession(restored);
        } catch (cause) {
          if ((cause as { status?: number }).status === 401)
            localStorage.removeItem(TOKEN_KEY);
          else throw cause;
        }
      } catch {
        if (active)
          setError(t('无法连接服务。请确认服务电脑已启动邻传，再重试。'));
      } finally {
        if (active) setLoading(false);
      }
    };
    void initialize();
    return () => {
      active = false;
    };
  }, [loadAttempt]);
  if (loading)
    return (
      <div className="loading-page">
        <span className="loading-spinner" />
        <p>{t('正在连接邻传…')}</p>
      </div>
    );
  if (!info)
    return (
      <div className="loading-page">
        <MessageCircle size={44} />
        <h1>{t('服务暂时无法连接')}</h1>
        <p>{localizeNotice(error)}</p>
        <button
          className="primary"
          onClick={() => setLoadAttempt((attempt) => attempt + 1)}
        >
          {t('重新连接')}
        </button>
      </div>
    );
  if (!session)
    return (
      <JoinScreen
        onJoin={(joined) => {
          setSession(joined);
          setError('');
        }}
        initialError={localizeNotice(error)}
      />
    );
  return <Workspace session={session} info={info} onLeave={leave} />;
}
