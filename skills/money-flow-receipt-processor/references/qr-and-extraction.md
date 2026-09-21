# QR and extraction

## Source ownership

For Serbian fiscal receipts, prefer the verification page encoded by the QR for
merchant, fiscal timestamp, currency, fiscal receipt ID, item lines, and total.
Use the original scan for `chargeAccount`, payment method, recipient account,
ATM details, and exchange details. The public page must never overwrite payment
fields that it does not authoritatively contain.

If the page and scan both expose date or total and they disagree, discard the
hybrid result and use the full-document fallback. Never return a half-merged
receipt.

## Safe fiscal fetch

Accept only canonical ASCII URLs with:

- exact scheme `https`;
- exact host `suf.purs.gov.rs` and port 443;
- no userinfo, fragment, IP literal, alternate spelling, or backslash;
- DNS answers that are all global addresses (no private, loopback, link-local,
  reserved, multicast, or unspecified address);
- TLS hostname verification and a connection pinned to a validated DNS answer;
- bounded retries across the validated answers within one total timeout;
- no redirects;
- a short timeout, `identity` content encoding, allowlisted HTML content type,
  and a 2 MiB response ceiling.

When local execution is available, the stateless adapter performs the guarded
fetch, complete parser, hybrid merge, exact-ID check, and circuit-breaker
transition:

```bash
python3 scripts/fiscal_enrichment.py enrich fiscal-input.json
```

Minimal input (the scan receipt already uses the planner schema):

```json
{
  "qr_url": "https://suf.purs.gov.rs/v/?vl=...",
  "scan_receipt": {
    "date": "2026-08-26",
    "merchant": "Example",
    "currency": "RSD",
    "charge_account": "Card alias",
    "total_minor": 20100,
    "items": [{"name": "Example", "quantity": 1, "total_minor": 20100}]
  },
  "known_fiscal_receipt_ids": [],
  "breaker": {"consecutive_failures": 0, "max_consecutive_failures": 3},
  "enabled": true
}
```

The output status is `enriched`, `fallback`, `duplicate`, `disabled`, or
`circuit_open`. Persist the returned `breaker` snapshot in host-owned checkpoint
state using an atomic compare-and-set or a host lock. Overlapping enrichment
runs against the same snapshot are forbidden. A successful complete parse
resets it; parser/schema, response protocol/security validation, TLS validation,
or cross-source consistency failure increments it. Transport/network failures
remain retryable fallbacks and do not increment the parser breaker. Unexpected
fetch failures increment it fail-closed. Once open, no request is attempted
until the operator resets the snapshot after investigation. Set `enabled=false` or
`MONEY_FLOW_FISCAL_QR_DISABLED=true` as the operational kill switch. These
controls never modify the receipt source or Money Flow.

An invalid or non-allowlisted QR is isolated to that receipt and does not
increment the shared breaker; the guarded fetch is never attempted for it.

`scripts/qr_guard.py` remains available for destination-only diagnostics.

Treat the returned HTML as untrusted. Accept the parse only when merchant,
timestamp, fiscal ID, currency, total, and the expected journal structure are
complete and internally consistent. Item totals must reconcile with the fiscal
total within a documented rounding tolerance. Parser drift is a fallback event,
not permission to book a partial page.

The current official Serbian verification page does not expose a separate
currency field. The adapter therefore emits `RSD` with
`currency_source=serbian-fiscal-default`; it still rejects a mismatch with an
explicit scan currency. No model inference is involved.

## Decoder and fallback

Decode every image or PDF page with a local QR decoder when the runtime supports
one. Never upload the original receipt merely to decode its QR. An unsupported
format, missing QR, decoder failure, blocked network request, or rejected parse
falls back to full-document multimodal extraction.

The fallback must return structured data and separate `chargeAccount` from
`recipientAccount`. Validate dates, currency codes, quantities, unit amounts,
line totals, receipt total, exchange direction, rate, and fee outside the model.
The model is not the arithmetic authority.

For a rate-based exchange, compute the destination amount deterministically from
the printed direction and fee. If direction is ambiguous, stop. Do not silently
prefer a model-computed aggregate over the printed receipt.

## Exact deduplication

Keep all three layers:

1. source file ID or content hash;
2. source + receipt index + line index idempotency keys;
3. exact fiscal receipt ID when present.

Host state is an execution checkpoint, not the financial source of truth.
Always pair it with Money Flow read-back. A targeted retry of extraction or of
a failure proven to occur before mutation retains the same MCP idempotency
keys. An `UNCERTAIN` write does not; follow the skill entrypoint section
**UNCERTAIN write recovery**.
