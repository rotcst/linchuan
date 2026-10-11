import { useTranslation } from 'react-i18next';
import { Monitor, Moon, Sun } from 'lucide-react';
import { useTheme, type ThemeMode } from '../theme';
import { SelectMenu, type SelectOption } from './SelectMenu';

export function ThemeSelector() {
  const { t } = useTranslation();
  const options: SelectOption<ThemeMode>[] = [
    {
      value: 'system',
      label: t('跟随系统'),
      icon: <Monitor size={17} aria-hidden="true" />,
    },
    {
      value: 'light',
      label: t('浅色'),
      icon: <Sun size={17} aria-hidden="true" />,
    },
    {
      value: 'dark',
      label: t('深色'),
      icon: <Moon size={17} aria-hidden="true" />,
    },
  ];

  const { mode, setMode } = useTheme();
  return (
    <SelectMenu
      value={mode}
      options={options}
      onValueChange={setMode}
      ariaLabel={t('外观主题')}
      className="theme-selector"
    />
  );
}
