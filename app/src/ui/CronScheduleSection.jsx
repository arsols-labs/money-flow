// Background Worker cron schedule configuration on the "Data" screen.
// Permanent section directly below the customizable block grid (`#/data/schedule`).
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Clock } from 'lucide-react';
import { api } from './api';
import {
  CRON_DEFAULT_HOUR,
  CRON_DEFAULT_TIMEZONE,
  CRON_HOUR_MAX,
  CRON_HOUR_MIN,
  formatCronHour,
  listSupportedCronTimezones,
  normalizeCronTimezone,
} from '../shared/cron-schedule';

const HOUR_OPTIONS = Array.from(
  { length: CRON_HOUR_MAX - CRON_HOUR_MIN + 1 },
  (_, hour) => ({ value: hour, label: formatCronHour(hour) }),
);

function detectBrowserTimezone() {
  try {
    if (typeof Intl === 'undefined' || typeof Intl.DateTimeFormat !== 'function') return null;
    const raw = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return normalizeCronTimezone(raw);
  } catch {
    return null;
  }
}

export default function CronScheduleSection({
  schedule = null,
  loadError = null,
  demoMode = false,
  onScheduleUpdated = () => {},
}) {
  const { t } = useTranslation();
  const headingId = useId();
  const tzInputId = useId();
  const tzListId = useId();
  const tzHelpId = useId();
  const tzErrorId = useId();
  const fxHourId = useId();
  const recurringHourId = useId();
  const tzInputRef = useRef(null);

  const initialTimezone = schedule?.timezone || CRON_DEFAULT_TIMEZONE;
  const initialFxHour =
    Number.isInteger(schedule?.fx_auto_update_hour)
      ? schedule.fx_auto_update_hour
      : CRON_DEFAULT_HOUR;
  const initialRecurringHour =
    Number.isInteger(schedule?.recurring_auto_skip_hour)
      ? schedule.recurring_auto_skip_hour
      : CRON_DEFAULT_HOUR;

  const [timezoneInput, setTimezoneInput] = useState(initialTimezone);
  const [fxHour, setFxHour] = useState(initialFxHour);
  const [recurringHour, setRecurringHour] = useState(initialRecurringHour);
  const [tzDirty, setTzDirty] = useState(false);
  const [tzError, setTzError] = useState(null);
  const [submitError, setSubmitError] = useState(null);
  const [statusMessage, setStatusMessage] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTimezoneInput(initialTimezone);
    setFxHour(initialFxHour);
    setRecurringHour(initialRecurringHour);
    setTzDirty(false);
    setTzError(null);
  }, [initialTimezone, initialFxHour, initialRecurringHour]);

  useEffect(() => {
    const scrollIfTarget = () => {
      if (typeof window === 'undefined') return;
      if (window.location.hash === '#/data/schedule') {
        const el = document.getElementById('schedule');
        if (el?.scrollIntoView) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    };
    scrollIfTarget();
    if (typeof window !== 'undefined') {
      window.addEventListener('hashchange', scrollIfTarget);
      return () => window.removeEventListener('hashchange', scrollIfTarget);
    }
    return undefined;
  }, []);

  const timezoneList = useMemo(() => listSupportedCronTimezones(), []);
  const browserTimezone = useMemo(() => detectBrowserTimezone(), []);
  const isDemo = Boolean(demoMode || schedule?.demo_mode);

  const fxLastRun = schedule?.jobs?.fx_refresh?.last_run_local_date ?? null;
  const recurringLastRun = schedule?.jobs?.recurring_auto_skip?.last_run_local_date ?? null;

  const handleTimezoneChange = (e) => {
    const nextValue = e.target.value;
    setTimezoneInput(nextValue);
    setTzDirty(true);
    setStatusMessage(null);
    setSubmitError(null);
    if (tzError && normalizeCronTimezone(nextValue) !== null) {
      setTzError(null);
    }
  };

  const handleTimezoneBlur = () => {
    if (!tzDirty) return;
    if (normalizeCronTimezone(timezoneInput) === null) {
      setTzError(t('errors.SETTING_TIMEZONE_INVALID'));
    } else {
      setTzError(null);
    }
  };

  const handleUseBrowserTimezone = () => {
    if (!browserTimezone) return;
    setTimezoneInput(browserTimezone);
    setTzDirty(false);
    setTzError(null);
    setSubmitError(null);
    setStatusMessage(null);
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setStatusMessage(null);
    setSubmitError(null);

    const canonicalTimezone = normalizeCronTimezone(timezoneInput);
    if (canonicalTimezone === null) {
      setTzError(t('errors.SETTING_TIMEZONE_INVALID'));
      tzInputRef.current?.focus();
      return;
    }
    setTzError(null);

    setSaving(true);
    try {
      const updated = await api.updateCronSchedule({
        timezone: canonicalTimezone,
        fx_auto_update_hour: Number(fxHour),
        recurring_auto_skip_hour: Number(recurringHour),
      });
      setTimezoneInput(updated.timezone);
      setFxHour(updated.fx_auto_update_hour);
      setRecurringHour(updated.recurring_auto_skip_hour);
      setTzDirty(false);
      onScheduleUpdated(updated);
      setStatusMessage(
        t('data.schedule.saved', {
          timezone: updated.timezone,
          fxTime: formatCronHour(updated.fx_auto_update_hour),
          recurringTime: formatCronHour(updated.recurring_auto_skip_hour),
        }),
      );
    } catch (err) {
      setSubmitError(err?.message || t('common.actionFailed'));
    } finally {
      setSaving(false);
    }
  };

  const effectiveError = submitError || loadError;

  return (
    <section className="data-section cron-schedule-section" id="schedule" aria-labelledby={headingId}>
      <div className="data-section-header">
        <h2 id={headingId} className="cron-schedule-heading">
          <Clock size={15} aria-hidden="true" />
          <span>{t('data.schedule.title')}</span>
        </h2>
      </div>
      <p className="data-hint">{t('data.schedule.hint')}</p>

      {isDemo && (
        <div className="data-warning" role="status">
          <AlertTriangle size={14} className="data-warning-icon" />
          <div className="data-warning-body">
            <p>{t('data.schedule.demoNotice')}</p>
          </div>
        </div>
      )}

      <form className="cron-schedule-form" aria-labelledby={headingId} onSubmit={handleSubmit} noValidate>
        <div className="data-form-field cron-schedule-tz-field">
          <label htmlFor={tzInputId}>{t('data.schedule.timezoneLabel')}</label>
          <div className="cron-schedule-tz-row">
            <input
              ref={tzInputRef}
              id={tzInputId}
              name="timezone"
              type="text"
              list={tzListId}
              value={timezoneInput}
              onChange={handleTimezoneChange}
              onBlur={handleTimezoneBlur}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              enterKeyHint="done"
              required
              aria-invalid={tzError ? 'true' : undefined}
              aria-describedby={tzError ? `${tzErrorId} ${tzHelpId}` : tzHelpId}
              disabled={saving}
              placeholder="UTC"
            />
            {browserTimezone && (
              <button
                type="button"
                className="btn-secondary cron-schedule-detect-btn"
                onClick={handleUseBrowserTimezone}
                disabled={saving}
              >
                {t('data.schedule.useBrowserTimezone')}
              </button>
            )}
          </div>
          <datalist id={tzListId}>
            {timezoneList.map((zone) => (
              <option key={zone} value={zone} />
            ))}
          </datalist>
          <span id={tzHelpId} className="data-form-note">
            {t('data.schedule.timezoneHint')}
          </span>
          {tzError && (
            <span id={tzErrorId} className="data-form-error" role="alert">
              {tzError}
            </span>
          )}
        </div>

        <div className="cron-schedule-hours">
          <div className="data-form-field">
            <label htmlFor={fxHourId}>{t('data.schedule.fxHourLabel')}</label>
            <select
              id={fxHourId}
              name="fx_auto_update_hour"
              value={String(fxHour)}
              onChange={(e) => {
                setFxHour(Number(e.target.value));
                setStatusMessage(null);
                setSubmitError(null);
              }}
              disabled={saving}
            >
              {HOUR_OPTIONS.map((opt) => (
                <option key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>

          <div className="data-form-field">
            <label htmlFor={recurringHourId}>{t('data.schedule.recurringHourLabel')}</label>
            <select
              id={recurringHourId}
              name="recurring_auto_skip_hour"
              value={String(recurringHour)}
              onChange={(e) => {
                setRecurringHour(Number(e.target.value));
                setStatusMessage(null);
                setSubmitError(null);
              }}
              disabled={saving}
            >
              {HOUR_OPTIONS.map((opt) => (
                <option key={opt.value} value={String(opt.value)}>
                  {opt.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="cron-schedule-meta">
          <span>{t('data.schedule.lastRunFx', { date: fxLastRun || t('data.schedule.neverRan') })}</span>
          <span>{t('data.schedule.lastRunRecurring', { date: recurringLastRun || t('data.schedule.neverRan') })}</span>
        </div>

        {effectiveError && (
          <div className="data-error" role="alert">
            {effectiveError}
          </div>
        )}
        <div
          className={statusMessage ? 'data-fx-notice' : 'visually-hidden'}
          role="status"
          aria-live="polite"
        >
          {statusMessage || ''}
        </div>

        <div className="cron-schedule-actions">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? t('common.saving') : t('data.schedule.save')}
          </button>
        </div>
      </form>
    </section>
  );
}
