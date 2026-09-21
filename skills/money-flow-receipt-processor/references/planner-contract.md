# Planner contract

`scripts/receipt_plan.py` is a local, read-only preflight helper. It does not
extract images, call MCP, read credentials, or persist state.

## Input

```json
{
  "source_id": "stable-provider-id-or-sha256",
  "receipt_index": 0,
  "receipt": {
    "date": "2026-08-26",
    "merchant": "Example store",
    "currency": "RSD",
    "charge_account": "Card alias",
    "total_minor": 20100,
    "fiscal_receipt_id": "optional exact ID",
    "items": [
      {
        "name": "Example item",
        "quantity": 1,
        "quantity_confirmed": true,
        "total_minor": 20100,
        "category": "Example",
        "subcategory": "Optional"
      }
    ]
  },
  "known_fiscal_receipt_ids": ["optional exact IDs from verified host state"],
  "accounts": [],
  "planned_items": [],
  "recurring_items": []
}
```

`accounts` accepts the live `accounts_list` objects, including nested
`aliases[].alias_text`. Planned and recurring arrays accept the corresponding
MCP list objects. Set `quantity_confirmed=true` only when the fiscal source or
an explicit owner confirmation proves the integer unit count; an extracted or
inferred number alone cannot advance multiple recurring occurrences.
All receipt and occurrence dates must use the canonical `YYYY-MM-DD` form.
Confirmed discrete quantities must be integer values from 1 through 100;
larger batches require owner-guided splitting rather than an oversized plan.

## Output

The command emits JSON with validation errors, warnings, resolved account,
normalized line amounts, stable UUID idempotency keys, duplicate state keys,
and zero-or-one exact reconciliation candidate per line. It returns exit code 2
when planning is unsafe.

When the receipt's non-empty `fiscal_receipt_id` exactly matches an entry in
`known_fiscal_receipt_ids`, the planner returns unsafe and emits no line routes.
The comparison is exact; fuzzy fiscal-ID matching is forbidden.

Small rounding residuals are absorbed into the final line. A larger positive
difference becomes an explicit `Receipt total adjustment` line so the ledger
total remains exact without falsifying a product line. A large negative
difference means extracted lines exceed the receipt total and fails closed; the
extractor must represent discounts correctly before booking.

The planner's candidate is evidence, not authorization. The agent must re-read
live state immediately before a write and apply the rules in
`references/reconciliation.md`.

## Post-booking recurring planner

`scripts/recurring_reconcile.py plan input.json` handles only already-booked
evidence and analytical/discrete recurring advancement. Its input contains:

- `run_date`;
- live `recurring_items`, `operations`, and `recurring_fulfillments` reads;
- explicit `policies` (`analytical_daily` or `discrete_quantity`);
- verified receipt `evidence` with `source_id`, `receipt_index`,
  `recurring_item_id`, `occurrence_date`, and exact `operation_ids`;
- for a discrete item, `explicit_quantity`;
- host-owned `recurring_evidence_skips` and optional provider `readbacks`.

The helper emits ordered MCP actions with stable idempotency keys, exact
occurrence dates, expected next due dates, and pending checkpoint keys. It
emits no checkpoint update until a supplied read-back confirms the expected
`next_due_date`, unchanged operation count, and unchanged balances. Any
ambiguity emits `action_required`, clears all actions, and exits unsafe.

For analytical rules, `any_expense` covers one day per calendar date.
`budget_multiple` is an explicit opt-in that aggregates verified qualifying
expenses for that date and clamps coverage to 1–3 days. For discrete rules,
neither amounts nor overdue time can substitute for `explicit_quantity`.
