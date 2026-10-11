import { useTranslation } from 'react-i18next';
import { ArrowRightLeft } from 'lucide-react';

export function Brand() {
  const { t } = useTranslation();

  return (
    <div className="brand">
      <span className="brand-mark">
        <ArrowRightLeft size={23} />
      </span>
      <strong>{t('邻传')}</strong>
      <span className="brand-tagline">{t('设备互传')}</span>
    </div>
  );
}
