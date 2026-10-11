import { useTranslation } from 'react-i18next';
import { lazy, Suspense, useState } from 'react';
import type { Message } from '../types';
import { mediaKind } from '../media';

const ImageGallery = lazy(() => import('./ImageGallery'));

type FileRef = NonNullable<Message['file']>;
type GallerySlide = {
  src: string;
  alt: string;
  title: string;
  fileId: string;
  fileName: string;
};

export function MediaPreview({
  file,
  galleryFiles,
  onLoad,
}: {
  file: FileRef;
  galleryFiles: FileRef[];
  onLoad: () => void;
}) {
  const { t } = useTranslation();

  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  const image = mediaKind(file) === 'image';
  const video = mediaKind(file) === 'video';
  if (!image && !video) return null;
  if (failed)
    return (
      <p className="preview-unavailable">
        {t('此文件无法直接预览，可下载原文件查看。')}
      </p>
    );

  const base = `/api/files/${encodeURIComponent(file.id)}`;
  const imageFiles = galleryFiles.filter(
    (candidate) => mediaKind(candidate) === 'image',
  );
  const slides: GallerySlide[] = imageFiles.map((candidate) => ({
    src: `/api/files/${encodeURIComponent(candidate.id)}/media`,
    alt: candidate.name,
    title: candidate.name,
    fileId: candidate.id,
    fileName: candidate.name,
  }));
  const index = Math.max(
    0,
    imageFiles.findIndex((candidate) => candidate.id === file.id),
  );

  return (
    <>
      {image ? (
        <button
          className="image-preview"
          aria-label={t('查看大图 {{name}}', { name: file.name })}
          onClick={() => setOpen(true)}
        >
          <img
            src={`${base}/preview`}
            alt={t('预览 {{name}}', { name: file.name })}
            loading="lazy"
            onLoad={onLoad}
            onError={() => {
              setFailed(true);
              onLoad();
            }}
          />
        </button>
      ) : (
        <video
          className="video-preview"
          src={`${base}/media`}
          controls
          playsInline
          preload="none"
          aria-label={t('播放 {{name}}', { name: file.name })}
          onError={() => {
            setFailed(true);
            onLoad();
          }}
        />
      )}
      {image && open && (
        <Suspense
          fallback={
            <div className="gallery-loading" role="status">
              {t('正在加载…')}
            </div>
          }
        >
          <ImageGallery
            index={index}
            slides={slides}
            onClose={() => setOpen(false)}
          />
        </Suspense>
      )}
    </>
  );
}
