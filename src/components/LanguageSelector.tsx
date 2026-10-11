import { useTranslation } from 'react-i18next';
import cn from 'flag-icons/flags/4x3/cn.svg';
import us from 'flag-icons/flags/4x3/us.svg';
import kr from 'flag-icons/flags/4x3/kr.svg';
import jp from 'flag-icons/flags/4x3/jp.svg';
import { type Language, setLanguage } from '../i18n';
import { SelectMenu } from './SelectMenu';

const languageOptions = [
  { value: 'zh', label: '简体中文', flag: cn },
  { value: 'en', label: 'English', flag: us },
  { value: 'ko', label: '한국어', flag: kr },
  { value: 'ja', label: '日本語', flag: jp },
] as const;

export function LanguageSelector() {
  const { t, i18n } = useTranslation();
  const selected =
    languageOptions.find((option) => option.value === i18n.resolvedLanguage) ||
    languageOptions[1];
  return (
    <SelectMenu<Language>
      value={selected.value}
      options={languageOptions.map(({ flag, ...option }) => ({
        ...option,
        icon: <img src={flag} alt="" aria-hidden="true" />,
      }))}
      onValueChange={(value) => void setLanguage(value)}
      ariaLabel={t('语言')}
      className="language-selector"
      hideLabel
    />
  );
}
