#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("receipt_plan.py")
SPEC = importlib.util.spec_from_file_location("receipt_plan", MODULE_PATH)
rp = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = rp
SPEC.loader.exec_module(rp)


def base_payload():
    return {
        "source_id": "synthetic-source",
        "receipt_index": 0,
        "receipt": {
            "date": "2026-08-26",
            "merchant": "Example",
            "currency": "RSD",
            "charge_account": "Card *1234",
            "total_minor": 20100,
            "items": [
                {
                    "name": "Bread",
                    "quantity": 1,
                    "total_minor": 5000,
                    "category": "Food",
                },
                {
                    "name": "Milk",
                    "quantity": 2,
                    "total_minor": 15100,
                    "category": "Food",
                },
            ],
        },
        "accounts": [
            {
                "id": 7,
                "name": "Primary RSD",
                "currency": "RSD",
                "aliases": [{"alias_text": "Card *1234"}],
            }
        ],
        "planned_items": [],
        "recurring_items": [],
    }


class ReceiptPlanTests(unittest.TestCase):
    def test_plans_exact_lines_and_stable_keys(self):
        first = rp.plan(base_payload())
        second = rp.plan(base_payload())
        self.assertTrue(first["safe"])
        self.assertEqual(first["account_id"], 7)
        self.assertEqual(
            sum(line["amount_minor"] for line in first["lines"]),
            -20100,
        )
        self.assertEqual(
            first["lines"][0]["idempotency_key"],
            second["lines"][0]["idempotency_key"],
        )

    def test_nested_alias_and_currency_mismatch_fail_closed(self):
        payload = base_payload()
        payload["receipt"]["currency"] = "USD"
        result = rp.plan(payload)
        self.assertFalse(result["safe"])
        self.assertIn(
            "receipt currency does not match resolved account currency",
            result["errors"],
        )

    def test_large_residual_becomes_explicit_adjustment(self):
        payload = base_payload()
        payload["receipt"]["total_minor"] = 20500
        result = rp.plan(payload)
        self.assertTrue(result["safe"])
        self.assertEqual(
            result["lines"][-1]["name"],
            "Receipt total adjustment",
        )
        self.assertEqual(result["lines"][-1]["amount_minor"], -400)

    def test_unrepresented_discount_fails_closed(self):
        payload = base_payload()
        payload["receipt"]["total_minor"] = 19000
        result = rp.plan(payload)
        self.assertFalse(result["safe"])
        self.assertIn(
            "line reconciliation produced a non-positive expense line",
            result["errors"],
        )

    def test_malformed_item_collections_fail_closed(self):
        for malformed in ({}, "not-an-array", ["not-an-object"]):
            with self.subTest(items=malformed):
                payload = base_payload()
                payload["receipt"]["items"] = malformed
                result = rp.plan(payload)
                self.assertFalse(result["safe"])
                self.assertEqual(result["lines"], [])

    def test_noncanonical_date_forms_fail_closed(self):
        for malformed in ("20260826", "2026-W35-3"):
            with self.subTest(date=malformed):
                payload = base_payload()
                payload["receipt"]["date"] = malformed
                result = rp.plan(payload)
                self.assertFalse(result["safe"])
                self.assertIn("receipt.date must be YYYY-MM-DD", result["errors"])

    def test_confirmed_discrete_quantity_above_provider_limit_is_not_routed(self):
        payload = base_payload()
        payload["receipt"]["total_minor"] = 5353000
        payload["receipt"]["items"] = [{
            "name": "Cigarettes",
            "quantity": 101,
            "quantity_confirmed": True,
            "total_minor": 5353000,
            "category": "Smoking",
        }]
        payload["recurring_items"] = [{
            "id": 9,
            "title": "Cigarettes",
            "amount_minor": -53000,
            "currency": "RSD",
            "account_id": 7,
            "category": "Smoking",
            "frequency": "daily",
            "interval_count": 1,
            "next_due_date": "2026-08-26",
            "active": True,
        }]
        result = rp.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(result["lines"][0]["route"]["type"], "operation_add")

    def test_exact_planned_match_replaces_operation_add(self):
        payload = base_payload()
        payload["planned_items"] = [
            {
                "id": 8,
                "date": "2026-08-26",
                "title": "Milk",
                "amount_minor": -15100,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "done": False,
            }
        ]
        result = rp.plan(payload)
        self.assertEqual(
            result["lines"][1]["route"]["type"],
            "planned_item_update",
        )
        self.assertEqual(
            result["lines"][1]["route"]["planned_item_id"],
            8,
        )

    def test_recurring_quantity_closes_once_and_covers_future_periods(self):
        payload = base_payload()
        payload["receipt"]["total_minor"] = 159000
        payload["receipt"]["items"] = [
            {
                "name": "Cigarettes",
                "quantity": 3,
                "quantity_confirmed": True,
                "total_minor": 159000,
                "category": "Smoking",
            }
        ]
        payload["recurring_items"] = [
            {
                "id": 9,
                "title": "Cigarettes",
                "amount_minor": -53000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Smoking",
                "frequency": "daily",
                "next_due_date": "2026-08-26",
                "active": True,
            }
        ]
        result = rp.plan(payload)
        route = result["lines"][0]["route"]
        self.assertEqual(route["type"], "recurring_item_close_period")
        self.assertEqual(route["recurring_item_id"], 9)
        self.assertEqual(route["covered_occurrences"], 3)
        self.assertEqual(len(route["future_skip_idempotency_keys"]), 2)
        self.assertEqual(
            [skip["occurrence_date"] for skip in route["future_skips"]],
            ["2026-08-27", "2026-08-28"],
        )
        self.assertIn("source_id=synthetic-source", route["future_skips"][0]["durable_key"])
        self.assertIn("receipt_index=0", route["future_skips"][0]["durable_key"])
        self.assertIn("recurring_item_id=9", route["future_skips"][0]["durable_key"])
        self.assertIn("occurrence_date=2026-08-27", route["future_skips"][0]["durable_key"])
        self.assertNotEqual(
            route["future_skip_idempotency_keys"][0],
            route["future_skip_idempotency_keys"][1],
        )

    def test_recurring_quantity_requires_explicit_confirmation(self):
        payload = base_payload()
        payload["receipt"]["total_minor"] = 159000
        payload["receipt"]["items"] = [{
            "name": "Cigarettes",
            "quantity": 3,
            "total_minor": 159000,
            "category": "Smoking",
        }]
        payload["recurring_items"] = [{
            "id": 9,
            "title": "Cigarettes",
            "amount_minor": -53000,
            "currency": "RSD",
            "account_id": 7,
            "category": "Smoking",
            "frequency": "daily",
            "interval_count": 1,
            "next_due_date": "2026-08-26",
            "active": True,
        }]
        result = rp.plan(payload)
        self.assertTrue(result["safe"])
        self.assertEqual(result["lines"][0]["route"]["type"], "operation_add")

    def test_multiple_candidates_are_unsafe(self):
        payload = base_payload()
        candidate = {
            "date": "2026-08-26",
            "title": "Milk",
            "amount_minor": -15100,
            "currency": "RSD",
            "account_id": 7,
            "category": "Food",
            "done": False,
        }
        payload["planned_items"] = [
            dict(candidate, id=1),
            dict(candidate, id=2),
        ]
        result = rp.plan(payload)
        self.assertFalse(result["safe"])
        self.assertIn(
            "multiple reconciliation candidates",
            result["errors"][-1],
        )

    def test_exact_fiscal_id_duplicate_is_unsafe(self):
        payload = base_payload()
        payload["receipt"]["fiscal_receipt_id"] = "123/150493ПР"
        payload["known_fiscal_receipt_ids"] = ["123/150493ПР"]
        result = rp.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["lines"], [])
        self.assertIn(
            "exact fiscal receipt ID is already present in verified host state",
            result["errors"],
        )

    def test_malformed_fiscal_checkpoint_is_unsafe(self):
        for value in ("", 0, False, None):
            payload = base_payload()
            payload["known_fiscal_receipt_ids"] = value
            result = rp.plan(payload)
            with self.subTest(value=value):
                self.assertFalse(result["safe"])
                self.assertIn(
                    "known_fiscal_receipt_ids must be an array of strings",
                    result["errors"],
                )

    def test_boolean_integer_fields_fail_closed(self):
        cases = (
            (
                lambda payload: payload.update({"receipt_index": True}),
                "receipt_index must be a non-negative integer",
            ),
            (
                lambda payload: payload["receipt"].update({"total_minor": True}),
                "receipt.total_minor must be a positive integer",
            ),
            (
                lambda payload: payload["receipt"]["items"][0].update({"total_minor": True}),
                "receipt.items[0].total_minor must be a positive integer",
            ),
        )
        for mutate, expected in cases:
            with self.subTest(expected=expected):
                payload = base_payload()
                mutate(payload)
                result = rp.plan(payload)
                self.assertFalse(result["safe"])
                self.assertIn(expected, result["errors"])


if __name__ == "__main__":
    unittest.main()
