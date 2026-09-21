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


class QrGuardTests(unittest.TestCase):
    def test_accepts_only_canonical_fiscal_url(self):
        result = qr.validate_fiscal_url(
            "https://suf.purs.gov.rs/v/?vl=synthetic"
        )
        self.assertEqual(result.host, "suf.purs.gov.rs")
        self.assertEqual(result.target, "/v/?vl=synthetic")

    def test_rejects_unsafe_authorities_and_redirect_targets(self):
        rejected = [
            "http://suf.purs.gov.rs/v/",
            "HTTPS://suf.purs.gov.rs/v/",
            "https://SUF.PURS.GOV.RS/v/",
            "https://suf.purs.gov.rs.evil.example/v/",
            "https://user@suf.purs.gov.rs/v/",
            "https://suf.purs.gov.rs:444/v/",
            "https://suf.purs.gov.rs/v/#unsafe",
            "https://127.0.0.1/v/",
            " https://suf.purs.gov.rs/v/",
        ]
        for url in rejected:
            with self.subTest(url=url), self.assertRaises(
                qr.FiscalSecurityError
            ):
                qr.validate_fiscal_url(url)

    def test_rejects_resolution_when_any_address_is_not_global(self):
        with self.assertRaises(qr.FiscalSecurityError):
            qr.validate_resolved_addresses(
                ["93.184.216.34", "127.0.0.1"]
            )

    def test_accepts_global_resolution(self):
        self.assertEqual(
            qr.validate_resolved_addresses(["93.184.216.34"]),
            ("93.184.216.34",),
        )


if __name__ == "__main__":
    unittest.main()
