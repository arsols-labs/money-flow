// Helper/UI suites that still assert the original Russian copy.
// Default product language is `en`; restore it after the file finishes.
import { afterAll, beforeAll } from 'vitest';
import i18n from '../src/ui/i18n.js';

beforeAll(async () => {
  await i18n.changeLanguage('ru');
});

afterAll(async () => {
  await i18n.changeLanguage('en');
});
