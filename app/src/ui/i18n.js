// i18n infrastructure for UI v2 (issues #511, #512, #513, #586).
//
// Screen dictionaries are locales/{en,ru,de,fr,es,pt,sr}.json. Imported from
// main.jsx before the first render so useTranslation sees a ready instance.
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import {
  applyDocumentLanguage,
  resolveInitialLanguage,
  SUPPORTED_LANGUAGES,
} from './language';
import en from './locales/en.json';
import ru from './locales/ru.json';
import de from './locales/de.json';
import fr from './locales/fr.json';
import es from './locales/es.json';
import pt from './locales/pt.json';
import sr from './locales/sr.json';

const initialLanguage = resolveInitialLanguage();

void i18n.use(initReactI18next).init({
  resources: {
    en: { translation: en },
    ru: { translation: ru },
    de: { translation: de },
    fr: { translation: fr },
    es: { translation: es },
    pt: { translation: pt },
    sr: { translation: sr },
  },
  lng: initialLanguage,
  fallbackLng: 'en',
  supportedLngs: [...SUPPORTED_LANGUAGES],
  interpolation: { escapeValue: false },
  // Detect the browser only when mf_lang is empty. A manual choice writes storage
  // from LanguageDropdown, not from languageChanged — otherwise the default would become a "choice".
  initImmediate: true,
});

applyDocumentLanguage(i18n.resolvedLanguage || initialLanguage);

i18n.on('languageChanged', (lng) => {
  applyDocumentLanguage(lng);
});

export default i18n;
