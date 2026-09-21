# Money Flow Agent Skills

This directory contains portable, task-specific instructions for AI agents that
use the Money Flow v2 MCP server. Each subdirectory is an independently
importable skill; its entrypoint is `SKILL.md`.

Skills are guidance for a client agent, not application configuration. They do
not grant MCP access, contain credentials, change Money Flow data by themselves,
or create schedules in the Worker. An importing agent must use its authorized
MCP client, inspect the current tool schema, and honor the approval boundaries
in the selected skill.

| Skill | Use it for | Entrypoint |
|---|---|---|
| `money-flow-fx-rate-updater` | Reconcile the USD-anchored FX reference with a current external market-data source and verify the stored result. | [SKILL.md](money-flow-fx-rate-updater/SKILL.md) |
| `money-flow-receipt-processor` | Configure notification delivery, then extract, validate, book, recover mid-receipt `UNCERTAIN` writes by reconciling landed lines, link existing facts to expectations, and reconcile analytical/discrete recurring periods through Money Flow MCP without double-counting balances. | [SKILL.md](money-flow-receipt-processor/SKILL.md) |

When importing `money-flow-receipt-processor`, choose its notification delivery
policy during installation when the host supports onboarding. Otherwise the
skill asks on first use. Interactive use defaults safely to the current session;
Slack, Telegram, WhatsApp, and multi-destination delivery are optional runtime
adapters. Unattended use requires a tested durable external destination. Targets
and credentials remain in the host's canonical secret/configuration stores, not
in this repository.

Add a skill here only when it captures non-obvious, reusable application
behavior. Keep the client workflow in the skill itself; do not copy secrets,
tool implementations, or a platform-specific scheduler configuration into this
directory.
