#!/usr/bin/env python3
"""Deterministic post-booking recurring reconciliation for Money Flow receipts."""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path
from typing import Any


NAMESPACE = uuid.UUID("deaf90d2-018e-55aa-b7dc-a91807831627")
CANONICAL_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def _stable_uuid(*parts: Any) -> str:
    return str(uuid.uuid5(NAMESPACE, "|".join(str(part) for part in parts)))


def _iso_date(value: Any, field: str, errors: list[str]) -> date | None:
    if not isinstance(value, str) or CANONICAL_DATE.fullmatch(value) is None:
        errors.append(f"{field} must be YYYY-MM-DD")
        return None
    try:
        parsed = date.fromisoformat(value)
        if parsed.isoformat() != value:
            raise ValueError
        return parsed
    except ValueError:
        errors.append(f"{field} must be YYYY-MM-DD")
        return None


def _evidence_key(
    source_id: str,
    receipt_index: int,
    recurring_item_id: int,
    occurrence_date: str,
) -> str:
    return (
        f"source_id={source_id}|receipt_index={receipt_index}"
        f"|recurring_item_id={recurring_item_id}|occurrence_date={occurrence_date}"
    )


def _next_daily(value: date, count: int = 1) -> date:
    return value + timedelta(days=count)


def _readback_checkpoint_updates(
    actions: list[dict[str, Any]],
    readbacks: list[dict[str, Any]],
) -> tuple[list[str], list[str]]:
    """Release evidence markers only after exact provider read-back."""
    errors: list[str] = []
    updates: list[str] = []
    by_key: dict[str, dict[str, Any]] = {}
    for action in actions:
        if action.get("checkpoint_keys"):
            by_key[str(action["durable_key"])] = action

    for index, readback in enumerate(readbacks):
        if not isinstance(readback, dict):
            errors.append(f"readbacks[{index}] must be an object")
            continue
        required = {
            "durable_key",
            "observed_next_due_date",
            "operation_count_before",
            "operation_count_after",
            "balances_before",
            "balances_after",
        }
        missing = sorted(required - readback.keys())
        if missing:
            errors.append(f"readbacks[{index}] is missing required fields: {', '.join(missing)}")
            continue
        key = readback.get("durable_key")
        action = by_key.get(str(key))
        if action is None:
            errors.append(f"readbacks[{index}] does not match a pending evidence skip")
            continue
        if readback.get("observed_next_due_date") != action["expected_next_due_date"]:
            errors.append(f"readbacks[{index}] next_due_date does not match")
            continue
        before_count = readback.get("operation_count_before")
        after_count = readback.get("operation_count_after")
        if (
            isinstance(before_count, bool)
            or isinstance(after_count, bool)
            or not isinstance(before_count, int)
            or not isinstance(after_count, int)
            or before_count < 0
            or after_count < 0
        ):
            errors.append(f"readbacks[{index}] operation counts must be non-negative integers")
            continue
        if before_count != after_count:
            errors.append(f"readbacks[{index}] operation count changed")
            continue
        before_balances = readback.get("balances_before")
        after_balances = readback.get("balances_after")
        if (
            not isinstance(before_balances, (dict, list))
            or not isinstance(after_balances, type(before_balances))
        ):
            errors.append(f"readbacks[{index}] balances must be matching objects or arrays")
            continue
        if before_balances != after_balances:
            errors.append(f"readbacks[{index}] account balances changed")
            continue
        updates.extend(str(value) for value in action["checkpoint_keys"])
    return sorted(set(updates)), errors


def _validate_operation_group(
    evidence: list[dict[str, Any]],
    rule: dict[str, Any],
    operations: dict[int, dict[str, Any]],
    match_category: str | None,
    errors: list[str],
) -> tuple[list[int], int]:
    operation_ids: list[int] = []
    qualifying_total = 0
    seen: set[int] = set()
    for item in evidence:
        for raw_id in item.get("operation_ids") or []:
            if isinstance(raw_id, bool) or not isinstance(raw_id, int) or raw_id <= 0:
                errors.append("evidence.operation_ids must contain positive integers")
                continue
            if raw_id in seen:
                continue
            seen.add(raw_id)
            operation = operations.get(raw_id)
            if operation is None:
                errors.append(f"operation {raw_id} is missing from operations read-back")
                continue
            fulfillment = operation.get("fulfillment")
            if fulfillment is not None:
                same_occurrence = (
                    isinstance(fulfillment, dict)
                    and fulfillment.get("recurring_item_id") == rule.get("id")
                    and fulfillment.get("period_due_date") == item.get("occurrence_date")
                )
                if not same_occurrence:
                    errors.append(f"operation {raw_id} already fulfills another expectation")
                    continue
            amount_minor = operation.get("amount_minor")
            if (
                isinstance(amount_minor, bool)
                or not isinstance(amount_minor, int)
                or amount_minor == 0
            ):
                errors.append(f"operation {raw_id}.amount_minor must be a non-zero integer")
                continue
            if operation.get("account_id") != rule.get("account_id"):
                errors.append(f"operation {raw_id} uses a different account")
            if operation.get("currency") != rule.get("currency"):
                errors.append(f"operation {raw_id} uses a different currency")
            if operation.get("date") != item.get("occurrence_date"):
                errors.append(f"operation {raw_id} uses a different calendar date")
            if operation.get("kind") != "expense" or amount_minor >= 0:
                errors.append(f"operation {raw_id} is not an expense")
            if match_category and operation.get("category") != match_category:
                errors.append(f"operation {raw_id} does not match category {match_category}")
            operation_ids.append(raw_id)
            qualifying_total += abs(amount_minor)
    return sorted(operation_ids), qualifying_total


def plan(payload: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    action_required: list[dict[str, Any]] = []
    run_date = _iso_date(payload.get("run_date"), "run_date", errors)
    recurring_items = payload.get("recurring_items") or []
    operations_list = payload.get("operations") or []
    fulfillments = payload.get("recurring_fulfillments") or []
    policies = payload.get("policies") or []
    evidence_list = payload.get("evidence") or []
    processed_raw = payload.get("recurring_evidence_skips") or []
    readbacks = payload.get("readbacks") or []

    for field, value in (
        ("recurring_items", recurring_items),
        ("operations", operations_list),
        ("recurring_fulfillments", fulfillments),
        ("policies", policies),
        ("evidence", evidence_list),
        ("recurring_evidence_skips", processed_raw),
        ("readbacks", readbacks),
    ):
        if not isinstance(value, list):
            errors.append(f"{field} must be an array")

    if errors:
        return {
            "safe": False,
            "errors": errors,
            "action_required": [],
            "actions": [],
            "checkpoint_updates": [],
        }

    if any(not isinstance(value, str) or not value for value in processed_raw):
        return {
            "safe": False,
            "errors": ["recurring_evidence_skips must contain non-empty strings"],
            "action_required": [],
            "actions": [],
            "checkpoint_updates": [],
        }
    processed = set(processed_raw)

    rules = {
        item.get("id"): item
        for item in recurring_items
        if (
            isinstance(item, dict)
            and isinstance(item.get("id"), int)
            and not isinstance(item.get("id"), bool)
        )
    }
    operations = {
        item.get("id"): item
        for item in operations_list
        if (
            isinstance(item, dict)
            and isinstance(item.get("id"), int)
            and not isinstance(item.get("id"), bool)
        )
    }
    history: dict[int, dict[str, dict[str, Any]]] = defaultdict(dict)
    for index, item in enumerate(fulfillments):
        if not isinstance(item, dict):
            errors.append(f"recurring_fulfillments[{index}] must be an object")
            continue
        rule_id = item.get("recurring_item_id")
        period = item.get("period_due_date")
        outcome = item.get("outcome")
        operation_ids = item.get("operation_ids")
        evidence_quantity = item.get("evidence_quantity", 1)
        valid = True
        if isinstance(rule_id, bool) or not isinstance(rule_id, int) or rule_id <= 0:
            errors.append(f"recurring_fulfillments[{index}].recurring_item_id is invalid")
            valid = False
        parsed_period = _iso_date(period, f"recurring_fulfillments[{index}].period_due_date", errors)
        if parsed_period is None:
            valid = False
        if outcome not in {"materialized", "linked", "skipped"}:
            errors.append(f"recurring_fulfillments[{index}].outcome is invalid")
            valid = False
        if (
            not isinstance(operation_ids, list)
            or any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in operation_ids)
            or len(set(operation_ids or [])) != len(operation_ids or [])
        ):
            errors.append(f"recurring_fulfillments[{index}].operation_ids is invalid")
            valid = False
        elif outcome == "skipped" and operation_ids:
            errors.append(f"recurring_fulfillments[{index}] skipped outcome cannot have operations")
            valid = False
        elif outcome in {"materialized", "linked"} and not operation_ids:
            errors.append(f"recurring_fulfillments[{index}] {outcome} outcome requires operations")
            valid = False
        if (
            isinstance(evidence_quantity, bool)
            or not isinstance(evidence_quantity, int)
            or not 1 <= evidence_quantity <= 100
            or (outcome != "linked" and evidence_quantity != 1)
        ):
            errors.append(f"recurring_fulfillments[{index}].evidence_quantity is invalid")
            valid = False
        if valid:
            if str(period) in history[rule_id]:
                errors.append(f"recurring_fulfillments[{index}] duplicates a recurring period")
            else:
                history[rule_id][str(period)] = item

    for rule_id, periods in history.items():
        rule = rules.get(rule_id)
        if rule is None:
            errors.append(f"recurring fulfillment references missing rule {rule_id}")
            continue
        if rule.get("active") is True:
            next_due = _iso_date(rule.get("next_due_date"), f"recurring item {rule_id}.next_due_date", errors)
            if next_due is not None and any(date.fromisoformat(period) >= next_due for period in periods):
                errors.append(f"recurring history for rule {rule_id} is not before next_due_date")

    evidence_by_rule: dict[int, list[dict[str, Any]]] = defaultdict(list)
    operation_claims: dict[int, set[int]] = defaultdict(set)
    for index, item in enumerate(evidence_list):
        if not isinstance(item, dict):
            errors.append(f"evidence[{index}] must be an object")
            continue
        source_id = item.get("source_id")
        receipt_index = item.get("receipt_index")
        rule_id = item.get("recurring_item_id")
        occurrence_date = item.get("occurrence_date")
        operation_ids = item.get("operation_ids")
        valid = True
        if not isinstance(source_id, str) or not source_id.strip():
            errors.append(f"evidence[{index}].source_id is required")
            valid = False
        if isinstance(receipt_index, bool) or not isinstance(receipt_index, int) or receipt_index < 0:
            errors.append(f"evidence[{index}].receipt_index must be non-negative")
            valid = False
        if isinstance(rule_id, bool) or not isinstance(rule_id, int) or rule_id <= 0:
            errors.append(f"evidence[{index}].recurring_item_id is invalid")
            continue
        if _iso_date(occurrence_date, f"evidence[{index}].occurrence_date", errors) is None:
            valid = False
        if (
            not isinstance(operation_ids, list)
            or any(isinstance(value, bool) or not isinstance(value, int) or value <= 0 for value in operation_ids)
            or len(set(operation_ids or [])) != len(operation_ids or [])
        ):
            errors.append(f"evidence[{index}].operation_ids is invalid")
            valid = False
        if not valid:
            continue
        evidence_by_rule[rule_id].append(item)
        for raw_id in operation_ids:
            if isinstance(raw_id, int) and not isinstance(raw_id, bool) and raw_id > 0:
                operation_claims[raw_id].add(rule_id)

    for operation_id, claimed_rules in sorted(operation_claims.items()):
        if len(claimed_rules) > 1:
            action_required.append({
                "operation_id": operation_id,
                "recurring_item_ids": sorted(claimed_rules),
                "question": "Which single recurring rule may claim this verified operation?",
            })

    policy_ids: set[int] = set()
    actions: list[dict[str, Any]] = []
    for policy_index, policy in enumerate(policies):
        if not isinstance(policy, dict):
            errors.append(f"policies[{policy_index}] must be an object")
            continue
        rule_id = policy.get("recurring_item_id")
        mode = policy.get("mode")
        if isinstance(rule_id, bool) or not isinstance(rule_id, int) or rule_id <= 0 or rule_id in policy_ids:
            errors.append(f"policies[{policy_index}].recurring_item_id is invalid or duplicated")
            continue
        policy_ids.add(rule_id)
        rule = rules.get(rule_id)
        if rule is None:
            errors.append(f"recurring item {rule_id} is missing")
            continue
        if rule.get("active") is not True:
            continue
        interval_count = rule.get("interval_count", 1)
        amount_minor = rule.get("amount_minor")
        account_id = rule.get("account_id")
        if (
            isinstance(interval_count, bool)
            or not isinstance(interval_count, int)
            or rule.get("frequency") != "daily"
            or interval_count != 1
        ):
            errors.append(f"recurring item {rule_id} must be a one-day daily rule")
            continue
        if isinstance(amount_minor, bool) or not isinstance(amount_minor, int) or amount_minor >= 0:
            errors.append(f"recurring item {rule_id}.amount_minor must be a negative integer")
            continue
        if isinstance(account_id, bool) or not isinstance(account_id, int) or account_id <= 0:
            errors.append(f"recurring item {rule_id}.account_id is invalid")
            continue
        if not isinstance(rule.get("currency"), str) or not rule["currency"]:
            errors.append(f"recurring item {rule_id}.currency is invalid")
            continue
        due = _iso_date(rule.get("next_due_date"), f"recurring item {rule_id}.next_due_date", errors)
        if due is None or run_date is None:
            continue

        rule_evidence = evidence_by_rule.get(rule_id, [])
        match_category = policy.get("match_category")
        if match_category is not None and not isinstance(match_category, str):
            errors.append(f"policy {rule_id}.match_category must be a string or null")
            continue

        if mode == "analytical_daily":
            coverage_mode = policy.get("coverage_mode", "any_expense")
            max_days = policy.get("max_coverage_days", 1)
            if coverage_mode not in {"any_expense", "budget_multiple"}:
                errors.append(f"policy {rule_id}.coverage_mode is invalid")
                continue
            if isinstance(max_days, bool) or not isinstance(max_days, int) or not 1 <= max_days <= 3:
                errors.append(f"policy {rule_id}.max_coverage_days must be 1..3")
                continue
            grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for item in rule_evidence:
                grouped[str(item["occurrence_date"])].append(item)

            guard = 0
            while due <= run_date:
                guard += 1
                if guard > 366:
                    errors.append(f"recurring item {rule_id} is more than 366 daily periods overdue")
                    break
                due_text = due.isoformat()
                group = grouped.get(due_text, [])
                if group:
                    operation_ids, qualifying_total = _validate_operation_group(
                        group, rule, operations, match_category, errors
                    )
                    if not operation_ids:
                        action_required.append({
                            "recurring_item_id": rule_id,
                            "occurrence_date": due_text,
                            "question": "Which verified expense operations prove this analytical day?",
                        })
                        break
                    coverage = 1
                    if coverage_mode == "budget_multiple":
                        daily_amount = abs(amount_minor)
                        coverage = max(1, min(max_days, qualifying_total // daily_amount))

                    group_keys = [
                        _evidence_key(
                            str(item["source_id"]),
                            int(item["receipt_index"]),
                            rule_id,
                            due_text,
                        )
                        for item in sorted(group, key=lambda value: (str(value["source_id"]), int(value["receipt_index"])))
                    ]
                    for offset in range(coverage):
                        occurrence = _next_daily(due, offset)
                        occurrence_text = occurrence.isoformat()
                        if occurrence_text in history[rule_id]:
                            continue
                        keys = [
                            key.rsplit("|occurrence_date=", 1)[0] + f"|occurrence_date={occurrence_text}"
                            for key in group_keys
                        ]
                        if any(key in processed for key in keys):
                            continue
                        expected = _next_daily(occurrence).isoformat()
                        lead = keys[0]
                        actions.append({
                            "tool": "recurring_item_skip_period",
                            "arguments": {"recurring_item_id": rule_id},
                            "occurrence_date": occurrence_text,
                            "expected_next_due_date": expected,
                            "idempotency_key": _stable_uuid("analytical-skip", lead),
                            "durable_key": lead,
                            "checkpoint_keys": keys,
                            "reason": "qualifying expenses already provide the analytical fact",
                        })
                    due = _next_daily(due, coverage)
                    continue

                if due < run_date:
                    expected = _next_daily(due).isoformat()
                    key = _evidence_key("analytics-overdue", 0, rule_id, due_text)
                    if due_text not in history[rule_id]:
                        actions.append({
                            "tool": "recurring_item_skip_period",
                            "arguments": {"recurring_item_id": rule_id},
                            "occurrence_date": due_text,
                            "expected_next_due_date": expected,
                            "idempotency_key": _stable_uuid("overdue-analytical-skip", key),
                            "durable_key": key,
                            "checkpoint_keys": [],
                            "reason": "overdue analytical day has no qualifying expense",
                        })
                    due = _next_daily(due)
                    continue
                break

        elif mode == "discrete_quantity":
            if len(rule_evidence) != 1:
                action_required.append({
                    "recurring_item_id": rule_id,
                    "question": "Which single receipt line and explicit unit quantity belong to this discrete rule?",
                })
                continue
            item = rule_evidence[0]
            quantity = item.get("explicit_quantity")
            if (
                isinstance(quantity, bool)
                or not isinstance(quantity, int)
                or not 1 <= quantity <= 100
            ):
                action_required.append({
                    "recurring_item_id": rule_id,
                    "question": "What exact integer unit quantity from 1 to 100 is explicitly shown for this item?",
                })
                continue
            first_occurrence = _iso_date(item.get("occurrence_date"), "discrete occurrence_date", errors)
            operation_ids, _ = _validate_operation_group([item], rule, operations, match_category, errors)
            if first_occurrence is None:
                continue
            for offset in range(quantity):
                occurrence = _next_daily(first_occurrence, offset)
                occurrence_text = occurrence.isoformat()
                key = _evidence_key(
                    str(item["source_id"]), int(item["receipt_index"]), rule_id, occurrence_text
                )
                if occurrence_text in history[rule_id] or key in processed:
                    continue
                if occurrence != due:
                    action_required.append({
                        "recurring_item_id": rule_id,
                        "occurrence_date": occurrence_text,
                        "question": "Recurring history and next_due_date do not prove which quantity occurrence remains; reconcile them first.",
                    })
                    break
                expected = _next_daily(due).isoformat()
                if offset == 0:
                    if not operation_ids:
                        action_required.append({
                            "recurring_item_id": rule_id,
                            "occurrence_date": occurrence_text,
                            "question": "Which verified operation records the purchased units?",
                        })
                        break
                    actions.append({
                        "tool": "recurring_item_fulfill_existing",
                        "arguments": {
                            "recurring_item_id": rule_id,
                            "period_due_date": occurrence_text,
                            "operation_ids": operation_ids,
                            "evidence_quantity": quantity,
                        },
                        "occurrence_date": occurrence_text,
                        "expected_next_due_date": expected,
                        "idempotency_key": _stable_uuid("discrete-fulfill", key),
                        "durable_key": key,
                        "checkpoint_keys": [],
                        "reason": "verified existing operations record the discrete purchase",
                    })
                else:
                    actions.append({
                        "tool": "recurring_item_skip_period",
                        "arguments": {"recurring_item_id": rule_id},
                        "occurrence_date": occurrence_text,
                        "expected_next_due_date": expected,
                        "idempotency_key": _stable_uuid("discrete-skip", key),
                        "durable_key": key,
                        "checkpoint_keys": [key],
                        "reason": "explicit unit quantity covers this additional occurrence",
                    })
                due = _next_daily(due)
        else:
            errors.append(f"policy {rule_id}.mode must be analytical_daily or discrete_quantity")

    if action_required:
        actions = []
    checkpoint_updates, readback_errors = _readback_checkpoint_updates(actions, readbacks)
    errors.extend(readback_errors)
    if errors:
        actions = []
        checkpoint_updates = []

    return {
        "safe": not errors and not action_required,
        "errors": errors,
        "action_required": action_required,
        "actions": actions,
        "checkpoint_updates": checkpoint_updates,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    plan_parser = subparsers.add_parser("plan")
    plan_parser.add_argument("input", type=Path)
    args = parser.parse_args(argv)
    payload = json.loads(args.input.read_text(encoding="utf-8"))
    result = plan(payload)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if result["safe"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
