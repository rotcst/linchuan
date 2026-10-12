import { localizeNotice } from '../i18n';
import { useTranslation } from 'react-i18next';
import { useEffect, useRef, useState } from 'react';
import { Download, X } from 'lucide-react';
import type { Message } from '../types';
import { isPhoneBrowser } from '../media';
import { networkFetch } from '../network';

export function SaveToPhone({ file }: { file: NonNullable<Message['file']> }) {
  const { t } = useTranslation();

  const [guide, setGuide] = useState(false);
  const [busy, setBusy] = useState(false);
  const [prepared, setPrepared] = useState<File | null>(null);
  const [hint, setHint] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (guide) dialog.current?.showModal();
  }, [guide]);
  const phone = isPhoneBrowser();
  if (!phone) return null;
  const base = `/api/files/${encodeURIComponent(file.id)}`;
  const showGuide = () => {
    setGuide(true);
  };
  return (
    <>
      <button
        className="text-button phone-save"
        disabled={busy}
        onClick={async () => {
          setHint('');
          if (prepared) {
            try {
              await navigator.share({ files: [prepared] });
            } catch (cause) {
              if ((cause as Error).name !== 'AbortError') showGuide();
            } finally {
              setPrepared(null);
            }
            return;
          }
          if (
            !window.isSecureContext ||
            !navigator.share ||
            !navigator.canShare ||
            file.size > 64 * 1024 ** 2
          ) {
            showGuide();
            return;
          }
          setBusy(true);
          try {
            const response = await networkFetch(`${base}/media`, {
              signal: AbortSignal.timeout(60000),
            });
            if (!response.ok)
              throw new Error(t('无法读取原文件，请重试或下载。'));
            const sharedFile = new File([await response.blob()], file.name, {
              type: file.mime,
            });
            if (!navigator.canShare({ files: [sharedFile] })) showGuide();
            else {
              setPrepared(sharedFile);
              setHint(t('原文件已准备好，点击打开系统菜单后选择保存。'));
            }
          } catch (cause) {
            setHint((cause as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Download size={16} />
        {busy ? t('准备中…') : prepared ? t('保存菜单') : t('保存')}
      </button>
      {hint && <p className="field-help">{localizeNotice(hint)}</p>}
      {guide && (
        <dialog
          ref={dialog}
          className="phone-save-guide modal"
          aria-label={t('保存到手机')}
          onClose={() => setGuide(false)}
        >
          <button
            className="modal-close icon-button"
            aria-label={t('关闭手机保存说明')}
            onClick={() => dialog.current?.close()}
          >
            <X size={20} />
          </button>
          <h2>{t('保存到手机')}</h2>
          <p>
            {t('图片：打开原图后，长按图片，选择“存储到照片”或“保存图片”。')}
          </p>
          <p>
            {t(
              '视频：打开原视频，在浏览器或系统分享菜单中选择“存储视频”。如果没有此选项，可先下载，再从“文件”中导入相册。',
            )}
          </p>
          <div className="phone-save-actions">
            <a
              className="outline-button"
              href={`${base}/media`}
              target="_blank"
              rel="noreferrer"
            >
              {t(file.mime.startsWith('video/') ? '打开原视频' : '打开原图')}
            </a>
            <a className="outline-button" href={base} download={file.name}>
              {t('下载原文件')}
            </a>
          </div>
        </dialog>
      )}
    </>
  );
}
