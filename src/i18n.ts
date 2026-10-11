import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import zh from './locales/zh.json';
import en from './locales/en.json';
import ko from './locales/ko.json';
import ja from './locales/ja.json';

export const LANGUAGE_KEY = 'linchuan-language';
export const languages = ['zh', 'en', 'ko', 'ja'] as const;
export type Language = (typeof languages)[number];
export const localeTags: Record<Language, string> = {
  zh: 'zh-CN',
  en: 'en-US',
  ko: 'ko-KR',
  ja: 'ja-JP',
};
export function detectLanguage(preferences: readonly string[]): Language {
  for (const value of preferences) {
    const base = value.toLowerCase().split(/[-_]/)[0];
    if (languages.includes(base as Language)) return base as Language;
  }
  return 'en';
}
function initialLanguage(): Language {
  try {
    const saved = localStorage.getItem(LANGUAGE_KEY);
    if (languages.includes(saved as Language)) return saved as Language;
  } catch {
    /* Browser storage may be unavailable. */
  }
  return detectLanguage(
    typeof navigator === 'undefined' ? ['zh'] : navigator.languages,
  );
}
void i18n.use(initReactI18next).init({
  resources: {
    zh: { translation: zh },
    en: { translation: en },
    ko: { translation: ko },
    ja: { translation: ja },
  },
  lng: initialLanguage(),
  fallbackLng: 'en',
  supportedLngs: languages,
  keySeparator: false,
  nsSeparator: false,
  initAsync: false,
  interpolation: { escapeValue: false },
});
function syncDocument(language: string) {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = localeTags[language as Language] || 'en-US';
  document.title = `${i18n.t('邻传')} · ${i18n.t('设备互传')}`;
}
syncDocument(i18n.language);
i18n.on('languageChanged', syncDocument);
export async function setLanguage(language: Language) {
  if (!languages.includes(language)) return;
  try {
    localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    /* Keep the in-memory choice. */
  }
  await i18n.changeLanguage(language);
}
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (
      event.key === LANGUAGE_KEY &&
      languages.includes(event.newValue as Language)
    ) {
      void i18n.changeLanguage(event.newValue as Language);
    }
  });
}
export const translate = (
  key: string,
  values?: Record<string, string | number>,
) => String(i18n.t(key, values));
export const currentLocale = () =>
  localeTags[i18n.resolvedLanguage as Language] || 'en-US';
const noticeKeys = new Map<string, string>();
for (const catalog of [zh, en, ko, ja]) {
  for (const [key, value] of Object.entries(catalog))
    noticeKeys.set(value, key);
}
export function localizeNotice(message: string) {
  const key = noticeKeys.get(message);
  return key ? translate(key) : message;
}
export function translateError(message: unknown, status?: number): string {
  if (typeof message === 'string' && Object.hasOwn(zh, message))
    return translate(message);
  return translate('请求失败（{{status}}）', { status: status || '—' });
}
export default i18n;
