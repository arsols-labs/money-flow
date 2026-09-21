import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RecurringItemForm } from '../src/ui/RecurringSection.jsx';
import { PlannedItemForm } from '../src/ui/PlannedSection.jsx';
import { OperationForm } from '../src/ui/OperationsSection.jsx';
import i18n from '../src/ui/i18n.js';

const accounts = [
  { id: 1, name: 'Счёт в банке', currency: 'RSD', archived: false },
  { id: 2, name: 'Наличные EUR', currency: 'EUR', archived: false },
];

describe('Data form kind toggles (Section 12 of Design Spec)', () => {
  describe('RecurringItemForm', () => {
    it('по умолчанию выбирает «Расход» с классами data-kind-btn--expense data-kind-btn--active и aria-pressed="true"', () => {
      const html = renderToStaticMarkup(
        React.createElement(RecurringItemForm as any, {
          initial: null,
          accounts,
          onSubmit: async () => {},
          onCancel: () => {},
          submitLabel: 'Добавить',
        }),
      );

      expect(html).toContain(`role="group" aria-label="${i18n.t('data.recurring.fieldTypeAria')}"`);
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--expense data-kind-btn--active"[^>]*aria-pressed="true"[^>]*>\\s*${i18n.t('data.recurring.expense')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.recurring.income')}\\s*</button>`),
      );
    });

    it('при начальном доходе (amount_minor > 0) активирует «Доход» с data-kind-btn--income data-kind-btn--active', () => {
      const initial = {
        id: 10,
        title: 'Зарплата',
        amount_minor: 25000000,
        currency: 'RSD',
        account_id: 1,
        frequency: 'monthly',
        interval_count: 1,
        day_of_month: 5,
        next_due_date: '2026-10-05',
      };

      const html = renderToStaticMarkup(
        React.createElement(RecurringItemForm as any, {
          initial,
          accounts,
          onSubmit: async () => {},
          onCancel: () => {},
          submitLabel: 'Сохранить',
        }),
      );

      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--expense\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.recurring.expense')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income data-kind-btn--active"[^>]*aria-pressed="true"[^>]*>\\s*${i18n.t('data.recurring.income')}\\s*</button>`),
      );
    });
  });

  describe('PlannedItemForm', () => {
    it('рендерит переключатель с role="group", семантическими классами и aria-pressed', () => {
      const html = renderToStaticMarkup(
        React.createElement(PlannedItemForm as any, {
          initial: null,
          accounts,
          onSubmit: async () => {},
          onCancel: () => {},
          submitLabel: 'Добавить',
        }),
      );

      expect(html).toContain(`role="group" aria-label="${i18n.t('data.planned.fieldTypeAria')}"`);
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--expense data-kind-btn--active"[^>]*aria-pressed="true"[^>]*>\\s*${i18n.t('data.planned.expense')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.planned.income')}\\s*</button>`),
      );
    });

    it('при доходе подсвечивает кнопку «Доход»', () => {
      const initial = {
        id: 20,
        title: 'Премия',
        amount_minor: 500000,
        currency: 'RSD',
        account_id: 1,
        date: '2026-09-15',
        done: false,
      };

      const html = renderToStaticMarkup(
        React.createElement(PlannedItemForm as any, {
          initial,
          accounts,
          onSubmit: async () => {},
          onCancel: () => {},
          submitLabel: 'Сохранить',
        }),
      );

      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--expense\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.planned.expense')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income data-kind-btn--active"[^>]*aria-pressed="true"[^>]*>\\s*${i18n.t('data.planned.income')}\\s*</button>`),
      );
    });
  });

  describe('OperationForm', () => {
    it('рендерит переключатель с role="group", 4 кнопками и корректным aria-pressed', () => {
      const html = renderToStaticMarkup(
        React.createElement(OperationForm as any, {
          initial: null,
          accounts,
          onSubmit: async () => {},
          onCancel: () => {},
          submitLabel: 'Добавить',
        }),
      );

      expect(html).toContain(`role="group" aria-label="${i18n.t('data.operations.fieldKindAria')}"`);
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--expense data-kind-btn--active"[^>]*aria-pressed="true"[^>]*>\\s*${i18n.t('data.operations.kind.expense')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.operations.kind.income')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--income\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.operations.kind.refund')}\\s*</button>`),
      );
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="data-kind-btn data-kind-btn--transfer\\s*"[^>]*aria-pressed="false"[^>]*>\\s*${i18n.t('data.operations.kind.transfer')}\\s*</button>`),
      );
      expect(html).toContain(i18n.t('data.operations.fieldComment'));
      expect(html).toContain(i18n.t('data.operations.fieldFiscalReceiptId'));
      expect(html).toContain(i18n.t('data.operations.fieldReceiptUrl'));
    });
  });
});
