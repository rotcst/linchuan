import { useTranslation } from 'react-i18next';
import { Check, Copy, FileText } from 'lucide-react';
import { useId, useState } from 'react';
import { copyText } from '../api';
import type { Connection, ServerInfo } from '../types';
import { HostPanel } from './HostPanel';
import { SelectMenu } from './SelectMenu';

export function InvitePanel({
  info,
}: {
  info: ServerInfo | null;
  connection: Connection;
}) {
  const { t } = useTranslation();
  const addressId = useId();

  const [index, setIndex] = useState(() =>
    Math.max(0, info?.urls.indexOf(location.origin) ?? 0),
  );
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const url = info?.urls[index] || location.origin;
  return (
    <div className="invite-content">
      <h2>{t('连接设备')}</h2>
      <p className="inspector-subtitle">{t('扫码或输入地址加入')}</p>
      <HostPanel />
      <div className="qr-frame">
        <img
          src={`/api/qr?url=${encodeURIComponent(url)}`}
          alt={t('扫码打开 {{url}}', { url })}
          width="170"
          height="170"
        />
      </div>
      {info && info.urls.length > 1 && (
        <div className="address-select">
          <label htmlFor={addressId}>{t('选择连接入口')}</label>
          <SelectMenu
            id={addressId}
            ariaLabel={t('局域网地址')}
            className="address-selector"
            value={String(index)}
            options={info.urls.map((address, i) => ({
              value: String(i),
              label: address,
            }))}
            onValueChange={(value) => {
              setIndex(Number(value));
              setCopied(false);
              setCopyFailed(false);
            }}
          />
        </div>
      )}
      <div className="address-row">
        <input
          readOnly
          aria-label={t('连接地址')}
          value={url.replace(/^http:\/\//, '')}
          onClick={(event) => event.currentTarget.select()}
        />
        <button
          className="outline-button"
          onClick={async () => {
            const ok = await copyText(url);
            setCopied(ok);
            setCopyFailed(!ok);
            if (ok) setTimeout(() => setCopied(false), 2000);
          }}
        >
          <span className="copy-icon">
            {copied ? <Check size={15} /> : <Copy size={15} />}
          </span>
          {copied ? t('已复制') : t('复制地址')}
        </button>
      </div>
      {copyFailed && (
        <p className="field-help">{t('请长按或选中上方地址，手动复制。')}</p>
      )}
      <p className="invite-help">
        {t('手机扫描二维码，电脑输入上面的地址。')}
        <br />
        {t('再输入服务电脑页面上的 6 位连接码。')}
      </p>
      <div className="storage-note" title={t('不限制文件类型与大小')}>
        <FileText size={32} />
        <div>
          <strong>
            {info?.expiresHours
              ? t('文件保留 {{hours}} 小时', { hours: info.expiresHours })
              : t('文件与聊天持久保存')}
          </strong>
          <p>{t('保存在服务电脑，重启后保留。')}</p>
          <p>{t('删除聊天记录仅影响本设备。')}</p>
        </div>
      </div>
    </div>
  );
}
