# Planned and recurring reconciliation

Reconciliation is a routing decision before or after receipt booking. The goal
is one financial fact plus durable expectation history, never “receipt
operation plus completion operation.”

## Candidate gate

Read open planned items and active recurring rules before writing. Auto-route
only when exactly one candidate satisfies all mandatory dimensions:

- same account and currency;
- compatible expense sign;
- exact due date for planned items, or the current `next_due_date` occurrence
  for a recurring rule;
- exact amount, or a documented quantity multiple for a daily consumable;
- corroborating category or normalized title/item evidence.

Store/merchant similarity is supporting evidence, not enough by itself. Do not
use a broad fuzzy score, cross-currency comparison, or “closest amount.” More
than one candidate is ambiguous and requires owner input.

## Before the receipt operation exists

### Planned item

When one receipt line exactly satisfies one open planned item, call
`planned_item_update` with the actual date, account, amount, category/title as
needed, and `done=true` **instead of** `operation_add` for that line. Verify the
returned linked operation and the plan's `done` state.

Do not use this route for an already-booked line; use
`planned_item_fulfill_existing` below.

### Recurring current period

When one receipt line exactly satisfies the current occurrence, call
`recurring_item_close_period` with the actual line date, account, amount, item,
category, and subcategory **instead of** `operation_add` for that line. Verify
the created operation, closure, balance effect, and advanced `next_due_date`.

For a daily consumable covering `N` occurrences (for example three packs bought
at once), the close-period operation records the actual full line amount once.
After it succeeds, call `recurring_item_skip_period` exactly `N - 1` times to
advance the already-covered future occurrences without creating operations or
changing balance. Each period gets its own stable idempotency key and read-back.

Never infer `N` from price alone when quantity is absent or non-integral.

## After the financial operation already exists

A periodic reconciliation scan must not materialize a second fact.

- For one exact open planned item, call `planned_item_fulfill_existing` with the
  verified operation ID. Read back `done=true`, the linked fulfillment, the
  unchanged operation provenance, unchanged operation count, and unchanged
  balances.
- For one exact current recurring occurrence, call
  `recurring_item_fulfill_existing` with its due date and the complete sorted
  operation-ID group. For explicitly counted discrete units, also pass
  `evidence_quantity`; it validates `rule.amount_minor × quantity` but advances
  exactly one occurrence. Read back one `linked` fulfillment with exactly that
  group and evidence quantity, the rule advanced exactly once, unchanged
  operation count, and unchanged balances.
- If these tools are absent, return `needs-link-capability`. Never substitute
  delete, `done=true`, or `close_period`.

An operation linked as recurring evidence cannot be deleted until the
fulfillment is explicitly undone. This fail-closed rule prevents an advanced
recurring schedule from retaining a false evidence record.
Semantic fields of externally linked operations and plans (date, account,
kind/category, currency where applicable, and amount) must not be edited while
the link exists. Reopen/unlink first; descriptive labels may still be corrected.

## Explicit analytical daily policies

Analytical daily rules are optional markers for reporting, not financial facts.
The host must identify them explicitly by recurring item ID and select one
coverage mode. Never infer this policy merely because a rule is daily.

- `any_expense`: all qualifying receipt evidence on one calendar date covers
  at most one occurrence, regardless of receipt count, line count, or total.
- `budget_multiple`: aggregate the verified qualifying expense total for one
  calendar date and calculate `floor(total / abs(daily_amount))`, clamped to
  1–3 days. This is opt-in and intended for variable budgets such as groceries.

For either mode, use `recurring_item_skip_period`; do not create or link another
financial fact. The provider rejects `close_period` and `fulfill_existing` on
analytical recurring ids 16 and 17 with `ANALYTICAL_RECURRING_SKIP_ONLY`. If the current due date has qualifying expenses, skip the
covered occurrence(s). If a due date is before the run date and has no
qualifying expense, skip that overdue analytical occurrence. If the current
date has no qualifying expense, leave it open. This no-evidence catch-up is
for explicitly configured analytical rules only.

## Discrete consumables

For items such as cigarette packs, occurrence count comes only from an
explicitly confirmed integer unit quantity (`quantity_confirmed=true` in the
pre-booking planner or `explicit_quantity` in the post-booking helper), bounded
to the MCP provider contract of 1–100 units. The existing operation group may
fulfill the first current occurrence; each additional unit permits one exact
`recurring_item_skip_period`. Pass the explicit unit count as
`evidence_quantity` when linking the first operation group; that field validates
the recorded aggregate and never advances the extra periods itself. Subtract occurrences already represented by a
materialized/linked fulfillment or a verified prior skip. Never derive units
from total amount, price ratios, elapsed days, or the current date, and never
catch up an unproved discrete period.

## Idempotency and checkpoints

Use `scripts/recurring_reconcile.py` for post-booking actions. Every evidence
skip key includes `source_id`, `receipt_index`, `recurring_item_id`, and the
exact occurrence date. Replaying a processed key must not produce another
skip. Save `recurring_evidence_skips` only after provider read-back proves the
expected `next_due_date`, identical operation count, and identical account
balances. The server-side fulfillment history remains the source of truth for
materialized, linked, and skipped occurrences.

Ambiguous operation groups, missing explicit quantity, conflicting history, or
insufficient evidence produce `action_required` and no mutation plan.

This limitation is an application/MCP capability gap, not an invitation to
maintain a second ledger in scheduler state.

## Mid-receipt UNCERTAIN writes

Do not start planned/recurring or cigarette/discrete advancement while any
booking write for that receipt is `UNCERTAIN`. First reconcile landed lines
with `operations_list` (or the equivalent read), keep confirmed operations,
and book only missing lines with **new** idempotency keys. Follow the skill
entrypoint section **UNCERTAIN write recovery**. Recurring and cigarette
advancement starts only after every line for that date/account/store is
settled. An `UNCERTAIN` key is reconcile-required; never replay it.
