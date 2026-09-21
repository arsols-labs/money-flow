#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


PROVIDERS = {"session", "slack", "telegram", "whatsapp"}
EVENTS = {"action_required", "incident", "completion", "routine_success"}
REQUIRED_ALERT_EVENTS = {"action_required", "incident"}
TOP_LEVEL_KEYS = {
    "version",
    "primary_destination",
    "fallback_destination",
    "routine_success",
    "include_receipt_details",
    "destinations",
}
DESTINATION_KEYS = {"id", "provider", "target", "events"}
ACTION_REQUIRED_CONTEXT_KEYS = {
    "filename",
    "merchant_or_service",
    "receipt_date",
    "total_minor",
    "currency",
    "matched_account",
    "matched_recurring_rule",
    "question",
}


class PolicyError(ValueError):
    pass


def recommended_policy() -> dict[str, Any]:
    return {
        "version": 1,
        "primary_destination": "session",
        "fallback_destination": None,
        "routine_success": "silent",
        "include_receipt_details": False,
        "destinations": [
            {
                "id": "session",
                "provider": "session",
                "target": "current",
                "events": ["action_required", "incident", "completion"],
            }
        ],
    }


def _require_exact_keys(value: dict[str, Any], allowed: set[str], label: str) -> None:
    unknown = set(value) - allowed
    if unknown:
        raise PolicyError(f"{label} has unknown fields: {', '.join(sorted(unknown))}")


def validate_policy(policy: Any, *, scheduled: bool = False) -> dict[str, Any]:
    if not isinstance(policy, dict):
        raise PolicyError("policy must be a JSON object")
    _require_exact_keys(policy, TOP_LEVEL_KEYS, "policy")

    if policy.get("version") != 1:
        raise PolicyError("version must be 1")
    if policy.get("routine_success") not in {"silent", "notify"}:
        raise PolicyError("routine_success must be 'silent' or 'notify'")
    if policy.get("include_receipt_details") is not False:
        raise PolicyError("include_receipt_details must remain false")

    destinations = policy.get("destinations")
    if not isinstance(destinations, list) or not destinations:
        raise PolicyError("destinations must be a non-empty array")

    by_id: dict[str, dict[str, Any]] = {}
    for index, destination in enumerate(destinations):
        label = f"destinations[{index}]"
        if not isinstance(destination, dict):
            raise PolicyError(f"{label} must be an object")
        _require_exact_keys(destination, DESTINATION_KEYS, label)

        destination_id = destination.get("id")
        if not isinstance(destination_id, str) or not destination_id.strip():
            raise PolicyError(f"{label}.id must be a non-empty string")
        if destination_id in by_id:
            raise PolicyError(f"duplicate destination id: {destination_id}")

        provider = destination.get("provider")
        if provider not in PROVIDERS:
            raise PolicyError(f"{label}.provider is unsupported")
        target = destination.get("target")
        if not isinstance(target, str) or not target.strip():
            raise PolicyError(f"{label}.target must be a non-empty string")
        if provider == "session" and target != "current":
            raise PolicyError("session target must be 'current'")

        events = destination.get("events")
        if not isinstance(events, list) or not events:
            raise PolicyError(f"{label}.events must be a non-empty array")
        if any(not isinstance(event, str) or event not in EVENTS for event in events):
            raise PolicyError(f"{label}.events contains an unsupported event")
        if len(events) != len(set(events)):
            raise PolicyError(f"{label}.events contains duplicates")

        by_id[destination_id] = destination

    primary_id = policy.get("primary_destination")
    if primary_id not in by_id:
        raise PolicyError("primary_destination must reference a destination id")
    fallback_id = policy.get("fallback_destination")
    if fallback_id is not None and fallback_id not in by_id:
        raise PolicyError("fallback_destination must be null or reference a destination id")
    if fallback_id == primary_id:
        raise PolicyError("fallback_destination must differ from primary_destination")

    for role, destination_id in (("primary", primary_id), ("fallback", fallback_id)):
        if destination_id is None:
            continue
        subscribed = set(by_id[destination_id]["events"])
        if not REQUIRED_ALERT_EVENTS.issubset(subscribed):
            raise PolicyError(f"{role} destination must subscribe to action_required and incident")

    if policy["routine_success"] == "notify" and not any(
        "routine_success" in destination["events"] for destination in destinations
    ):
        raise PolicyError("routine_success is notify but no destination subscribes to it")

    return policy


def validate_action_required_context(context: Any) -> dict[str, Any]:
    """Validate the privacy-safe context required for an owner question."""
    if not isinstance(context, dict):
        raise PolicyError("action_required context must be a JSON object")
    _require_exact_keys(context, ACTION_REQUIRED_CONTEXT_KEYS, "action_required context")
    for field in (
        "filename",
        "merchant_or_service",
        "receipt_date",
        "currency",
        "matched_account",
        "question",
    ):
        if not isinstance(context.get(field), str) or not context[field].strip():
            raise PolicyError(f"action_required context.{field} must be a non-empty string")
    try:
        from datetime import date

        value = context["receipt_date"]
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value) is None:
            raise ValueError
        if date.fromisoformat(value).isoformat() != value:
            raise ValueError
    except ValueError as exc:
        raise PolicyError("action_required context.receipt_date must be YYYY-MM-DD") from exc
    if len(context["currency"]) != 3 or not context["currency"].isalpha() or not context["currency"].isupper():
        raise PolicyError("action_required context.currency must be an uppercase ISO code")
    if (
        isinstance(context.get("total_minor"), bool)
        or not isinstance(context.get("total_minor"), int)
        or context["total_minor"] <= 0
    ):
        raise PolicyError("action_required context.total_minor must be a positive integer")
    rule = context.get("matched_recurring_rule")
    if rule is not None and (not isinstance(rule, str) or not rule.strip()):
        raise PolicyError("action_required context.matched_recurring_rule must be null or a non-empty string")
    return context


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise PolicyError(f"cannot read policy: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise PolicyError(f"invalid JSON: {exc.msg}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Validate receipt notification policy")
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("recommend", help="print the safe interactive default")
    validate_parser = subparsers.add_parser("validate", help="validate a policy file")
    validate_parser.add_argument("--scheduled", action="store_true")
    validate_parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)

    try:
        if args.command == "recommend":
            print(json.dumps(recommended_policy(), indent=2, sort_keys=True))
            return 0
        validate_policy(_load(args.path), scheduled=args.scheduled)
    except PolicyError as exc:
        print(f"invalid notification policy: {exc}", file=sys.stderr)
        return 2

    print("notification policy is valid")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
