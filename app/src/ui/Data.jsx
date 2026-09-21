// Экран «Данные»: счета с правкой баланса в одно касание и курсы валют рядом.
// Баланс — редактируемое поле (не сумма транзакций), см. docs/2026-08-09-v2-simple-spec.md.
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, Archive, ArchiveRestore, Trash2, ChevronDown, ChevronRight, AlertTriangle, Check,
  Search, SlidersHorizontal, X, RotateCcw,
} from 'lucide-react';
import { api } from './api';
import { SectionSkeleton, InlineEditable, DataSection } from './components';
import { suggestedNameUpdate, findSimilarAccount } from './accounts';
import { sectionFromHash } from './dataSections';
import {
  DATA_BLOCK_DEFS,
  DEFAULT_DATA_CONFIG,
  DEFAULT_DATA_FILTERS,
  loadDataConfig,
  saveDataConfig,
  resetDataConfig,
  loadDataFilters,
  saveDataFilters,
  resetDataFilters,
  toggleBlockVisibility,
} from './dataLayout';
import { blockTitle } from './i18nLabels';
import DashboardSettingsModal from './DashboardSettingsModal';
import BackupSection from './BackupSection';
import ResetSection from './ResetSection';
import {
  formatMinor, minorToInputString, parseAmountToMinor,
  normalizeRateInput, formatRelativeDate, daysSince, STALE_RATE_DAYS,
} from './money';
import PlannedSection from './PlannedSection';
import RecurringSection from './RecurringSection';
import OperationsSection from './OperationsSection';
import FiscalReceiptsSection from './FiscalReceiptsSection';
import { useRefreshNonce } from './RefreshContext';

// Порог сверки баланса — по образцу курсов, но вдвое короче, и это не вкусовое
// число. Курс между вводами меняется на проценты и правится редко; баланс
// двигают зарплата, аренда и продукты, то есть за две недели он расходится с
// банком практически наверняка, а прогноз (S1-4) стартует именно от него.
// Константа, а не настройка в settings: отдельную ручку заводить только по
// явному желанию владельца (issue #223).
const STALE_BALANCE_DAYS = 14;

function accountMeta(acc) {
  return [acc.bank, acc.type, acc.account_number, acc.owner, acc.country].filter(Boolean).join(' · ');
}

// existingAccounts — список для предупреждения о похожем счёте; нужен только
// форме создания, у формы правки его нет (и предупреждения там тоже нет).
//
// Алиасы (issue #339) привязываются к уже существующему счёту, поэтому
// редактор показывается только в форме правки (initial задан). Сами вызовы API
// берутся из импортированного `api` — отдельный проп не нужен.
function AccountForm({ initial, onSubmit, onCancel, submitLabel, existingAccounts = [] }) {
  const { t } = useTranslation();
  const [form, setForm] = useState(() => ({
    name: initial?.name ?? '',
    currency: initial?.currency ?? 'USD',
    bank: initial?.bank ?? '',
    type: initial?.type ?? '',
    account_number: initial?.account_number ?? '',
    owner: initial?.owner ?? '',
    country: initial?.country ?? 'Global',
    balance: initial ? minorToInputString(initial.balance_minor, initial.currency || 'USD') : '0',
  }));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  // Редактор алиасов живёт внутри формы правки и держит локальную копию списка
  // счёта — чтобы удаление/добавление не перечитывали весь экран «Данные»,
  // а обновляли только себя. Форма монтируется заново при разворачивании
  // строки, поэтому локальное состояние инициализируется актуальным initial.
  const aliasEditor = useAliasEditor(initial?.id, initial?.aliases ?? []);

  // Баланс в форме берётся из initial один раз, при монтировании, а форма
  // живёт всё время, пока строка развёрнута. За это время баланс можно
  // поправить инлайном в шапке той же строки — и тогда форма держала бы
  // устаревшее число, а сохранение со сменой валюты откатило бы свежую
  // правку, пометив её как только что подтверждённую. Поэтому поле
  // подтягивается заново, когда с сервера пришёл другой баланс; всё
  // остальное, что пользователь успел набрать, при этом не трогается.
  const syncedBalanceRef = useRef(initial?.balance_minor);
  // Набранное руками не перетирается никогда: явный ввод — сигнал намерения
  // сильнее, чем подставленное значение. Иначе правка баланса инлайном
  // затирала бы уже введённую сумму в новой валюте, да ещё форматируя её по
  // старой: набранные $34.00 превращались бы в 5100 (¥) и уходили как $5100.
  const balanceTouchedRef = useRef(false);
  useEffect(() => {
    if (!initial || syncedBalanceRef.current === initial.balance_minor) return;
    syncedBalanceRef.current = initial.balance_minor;
    if (balanceTouchedRef.current) return;
    setForm((f) => ({ ...f, balance: minorToInputString(initial.balance_minor, initial.currency) }));
  }, [initial]);

  // Валюта вернулась к исходной — поле баланса спряталось, и его содержимое
  // больше ничего не значит. Сбрасываем отметку «трогали», чтобы при
  // следующей смене валюты подставилось актуальное серверное число, а не
  // остатки прошлой попытки.
  const currencyMatchesInitial = Boolean(initial) && form.currency.trim().toUpperCase() === initial.currency;
  useEffect(() => {
    if (currencyMatchesInitial) balanceTouchedRef.current = false;
  }, [currencyMatchesInitial]);

  // Имя по умолчанию — «Вид · Валюта · Страна», как только тройка заполнена
  // (issue #235). Только при создании: у существующего счёта имя уже есть, и
  // подстановка поверх него затирала бы данные, а не подсказывала. Поэтому у
  // формы правки отметка «трогали» стоит с самого начала.
  const nameTouchedRef = useRef(Boolean(initial));
  useEffect(() => {
    const suggested = suggestedNameUpdate(form, { touched: nameTouchedRef.current });
    if (suggested !== null) setForm((f) => ({ ...f, name: suggested }));
  }, [form]);

  const set = (key) => (e) => {
    if (key === 'balance') balanceTouchedRef.current = true;
    if (key === 'name') nameTouchedRef.current = true;
    setForm((f) => ({ ...f, [key]: e.target.value }));
  };

  // Похожий счёт — предупреждение, а не запрет: правило прямо называет два
  // счёта с одной тройкой (владелец, валюта, страна) законными — «кошелёк» и
  // «дома в сейфе» одного человека. Поэтому кнопка «Создать» остаётся
  // активной, а предупреждение просто стоит перед ней. Имя в сравнении не
  // участвует: одинаковые имена допустимы по тому же правилу.
  const similarAccount = initial ? null : findSimilarAccount(existingAccounts, form);

  // Смена валюты у существующего счёта открывает поле баланса: сумма должна
  // быть названа в новой валюте явно (см. комментарий в submit).
  const currencyChanged = Boolean(initial) && form.currency.trim().toUpperCase() !== initial.currency;

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const name = form.name.trim();
    const currency = (form.currency.trim() || 'USD').toUpperCase();
    const owner = form.owner.trim();
    let country = form.country.trim();
    if (!country) {
      country = 'Global';
    }
    if (!name) { setError(t('data.accounts.nameRequired')); return; }
    if (!currency) { setError(t('data.accounts.currencyRequired')); return; }
    // Владелец обязателен — сервер его пустым не примет
    if (!owner) { setError(t('data.accounts.ownerRequired')); return; }

    const payload = { name, currency, owner, country };
    // Необязательные поля: в режиме правки шлются явно (даже пустыми — это
    // очистка), при создании пустые просто не отправляем.
    for (const key of ['bank', 'type', 'account_number']) {
      const v = form[key].trim();
      if (initial || v) payload[key] = v;
    }

    // Баланс уходит в payload при создании счёта и при смене валюты. Второе —
    // не удобство, а требование сервера: balance_minor хранится в минорных
    // единицах своей валюты, и у USD с JPY они разной разрядности, так что
    // сумму нужно назвать заново, а не унаследовать молча.
    if (!initial || currency !== initial.currency) {
      try {
        // Пустое поле считается нулём только при создании счёта. При смене
        // валюты это подтверждение суммы, и пустота там означает «не ввёл», а
        // не «ноль»: подставленный ноль обнулил бы баланс молча и с отметкой
        // «обновлён только что».
        payload.balance_minor = parseAmountToMinor(initial ? form.balance : form.balance || '0', currency);
      } catch (err) {
        setError(err.message);
        return;
      }
    }

    setBusy(true);
    try {
      await onSubmit(payload);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="data-form" onSubmit={submit}>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldName')}</span>
        <input value={form.name} onChange={set('name')} disabled={busy} placeholder={t('data.accounts.placeholderName')} autoFocus />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldCurrency')}</span>
        <input value={form.currency} onChange={set('currency')} disabled={busy} placeholder={t('data.accounts.placeholderCurrency')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldBank')}</span>
        <input value={form.bank} onChange={set('bank')} disabled={busy} placeholder={t('data.accounts.placeholderBank')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldType')}</span>
        <input value={form.type} onChange={set('type')} disabled={busy} placeholder={t('data.accounts.placeholderType')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldAccountNumber')}</span>
        <input value={form.account_number} onChange={set('account_number')} disabled={busy} placeholder={t('data.accounts.placeholderAccountNumber')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldOwner')}</span>
        <input value={form.owner} onChange={set('owner')} disabled={busy} placeholder={t('data.accounts.placeholderOwner')} />
      </label>
      <label className="data-form-field">
        <span>{t('data.accounts.fieldCountry')}</span>
        <input value={form.country} onChange={set('country')} disabled={busy} placeholder={t('data.accounts.placeholderCountry')} />
      </label>
      {(!initial || currencyChanged) && (
        <label className="data-form-field">
          <span>{initial ? t('data.accounts.fieldBalanceIn', { currency: form.currency.trim().toUpperCase() }) : t('data.accounts.fieldStartingBalance')}</span>
          <input value={form.balance} onChange={set('balance')} disabled={busy} inputMode="decimal" placeholder="0.00" />
          {currencyChanged && (
            <small className="data-form-hint">
              {t('data.accounts.currencyChangedHint')}
            </small>
          )}
        </label>
      )}
      {similarAccount && (
        <div className="data-warning" role="status">
          <AlertTriangle size={14} className="data-warning-icon" />
          <div className="data-warning-body">
            <p>
              {t('data.accounts.similarAccount', { name: similarAccount.name })}
            </p>
          </div>
        </div>
      )}
      {/* Редактор алиасов — только в форме правки существующего счёта
          (initial задан): алиасы привязываются к уже созданному счёту. У формы
          создания initial нет, и пустой блок там бессмысленен. */}
      {initial && aliasEditor}
      {error && <div className="data-form-error">{error}</div>}
      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>
          {busy ? t('common.saving') : submitLabel}
        </button>
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

// Редактор алиасов счёта (issue #339): привязка виртуальных карт к реальному
// счёту. Живёт внутри формы правки существующего счёта (`initial` задан) —
// алиасы имеют смысл только у уже созданного счёта.
//
// Держит ЛОКАЛЬНУЮ копию списка алиасов счёта и правит её сам, без
// перечитывания всего экрана «Данные»: добавление/удаление алиаса к счёту не
// меняет ни его баланс, ни набор счетов, поэтому гонять GET /accounts за этим
// нет смысла. Свежий список подхватывается, лишь когда форма монтируется
// заново (разворачивание строки) — аргумент `initialAliases`.
//
// Возвращает готовый блок JSX, чтобы AccountForm не тащил его состояние.
function useAliasEditor(accountId, initialAliases) {
  const { t } = useTranslation();
  const [aliases, setAliases] = useState(() => (initialAliases || []).slice());
  const [newAlias, setNewAlias] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  // Алиасы могут поменяться снаружи (перечитывание счетов после правки
  // баланса и т.п.) — но форма живёт внутри развёрнутой строки и обычно
  // перемонтируется при таких действиях. Подхватываем свежий список, только
  // когда он реально изменился по ссылке, чтобы не тереть ручной ввод.
  const incoming = initialAliases || [];
  useEffect(() => {
    setAliases((cur) => (cur === incoming ? cur : incoming.slice()));
  }, [incoming]);

  const add = async (e) => {
    e.preventDefault();
    setErr(null);
    const text = newAlias.trim();
    if (!text) {
      setErr(t('data.accounts.aliasesRequired'));
      return;
    }
    setBusy(true);
    try {
      const res = await api.addAccountAlias(accountId, text);
      setAliases((cur) => [...cur, res.alias]);
      setNewAlias('');
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (aliasId) => {
    setErr(null);
    setBusy(true);
    try {
      await api.deleteAccountAlias(accountId, aliasId);
      setAliases((cur) => cur.filter((a) => a.id !== aliasId));
    } catch (e2) {
      setErr(e2.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="alias-editor">
      <div className="alias-editor-title">{t('data.accounts.aliasesTitle')}</div>
      <p className="data-form-note">
        {t('data.accounts.aliasesDescription')}
      </p>
      {aliases.length === 0 ? (
        <p className="alias-empty">{t('data.accounts.aliasesEmpty')}</p>
      ) : (
        <ul className="alias-list">
          {aliases.map((a) => (
            <li key={a.id} className="alias-item">
              <span className="alias-text">{a.alias_text}</span>
              <button
                type="button"
                className="icon-btn alias-remove"
                onClick={() => remove(a.id)}
                disabled={busy}
                aria-label={t('data.accounts.aliasesDeleteAria', { alias: a.alias_text })}
              >
                <Trash2 size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className="alias-add" onSubmit={add}>
        <input
          value={newAlias}
          onChange={(e) => setNewAlias(e.target.value)}
          disabled={busy}
          placeholder={t('data.accounts.aliasesPlaceholder')}
        />
        <button type="submit" className="btn-secondary" disabled={busy || !newAlias.trim()}>
          {busy ? t('data.accounts.aliasesAdding') : t('data.accounts.aliasesAdd')}
        </button>
      </form>
      {err && <div className="data-form-error">{err}</div>}
    </div>
  );
}

function AccountRow({
  account, expanded, onToggle, onSaveBalance, onConfirmBalance, onUpdate, onArchiveToggle, onDelete,
}) {
  const { t } = useTranslation();
  const meta = accountMeta(account);
  const stale = daysSince(account.balance_updated_at) > STALE_BALANCE_DAYS;

  const onRowKeyDown = (e) => {
    // Только когда фокус на самой строке. Иначе `preventDefault` гасил бы
    // активацию вложенной кнопки баланса: с клавиатуры Enter на ней не
    // открывал правку, а разворачивал строку — баланс правился только мышью.
    if (e.target !== e.currentTarget) return;
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggle(); }
  };

  return (
    <li className={`data-row ${account.archived ? 'data-row--archived' : ''} ${stale ? 'data-row--stale' : ''}`}>
      <div
        className="data-row-top"
        onClick={onToggle}
        onKeyDown={onRowKeyDown}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
      >
        <div className="data-row-main">
          <div className="data-row-title">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            <span>{account.name}</span>
          </div>
          {meta && <div className="data-row-meta">{meta}</div>}
        </div>

        <div className="data-row-value">
          <InlineEditable
            className="data-row-balance"
            value={account.balance_minor}
            formatDisplay={(v) => formatMinor(v, account.currency)}
            toEditString={(v) => minorToInputString(v, account.currency)}
            parseValue={(s) => parseAmountToMinor(s, account.currency)}
            onSave={onSaveBalance}
            ariaLabel={t('data.accounts.balanceAria', { name: account.name })}
            inputMode="decimal"
          />
          <div className="data-row-sub">
            {stale && <AlertTriangle size={11} className="data-stale-icon" />}
            {t('data.accounts.updated', { date: formatRelativeDate(account.balance_updated_at) })}{stale ? t('data.accounts.reconcileSoon') : ''}
          </div>
          {/* Подтверждение в одно касание: «сверился с банком, сумма та же».
              Без него переставить отметку свежести можно было бы только изменив
              сумму, то есть соврав себе (issue #223). Кнопка стоит у каждого
              счёта, а не только у устаревшего: сверка — обычное действие
              владельца, и прятать её до порога значило бы наказывать за
              аккуратность. stopPropagation — потому что вся шапка строки
              кликабельна и без него подтверждение заодно разворачивало бы
              форму правки.

              aria-label НАЧИНАЕТСЯ с видимой надписи, а не заменяет её:
              голосовое управление сопоставляет команду «нажми Сумма та же» с
              доступным именем, и имя без этой подстроки делает кнопку
              недостижимой голосом (WCAG 2.5.3 Label in Name). Дальше —
              уточнение, какой именно счёт: кнопок с одной надписью на экране
              столько же, сколько счетов. */}
          <button
            type="button"
            className="link-btn data-confirm-balance"
            onClick={(e) => { e.stopPropagation(); onConfirmBalance(); }}
            aria-label={t('data.accounts.confirmBalanceAria', { name: account.name })}
            title={t('data.accounts.confirmBalanceTitle')}
          >
            <Check size={12} /> {t('data.accounts.confirmBalance')}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="data-row-expand" onClick={(e) => e.stopPropagation()}>
          <AccountForm initial={account} submitLabel={t('common.save')} onSubmit={onUpdate} onCancel={onToggle} />
          <div className="data-row-actions">
            <button type="button" className="btn-secondary" onClick={onArchiveToggle}>
              {account.archived
                ? <><ArchiveRestore size={14} /> {t('data.accounts.unarchive')}</>
                : <><Archive size={14} /> {t('data.accounts.archive')}</>}
            </button>
            <button type="button" className="btn-danger" onClick={onDelete}>
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

// initialCode — префилл из предупреждения «валюта без курса»: владелец попал
// сюда по кнопке рядом с конкретным кодом, перепечатывать его вручную незачем.
function RateForm({ baseCurrency, initialCode = '', onSubmit, onCancel }) {
  const { t } = useTranslation();
  const [code, setCode] = useState(initialCode);
  const [rate, setRate] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    const codeNorm = code.trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(codeNorm)) {
      setError(t('data.rates.codeFormat'));
      return;
    }
    // Клиентская проверка не заменяет серверную (#228, PUT её всё равно
    // отклонит) — она просто экономит круговой запрос на очевидной ошибке.
    if (baseCurrency && codeNorm === baseCurrency) {
      setError(t('data.rates.baseSelf', { code: codeNorm }));
      return;
    }

    let rateNorm;
    try {
      rateNorm = normalizeRateInput(rate);
    } catch (err) {
      setError(err.message);
      return;
    }

    setBusy(true);
    try {
      await onSubmit(codeNorm, rateNorm);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="data-form data-form--inline" onSubmit={submit}>
      <label className="data-form-field">
        <span>{t('data.rates.fieldCode')}</span>
        <input value={code} onChange={(e) => setCode(e.target.value)} disabled={busy} placeholder={t('data.rates.placeholderCode')} maxLength={3} autoFocus={!initialCode} />
      </label>
      <label className="data-form-field">
        <span>{baseCurrency ? t('data.rates.fieldRateToBase', { base: baseCurrency }) : t('data.rates.fieldRateToBaseFallback')}</span>
        {/* Код уже подставлен — курсор сразу в поле, которое осталось заполнить. */}
        <input value={rate} onChange={(e) => setRate(e.target.value)} disabled={busy} placeholder={t('data.rates.placeholderRate')} inputMode="decimal" autoFocus={Boolean(initialCode)} />
      </label>
      {error && <div className="data-form-error">{error}</div>}
      <div className="data-form-actions">
        <button type="submit" className="btn-primary" disabled={busy}>{busy ? t('common.saving') : t('common.add')}</button>
        <button type="button" className="link-btn" onClick={onCancel} disabled={busy}>{t('common.cancel')}</button>
      </div>
    </form>
  );
}

function RateRow({ rate, baseCurrency, onSave, onDelete }) {
  const { t } = useTranslation();
  // Строка курса USD — ошибка ввода (USD теперь абсолютный якорь): пересчёт
  // её не использует, править бессмысленно, а сохранение всё равно упрётся в 400.
  // Единственное осмысленное действие — удалить, поэтому значение здесь обычный
  // текст, а не InlineEditable.
  const isAnchorCurrency = rate.code === 'USD';
  const stale = !isAnchorCurrency && daysSince(rate.updated_at) > STALE_RATE_DAYS;
  const flagged = stale || isAnchorCurrency;

  return (
    <li className={`data-row data-row--rate ${stale ? 'data-row--stale' : ''} ${isAnchorCurrency ? 'data-row--rate-invalid' : ''}`}>
      <div className="data-row-main">
        <div className="data-row-title">
          {flagged && <AlertTriangle size={13} className="data-stale-icon" />}
          <span className="data-rate-expr">
            {t('data.rates.expression', { code: rate.code })}
            {' '}
            {isAnchorCurrency ? (
              // Код валюты не прячем: «1 USD = 2 USD» показывает бессмыслицу
              // целиком и объясняет строку само, а «= 2» читалось бы обрезком.
              <span className="data-rate-value">{rate.rate} USD</span>
            ) : (
              <InlineEditable
                value={rate.rate}
                formatDisplay={(v) => `${v} USD`}
                toEditString={(v) => v}
                parseValue={normalizeRateInput}
                onSave={onSave}
                ariaLabel={t('data.rates.editAria', { code: rate.code, base: baseCurrency || 'USD' })}
                inputMode="decimal"
              />
            )}
          </span>
        </div>
        <div className="data-row-meta">
          {isAnchorCurrency
            ? t('data.rates.anchorHint')
            : <>{t('data.accounts.updated', { date: formatRelativeDate(rate.updated_at) })}{stale && t('data.rates.staleSuffix')}</>}
        </div>
      </div>
      <button type="button" className="icon-btn" onClick={onDelete} aria-label={t('data.rates.deleteAria', { code: rate.code })}>
        <Trash2 size={14} />
      </button>
    </li>
  );
}

export function DataDashboard({
  config = loadDataConfig(),
  filters = DEFAULT_DATA_FILTERS,
  onUpdateFilter = () => {},
  onToggleSection = () => {},
  onOpenSettings = undefined,
  onResetConfig = undefined,
  accounts = [],
  refreshAccounts = () => {},
  factsRevision = 0,
  bumpFacts = () => {},
  operationsRevision = 0,
  bumpOperations = () => {},
  search = '',
  refreshRatesQuiet = () => {},
  rates = [],
  visibleRates = [],
  missingRates = [],
  baseCurrency = null,
  rateError = null,
  newRateCode = null,
  openRateForm = () => {},
  setNewRateCode = () => {},
  handleCreateRate = () => {},
  handleSaveRate = () => {},
  handleDeleteRate = () => {},
  actionError = null,
  showNewAccount = false,
  setShowNewAccount = () => {},
  handleCreateAccount = () => {},
  matchesAccount = () => true,
  expandedAccountId = null,
  setExpandedAccountId = () => {},
  handleSaveBalance = () => {},
  handleConfirmBalance = () => {},
  handleUpdateAccount = () => {},
  handleArchiveToggle = () => {},
  handleDeleteAccount = () => {},
  thresholdMinor = null,
  handleSaveThreshold = () => {},
}) {
  const { t } = useTranslation();
  const visibleBlocks = config.filter((b) => b.visible);

  if (visibleBlocks.length === 0) {
    return (
      <div className="data-empty-dashboard">
        <p>{t('data.allSectionsHidden')}</p>
        <div className="data-empty-dashboard-actions">
          {onResetConfig && (
            <button type="button" className="btn-secondary" onClick={onResetConfig}>
              <RotateCcw size={14} />
              <span>{t('common.reset')}</span>
            </button>
          )}
          {onOpenSettings && (
            <button type="button" className="btn-primary" onClick={onOpenSettings}>
              <SlidersHorizontal size={14} />
              <span>{t('data.configureSections')}</span>
            </button>
          )}
        </div>
      </div>
    );
  }

  const activeAccounts = accounts.filter((a) => !a.archived);
  const archivedAccounts = accounts.filter((a) => a.archived);

  const renderBlock = (blockId) => {
    switch (blockId) {
      case 'operations':
        return (
          <div key="operations" className="data-block data-block--operations">
            <OperationsSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              factsRevision={factsRevision}
              onOperationsChanged={bumpOperations}
              expanded={Boolean(filters.operationsOpen)}
              onToggle={() => onToggleSection('operations')}
              search={search}
              limit={filters.operationsLimit}
              onLimitChange={(l) => onUpdateFilter('operationsLimit', l)}
            />
          </div>
        );

      case 'receipts':
        return (
          <div key="receipts" className="data-block data-block--receipts">
            <FiscalReceiptsSection
              accounts={accounts}
              expanded={Boolean(filters.receiptsOpen)}
              onToggle={() => onToggleSection('receipts')}
              search={search}
              operationsRevision={operationsRevision}
            />
          </div>
        );

      case 'accounts':
        return (
          <div key="accounts" className="data-block data-block--accounts">
            <DataSection
              id="accounts"
              title={blockTitle(DATA_BLOCK_DEFS.accounts, t)}
              expanded={Boolean(filters.accountsOpen)}
              onToggle={() => onToggleSection('accounts')}
              actions={(
                <button type="button" className="btn-secondary" onClick={() => setShowNewAccount((v) => !v)}>
                  <Plus size={14} /> {t('data.accounts.addShort')}
                </button>
              )}
              collapsedActions={activeAccounts.length === 0 ? (
                <button
                  type="button"
                  className="btn-primary"
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!filters.accountsOpen) onToggleSection('accounts');
                    setShowNewAccount(true);
                  }}
                >
                  <Plus size={14} /> {t('data.accounts.add')}
                </button>
              ) : null}
            >
              {actionError && <div className="data-error" role="alert">{actionError}</div>}

              {showNewAccount && (
                <AccountForm
                  submitLabel={t('common.create')}
                  onSubmit={handleCreateAccount}
                  onCancel={() => setShowNewAccount(false)}
                  existingAccounts={accounts}
                />
              )}

              {activeAccounts.length === 0 && !showNewAccount && (
                <div className="data-empty">
                  <p>{t('data.accounts.empty')}</p>
                  <button type="button" className="btn-primary" onClick={() => setShowNewAccount(true)}>
                    <Plus size={14} /> {t('data.accounts.add')}
                  </button>
                </div>
              )}

              {activeAccounts.length > 0 && (
                <ul className="data-list">
                  {activeAccounts.filter(matchesAccount).map((acc) => (
                    <AccountRow
                      key={acc.id}
                      account={acc}
                      expanded={expandedAccountId === acc.id}
                      onToggle={() => setExpandedAccountId((id) => (id === acc.id ? null : acc.id))}
                      onSaveBalance={(minor) => handleSaveBalance(acc, minor)}
                      onConfirmBalance={() => handleConfirmBalance(acc)}
                      onUpdate={(payload) => handleUpdateAccount(acc, payload)}
                      onArchiveToggle={() => handleArchiveToggle(acc)}
                      onDelete={() => handleDeleteAccount(acc)}
                    />
                  ))}
                </ul>
              )}

              {archivedAccounts.length > 0 && (
                <div className="data-archive">
                  <button
                    type="button"
                    className="data-archive-toggle"
                    onClick={() => onUpdateFilter('archivedAccountsOpen', !filters.archivedAccountsOpen)}
                  >
                    {filters.archivedAccountsOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    {t('data.accounts.archiveSection', { count: archivedAccounts.length })}
                  </button>
                  {filters.archivedAccountsOpen && (
                    <ul className="data-list data-list--archived">
                      {archivedAccounts.filter(matchesAccount).map((acc) => (
                        <AccountRow
                          key={acc.id}
                          account={acc}
                          expanded={expandedAccountId === acc.id}
                          onToggle={() => setExpandedAccountId((id) => (id === acc.id ? null : acc.id))}
                          onSaveBalance={(minor) => handleSaveBalance(acc, minor)}
                          onConfirmBalance={() => handleConfirmBalance(acc)}
                          onUpdate={(payload) => handleUpdateAccount(acc, payload)}
                          onArchiveToggle={() => handleArchiveToggle(acc)}
                          onDelete={() => handleDeleteAccount(acc)}
                        />
                      ))}
                    </ul>
                  )}
                </div>
              )}
              {search.trim() && activeAccounts.filter(matchesAccount).length === 0 && archivedAccounts.filter(matchesAccount).length === 0 && !showNewAccount && (
                <p className="data-filter-note">{t('data.searchNoResults', { query: search })}</p>
              )}
            </DataSection>
          </div>
        );

      case 'planned':
        return (
          <div key="planned" className="data-block data-block--planned">
            <PlannedSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              refreshRatesQuiet={refreshRatesQuiet}
              onFactChanged={bumpFacts}
              operationsRevision={operationsRevision}
              expanded={Boolean(filters.plannedOpen)}
              onToggle={() => onToggleSection('planned')}
              search={search}
              doneOpen={filters.donePlannedOpen}
              onToggleDoneOpen={() => onUpdateFilter('donePlannedOpen', !filters.donePlannedOpen)}
            />
          </div>
        );

      case 'recurring':
        return (
          <div key="recurring" className="data-block data-block--recurring">
            <RecurringSection
              accounts={accounts}
              refreshAccounts={refreshAccounts}
              refreshRatesQuiet={refreshRatesQuiet}
              onFactChanged={bumpFacts}
              expanded={Boolean(filters.recurringOpen)}
              onToggle={() => onToggleSection('recurring')}
              search={search}
              pausedOpen={filters.pausedRecurringOpen}
              onTogglePausedOpen={() => onUpdateFilter('pausedRecurringOpen', !filters.pausedRecurringOpen)}
            />
          </div>
        );

      case 'rates':
        return (
          <div key="rates" className="data-block data-block--rates">
            <DataSection
              id="rates"
              title={blockTitle(DATA_BLOCK_DEFS.rates, t)}
              expanded={Boolean(filters.ratesOpen)}
              onToggle={() => onToggleSection('rates')}
              actions={(
                <button type="button" className="btn-secondary" onClick={() => (newRateCode === '' ? setNewRateCode(null) : openRateForm(''))}>
                  <Plus size={14} /> {t('data.rates.addShort')}
                </button>
              )}
            >
              <p className="data-hint">{t('data.rates.manualHint')}</p>
              {rateError && <div className="data-error" role="alert">{rateError}</div>}
              {baseCurrency === null && (
                <div className="data-warning" role="status">
                  <AlertTriangle size={14} className="data-warning-icon" />
                  <div className="data-warning-body">
                    <p>{t('data.rates.noBase')}</p>
                  </div>
                </div>
              )}
              {missingRates.length > 0 && (
                <div className="data-warning" role="status">
                  <AlertTriangle size={14} className="data-warning-icon" />
                  <div className="data-warning-body">
                    <p>
                      {t('data.rates.missingRate', {
                        count: missingRates.length,
                        codes: missingRates.join(', '),
                        base: baseCurrency,
                      })}
                    </p>
                    <div className="data-warning-actions">
                      {missingRates.map((code) => (
                        <button key={code} type="button" className="link-btn" onClick={() => openRateForm(code)}>
                          {t('data.rates.addForCode', { code })}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
              {newRateCode !== null && (
                <RateForm
                  key={newRateCode}
                  baseCurrency={baseCurrency}
                  initialCode={newRateCode}
                  onSubmit={handleCreateRate}
                  onCancel={() => setNewRateCode(null)}
                />
              )}
              {rates.length === 0 && newRateCode === null && (
                <div className="data-empty">
                  <p>{t('data.rates.empty')}</p>
                  <button type="button" className="btn-primary" onClick={() => openRateForm('')}>
                    <Plus size={14} /> {t('data.rates.add')}
                  </button>
                </div>
              )}
              {rates.length > 0 && (
                <ul className="data-list">
                  {visibleRates.map((r) => (
                    <RateRow
                      key={r.code}
                      rate={r}
                      baseCurrency={baseCurrency}
                      onSave={(rateStr) => handleSaveRate(r.code, rateStr)}
                      onDelete={() => handleDeleteRate(r)}
                    />
                  ))}
                </ul>
              )}
              {rates.length > 0 && search.trim() && visibleRates.length === 0 && (
                <p className="data-filter-note">{t('data.searchNoResults', { query: search })}</p>
              )}
            </DataSection>
          </div>
        );

      case 'forecast':
        return (
          <div key="forecast" className="data-block data-block--forecast">
            <section className="data-section">
              <div className="data-section-header">
                <h2>{blockTitle(DATA_BLOCK_DEFS.forecast, t)}</h2>
              </div>
              <p className="data-hint">
                {t('data.forecast.thresholdHint', { currency: baseCurrency })}
              </p>
              {thresholdMinor !== null && (
                <ul className="data-list">
                  <li className="data-row">
                    <div className="data-row-top">
                      <div className="data-row-main">
                        <div className="data-row-title"><span>{t('data.forecast.thresholdLabel')}</span></div>
                      </div>
                      <div className="data-row-value">
                        <InlineEditable
                          className="data-row-balance"
                          value={thresholdMinor}
                          formatDisplay={(v) => formatMinor(v, baseCurrency || 'USD')}
                          toEditString={(v) => minorToInputString(v, baseCurrency || 'USD')}
                          parseValue={(s) => parseAmountToMinor(s, baseCurrency || 'USD')}
                          onSave={handleSaveThreshold}
                          ariaLabel={t('data.forecast.thresholdLabel')}
                          inputMode="decimal"
                        />
                      </div>
                    </div>
                  </li>
                </ul>
              )}
            </section>
          </div>
        );

      default:
        return null;
    }
  };

  return (
    <div className="data-dashboard">
      {visibleBlocks.map((block) => renderBlock(block.id))}
    </div>
  );
}

export default function Data({
  isCustomizing: controlledIsCustomizing = undefined,
  onCustomizingChange = undefined,
}) {
  const { t } = useTranslation();
  const [internalCustomizing, setInternalCustomizing] = useState(false);
  const isCustomizing = controlledIsCustomizing !== undefined ? controlledIsCustomizing : internalCustomizing;
  const setIsCustomizing = onCustomizingChange || setInternalCustomizing;

  const [dataConfig, setDataConfig] = useState(loadDataConfig);
  const [dataFilters, setDataFilters] = useState(loadDataFilters);

  const handleConfigChange = useCallback((nextConfig) => {
    setDataConfig(nextConfig);
    saveDataConfig(nextConfig);
  }, []);

  const handleResetConfig = useCallback(() => {
    const reset = resetDataConfig();
    setDataConfig(reset);
  }, []);

  const handleUpdateFilter = useCallback((key, value) => {
    setDataFilters((prev) => {
      const next = { ...prev, [key]: value };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const handleToggleSection = useCallback((key) => {
    const field = `${key}Open`;
    setDataFilters((prev) => {
      const next = { ...prev, [field]: !prev[field] };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const handleResetFilters = useCallback(() => {
    setDataFilters((prev) => {
      const next = {
        ...prev,
        search: '',
      };
      saveDataFilters(next);
      return next;
    });
  }, []);

  const refreshNonce = useRefreshNonce();
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [loadError, setLoadError] = useState(null);
  const [accounts, setAccounts] = useState([]);
  const [rates, setRates] = useState([]);
  // Валюты в ходу, для которых курса нет (issue #193). Считает их сервер: он
  // один видит все таблицы со ссылками на валюту, а не только счета.
  const [missingRates, setMissingRates] = useState([]);
  // null — базовая валюта не настроена (`settings.base_currency` не задан или
  // непригоден). Дефолт 'USD' здесь был бы враньём: экран показывал бы
  // «USD» даже когда сервер сам не знает, какая валюта базовая (#228).
  const [baseCurrency, setBaseCurrency] = useState(null);

  // Порог предупреждения о низком балансе (issue #198) — читается вместе с
  // остальными данными экрана. null означает «ещё не загружен» (отличаем от
  // законных 0, которые парсер валидного ввода тоже может вернуть).
  const [thresholdMinor, setThresholdMinor] = useState(null);

  const [expandedAccountId, setExpandedAccountId] = useState(null);

  const [factsRevision, setFactsRevision] = useState(0);
  const bumpFacts = useCallback(() => setFactsRevision((n) => n + 1), []);
  const [operationsRevision, setOperationsRevision] = useState(0);
  const bumpOperations = useCallback(() => setOperationsRevision((n) => n + 1), []);

  const search = dataFilters.search || '';
  const setSearch = (val) => handleUpdateFilter('search', val);

  const toggleBlock = (key) => {
    const next = toggleBlockVisibility(dataConfig, key);
    handleConfigChange(next);
  };

  const q = search.trim().toLowerCase();
  const matchesAccount = (acc) => {
    if (!q) return true;
    return [acc.name, acc.bank, acc.type, acc.account_number, acc.owner, acc.country]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  };
  const matchesRate = (r) => !q || r.code.toLowerCase().includes(q);
  const visibleAccounts = accounts.filter(matchesAccount);
  const visibleRates = rates.filter(matchesRate);

  // Дип-линки на блоки экрана при смене хэша на лету (issue #278).
  useEffect(() => {
    const handleHash = () => {
      const section = sectionFromHash(window.location.hash);
      if (section) {
        handleUpdateFilter(`${section}Open`, true);
      }
    };
    handleHash();
    window.addEventListener('hashchange', handleHash);
    return () => window.removeEventListener('hashchange', handleHash);
  }, [handleUpdateFilter]);
  const [showNewAccount, setShowNewAccount] = useState(false);
  // null — форма курса скрыта; строка — открыта с этим кодом в поле (пустая
  // строка = обычная кнопка «Курс», код = переход из предупреждения).
  const [newRateCode, setNewRateCode] = useState(null);
  // Номер открытия формы. Сравнивать по коду мало: две подряд открытые пустые
  // формы неразличимы, и ответ по первой погасил бы вторую вместе с набранным.
  const rateFormSeq = useRef(0);
  const [actionError, setActionError] = useState(null);
  const [rateError, setRateError] = useState(null);

  // Ответ /fx-rates разбирается в одном месте: три поля из него всегда
  // ставятся вместе, и разъехаться (курсы новые, `missing` старый) не должны.
  const applyRates = useCallback((res) => {
    setRates(res.rates);
    setMissingRates(res.missing || []);
    setBaseCurrency(res.base_currency ?? null);
    // Данные перечитаны — прежняя жалоба на них больше не заслуживает доверия.
    // Без этого 409 «валюта занята» продолжал бы висеть после того, как
    // владелец сделал ровно то, что баннер просил: убрал счёт в этой валюте.
    // Действие, которое ошибку породило, само её и не снимает — оно упало.
    setRateError(null);
  }, []);

  const loadAll = useCallback(async () => {
    setStatus('loading');
    setLoadError(null);
    try {
      // Базовая валюта берётся из /fx-rates, а не из /settings: `missing`
      // считается сервером против неё же, и второй источник того же факта
      // разошёлся бы с первым — сервер значение нормализует, /settings отдаёт
      // как есть. Заодно на один запрос меньше: ничего другого из настроек
      // этому экрану пока не нужно.
      const [accRes, rateRes, settingsRes] = await Promise.all([
        api.listAccounts(), api.listFxRates(), api.getSettings(),
      ]);
      setAccounts(accRes.accounts);
      applyRates(rateRes);
      // Ключа может не быть вовсе (свежая база) — тогда порог не задан, 0.
      // Непригодное значение сводится туда же, а не показывается как NaN:
      // settings — key/value без типов в схеме, и PUT валидирует только то, что
      // прошло через него; строка, положенная правкой БД мимо API, доедет сюда
      // как есть (сервер для самого прогноза делает ровно то же — см.
      // normalizeThresholdMinor в worker/forecast/load.ts).
      const rawThreshold = Number(settingsRes.settings.low_balance_threshold_minor);
      setThresholdMinor(Number.isSafeInteger(rawThreshold) && rawThreshold >= 0 ? rawThreshold : 0);
      setStatus('ready');
    } catch (err) {
      setLoadError(err.message || t('common.loadFailed'));
      setStatus('error');
    }
  }, [applyRates, t]);

  useEffect(() => { loadAll(); }, [loadAll, refreshNonce]);

  const refreshRates = useCallback(async () => {
    applyRates(await api.listFxRates());
  }, [applyRates]);

  // Вариант refreshRates, который никогда не бросает. Создание/удаление
  // плановой или регулярной операции меняет набор валют «в ходу», от которого
  // зависит предупреждение «валюта без курса» (missingRates) — секции зовут
  // это после таких действий, чтобы предупреждение не отставало. Тот же
  // приём, что уже есть в refreshAccountsAndRates ниже: отказ обновления
  // курсов не имеет права выглядеть как отказ основного действия, которое уже
  // прошло на сервере.
  const refreshRatesQuiet = useCallback(async () => {
    await refreshRates().catch(() => {});
  }, [refreshRates]);

  const refreshAccounts = useCallback(async () => {
    const res = await api.listAccounts();
    setAccounts(res.accounts);
    setActionError(null); // то же, что в applyRates, но для действий со счетами
  }, []);

  // Набор валют «в ходу» меняют только создание, правка и удаление счёта —
  // от них зависит `missing`, поэтому курсы перечитываются заодно. Правка
  // баланса и архивация сюда не относятся: сумма валюту не меняет, а архивные
  // счета сервер считает наравне с активными.
  //
  // Отказ по курсам глушится намеренно. Действие пользователя относилось к
  // счёту и уже прошло — если дать этой ошибке всплыть, форма скажет, что
  // создание не удалось, и повторное нажатие заведёт дубль (UNIQUE по имени в
  // схеме нет). Цена глушения — предупреждение о валютах без курса останется
  // прежним до следующего обновления, а это подсказка, а не гарантия.
  const refreshAccountsAndRates = useCallback(async () => {
    const quiet = refreshRates().catch(() => {});
    await refreshAccounts();
    await quiet;
  }, [refreshAccounts, refreshRates]);

  const openRateForm = useCallback((code) => {
    // Счётчик двигается только когда форма реально пересоздаётся: её сброс
    // держит key={newRateCode}, и при том же коде перемонтирования не будет.
    // Безусловный инкремент означал бы «открыли заново» там, где ничего не
    // открывали, — и повторный клик по той же кнопке во время отправки
    // оставлял бы форму висеть после успешного сохранения.
    if (newRateCode !== code) rateFormSeq.current += 1;
    setNewRateCode(code);
  }, [newRateCode]);

  // Действия без собственного места под ошибку в форме (архив/удаление)
  // показывают её здесь, а не только в консоли.
  const runAction = useCallback(async (fn) => {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err.message || t('common.actionFailed'));
    }
  }, [t]);

  // Ошибки действий с курсами живут в своей секции, а не в общем баннере
  // наверху экрана: при десятке счетов тот баннер оказывается за пределами
  // экрана, и отказ удаления занятого курса (409) прошёл бы незамеченным.
  const runRateAction = useCallback(async (fn) => {
    setRateError(null);
    try {
      await fn();
    } catch (err) {
      setRateError(err.message || t('common.actionFailed'));
    }
  }, [t]);

  // Правки счёта выстраиваются в цепочку, а не летят параллельно. Инлайн-
  // редактор баланса в шапке строки и форма правки под ней открыты
  // одновременно, и клик по «Сохранить» сначала снимает фокус с инлайн-поля
  // (то есть коммитит его), а следом отправляет форму. Два PATCH к одной
  // строке применились бы в непредсказуемом порядке, и на счёте могла
  // остаться новая валюта со старой суммой. В очереди последним ложится то,
  // что владелец подтвердил последним.
  const chainRef = useRef(Promise.resolve());
  const serialize = useCallback((fn) => {
    const next = chainRef.current.then(fn, fn);
    chainRef.current = next.catch(() => {});
    return next;
  }, []);

  const handleSaveBalance = (account, minor) => serialize(async () => {
    await api.updateAccount(account.id, { balance_minor: minor });
    await refreshAccounts();
  });

  // Подтверждение идёт в ту же очередь, что и правка баланса: оба действия
  // пишут balance_updated_at, и разъехавшийся порядок оставил бы отметку от
  // более раннего из них. Ошибка показывается баннером — своего места под неё
  // у кнопки нет, как и у архивации с удалением.
  const handleConfirmBalance = (account) => runAction(() => serialize(async () => {
    await api.confirmAccountBalance(account.id);
    await refreshAccounts();
  }));

  const handleCreateAccount = (payload) => serialize(async () => {
    await api.createAccount(payload);
    await refreshAccountsAndRates();
    setShowNewAccount(false);
  });

  const handleUpdateAccount = (account, payload) => serialize(async () => {
    await api.updateAccount(account.id, payload);
    await refreshAccountsAndRates();
    setExpandedAccountId(null);
  });

  const handleArchiveToggle = (account) => runAction(() => serialize(async () => {
    await api.updateAccount(account.id, { archived: !account.archived });
    await refreshAccounts();
  }));

  const handleDeleteAccount = (account) => {
    if (!window.confirm(t('data.accounts.deleteConfirm', { name: account.name }))) return;
    return runAction(() => serialize(async () => {
      await api.deleteAccount(account.id);
      await refreshAccountsAndRates();
      setExpandedAccountId(null);
    }));
  };

  // Тот же чейнинг записей, что у баланса счёта: правка порога — отдельный
  // ключ settings, гонки с другими записями ему не грозят, но общая очередь
  // дешевле, чем заводить вторую ради одного поля.
  const handleSaveThreshold = (minor) => serialize(async () => {
    if (minor < 0) throw new Error(t('data.forecast.thresholdNegative'));
    await api.putSetting('low_balance_threshold_minor', minor);
    setThresholdMinor(minor);
  });

  const handleSaveRate = async (code, rateStr) => {
    await api.putFxRate(code, rateStr);
    await refreshRates();
  };

  const handleCreateRate = async (code, rateStr) => {
    const seq = rateFormSeq.current;
    await api.putFxRate(code, rateStr);
    await refreshRates();
    // Закрываем именно ту форму, из которой пришла отправка. Пока PUT был в
    // полёте, владелец мог открыть другую — в ней уже свой код и набранный
    // курс, и гасить её нельзя.
    if (rateFormSeq.current === seq) setNewRateCode(null);
  };

  const handleDeleteRate = (rate) => {
    if (!window.confirm(t('data.rates.deleteConfirm', { code: rate.code }))) return;
    return runRateAction(async () => {
      await api.deleteFxRate(rate.code);
      await refreshRates();
    });
  };

  if (status === 'loading') {
    return <SectionSkeleton />;
  }

  if (status === 'error') {
    return (
      <div className="data-error-panel">
        <p>{loadError}</p>
        <button type="button" className="btn-secondary" onClick={loadAll}>{t('common.retry')}</button>
      </div>
    );
  }

  const hiddenBlockCount = dataConfig.filter((b) => !b.visible).length;
  const activeFilterCount = (search.trim() ? 1 : 0) + hiddenBlockCount;

  const filterBar = (
    <div className="filter-bar data-filter-bar">
      <div className="filter-row">
        <div className="search-box">
          <Search size={15} />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('data.searchPlaceholder')}
          />
          {search && (
            <button className="search-clear" onClick={() => setSearch('')} aria-label={t('common.clear')}>
              <X size={14} />
            </button>
          )}
        </div>
        <button
          className={`filter-btn ${activeFilterCount > 0 || isCustomizing ? 'filter-btn--active' : ''}`}
          onClick={() => setIsCustomizing(true)}
          aria-label={t('data.configureSections')}
          title={t('data.configureSections')}
        >
          <SlidersHorizontal size={16} />
          {activeFilterCount > 0 && <span className="filter-badge">{activeFilterCount}</span>}
        </button>
        {activeFilterCount > 0 && (
          <button
            className="filter-btn filter-clear"
            onClick={() => {
              setSearch('');
              handleConfigChange(dataConfig.map((b) => ({ ...b, visible: true })));
            }}
            aria-label={t('data.resetFilters')}
            title={t('data.resetFilters')}
          >
            <RotateCcw size={15} />
          </button>
        )}
      </div>

      <div className="data-block-chips">
        {dataConfig.map((block) => {
          const def = DATA_BLOCK_DEFS[block.id];
          if (!def) return null;
          return (
            <button
              key={block.id}
              className={`chip ${block.visible ? 'chip--active' : ''}`}
              onClick={() => toggleBlock(block.id)}
              aria-pressed={block.visible}
            >
              {blockTitle(def, t)}
            </button>
          );
        })}
      </div>
    </div>
  );

  const effectiveFilters = {
    ...dataFilters,
    operationsOpen: Boolean(dataFilters.operationsOpen) || Boolean(search.trim()),
    receiptsOpen: Boolean(dataFilters.receiptsOpen) || Boolean(search.trim()),
    accountsOpen: Boolean(dataFilters.accountsOpen) || Boolean(search.trim()),
    plannedOpen: Boolean(dataFilters.plannedOpen) || Boolean(search.trim()),
    recurringOpen: Boolean(dataFilters.recurringOpen) || Boolean(search.trim()),
    ratesOpen: Boolean(dataFilters.ratesOpen) || Boolean(search.trim()),
  };

  return (
    <div className="data-screen">
      {filterBar}
      <DataDashboard
        config={dataConfig}
        filters={effectiveFilters}
        onUpdateFilter={handleUpdateFilter}
        onToggleSection={handleToggleSection}
        onOpenSettings={() => setIsCustomizing(true)}
        onResetConfig={handleResetConfig}
        accounts={accounts}
        refreshAccounts={refreshAccounts}
        factsRevision={factsRevision}
        bumpFacts={bumpFacts}
        operationsRevision={operationsRevision}
        bumpOperations={bumpOperations}
        search={search}
        refreshRatesQuiet={refreshRatesQuiet}
        rates={rates}
        visibleRates={visibleRates}
        missingRates={missingRates}
        baseCurrency={baseCurrency}
        rateError={rateError}
        newRateCode={newRateCode}
        openRateForm={openRateForm}
        setNewRateCode={setNewRateCode}
        handleCreateRate={handleCreateRate}
        handleSaveRate={handleSaveRate}
        handleDeleteRate={handleDeleteRate}
        actionError={actionError}
        showNewAccount={showNewAccount}
        setShowNewAccount={setShowNewAccount}
        handleCreateAccount={handleCreateAccount}
        matchesAccount={matchesAccount}
        expandedAccountId={expandedAccountId}
        setExpandedAccountId={setExpandedAccountId}
        handleSaveBalance={handleSaveBalance}
        handleConfirmBalance={handleConfirmBalance}
        handleUpdateAccount={handleUpdateAccount}
        handleArchiveToggle={handleArchiveToggle}
        handleDeleteAccount={handleDeleteAccount}
        thresholdMinor={thresholdMinor}
        handleSaveThreshold={handleSaveThreshold}
      />
      <BackupSection />
      <ResetSection />
      <div className="data-customize-footer">
        <button
          type="button"
          className="data-customize-link"
          onClick={() => setIsCustomizing(true)}
        >
          <SlidersHorizontal size={14} />
          <span>{t('data.configureOrderVisibility')}</span>
        </button>
      </div>

      {isCustomizing && (
        <DashboardSettingsModal
          open={isCustomizing}
          config={dataConfig}
          onChange={handleConfigChange}
          onReset={handleResetConfig}
          onClose={() => setIsCustomizing(false)}
          title={t('data.settingsTitle')}
          description={t('data.settingsDescription')}
          blockDefs={DATA_BLOCK_DEFS}
        />
      )}
    </div>
  );
}
