#!/usr/bin/env python3

from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("recurring_reconcile.py")
SPEC = importlib.util.spec_from_file_location("recurring_reconcile", MODULE_PATH)
rr = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = rr
SPEC.loader.exec_module(rr)


def operation(operation_id, amount=-600, item="Food"):
    return {
        "id": operation_id,
        "date": "2026-08-26",
        "account_id": 7,
        "currency": "RSD",
        "kind": "expense",
        "category": "Food",
        "item": item,
        "amount_minor": amount,
    }


def analytical_payload():
    return {
        "run_date": "2026-08-26",
        "recurring_items": [{
            "id": 16,
            "title": "Daily food analytics",
            "amount_minor": -1000,
            "currency": "RSD",
            "account_id": 7,
            "category": "Food",
            "frequency": "daily",
            "interval_count": 1,
            "next_due_date": "2026-08-26",
            "active": True,
        }],
        "operations": [operation(101), operation(102, -700)],
        "recurring_fulfillments": [],
        "policies": [{
            "recurring_item_id": 16,
            "mode": "analytical_daily",
            "coverage_mode": "any_expense",
            "max_coverage_days": 1,
            "match_category": "Food",
        }],
        "evidence": [
            {
                "source_id": "receipt-a",
                "receipt_index": 0,
                "recurring_item_id": 16,
                "occurrence_date": "2026-08-26",
                "operation_ids": [101],
            },
            {
                "source_id": "receipt-b",
                "receipt_index": 2,
                "recurring_item_id": 16,
                "occurrence_date": "2026-08-26",
                "operation_ids": [102],
            },
        ],
        "recurring_evidence_skips": [],
        "readbacks": [],
    }


class RecurringReconcileTests(unittest.TestCase):
    def test_multiple_grocery_receipts_on_one_date_produce_one_skip(self):
        result = rr.plan(analytical_payload())
        self.assertTrue(result["safe"], result)
        self.assertEqual(len(result["actions"]), 1)
        action = result["actions"][0]
        self.assertEqual(action["tool"], "recurring_item_skip_period")
        self.assertEqual(action["occurrence_date"], "2026-08-26")
        self.assertEqual(len(action["checkpoint_keys"]), 2)
        self.assertIn("source_id=receipt-a", action["durable_key"])
        self.assertIn("recurring_item_id=16", action["durable_key"])

    def test_budget_multiple_is_explicitly_clamped_to_three_days(self):
        payload = analytical_payload()
        payload["operations"][0]["amount_minor"] = -2500
        payload["operations"][1]["amount_minor"] = -2500
        payload["policies"][0].update({
            "coverage_mode": "budget_multiple",
            "max_coverage_days": 3,
        })
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(
            [action["occurrence_date"] for action in result["actions"]],
            ["2026-08-26", "2026-08-27", "2026-08-28"],
        )

    def test_discrete_quantity_subtracts_already_fulfilled_occurrences(self):
        payload = analytical_payload()
        payload["recurring_items"][0].update({
            "id": 15,
            "title": "Cigarettes",
            "category": "Smoking",
            "amount_minor": -53000,
            "next_due_date": "2026-08-28",
        })
        payload["operations"] = [{
            **operation(201, -159000, "Cigarettes"),
            "category": "Smoking",
        }]
        payload["policies"] = [{
            "recurring_item_id": 15,
            "mode": "discrete_quantity",
            "match_category": "Smoking",
        }]
        payload["evidence"] = [{
            "source_id": "cigarette-receipt",
            "receipt_index": 1,
            "recurring_item_id": 15,
            "occurrence_date": "2026-08-26",
            "operation_ids": [201],
            "explicit_quantity": 3,
        }]
        payload["recurring_fulfillments"] = [
            {
                "recurring_item_id": 15,
                "period_due_date": "2026-08-26",
                "outcome": "linked",
                "operation_ids": [201],
            },
            {
                "recurring_item_id": 15,
                "period_due_date": "2026-08-27",
                "outcome": "skipped",
                "operation_ids": [],
            },
        ]
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(len(result["actions"]), 1)
        self.assertEqual(result["actions"][0]["tool"], "recurring_item_skip_period")
        self.assertEqual(result["actions"][0]["occurrence_date"], "2026-08-28")

    def test_replay_with_same_durable_key_does_not_skip_again(self):
        payload = analytical_payload()
        first = rr.plan(payload)
        key = first["actions"][0]["durable_key"]
        payload["recurring_evidence_skips"] = [key]
        replay = rr.plan(payload)
        self.assertTrue(replay["safe"], replay)
        self.assertEqual(replay["actions"], [])

    def test_replay_is_idempotent_when_any_receipt_key_for_date_is_processed(self):
        payload = analytical_payload()
        first = rr.plan(payload)
        second_key = first["actions"][0]["checkpoint_keys"][1]
        payload["recurring_evidence_skips"] = [second_key]
        replay = rr.plan(payload)
        self.assertTrue(replay["safe"], replay)
        self.assertEqual(replay["actions"], [])

    def test_malformed_checkpoint_collection_fails_closed_without_exception(self):
        for malformed in ({"durable": "key"}, 7, [True], [""]):
            with self.subTest(recurring_evidence_skips=malformed):
                payload = analytical_payload()
                payload["recurring_evidence_skips"] = malformed
                result = rr.plan(payload)
                self.assertFalse(result["safe"])
                self.assertEqual(result["actions"], [])

    def test_discrete_quantity_is_never_inferred_from_amount_or_overdue_days(self):
        payload = analytical_payload()
        payload["run_date"] = "2026-09-10"
        payload["recurring_items"][0].update({
            "id": 15,
            "category": "Smoking",
            "amount_minor": -53000,
        })
        payload["operations"] = [{
            **operation(201, -318000, "Cigarettes"),
            "category": "Smoking",
        }]
        payload["policies"] = [{
            "recurring_item_id": 15,
            "mode": "discrete_quantity",
            "match_category": "Smoking",
        }]
        payload["evidence"] = [{
            "source_id": "cigarette-receipt",
            "receipt_index": 0,
            "recurring_item_id": 15,
            "occurrence_date": "2026-08-26",
            "operation_ids": [201],
        }]
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertRegex(result["action_required"][0]["question"], r"exact integer unit quantity")

    def test_discrete_quantity_above_provider_limit_requires_action(self):
        payload = analytical_payload()
        payload["recurring_items"][0].update({"id": 15, "category": "Smoking"})
        payload["operations"] = [{**operation(201, -5353000, "Cigarettes"), "category": "Smoking"}]
        payload["policies"] = [{
            "recurring_item_id": 15,
            "mode": "discrete_quantity",
            "match_category": "Smoking",
        }]
        payload["evidence"] = [{
            "source_id": "cigarette-receipt",
            "receipt_index": 0,
            "recurring_item_id": 15,
            "occurrence_date": "2026-08-26",
            "operation_ids": [201],
            "explicit_quantity": 101,
        }]
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertRegex(result["action_required"][0]["question"], r"1 to 100")

    def test_noncanonical_date_forms_fail_closed(self):
        for malformed in ("20260826", "2026-W35-3"):
            with self.subTest(run_date=malformed):
                payload = analytical_payload()
                payload["run_date"] = malformed
                result = rr.plan(payload)
                self.assertFalse(result["safe"])
                self.assertEqual(result["actions"], [])

    def test_empty_overdue_analytical_day_skips_but_empty_current_day_stays_open(self):
        payload = analytical_payload()
        payload["evidence"] = []
        payload["operations"] = []
        current = rr.plan(payload)
        self.assertTrue(current["safe"], current)
        self.assertEqual(current["actions"], [])

        payload["run_date"] = "2026-08-27"
        overdue = rr.plan(payload)
        self.assertTrue(overdue["safe"], overdue)
        self.assertEqual(len(overdue["actions"]), 1)
        self.assertEqual(overdue["actions"][0]["occurrence_date"], "2026-08-26")
        self.assertEqual(overdue["actions"][0]["checkpoint_keys"], [])

    def test_checkpoint_requires_exact_readback_and_unchanged_ledger(self):
        payload = analytical_payload()
        first = rr.plan(payload)
        action = first["actions"][0]
        self.assertEqual(first["checkpoint_updates"], [])

        verified = copy.deepcopy(payload)
        verified["readbacks"] = [{
            "durable_key": action["durable_key"],
            "observed_next_due_date": action["expected_next_due_date"],
            "operation_count_before": 1104,
            "operation_count_after": 1104,
            "balances_before": {"7": 100000},
            "balances_after": {"7": 100000},
        }]
        verified_result = rr.plan(verified)
        self.assertEqual(
            verified_result["checkpoint_updates"],
            sorted(action["checkpoint_keys"]),
        )

        changed = copy.deepcopy(verified)
        changed["readbacks"][0]["operation_count_after"] = 1105
        changed_result = rr.plan(changed)
        self.assertFalse(changed_result["safe"])
        self.assertEqual(changed_result["checkpoint_updates"], [])
        self.assertTrue(any("operation count changed" in error for error in changed_result["errors"]))

        incomplete = copy.deepcopy(payload)
        incomplete["readbacks"] = [{
            "durable_key": action["durable_key"],
            "observed_next_due_date": action["expected_next_due_date"],
        }]
        incomplete_result = rr.plan(incomplete)
        self.assertFalse(incomplete_result["safe"])
        self.assertEqual(incomplete_result["checkpoint_updates"], [])
        self.assertTrue(any("missing required fields" in error for error in incomplete_result["errors"]))

    def test_non_analytical_rule_is_not_caught_up_without_evidence(self):
        payload = analytical_payload()
        payload["run_date"] = "2026-09-10"
        payload["policies"] = []
        payload["evidence"] = []
        payload["operations"] = []
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(result["actions"], [])

    def test_evidence_cannot_claim_an_operation_from_another_date(self):
        payload = analytical_payload()
        payload["operations"][0]["date"] = "2026-08-25"
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertTrue(any("different calendar date" in error for error in result["errors"]))

    def test_one_operation_cannot_be_claimed_by_two_recurring_rules(self):
        payload = analytical_payload()
        payload["recurring_items"].append({
            **payload["recurring_items"][0],
            "id": 17,
            "title": "Second analytics rule",
        })
        payload["policies"].append({
            **payload["policies"][0],
            "recurring_item_id": 17,
        })
        payload["evidence"].append({
            "source_id": "receipt-a",
            "receipt_index": 0,
            "recurring_item_id": 17,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        })
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertRegex(result["action_required"][0]["question"], r"single recurring rule")

    def test_operation_already_linked_to_another_expectation_is_rejected(self):
        payload = analytical_payload()
        payload["operations"][0]["fulfillment"] = {
            "recurring_item_id": 99,
            "period_due_date": "2026-08-26",
        }
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertTrue(any("already fulfills another expectation" in error for error in result["errors"]))

    def test_malformed_evidence_and_history_fail_closed_without_exception(self):
        payload = analytical_payload()
        del payload["evidence"][0]["source_id"]
        payload["recurring_fulfillments"] = [{
            "recurring_item_id": 16,
            "period_due_date": "2026-08-26",
            "outcome": "invented",
            "operation_ids": [],
        }]
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertTrue(any("source_id is required" in error for error in result["errors"]))
        self.assertTrue(any("outcome is invalid" in error for error in result["errors"]))

    def test_malformed_operation_amounts_fail_closed_without_coercion(self):
        for malformed in ("oops", "-600", -600.5, True):
            with self.subTest(amount_minor=malformed):
                payload = analytical_payload()
                payload["operations"][0]["amount_minor"] = malformed
                result = rr.plan(payload)
                self.assertFalse(result["safe"])
                self.assertEqual(result["actions"], [])
                self.assertTrue(any("amount_minor must be a non-zero integer" in error for error in result["errors"]))


if __name__ == "__main__":
    unittest.main()
