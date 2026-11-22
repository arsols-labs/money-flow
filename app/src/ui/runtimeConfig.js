// Client-side runtime configuration state backed by D1 via GET /api/v2/config/runtime.
import { useEffect, useState } from 'react';
import {
  buildCurrencyCatalog,
  EMPTY_CURRENCY_CATALOG,
  setRuntimeCurrencyCatalog,
} from '../shared/currency';
import { api } from './api';

const INITIAL_STATE = {
  loading: false,
  loaded: false,
  error: null,
  rules_epoch: 0,
  base_currency: null,
  fx_anchor_currency: null,
  currencies: [],
  fiscal_formats: [],
  statement_templates: [],
  pdf_layouts: [],
  readiness: [],
  configured: false,
};

let snapshot = { ...INITIAL_STATE };
const listeners = new Set();

function emit() {
  for (const listener of listeners) {
    listener(snapshot);
  }
}

export function getRuntimeConfigSnapshot() {
  return snapshot;
}

export function getFxAnchorCurrency() {
  return snapshot.fx_anchor_currency;
}

export function applyRuntimeConfigPayload(payload) {
  const currencies = Array.isArray(payload?.currencies) ? payload.currencies : [];
  setRuntimeCurrencyCatalog(buildCurrencyCatalog(currencies));
  snapshot = {
    loading: false,
    loaded: true,
    error: null,
    rules_epoch: Number(payload?.rules_epoch) || 0,
    base_currency: payload?.base_currency ?? null,
    fx_anchor_currency: payload?.fx_anchor_currency ?? null,
    currencies,
    fiscal_formats: Array.isArray(payload?.fiscal_formats) ? payload.fiscal_formats : [],
    statement_templates: Array.isArray(payload?.statement_templates) ? payload.statement_templates : [],
    pdf_layouts: Array.isArray(payload?.pdf_layouts) ? payload.pdf_layouts : [],
    readiness: Array.isArray(payload?.readiness)
      ? payload.readiness
      : (payload?.readiness && typeof payload.readiness === 'object'
        ? Object.entries(payload.readiness).map(([domain, ok]) => ({ domain, configured: Boolean(ok) }))
        : []),
    configured: Boolean(payload?.configured),
  };
  emit();
  return snapshot;
}

export function resetRuntimeConfig() {
  setRuntimeCurrencyCatalog(EMPTY_CURRENCY_CATALOG);
  snapshot = { ...INITIAL_STATE };
  emit();
}

export async function loadRuntimeConfig(options = {}) {
  snapshot = { ...snapshot, loading: true, error: null };
  emit();
  try {
    const payload = await api.getRuntimeConfig({
      ...(options.country ? { country: options.country } : {}),
      ...(options.as_of_date ? { as_of_date: options.as_of_date } : {}),
    });
    return applyRuntimeConfigPayload(payload);
  } catch (err) {
    snapshot = {
      ...snapshot,
      loading: false,
      loaded: true,
      error: err instanceof Error ? err.message : String(err),
    };
    emit();
    return snapshot;
  }
}

export function getReadinessEntries(state = snapshot) {
  if (!state.readiness) return [];
  if (Array.isArray(state.readiness)) {
    return state.readiness.map((item) => ({
      domain: item.domain,
      configured: Boolean(item.configured),
    }));
  }
  if (typeof state.readiness === 'object') {
    return Object.entries(state.readiness).map(([domain, ok]) => ({
      domain,
      configured: Boolean(ok),
    }));
  }
  return [];
}

export const REQUIRED_STARTER_RULE_DOMAINS = ['currency_standards'];

export function isOptionalRuleDomain(domain) {
  return Boolean(domain) && !REQUIRED_STARTER_RULE_DOMAINS.includes(domain);
}

export function hasRequiredCurrencyConfig(state = snapshot) {
  if (!state?.loaded || state.error) return true;
  const currencyEntry = getReadinessEntries(state).find((item) => item.domain === 'currency_standards');
  if (currencyEntry) {
    return Boolean(currencyEntry.configured) && Boolean(state.fx_anchor_currency);
  }
  return Array.isArray(state.currencies) && state.currencies.length > 0 && Boolean(state.fx_anchor_currency);
}

export function listMissingConfigDomains(state = snapshot) {
  if (!state.loaded) return [];
  return getReadinessEntries(state)
    .filter((item) => !item.configured)
    .map((item) => item.domain);
}

export function useRuntimeConfig() {
  const [state, setState] = useState(snapshot);
  useEffect(() => {
    listeners.add(setState);
    setState(snapshot);
    return () => {
      listeners.delete(setState);
    };
  }, []);
  return state;
}
