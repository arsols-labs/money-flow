#!/usr/bin/env python3
"""Read-only receipt planner for the Money Flow receipt skill."""

from __future__ import annotations

import argparse
import json
import re
import sys
import uuid
from datetime import date, timedelta
from pathlib import Path
from typing import Any


NAMESPACE = uuid.UUID("3e6b5b19-6a37-5d31-8890-0b1bcc920cc3")
CANONICAL_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def is_canonical_date(value: Any) -> bool:
    if not isinstance(value, str) or CANONICAL_DATE.fullmatch(value) is None:
        return False
    try:
        return date.fromisoformat(value).isoformat() == value
    except ValueError:
        return False


def norm(value: Any) -> str:
    return re.sub(r"\s+", " ", str(value or "").strip()).casefold()


def stable_uuid(*parts: Any) -> str:
    return str(uuid.uuid5(NAMESPACE, "|".join(str(part) for part in parts)))


def recurring_evidence_key(
    source_id: str,
    receipt_index: int,
    recurring_item_id: int,
    occurrence_date: str,
) -> str:
    return (
        f"source_id={source_id}|receipt_index={receipt_index}"
        f"|recurring_item_id={recurring_item_id}|occurrence_date={occurrence_date}"
    )


def _aliases(account: dict[str, Any]) -> set[str]:
    values = {norm(account.get("name"))}
    for alias in account.get("aliases") or []:
        values.add(norm(alias.get("alias_text")))
    return {value for value in values if value}


def resolve_account(
    accounts: list[dict[str, Any]],
    receipt: dict[str, Any],
) -> tuple[int | None, list[int]]:
    explicit = receipt.get("account_id")
    if isinstance(explicit, int) and not isinstance(explicit, bool):
        matches = [account for account in accounts if account.get("id") == explicit]
        return (explicit, [explicit]) if len(matches) == 1 else (None, [])

    raw = norm(receipt.get("charge_account"))
    if not raw:
        return None, []
    exact = [account for account in accounts if raw in _aliases(account)]
    if len(exact) == 1:
        account_id = int(exact[0]["id"])
        return account_id, [account_id]

    digits = re.sub(r"\D", "", raw)
    suffix = digits[-4:] if len(digits) >= 4 else ""
    suffix_matches: list[dict[str, Any]] = []
    if suffix:
        for account in accounts:
            values = [str(account.get("account_number") or "")]
            values += [
                str(alias.get("alias_text") or "")
                for alias in account.get("aliases") or []
            ]
            if any(re.sub(r"\D", "", value).endswith(suffix) for value in values):
                suffix_matches.append(account)
    ids = sorted({int(account["id"]) for account in (exact or suffix_matches)})
    return (ids[0], ids) if len(ids) == 1 else (None, ids)


def normalize_lines(
    receipt: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str], list[str]]:
    errors: list[str] = []
    warnings: list[str] = []
    total = receipt.get("total_minor")
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return [], ["receipt.total_minor must be a positive integer"], warnings

    raw_items = receipt.get("items")
    if raw_items is None or raw_items == []:
        return [
            {
                "name": receipt.get("merchant") or "Receipt",
                "quantity": 1,
                "total_minor": total,
            }
        ], errors, ["no item lines; using receipt total"]
    if not isinstance(raw_items, list):
        return [], ["receipt.items must be an array or null"], warnings

    lines: list[dict[str, Any]] = []
    for index, item in enumerate(raw_items):
        if not isinstance(item, dict):
            errors.append(f"receipt.items[{index}] must be an object")
            continue
        amount = item.get("total_minor")
        if isinstance(amount, bool) or not isinstance(amount, int) or amount <= 0:
            errors.append(
                f"receipt.items[{index}].total_minor must be a positive integer"
            )
            continue
        line = dict(item)
        line["name"] = str(item.get("name") or f"Receipt line {index + 1}")
        line["quantity"] = item.get("quantity", 1)
        line["total_minor"] = amount
        lines.append(line)

    if errors:
        return [], errors, warnings
    residual = total - sum(int(line["total_minor"]) for line in lines)
    if residual:
        if abs(residual) <= 2:
            lines[-1]["total_minor"] += residual
            warnings.append(
                f"absorbed {residual} minor-unit rounding residual into final line"
            )
        else:
            lines.append(
                {
                    "name": "Receipt total adjustment",
                    "quantity": 1,
                    "total_minor": residual,
                    "category": None,
                    "subcategory": None,
                }
            )
            warnings.append(
                f"added explicit {residual} minor-unit receipt adjustment"
            )
    if any(int(line["total_minor"]) <= 0 for line in lines):
        errors.append("line reconciliation produced a non-positive expense line")
    return lines, errors, warnings


def _token_overlap(left: Any, right: Any) -> bool:
    left_tokens = {
        token for token in re.findall(r"[\w]+", norm(left)) if len(token) >= 3
    }
    right_tokens = {
        token for token in re.findall(r"[\w]+", norm(right)) if len(token) >= 3
    }
    return bool(left_tokens & right_tokens)


def _category_match(
    line: dict[str, Any],
    candidate: dict[str, Any],
) -> bool:
    category = norm(line.get("category"))
    return bool(category and category == norm(candidate.get("category")))


def planned_candidates(
    line: dict[str, Any],
    receipt: dict[str, Any],
    account_id: int,
    items: list[dict[str, Any]],
) -> list[int]:
    result: list[int] = []
    for candidate in items:
        if candidate.get("done") is True:
            continue
        mandatory = (
            candidate.get("account_id") == account_id
            and norm(candidate.get("currency")) == norm(receipt.get("currency"))
            and candidate.get("date") == receipt.get("date")
            and candidate.get("amount_minor") == -abs(int(line["total_minor"]))
        )
        corroborated = _category_match(line, candidate) or _token_overlap(
            line.get("name"), candidate.get("title")
        )
        if mandatory and corroborated:
            result.append(int(candidate["id"]))
    return result


def recurring_candidates(
    line: dict[str, Any],
    receipt: dict[str, Any],
    account_id: int,
    items: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for candidate in items:
        if candidate.get("active") is not True:
            continue
        mandatory = (
            candidate.get("account_id") == account_id
            and norm(candidate.get("currency")) == norm(receipt.get("currency"))
            and candidate.get("next_due_date") == receipt.get("date")
            and int(candidate.get("amount_minor") or 0) < 0
        )
        if not mandatory:
            continue
        quantity = line.get("quantity", 1)
        integral_quantity = (
            isinstance(quantity, int)
            and not isinstance(quantity, bool)
            and 1 <= quantity <= 100
        )
        quantity_int = quantity if integral_quantity else 1
        line_total = abs(int(line["total_minor"]))
        candidate_amount = int(candidate.get("amount_minor") or 0)
        exact = candidate_amount == -line_total
        multiple = (
            candidate.get("frequency") == "daily"
            and int(candidate.get("interval_count") or 1) == 1
            and line.get("quantity_confirmed") is True
            and integral_quantity
            and line_total % quantity_int == 0
            and candidate_amount == -(line_total // quantity_int)
        )
        corroborated = _category_match(line, candidate) or _token_overlap(
            line.get("name"), candidate.get("title")
        )
        if corroborated and (exact or multiple):
            result.append(
                {
                    "recurring_item_id": int(candidate["id"]),
                    "covered_occurrences": quantity_int if multiple else 1,
                }
            )
    return result


def plan(payload: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    warnings: list[str] = []
    source_id = str(payload.get("source_id") or "").strip()
    receipt_index = payload.get("receipt_index")
    receipt = payload.get("receipt")
    if not isinstance(receipt, dict):
        receipt = {}
        errors.append("receipt must be an object")
    if not source_id:
        errors.append("source_id is required")
    if isinstance(receipt_index, bool) or not isinstance(receipt_index, int) or receipt_index < 0:
        errors.append("receipt_index must be a non-negative integer")
    if not is_canonical_date(receipt.get("date")):
        errors.append("receipt.date must be YYYY-MM-DD")
    currency = receipt.get("currency")
    if not isinstance(currency, str) or not re.fullmatch(r"[A-Z]{3}", currency):
        errors.append("receipt.currency must be an uppercase three-letter code")

    known_fiscal_ids = payload.get("known_fiscal_receipt_ids", [])
    if not isinstance(known_fiscal_ids, list) or not all(
        isinstance(value, str) for value in known_fiscal_ids
    ):
        errors.append("known_fiscal_receipt_ids must be an array of strings")
    else:
        fiscal_id = receipt.get("fiscal_receipt_id")
        if isinstance(fiscal_id, str) and fiscal_id and fiscal_id in known_fiscal_ids:
            errors.append("exact fiscal receipt ID is already present in verified host state")

    accounts = payload.get("accounts") or []
    account_id, account_matches = resolve_account(accounts, receipt)
    if account_id is None:
        errors.append("charge account did not resolve uniquely")
    else:
        account = next(
            account for account in accounts if account.get("id") == account_id
        )
        if norm(account.get("currency")) != norm(currency):
            errors.append(
                "receipt currency does not match resolved account currency"
            )

    lines, line_errors, line_warnings = normalize_lines(receipt)
    errors.extend(line_errors)
    warnings.extend(line_warnings)

    output_lines: list[dict[str, Any]] = []
    if not errors and account_id is not None:
        for index, line in enumerate(lines):
            planned = planned_candidates(
                line,
                receipt,
                account_id,
                payload.get("planned_items") or [],
            )
            recurring = recurring_candidates(
                line,
                receipt,
                account_id,
                payload.get("recurring_items") or [],
            )
            route: dict[str, Any] = {"type": "operation_add"}
            if len(planned) + len(recurring) > 1:
                route = {
                    "type": "ambiguous",
                    "planned_ids": planned,
                    "recurring": recurring,
                }
                errors.append(
                    f"line {index} has multiple reconciliation candidates"
                )
            elif planned:
                route = {
                    "type": "planned_item_update",
                    "planned_item_id": planned[0],
                    "done": True,
                }
            elif recurring:
                route = {
                    "type": "recurring_item_close_period",
                    **recurring[0],
                }
                first_occurrence = date.fromisoformat(str(receipt["date"]))
                future_skips = []
                for occurrence in range(1, recurring[0]["covered_occurrences"]):
                    occurrence_date = (first_occurrence + timedelta(days=occurrence)).isoformat()
                    durable_key = recurring_evidence_key(
                        source_id,
                        int(receipt_index),
                        recurring[0]["recurring_item_id"],
                        occurrence_date,
                    )
                    future_skips.append({
                        "occurrence_date": occurrence_date,
                        "durable_key": durable_key,
                        "idempotency_key": stable_uuid("recurring-skip", durable_key),
                    })
                route["future_skips"] = future_skips
                route["future_skip_idempotency_keys"] = [
                    skip["idempotency_key"] for skip in future_skips
                ]
            line_out = dict(line)
            line_out.update(
                {
                    "amount_minor": -abs(int(line["total_minor"])),
                    "idempotency_key": stable_uuid(
                        source_id,
                        receipt_index,
                        "line",
                        index,
                    ),
                    "route": route,
                }
            )
            output_lines.append(line_out)

    return {
        "safe": not errors,
        "errors": errors,
        "warnings": warnings,
        "account_id": account_id,
        "account_matches": account_matches,
        "state_keys": {
            "receipt": f"{source_id}:{receipt_index}",
            "fiscal_receipt_id": receipt.get("fiscal_receipt_id"),
        },
        "lines": output_lines,
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
