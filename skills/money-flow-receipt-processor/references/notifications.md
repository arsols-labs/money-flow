# Notification setup and delivery

Use this contract for interactive, batch, and scheduled receipt runs. The skill
describes routing; the agent host owns connectors, targets, credentials, and
delivery state.

## Onboarding question

At installation, or once at first invocation when the host has no install hook,
ask:

> Where should receipt-run notifications be delivered: this session, Slack,
> Telegram, WhatsApp, or a combination? For unattended runs, the scheduled
> session is the simplest default when the host retains it and alerts you;
> otherwise I recommend one durable external primary destination and an
> optional fallback.

Do not block a run when no choice was saved: use `session` and state the
default. For an unattended schedule, verify that the host retains scheduled
task output and makes owner-action events visible. Require and test an external
destination only when the host session lacks that durability or the owner chose
an external channel.

## Portable policy

Store the policy in the host's canonical configuration, never in this skill.
The deterministic validator accepts this shape:

```json
{
  "version": 1,
  "primary_destination": "session",
  "fallback_destination": null,
  "routine_success": "silent",
  "include_receipt_details": false,
  "destinations": [
    {
      "id": "session",
      "provider": "session",
      "target": "current",
      "events": ["action_required", "incident", "completion"]
    }
  ]
}
```

Supported providers are `session`, `slack`, `telegram`, and `whatsapp`.
Destination IDs are local aliases. External `target` values are provider-owned
channel, chat, group, or recipient identifiers; keep them outside the repo and
avoid displaying them unnecessarily. Credentials are never policy fields.

`primary_destination` must exist. `fallback_destination` is optional, distinct
from primary, and used only after a confirmed primary delivery failure. Both
must subscribe to `action_required` and `incident`. `routine_success` is
`silent` by default or `notify` by explicit choice. `include_receipt_details`
remains `false`; changing it requires a separate privacy review and is rejected
by the bundled validator.

## Event envelope

Build a minimal provider-neutral event before calling any adapter:

- `event_id`: stable ID derived from run ID and event kind for deduplication;
- `kind`: `action_required`, `incident`, `completion`, or `routine_success`;
- `title`: short outcome without receipt contents;
- `action`: smallest owner action, only when required;
- `run_id`: opaque execution reference;
- `counts`: written, duplicate, unresolved, failed, and uncertain totals;
- `reference`: safe canonical task/run reference when available.

An `action_required` event must additionally contain a validated context with:

- filename;
- merchant or service label;
- receipt date;
- positive total in minor units and currency;
- matched Money Flow account;
- matched recurring rule when applicable;
- one exact owner question.

Use `validate_action_required_context()` from `scripts/notification_policy.py`
before delivery. Do not include images, item lines, fiscal/payment identifiers,
card numbers, addresses, or email addresses. The merchant/service label is a
short business name, not copied address or fiscal-header data.

Never include receipt images, line items, payment identifiers, full merchant
data, credentials, tool payloads, or raw model output. A completion event can
contain counts and a canonical reference. Deliver `routine_success` only when
the policy opts in.

## Adapter contract

Prefer the host's direct authorized MCP/API connector, then its supported
CLI/SDK. UI automation is exceptional. For Slack, Telegram, and WhatsApp:

1. Resolve the configured destination without exposing secrets.
2. Obtain explicit authorization before the first test message unless the host
   already has a documented authorized setup flow.
3. Send a privacy-safe test event and verify provider acknowledgement or
   read-back before unattended use.
4. Persist a delivery record keyed by `event_id` only after acknowledgement.
5. On confirmed failure, try the configured fallback once. Never choose another
   channel or recipient implicitly.
6. If delivery remains uncertain, freeze that event ID. Reconcile provider
   state before retrying so a financial incident is not spammed repeatedly.

Financial state and delivery state are independent. A message failure cannot
turn a verified Money Flow write into a failed write, and a delivered message
cannot prove that a write happened.

## Provider guidance

- `session`: render in the active or scheduled agent conversation. It may be
  the only destination when that host durably retains scheduled output and
  surfaces owner-action events.
- `slack`: use an authorized Slack connector/app and a configured channel or DM
  target. Post owner questions in a thread and let the next scheduled run read
  ordinary thread replies; requiring `@ChatGPT` is forbidden. Do not request or
  embed a webhook URL in chat.
- `telegram`: use an authorized bot/client connector and an approved chat
  target. Do not request or embed a bot token in chat.
- `whatsapp`: use an authorized business/API connector and an approved
  recipient or group target. Do not automate a personal UI session as a hidden
  fallback.

Multiple destinations are supported, but designate one primary and at most one
fallback for incidents. Additional destinations may subscribe to `completion`
or opt-in `routine_success`; they must not multiply action-required alerts by
default.
