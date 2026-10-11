import { useTranslation } from 'react-i18next';
import {
  ChevronRight,
  MessageSquare,
  MessagesSquare,
  Settings,
  X,
} from 'lucide-react';
import type { Device } from '../types';
import { DeviceIcon } from './DeviceIcon';

export function Sidebar({
  devices,
  self,
  target,
  unread,
  onSelect,
  onSettings,
  onClose,
  open,
}: {
  devices: Device[];
  self: Device;
  target: string;
  unread: Record<string, number>;
  onSelect: (id: string) => void;
  onSettings: () => void;
  onClose: () => void;
  open: boolean;
}) {
  const { t } = useTranslation();

  const online = devices.filter((device) => device.online).length;
  return (
    <>
      <button
        className={`drawer-backdrop ${open ? 'visible' : ''}`}
        aria-label={t('关闭设备列表')}
        onClick={onClose}
        tabIndex={open ? 0 : -1}
      />
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar-heading">
          <h2>
            {t('在线设备')} <span>{online}</span>
          </h2>
          <button
            className="icon-button mobile-only"
            onClick={onClose}
            aria-label={t('关闭设备列表')}
          >
            <X size={20} />
          </button>
        </div>
        <nav aria-label={t('选择聊天对象')}>
          <button
            className={`device-row public-row ${target === 'all' ? 'active' : ''}`}
            onClick={() => onSelect('all')}
          >
            <span className="device-icon">
              <MessageSquare size={30} />
            </span>
            <span className="device-label">
              <strong>{t('公共聊天室')}</strong>
              <small>{t('发给所有在线设备')}</small>
            </span>
            {unread.all > 0 && (
              <span className="unread">
                {unread.all > 99 ? '99+' : unread.all}
              </span>
            )}
          </button>
          {devices.map((device) => (
            <button
              key={device.id}
              disabled={device.id === self.id}
              className={`device-row ${target === device.id ? 'active' : ''} ${!device.online ? 'offline' : ''}`}
              onClick={() => onSelect(device.id)}
            >
              <span className="device-icon">
                <DeviceIcon type={device.type} size={29} />
              </span>
              <span className="device-label">
                <strong>{device.name}</strong>
                <small>
                  {device.id === self.id
                    ? t('本机')
                    : device.online
                      ? t('在线')
                      : t('离线 · 可留言')}
                </small>
              </span>
              {unread[device.id] > 0 ? (
                <span className="unread">
                  {unread[device.id] > 99 ? '99+' : unread[device.id]}
                </span>
              ) : (
                <span
                  className={`presence-dot ${device.online ? 'online' : ''}`}
                />
              )}
            </button>
          ))}
        </nav>
        {devices.length <= 1 && (
          <div className="device-hint">
            <MessagesSquare size={22} />
            <p>
              {t('其他设备加入后，')}
              <br />
              {t('会出现在这里。')}
            </p>
          </div>
        )}
        <div className="self-profile">
          <div className="self-identity">
            <DeviceIcon type={self.type} size={30} />
            <div className="device-label">
              <strong>{self.name}</strong>
              <small>
                {self.type === 'phone'
                  ? t('手机')
                  : self.type === 'tablet'
                    ? t('平板')
                    : t('电脑')}{' '}
                · {t('本机')}
              </small>
            </div>
          </div>
          <button
            className="profile-settings"
            onClick={onSettings}
            aria-label={t('设备设置')}
            title={t('设备设置')}
          >
            <Settings size={26} />
            <span>{t('设置')}</span>
            <ChevronRight size={19} />
          </button>
        </div>
      </aside>
    </>
  );
}
