#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("qr_guard.py")
SPEC = importlib.util.spec_from_file_location("qr_guard", MODULE_PATH)
qr = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = qr
SPEC.loader.exec_module(qr)

SYNTH_HOST = "fiscal.example"


class QrGuardTests(unittest.TestCase):
    def test_accepts_only_canonical_configured_fiscal_url(self):
        result = qr.validate_fiscal_url(
            f"https://{SYNTH_HOST}/v/?vl=synthetic",
            allowed_hosts=[SYNTH_HOST],
        )
        self.assertEqual(result.host, SYNTH_HOST)
        self.assertEqual(result.target, "/v/?vl=synthetic")

    def test_rejects_when_allowed_hosts_missing(self):
        with self.assertRaises(qr.FiscalSecurityError):
            qr.validate_fiscal_url(f"https://{SYNTH_HOST}/v/?vl=synthetic")

    def test_rejects_unsafe_authorities_and_redirect_targets(self):
        rejected = [
            f"http://{SYNTH_HOST}/v/",
            f"HTTPS://{SYNTH_HOST}/v/",
            f"https://{SYNTH_HOST.upper()}/v/",
            f"https://{SYNTH_HOST}.evil.example/v/",
            f"https://user@{SYNTH_HOST}/v/",
            f"https://{SYNTH_HOST}:444/v/",
            f"https://{SYNTH_HOST}/v/#unsafe",
            "https://127.0.0.1/v/",
            f" https://{SYNTH_HOST}/v/",
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(
                qr.FiscalSecurityError
            ):
                qr.validate_fiscal_url(url, allowed_hosts=[SYNTH_HOST])

    def test_rejects_resolution_when_any_address_is_not_global(self):
        with self.assertRaises(qr.FiscalSecurityError):
            qr.validate_resolved_addresses(
                ["93.184.216.34", "127.0.0.1"]
            )


if __name__ == "__main__":
    unittest.main()
