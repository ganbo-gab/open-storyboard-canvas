import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zh from './locales/zh.json';
import en from './locales/en.json';
import reworkZh from './locales/rework.zh.json';
import reworkEn from './locales/rework.en.json';

// Per-surface UI strings live in `locales/ui/<surface>.<lang>.json` and resolve under `ui.<surface>.*`.
const surfaceModules = import.meta.glob<{ default: Record<string, unknown> }>(
  './locales/ui/*.json',
  { eager: true }
);

function surfaceStrings(language: 'zh' | 'en'): Record<string, unknown> {
  const strings: Record<string, unknown> = {};
  for (const [path, module] of Object.entries(surfaceModules)) {
    const match = /\/([\w-]+)\.(zh|en)\.json$/.exec(path);
    if (match && match[2] === language) strings[match[1]] = module.default;
  }
  return strings;
}

const resources = {
  zh: { translation: { ...zh, rework: reworkZh, ui: surfaceStrings('zh') } },
  en: { translation: { ...en, rework: reworkEn, ui: surfaceStrings('en') } },
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'zh',
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ['localStorage', 'navigator'],
      caches: ['localStorage'],
    },
  });

export default i18n;
