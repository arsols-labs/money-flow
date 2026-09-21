---
name: money-flow-fx-rate-updater
description: Refresh Money Flow v2's USD-anchored FX reference through its MCP server. Use when an authorized agent must reconcile stored or missing currency rates; do not use to change base currency or configure a scheduler.
---

# Money Flow FX Rate Updater

Use this skill to refresh the FX reference of Money Flow v2 through its MCP
server. It updates reference data only; it never transfers money, changes an
account balance, or changes the application's base-currency setting.

## Preconditions

- The caller has an authorized Money Flow MCP client with both `read` and
  `write` scopes.
- The user has asked for the update, or has already authorized the external
  scheduled job that invokes it.
- Inspect `tools/list` when the client exposes it, and use the server's current
  schemas rather than assuming a client-specific wrapper has the same shape.

The application does not fetch market data or own a schedule. An agent chooses
and reads an external market-data source; its host may schedule that agent.

## Determine the update set

1. Call `fx_rates_list`. Record `base_currency`, every existing `rates[].code`,
   and `missing`.
2. Call `accounts_list` and collect every `accounts[].currency`, including
   archived accounts.
3. Update the uppercase, non-`USD` union of those three lists. This refreshes
   existing reference rows and fills currencies currently needed by the
   application. Do not create a rate for `USD`: it is always exactly 1 USD and
   the server rejects it.

`missing` is authoritative for currencies referenced outside accounts as well
(for example, planned or recurring items), so do not derive the update set from
accounts alone.

## Obtain and normalize market data

For each target, obtain a current quote from a source whose quote direction and
as-of time are clear. Money Flow stores:

```text
usd_per_unit = USD value of 1 unit of the foreign currency
```

Thus an `EUR/USD` quote of `1.1564` is used directly. A source with `USD` as
its base that returns `EUR = 0.8647` instead means 1 USD buys 0.8647 EUR; use
the reciprocal as `usd_per_unit`.

Before writing, ensure each value is a positive ordinary decimal with no more
than nine digits after the decimal point and no exponent notation. Round only
when the source precision requires it, using a documented deterministic rule;
never silently reverse, guess, reuse a stale value, or infer a quote direction.
If a source is unavailable, incomplete, stale for the requested run, or
ambiguous about quote direction, leave that currency unchanged and report the
blocker.

## Write safely

For each currency generate one fresh UUID `idempotency_key` and retain it for
all retries of that exact currency and value.

For an unattended, already-authorized run, call `fx_rate_set` with:

```json
{
  "code": "EUR",
  "rate": 1.1564,
  "idempotency_key": "<fresh UUID>",
  "auto_confirm": true
}
```

Treat the write as successful only when `structuredContent.resultType` is
`complete` and `structuredContent.written` is `true`.

Some clients or server configurations may return the normal two-step MRTR
response instead. In that case, `resultType: input_required` and
`written: false` mean **nothing was written**. Repeat `fx_rate_set` with the
same code, rate, and idempotency key plus the returned `requestState`; then
require `complete` and `written: true`.

If the connection fails or the result is unclear after a write attempt, do not
create a new key or issue a second mutation. Retry with the same key only when
the server permits it. If it reports an uncertain prior write, read back the
provider state and stop for human direction rather than risking an untraceable
duplicate or overwrite.

## Verify and report

Call `fx_rates_list` after all writes. For every successfully updated code,
verify the returned rate equals the normalized `usd_per_unit` value (allowing
only insignificant trailing-zero formatting) and that `updated_at` is fresh.
For a full reconciliation run, `missing` must be empty; otherwise report each
remaining missing or failed code explicitly.

Report the data-source name and as-of time, target currencies, values actually
verified, currencies deliberately unchanged, and any failures. Do not report
success merely because an update was requested or a confirmation was issued.

## Scheduling boundary

Create or alter a recurring job only when the user explicitly requests it and
the agent host provides a verified scheduling capability. Configure that host to
invoke this skill at the requested time and to preserve the verification
summary. Do not assume tools named `schedules:*` exist, and do not represent an
external scheduler as a Money Flow application feature.
