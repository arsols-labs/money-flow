// Global data refresh without reloading the page (issue #381).
//
// Why: the "Refresh" button in the header must actually re-read data on every
// screen (Pulse, Data, Access), rather than calling window.location.reload() —
// a browser page refresh drops all local state
// (expanded "Data" blocks, filters, the selected Pulse period) and looks to
// the user like a "flicker".
//
// How it works: the provider holds a `nonce` counter. Shell increments it on
// an icon click; each screen/section subscribes through
// useRefreshNonce() and restarts its load() in an effect on nonce. Resetting
// the "Data" cache (useLoadWhenExpanded loads a block once) also goes through
// nonce — the effect clears startedRef before calling load() again.
//
// StrictMode mounts effects twice in dev: nonce must not change there from
// the mount itself (it changes only on click), so the dependency is only
// [nonce]. A double load() call in dev is harmless (idempotent fetch).
import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';

const RefreshContext = createContext(null);

export function RefreshProvider({ children }) {
  const [nonce, setNonce] = useState(0);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const value = useMemo(() => ({ nonce, refresh }), [nonce, refresh]);
  return <RefreshContext.Provider value={value}>{children}</RefreshContext.Provider>;
}

// Subscription to the refresh counter. Returns the current nonce; an effect
// that depends on it reloads data on every "Refresh" click.
export function useRefreshNonce() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefreshNonce must be used within RefreshProvider');
  return ctx.nonce;
}

// The function Shell calls when the "Refresh" icon is clicked.
export function useRefresh() {
  const ctx = useContext(RefreshContext);
  if (!ctx) throw new Error('useRefresh must be used within RefreshProvider');
  return ctx.refresh;
}
