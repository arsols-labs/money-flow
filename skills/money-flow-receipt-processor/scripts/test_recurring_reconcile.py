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

    def test_auto_skip_rule_skips_current_period_on_booked_receipt_category_match(self):
        payload = analytical_payload()
        payload["policies"] = []
        payload["evidence"] = []
        payload["recurring_items"] = [{
            "id": 25,
            "title": "Every 3 days groceries",
            "amount_minor": -3000,
            "currency": "RSD",
            "account_id": 7,
            "category": "  food ",
            "frequency": "daily",
            "interval_count": 3,
            "next_due_date": "2026-08-25",
            "end_date": None,
            "active": True,
            "auto_skip_overdue": True,
            "auto_skip_after_days": 2,
        }]
        payload["operations"] = [
            operation(101, -600, "Bread"),
            {**operation(102, -400, "Soap"), "category": "Household"},
            {**operation(103, -900, "Milk"), "date": "2026-08-27"},
        ]
        payload["booked_receipts"] = [
            {
                "source_id": "rec-a",
                "receipt_index": 0,
                "occurrence_date": "2026-08-26",
                "operation_ids": [101, 102],
            },
            {
                "source_id": "rec-b",
                "receipt_index": 1,
                "occurrence_date": "2026-08-27",
                "operation_ids": [103],
            },
        ]
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(len(result["actions"]), 1)
        action = result["actions"][0]
        self.assertEqual(action["tool"], "recurring_item_skip_period")
        self.assertEqual(action["arguments"], {"recurring_item_id": 25})
        self.assertEqual(action["occurrence_date"], "2026-08-25")
        self.assertEqual(action["expected_next_due_date"], "2026-08-28")
        self.assertTrue(action["expected_active"])
        self.assertEqual(len(action["checkpoint_keys"]), 2)

        verified = copy.deepcopy(payload)
        verified["readbacks"] = [{
            "durable_key": action["durable_key"],
            "observed_next_due_date": "2026-08-28",
            "observed_active": True,
            "operation_count_before": 50,
            "operation_count_after": 50,
            "balances_before": {"7": 10000},
            "balances_after": {"7": 10000},
        }]
        v_result = rr.plan(verified)
        self.assertTrue(v_result["safe"], v_result)
        self.assertEqual(v_result["checkpoint_updates"], sorted(action["checkpoint_keys"]))

    def test_auto_skip_rule_deactivates_when_next_occurrence_passes_end_date(self):
        payload = analytical_payload()
        payload["policies"] = []
        payload["evidence"] = []
        payload["recurring_items"] = [{
            "id": 26,
            "title": "Weekly produce",
            "amount_minor": -1500,
            "currency": "RSD",
            "account_id": 7,
            "category": "Food",
            "frequency": "weekly",
            "interval_count": 1,
            "next_due_date": "2026-08-24",
            "end_date": "2026-08-30",
            "active": True,
            "auto_skip_overdue": True,
            "auto_skip_after_days": 1,
        }]
        payload["operations"] = [operation(101, -600, "Tomatoes")]
        payload["booked_receipts"] = [{
            "source_id": "rec-w",
            "receipt_index": 0,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        }]
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(len(result["actions"]), 1)
        action = result["actions"][0]
        self.assertEqual(action["expected_next_due_date"], "2026-08-24")
        self.assertFalse(action["expected_active"])

        wrong_active = copy.deepcopy(payload)
        wrong_active["readbacks"] = [{
            "durable_key": action["durable_key"],
            "observed_next_due_date": "2026-08-24",
            "observed_active": True,
            "operation_count_before": 10,
            "operation_count_after": 10,
            "balances_before": {"7": 5000},
            "balances_after": {"7": 5000},
        }]
        bad_res = rr.plan(wrong_active)
        self.assertFalse(bad_res["safe"])
        self.assertEqual(bad_res["checkpoint_updates"], [])

    def test_auto_skip_rule_ignores_empty_overdue_days_and_non_optional_rules(self):
        payload = analytical_payload()
        payload["run_date"] = "2026-08-30"
        payload["policies"] = []
        payload["evidence"] = []
        payload["operations"] = [operation(101)]
        payload["recurring_items"] = [
            {
                "id": 27,
                "title": "Optional empty overdue",
                "amount_minor": -1000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "frequency": "daily",
                "interval_count": 1,
                "next_due_date": "2026-08-20",
                "active": True,
                "auto_skip_overdue": True,
            },
            {
                "id": 28,
                "title": "Mandatory daily rule",
                "amount_minor": -1000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "frequency": "daily",
                "interval_count": 1,
                "next_due_date": "2026-08-26",
                "active": True,
                "auto_skip_overdue": False,
            },
        ]
        payload["booked_receipts"] = [{
            "source_id": "rec-other",
            "receipt_index": 0,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        }]
        result = rr.plan(payload)
        self.assertTrue(result["safe"], result)
        self.assertEqual(result["actions"], [])

    def test_auto_skip_multi_rule_category_conflict_stops_with_action_required(self):
        payload = analytical_payload()
        payload["policies"] = []
        payload["evidence"] = []
        payload["operations"] = [operation(101)]
        payload["recurring_items"] = [
            {
                "id": 29,
                "title": "Food A",
                "amount_minor": -1000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "frequency": "daily",
                "interval_count": 1,
                "next_due_date": "2026-08-26",
                "active": True,
                "auto_skip_overdue": True,
            },
            {
                "id": 30,
                "title": "Food B",
                "amount_minor": -1500,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "frequency": "weekly",
                "interval_count": 1,
                "next_due_date": "2026-08-25",
                "active": True,
                "auto_skip_overdue": True,
            },
        ]
        payload["booked_receipts"] = [{
            "source_id": "rec-ambig",
            "receipt_index": 0,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        }]
        result = rr.plan(payload)
        self.assertFalse(result["safe"])
        self.assertEqual(result["actions"], [])
        self.assertEqual(result["action_required"][0]["recurring_item_ids"], [29, 30])

    def test_explicit_policy_takes_precedence_and_malformed_booked_receipts_fail_closed(self):
        payload = analytical_payload()
        payload["recurring_items"][0]["auto_skip_overdue"] = True
        payload["booked_receipts"] = [{
            "source_id": "receipt-a",
            "receipt_index": 0,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        }]
        res_explicit = rr.plan(payload)
        self.assertTrue(res_explicit["safe"], res_explicit)
        self.assertEqual(len(res_explicit["actions"]), 1)

        bad_payload = analytical_payload()
        bad_payload["booked_receipts"] = [{"source_id": "", "receipt_index": 0, "occurrence_date": "2026-08-26", "operation_ids": []}]
        res_bad = rr.plan(bad_payload)
        self.assertFalse(res_bad["safe"])
        self.assertEqual(res_bad["actions"], [])

        falsy_dict = analytical_payload()
        falsy_dict["booked_receipts"] = {}
        res_dict = rr.plan(falsy_dict)
        self.assertFalse(res_dict["safe"])
        self.assertIn("booked_receipts must be an array", res_dict["errors"])

    def test_auto_skip_income_rules_ignored_and_replay_plus_readback_compatibility(self):
        payload = analytical_payload()
        payload["policies"] = []
        payload["evidence"] = []
        payload["operations"] = [operation(101)]
        payload["recurring_items"] = [
            {
                "id": 40,
                "title": "Freelance income auto-shift",
                "amount_minor": 50000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Freelance",
                "frequency": "monthly",
                "interval_count": 1,
                "day_of_month": 25,
                "next_due_date": "2026-08-25",
                "active": True,
                "auto_skip_overdue": True,
            },
            {
                "id": 41,
                "title": "End-date food",
                "amount_minor": -1000,
                "currency": "RSD",
                "account_id": 7,
                "category": "Food",
                "frequency": "daily",
                "interval_count": 1,
                "next_due_date": "2026-08-26",
                "end_date": "2026-08-26",
                "active": True,
                "auto_skip_overdue": True,
            },
        ]
        payload["booked_receipts"] = [{
            "source_id": "rec-inc",
            "receipt_index": 0,
            "occurrence_date": "2026-08-26",
            "operation_ids": [101],
        }]
        first = rr.plan(payload)
        self.assertTrue(first["safe"], first)
        self.assertEqual(len(first["actions"]), 1)
        action = first["actions"][0]
        self.assertEqual(action["arguments"]["recurring_item_id"], 41)
        self.assertFalse(action["expected_active"])

        # Replay with checkpoint key suppresses duplicate skip
        replay = copy.deepcopy(payload)
        replay["recurring_evidence_skips"] = action["checkpoint_keys"]
        replay_res = rr.plan(replay)
        self.assertTrue(replay_res["safe"], replay_res)
        self.assertEqual(replay_res["actions"], [])

        # Readback works both with observed_active=False and when omitted (legacy format)
        for include_active in (True, False):
            with self.subTest(include_active=include_active):
                ver = copy.deepcopy(payload)
                rb = {
                    "durable_key": action["durable_key"],
                    "observed_next_due_date": action["expected_next_due_date"],
                    "operation_count_before": 5,
                    "operation_count_after": 5,
                    "balances_before": {"7": 10000},
                    "balances_after": {"7": 10000},
                }
                if include_active:
                    rb["observed_active"] = False
                ver["readbacks"] = [rb]
                v_res = rr.plan(ver)
                self.assertTrue(v_res["safe"], v_res)
                self.assertEqual(v_res["checkpoint_updates"], action["checkpoint_keys"])


if __name__ == "__main__":
    unittest.main()
