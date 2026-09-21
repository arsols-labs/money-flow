# Operator runbook

Use this only for an explicitly authorized scheduled or batch receipt run.
Read [Notification setup and delivery](notifications.md) before enabling or
changing a job.

## Discover live state

Read the host scheduler and checkpoint state before changing anything. Record:

- enabled/paused state, schedule, executable/skill entrypoint, agent mode, and
  the validated notification policy with primary and fallback destinations;
- source location and read-only access health;
- checkpoint schema and counts for processed sources, booked line keys, fiscal
  IDs, `recurring_evidence_skips`, the fiscal circuit-breaker snapshot,
  unresolved items, and uncertain writes;
- current extraction adapter/model and its documented quota limits;
- current Money Flow MCP tools and scopes.

Do not rely on a copied job ID, channel ID, absolute profile path, model name,
or old “live state” note. A session-only scheduled job is ready when the host
durably retains its output and surfaces owner-action events. An external
destination is ready only after a test message and read-back. If configured
delivery and direct-alert destinations differ, stop and ask the owner before
changing either.

## Safe run modes

Provide these semantic modes even if a runtime spells them differently:

- **inventory/dry run:** list pending supported files; no extraction, state
  mutation, or MCP write;
- **read-only evidence:** decode/fetch/parse selected receipts; no checkpoint or
  Money Flow mutation;
- **bounded live run:** process an explicit file or a small configured batch;
- **scheduled run:** use the previously authorized limits and delivery policy.

Never make a seed/import mode the default. A targeted retry of an extraction
or a failure proven to occur before mutation keeps the original stable keys.
An `UNCERTAIN` write does not: leave that key unused, reconcile with
`operations_list`, keep landed lines, and book only missing lines with new
keys. A disabled gateway or paused scheduler means the run will not fire
even if the job object still exists.

The QR enrichment branch has its own host-persisted consecutive-failure
breaker. Do not silently reset an open breaker. Inspect the failure, verify a
representative parse in read-only mode, then reset the counter explicitly. The
kill switch disables only online enrichment; a complete scan fallback remains
available.

Serialize runs that share checkpoint state, or update the breaker with an
atomic compare-and-set/lock. If the host cannot prevent overlapping updates,
disable online enrichment for unattended runs; last-writer-wins breaker state
is not safe enough.

For recurring reconciliation, read live recurring items, operations, and
fulfillment history before every plan. Execute proposed actions in order and
read back after each one. Persist an evidence-skip marker only after the helper
accepts read-back with the expected next due date, unchanged operation count,
and unchanged account balances. A current empty analytical day remains open;
only an overdue empty day of an explicitly configured analytical rule is
skipped without receipt evidence.

## Quotas and incidents

Honor the extractor's current published quota with a conservative per-run cap,
inter-file delay, bounded exponential backoff, and a circuit breaker. Quota and
model values belong to runtime configuration, not this portable skill.

Classify outcomes:

- `written`: MCP returned `written=true` and read-back matched;
- `duplicate`: stable/exact evidence proved an existing fact;
- `needs-input`: one missing owner decision; do not repeatedly notify;
- `unresolved`: understood but unsafe/unsupported to mutate;
- `failed`: transient extraction/network/MCP failure; retain for retry;
- `uncertain`: mutation outcome cannot be proved. Do not freeze the receipt
  forever, reconnect, or replay the same key. Reconcile provider state with
  `operations_list`, keep confirmed lines, book missing lines with new keys,
  and only then run recurring/cigarette advancement. Escalate only if
  read-back still cannot settle a line.

Send only actionable questions, incident alerts, and the requested completion
summary through the runtime's verified delivery policy. Deduplicate by event
ID, report delivery failure separately from the receipt outcome, and use only
the declared fallback. Do not send receipt payloads or credentials.
