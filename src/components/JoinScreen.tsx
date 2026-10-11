import { localizeNotice } from '../i18n';
import { useTranslation } from 'react-i18next';
import { useState } from 'react';
import {
  ArrowRight,
  Laptop,
  ShieldCheck,
  Smartphone,
  Tablet,
} from 'lucide-react';
import { api, PROFILE_KEY, savedProfile, TOKEN_KEY } from '../api';
import type { DeviceType, Session } from '../types';
import { HostPanel } from './HostPanel';
import { Brand } from './Brand';
import { ThemeSelector } from './ThemeSelector';
import { LanguageSelector } from './LanguageSelector';

export function JoinScreen({
  onJoin,
  initialError,
}: {
  onJoin: (session: Session) => void;
  initialError: string;
}) {
  const { t } = useTranslation();

  const [profile, setProfile] = useState(savedProfile);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError);
  return (
    <main className="join-page">
      <header className="join-brand">
        <Brand />
        <div className="header-tools">
          <LanguageSelector />
          <ThemeSelector />
        </div>
      </header>
      <section className="join-shell">
        <div className="join-intro">
          <div className="join-device-art">
            <Laptop size={60} strokeWidth={1.4} />
            <span className="connection-dots">
              <i />
              <i />
              <i />
            </span>
            <Smartphone size={42} strokeWidth={1.4} />
          </div>
          <h1>
            {t('设备在身边，')}
            <br />
            {t('文件和消息也是。')}
          </h1>
          <p>
            {t('让家里的电脑和手机连起来。')}
            <br />
            {t('不用数据线，也不用把文件发到云端。')}
          </p>
          <div className="join-feature">
            <ShieldCheck size={20} />
            <span>{t('连接码加入 · 局域网 / 互联网互传')}</span>
          </div>
        </div>
        <form
          className="join-form"
          onSubmit={async (event) => {
            event.preventDefault();
            setError('');
            setBusy(true);
            try {
              const session = await api<Session>('/api/join', {
                method: 'POST',
                body: JSON.stringify({
                  ...profile,
                  name: profile.name.trim(),
                  code,
                }),
              });
              localStorage.setItem(TOKEN_KEY, session.token);
              localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
              onJoin(session);
            } catch (cause) {
              setError((cause as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2>{t('连接你的设备')}</h2>
          <p className="muted">
            {t('给当前设备起个名字，就能被其他设备找到。')}
          </p>
          <HostPanel onCode={setCode} />
          <label htmlFor="device-name">{t('设备名称')}</label>
          <input
            id="device-name"
            required
            maxLength={30}
            value={profile.name}
            autoComplete="off"
            onChange={(event) =>
              setProfile({ ...profile, name: event.target.value })
            }
            placeholder={t('例如：书房电脑')}
          />
          <label>{t('设备类型')}</label>
          <div className="type-selector">
            {(
              [
                { type: 'computer', title: t('电脑'), Icon: Laptop },
                { type: 'phone', title: t('手机'), Icon: Smartphone },
                { type: 'tablet', title: t('平板'), Icon: Tablet },
              ] as const
            ).map(({ type, title, Icon }) => (
              <button
                type="button"
                key={type}
                className={profile.type === type ? 'selected' : ''}
                aria-pressed={profile.type === type}
                onClick={() =>
                  setProfile({ ...profile, type: type as DeviceType })
                }
              >
                <Icon size={20} />
                {title}
              </button>
            ))}
          </div>
          <label htmlFor="join-code">{t('6 位连接码')}</label>
          <input
            id="join-code"
            className="code-input"
            value={code}
            onChange={(event) =>
              setCode(event.target.value.replace(/\D/g, '').slice(0, 6))
            }
            inputMode="numeric"
            pattern="[0-9]{6}"
            required
            autoComplete="one-time-code"
            placeholder={t('输入服务电脑页面上的连接码')}
          />
          <p className="field-help">
            {t('连接码显示在服务电脑的本机邻传页面中。')}
          </p>
          {error && (
            <p className="form-error" role="alert">
              {localizeNotice(error)}
            </p>
          )}
          <button
            className="primary join-submit"
            disabled={busy || !profile.name.trim() || code.length !== 6}
          >
            {busy ? t('正在连接…') : t('进入聊天室')}
            <ArrowRight size={18} />
          </button>
          <p className="join-note">
            {t('家中使用局域网地址，外出使用 HTTPS 入口。')}
            <br />
            {t('服务电脑保持开机，邻传在后台运行。')}
          </p>
        </form>
      </section>
      <p className="join-footer">
        {t('邻传 · 让身边和远方的设备，成为你的共享空间')}
      </p>
    </main>
  );
}
