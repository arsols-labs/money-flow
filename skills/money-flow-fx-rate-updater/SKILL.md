---
name: money-flow-fx-rate-updater
description: Manage and refresh Money Flow v2's exchange rates relative to the workspace FX anchor currency through its MCP server (using built-in ExchangeRate-API daily auto-update, on-demand refresh, or external market data via fx_rate_set). Do not use to change base currency or configure a client scheduler unless requested for a custom external source.
---

# Money Flow FX Rate Updater

Use this skill to manage and refresh foreign-exchange rates in Money Flow v2 through
its MCP server. It reads or updates FX configuration and reference rates only; it
never transfers money, changes an account balance, or changes the workspace
`base_currency` setting.

## Preconditions

- The caller has an authorized Money Flow MCP client with `read` (and `write` for
  mutations) scopes.
- The user has asked for the refresh/configuration change, or already authorized
  the scheduled job invoking this skill.
- Inspect `tools/list` when the client exposes it, and use the server's current
  schemas (`fx_rates_list`, `accounts_list`, `fx_rates_refresh`, `fx_rate_set`,
  `setting_set`) rather than assuming a client-specific wrapper shape.

## Two supported workflows

Money Flow v2 includes a built-in free ExchangeRate-API integration (no API key
required) alongside manual/external overrides:

1. **Built-in automatic or on-demand refresh (recommended default):**
   - Daily Worker Cron updates all tracked and missing currencies when
     `fx_auto_update` is enabled (**disabled by default**), running at the
     configured `fx_auto_update_hour` in `cron_timezone` (defaults to
     `02:00 UTC`). Toggle or adjust schedule via UI (`Data -> Exchange rates` /
     `Data -> Background schedule`), API (`PUT /api/v2/settings/fx_auto_update`,
     `PUT /api/v2/cron-schedule`), or MCP (`setting_set` / `cron_schedule_set`).
   - Trigger an immediate refresh anytime via `fx_rates_refresh` (requires `write`
     scope, fresh UUID `idempotency_key`, and standard MRTR confirmation; subject
     to a 60-second cooldown).
2. **External market-data override (`fx_rate_set`):**
   - Use when the user specifies another market-data source or needs a currency
     that the built-in feed does not cover.

## Determine the update set

1. Call `fx_rates_list`. Record `fx_anchor_currency` (usually `USD`),
   `base_currency`, every existing `rates[].code`, `missing`, and `auto_update`.
2. Call `accounts_list` and collect every `accounts[].currency`, including
   archived accounts.
3. Exclude `fx_anchor_currency`: the anchor currency is always `1` relative to
   itself and the server rejects setting an FX rate for it. The uppercase union
   of `rates[].code`, `missing`, and `accounts[].currency` (minus
   `fx_anchor_currency`) is the target set.

`missing` is authoritative for currencies referenced outside accounts as well
(for example, planned or recurring items), so do not derive the update set from
accounts alone.

## Built-in refresh / auto-update (`fx_rates_refresh` & `setting_set`)

- To enable or disable built-in daily updates (ExchangeRate-API, no API key;
  configurable schedule via `cron_schedule_set`, defaults to `02:00 UTC`), call
  `setting_set` with `key: "fx_auto_update"`, `value: "1"` (on) or `"0"` (off),
  and a fresh UUID `idempotency_key`. Confirm via MRTR (`requestState`) unless an
  explicitly authorized unattended run passes `auto_confirm: true`.
- To refresh immediately using the built-in provider, call `fx_rates_refresh`
  with a fresh UUID `idempotency_key` and complete the two-step `requestState`
  confirmation (or `auto_confirm: true` inside an explicitly authorized run).
  Inspect `updated` and `skipped` in the response before reading back
  `fx_rates_list`.

## Obtain and normalize external market data (when not using `fx_rates_refresh`)

For each target when using an external source, obtain a current quote whose quote
direction and as-of time are clear. Money Flow stores:

```text
anchor_per_unit = value of 1 unit of the foreign currency in fx_anchor_currency
```

For example, when `fx_anchor_currency` is `USD`, an `EUR/USD` quote of `1.1564`
is used directly. A source with `USD` as its base that returns `EUR = 0.8647`
instead means 1 USD buys 0.8647 EUR; use the reciprocal (`1 / 0.8647`) as
`anchor_per_unit`.

Before writing, ensure each value is a positive ordinary decimal with no more
than nine digits after the decimal point and no exponent notation. Round only
when the source precision requires it, using a documented deterministic rule;
never silently reverse, guess, reuse a stale value, or infer a quote direction.
If a source is unavailable, incomplete, stale for the requested run, or
ambiguous about quote direction, leave that currency unchanged and report the
blocker.

## Write safely via `fx_rate_set`

For each currency generate one fresh UUID `idempotency_key` and retain it for
all retries of that exact currency and value.

For an authenticated (non-anonymous) client, `fx_rate_set` writes immediately
by default (`auto_confirm` defaults to `true`). MRTR confirmation runs when
`auto_confirm` is explicitly `false` (recommended for interactive runs unless the
user wants immediate writes) or when the client is anonymous.

```json
{
  "code": "EUR",
  "rate": 1.1564,
  "idempotency_key": "<fresh UUID>"
}
```

Treat the write as successful only when `structuredContent.resultType` is
`complete` and `structuredContent.written` is `true`.

If `auto_confirm` is `false`, or the client is anonymous, the server returns
the two-step MRTR response. `resultType: input_required` and `written: false`
mean **nothing was written**. Repeat `fx_rate_set` with the same code, rate,
and idempotency key plus the returned `requestState`; then require `complete`
and `written: true`.

If the connection fails or the result is unclear after a write attempt, do not
create a new key or issue a second mutation. Retry with the same key only when
the server permits it. If it reports an uncertain prior write, read back the
provider state and stop for human direction rather than risking an untraceable
duplicate or overwrite.

## Verify and report

Call `fx_rates_list` after all writes or refreshes. For every updated code, verify
the returned rate equals the expected normalized value (allowing only
insignificant trailing-zero formatting) and that `updated_at` is fresh.
For a full reconciliation run, `missing` must be empty; otherwise report each
remaining missing or failed code explicitly.

Report whether the built-in ExchangeRate-API (`fx_rates_refresh`) or a named
external data source was used, the as-of time, target currencies, verified
values, skipped/unchanged currencies, and any failures.

## Scheduling boundary

Prefer Money Flow's built-in `fx_auto_update` setting (daily Worker Cron in
the Worker, off by default, configurable timezone/hour via `cron_schedule_set`)
for standard automatic FX updates. Configure an
external host scheduler only when the user explicitly requests a custom external
market-data source or schedule outside ExchangeRate-API, and verify that the
agent host actually provides a scheduling capability (do not assume tools named
`schedules:*` exist).
