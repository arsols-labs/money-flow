#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("notification_policy.py")
SPEC = importlib.util.spec_from_file_location("notification_policy", MODULE_PATH)
np = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = np
SPEC.loader.exec_module(np)


def external_policy():
    policy = np.recommended_policy()
    policy["primary_destination"] = "slack-alerts"
    policy["fallback_destination"] = "telegram-alerts"
    policy["destinations"] = [
        {
            "id": "slack-alerts",
            "provider": "slack",
            "target": "configured-channel-id",
            "events": ["action_required", "incident", "completion"],
        },
        {
            "id": "telegram-alerts",
            "provider": "telegram",
            "target": "configured-chat-id",
            "events": ["action_required", "incident"],
        },
    ]
    return policy


class NotificationPolicyTests(unittest.TestCase):
    def test_recommended_policy_is_valid_for_interactive_use(self):
        policy = np.recommended_policy()
        self.assertIs(np.validate_policy(policy), policy)

    def test_session_only_policy_is_valid_for_durable_scheduled_session(self):
        policy = np.recommended_policy()
        self.assertIs(np.validate_policy(policy, scheduled=True), policy)

    def test_external_primary_and_fallback_are_valid_for_schedule(self):
        policy = external_policy()
        self.assertIs(np.validate_policy(policy, scheduled=True), policy)

    def test_all_supported_providers_are_accepted(self):
        policy = external_policy()
        policy["destinations"].append(
            {
                "id": "whatsapp-completion",
                "provider": "whatsapp",
                "target": "configured-recipient-id",
                "events": ["completion"],
            }
        )
        np.validate_policy(policy, scheduled=True)

    def test_primary_must_receive_actionable_events(self):
        policy = external_policy()
        policy["destinations"][0]["events"] = ["completion"]
        with self.assertRaisesRegex(np.PolicyError, "action_required and incident"):
            np.validate_policy(policy)

    def test_credentials_and_unknown_fields_are_rejected(self):
        policy = external_policy()
        policy["destinations"][0]["token"] = "must-not-be-here"
        with self.assertRaisesRegex(np.PolicyError, "unknown fields: token"):
            np.validate_policy(policy)

    def test_receipt_details_cannot_be_enabled(self):
        policy = external_policy()
        policy["include_receipt_details"] = True
        with self.assertRaisesRegex(np.PolicyError, "must remain false"):
            np.validate_policy(policy)

    def test_notify_requires_a_subscriber(self):
        policy = external_policy()
        policy["routine_success"] = "notify"
        with self.assertRaisesRegex(np.PolicyError, "no destination subscribes"):
            np.validate_policy(policy)

    def test_action_required_context_is_complete_and_privacy_safe(self):
        context = {
            "filename": "Scanned_20260824-2355.pdf",
            "merchant_or_service": "Delhaize Maxi",
            "receipt_date": "2026-08-24",
            "total_minor": 237389,
            "currency": "RSD",
            "matched_account": "PSB-RSD",
            "matched_recurring_rule": "Продукты #16",
            "question": "Was this purchase paid from PSB-RSD?",
        }
        self.assertIs(np.validate_action_required_context(context), context)

    def test_action_required_rejects_private_or_unexpected_payload_fields(self):
        context = {
            "filename": "receipt.pdf",
            "merchant_or_service": "Example",
            "receipt_date": "2026-08-24",
            "total_minor": 1000,
            "currency": "RSD",
            "matched_account": "PSB-RSD",
            "matched_recurring_rule": None,
            "question": "Which account was charged?",
            "card_number": "must-not-be-sent",
        }
        with self.assertRaisesRegex(np.PolicyError, "unknown fields: card_number"):
            np.validate_action_required_context(context)

    def test_action_required_rejects_boolean_minor_amount(self):
        context = {
            "filename": "receipt.pdf",
            "merchant_or_service": "Example",
            "receipt_date": "2026-08-24",
            "total_minor": True,
            "currency": "RSD",
            "matched_account": "PSB-RSD",
            "matched_recurring_rule": None,
            "question": "Which account was charged?",
        }
        with self.assertRaisesRegex(np.PolicyError, "positive integer"):
            np.validate_action_required_context(context)

    def test_action_required_rejects_noncanonical_date_forms(self):
        for malformed in ("20260824", "2026-W35-1"):
            with self.subTest(receipt_date=malformed):
                context = {
                    "filename": "receipt.pdf",
                    "merchant_or_service": "Example",
                    "receipt_date": malformed,
                    "total_minor": 1000,
                    "currency": "RSD",
                    "matched_account": "PSB-RSD",
                    "matched_recurring_rule": None,
                    "question": "Which account was charged?",
                }
                with self.assertRaisesRegex(np.PolicyError, "YYYY-MM-DD"):
                    np.validate_action_required_context(context)


if __name__ == "__main__":
    unittest.main()
