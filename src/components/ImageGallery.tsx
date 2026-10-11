import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';
import Lightbox from 'yet-another-react-lightbox';
import Captions from 'yet-another-react-lightbox/plugins/captions';
import Counter from 'yet-another-react-lightbox/plugins/counter';
import Zoom from 'yet-another-react-lightbox/plugins/zoom';
import 'yet-another-react-lightbox/styles.css';
import 'yet-another-react-lightbox/plugins/captions.css';
import 'yet-another-react-lightbox/plugins/counter.css';
type GallerySlide = {
  src: string;
  alt: string;
  title: string;
  fileId: string;
  fileName: string;
};

export default function ImageGallery({
  slides,
  index,
  onClose,
}: {
  slides: GallerySlide[];
  index: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Lightbox
      open={true}
      close={onClose}
      index={index}
      slides={slides}
      plugins={[Zoom, Counter, Captions]}
      zoom={{ scrollToZoom: true, maxZoomPixelRatio: 2 }}
      captions={{ descriptionMaxLines: 2 }}
      labels={{
        Lightbox: t('图片查看器'),
        Close: t('关闭图片预览'),
        Previous: t('上一张'),
        Next: t('下一张'),
        'Zoom in': t('放大'),
        'Zoom out': t('缩小'),
      }}
      toolbar={{ buttons: ['zoom', 'close'] }}
      render={{
        slideFooter: ({ slide }) => {
          const current = slide as GallerySlide;
          return (
            <a
              className="outline-button"
              href={`/api/files/${encodeURIComponent(current.fileId)}`}
              download={current.fileName}
              aria-label={t('下载 {{name}}', { name: current.fileName })}
            >
              <Download size={16} />
              {t('下载原图')}
            </a>
          );
        },
      }}
    />
  );
}
