import { localizeNotice } from '../i18n';
import { useTranslation } from 'react-i18next';
import { useEffect, useState } from 'react';
import { Copy, Power, RefreshCw, ShieldCheck } from 'lucide-react';
import { api, copyText } from '../api';

export function HostPanel({ onCode }: { onCode?: (code: string) => void }) {
  const { t } = useTranslation();

  type Host = { code: string; internet?: string; joinLocked?: boolean };
  const [host, setHost] = useState<Host | null>(null);
  const [refreshingCode, setRefreshingCode] = useState(false);
  const [error, setError] = useState('');
  const [stopped, setStopped] = useState(false);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  useEffect(() => {
    if (!local) return;
    let active = true;
    const refresh = async () => {
      try {
        const data = await api<Host>('/api/host', {
          headers: { 'X-Linchuan-Host': '1' },
        });
        if (active) {
          setHost(data);
          setError('');
        }
      } catch {
        /* The service can be stopping or temporarily reconnecting. */
      }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [local]);
  if (!local || !host) return null;
  return (
    <section className="host-panel" aria-label={t('本机服务管理')}>
      <div className="host-label">
        <ShieldCheck size={16} />
        {t('这台电脑的连接码')}
      </div>
      <div className="host-code-row">
        <output className="host-code" aria-label={t('本机连接码')}>
          {host.code}
        </output>
        <div className="host-code-actions">
          <button
            type="button"
            className="icon-button"
            aria-label={t('刷新连接码')}
            title={t('刷新连接码')}
            disabled={stopped || refreshingCode}
            onClick={async () => {
              setRefreshingCode(true);
              try {
                const next = await api<Host>('/api/host/code', {
                  method: 'POST',
                  headers: { 'X-Linchuan-Host': '1' },
                });
                setHost((current) => ({ ...current, ...next }));
                setError(t('连接码已更新'));
              } catch (cause) {
                setError((cause as Error).message);
              } finally {
                setRefreshingCode(false);
              }
            }}
          >
            <RefreshCw size={17} />
          </button>
          <button
            type="button"
            className="icon-button"
            disabled={host.joinLocked || stopped}
            aria-label={t('复制连接码')}
            title={t('复制连接码')}
            onClick={async () => {
              if (await copyText(host.code)) setError(t('连接码已复制'));
              else setError(t('请选中连接码手动复制。'));
            }}
          >
            <Copy size={19} />
          </button>
        </div>
      </div>
      {host.joinLocked && (
        <p className="form-error" role="alert">
          {t('加入已暂停，请在服务电脑刷新连接码。')}
        </p>
      )}
      {onCode && (
        <div className="host-actions">
          <button
            type="button"
            className="text-button"
            disabled={host.joinLocked || stopped}
            onClick={() => onCode(host.code)}
          >
            {t('本机使用此码')}
          </button>
        </div>
      )}
      <p className="field-help host-status">
        <span className={`presence-dot ${stopped ? '' : 'online'}`} />
        {stopped
          ? t('服务已停止，双击启动邻传可重新打开。')
          : host.internet === 'connected'
            ? t('后台运行中 · 互联网通道已连接')
            : host.internet === 'disabled' || !host.internet
              ? t('后台运行中 · 局域网可用')
              : host.internet === 'error'
                ? t('局域网可用 · 互联网通道连接失败')
                : t('后台运行中 · 互联网通道连接中…')}
      </p>
      <button
        type="button"
        className="host-stop text-button"
        disabled={stopped}
        onClick={async () => {
          if (
            !window.confirm(
              t('停止邻传服务？其他设备会断开连接，已保存的聊天和文件会保留。'),
            )
          )
            return;
          try {
            await api('/api/host/stop', {
              method: 'POST',
              headers: { 'X-Linchuan-Host': '1' },
            });
            setStopped(true);
          } catch (cause) {
            setError((cause as Error).message);
          }
        }}
      >
        <Power size={14} />
        {t('停止后台服务')}
      </button>
      {error && (
        <p className="field-help" role="status">
          {localizeNotice(error)}
        </p>
      )}
    </section>
  );
}
