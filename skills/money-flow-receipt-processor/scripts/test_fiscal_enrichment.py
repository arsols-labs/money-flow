#!/usr/bin/env python3
"""Tests for the stateless fiscal enrichment adapter."""

from __future__ import annotations

import importlib.util
import os
import ssl
import subprocess
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("fiscal_enrichment.py")
SPEC = importlib.util.spec_from_file_location("fiscal_enrichment", MODULE_PATH)
fe = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = fe
SPEC.loader.exec_module(fe)


COMPLETE_HTML = """
<html><body>
  <script>Продавац: EVIL</script>
  <div>ПРОМЕТ ПРОДАЈА</div>
  <div>Продавац: MAXI 722</div>
  <div>Датум и време: 24.08.2026 13:45</div>
  <div>ПИБ: 123456789</div>
  <div>Бројач рачуна: 123/150493ПР</div>
  <div>Валута: RSD</div>
  <div>Журнал</div>
  <table>
    <tr><th>Назив</th><th>Количина</th><th>Јед. цена</th><th>Укупно</th></tr>
    <tr><td>Хлеб</td><td>1</td><td>50,00</td><td>50,00</td></tr>
    <tr><td>Млеко</td><td>2</td><td>75,50</td><td>151,00</td></tr>
  </table>
  <div>Укупан износ: 201,00</div>
</body></html>
"""

REAL_SHAPE_HTML = """
<html><body>
  <div>Статус рачуна</div><div>Рачун је проверен</div>
  <div>Захтев за фискализацију рачуна</div>
  <div>ПИБ</div><div>123456789</div>
  <div>Име продајног места</div><div>1000000-001-TEST</div>
  <div>Врста</div><div>Промет Продаја</div>
  <div>Резултат фискализације рачуна</div>
  <div>Укупан износ</div><div>1.500,00</div>
  <div>Затражио - Потписао - Бројач</div>
  <div>SYNTHETIC-SIGNER-000001</div>
  <div>ПФР време (временска зона сервера)</div>
  <div>24.8.2026. 20:23:01</div>
  <div>Спецификација рачуна</div><div>Журнал</div>
  <pre>============ ФИСКАЛНИ РАЧУН ============
  -------------ПРОМЕТ ПРОДАЈА------------- Артикли
  ========================================
  Назив Цена Кол. Укупно
  Test Item A/KOM (Ђ) 500,00 1 500,00
  Test Item B/KOM (Ђ) 500,00 2 1.000,00
  ----------------------------------------
  Укупан износ: 1.500,00</pre>
</body></html>
"""

SCAN = {
    "merchant": "MAXI",
    "date": "2026-08-24",
    "currency": "RSD",
    "charge_account": "Visa *9999",
    "recipient_account": None,
    "total_minor": 20100,
    "items": [{"name": "scan fallback", "quantity": 1, "total_minor": 20100}],
}


class FakeResponse:
    def __init__(self, status=200, headers=None, body=COMPLETE_HTML.encode("utf-8")):
        self.status = status
        self.headers = headers or {
            "Content-Type": "text/html; charset=utf-8",
            "Content-Encoding": "identity",
            "Content-Length": str(len(body)),
        }
        self.body = body
        self.offset = 0

    def getheader(self, name, default=None):
        return self.headers.get(name, default)

    def read(self, amount=-1):
        if amount < 0:
            result = self.body[self.offset :]
            self.offset = len(self.body)
            return result
        result = self.body[self.offset : self.offset + amount]
        self.offset += len(result)
        return result


class FakeConnection:
    def __init__(self, response, events):
        self.response = response
        self.events = events

    def request(self, method, target, body=None, headers=None):
        self.events.append(("request", method, target, body, headers))

    def getresponse(self):
        return self.response

    def close(self):
        self.events.append(("close",))


def public_resolver(host, port, **kwargs):
    return [(2, 1, 6, "", ("93.184.216.34", port))]


class FetchTests(unittest.TestCase):
    def factory(self, response, events):
        def make(host, port, pinned_ip, timeout):
            events.append(("connect", host, port, pinned_ip, timeout))
            return FakeConnection(response, events)

        return make

    def test_rejects_unsafe_url_before_network(self):
        calls = []

        def forbidden(*args, **kwargs):
            calls.append((args, kwargs))
            raise AssertionError("must not be called")

        with self.assertRaises(fe.FiscalSecurityError):
            fe.fetch_fiscal_page(
                "https://evil.example/receipt",
                resolver=forbidden,
                connection_factory=forbidden,
            )
        self.assertEqual(calls, [])

    def test_dns_resolution_is_inside_total_timeout(self):
        started = time.monotonic()
        with patch.object(
            fe.subprocess,
            "run",
            side_effect=subprocess.TimeoutExpired("dns-helper", 0.02),
        ):
            with self.assertRaises(TimeoutError):
                fe.fetch_fiscal_page(
                    "https://suf.purs.gov.rs/v/?vl=synthetic",
                    timeout=0.02,
                )
        self.assertLess(time.monotonic() - started, 0.5)

    def test_dns_helper_failure_is_a_transport_failure(self):
        with patch.object(
            fe.subprocess,
            "run",
            side_effect=subprocess.CalledProcessError(1, "dns-helper"),
        ):
            with self.assertRaises(fe.FiscalNetworkError):
                fe.fetch_fiscal_page(
                    "https://suf.purs.gov.rs/v/?vl=synthetic",
                )

    def test_late_dns_result_is_rejected_before_connection(self):
        now = [0.0]
        calls = []

        def clock():
            return now[0]

        def late_resolver(host, port, **kwargs):
            now[0] = 5.0
            return public_resolver(host, port, **kwargs)

        def forbidden_factory(*args):
            calls.append(args)
            raise AssertionError("connection must not start")

        with self.assertRaises(TimeoutError):
            fe.fetch_fiscal_page(
                "https://suf.purs.gov.rs/v/?vl=synthetic",
                resolver=late_resolver,
                connection_factory=forbidden_factory,
                timeout=2,
                clock=clock,
            )
        self.assertEqual(calls, [])

    def test_pins_dns_and_fetches_identity_utf8_html(self):
        events = []
        result = fe.fetch_fiscal_page(
            "https://suf.purs.gov.rs/v/?vl=synthetic",
            resolver=public_resolver,
            connection_factory=self.factory(FakeResponse(), events),
        )
        self.assertIn("MAXI 722", result)
        self.assertEqual(events[0][3], "93.184.216.34")
        self.assertEqual(events[1][4]["Accept-Encoding"], "identity")
        self.assertEqual(events[-1], ("close",))

    def test_tries_each_validated_address_within_total_timeout(self):
        events = []

        def resolver(host, port, **kwargs):
            return [
                (2, 1, 6, "", ("93.184.216.34", port)),
                (2, 1, 6, "", ("93.184.216.35", port)),
            ]

        def factory(host, port, pinned_ip, timeout):
            events.append(("connect", pinned_ip, timeout))
            if pinned_ip == "93.184.216.34":
                raise TimeoutError("synthetic first-address timeout")
            return FakeConnection(FakeResponse(), events)

        result = fe.fetch_fiscal_page(
            "https://suf.purs.gov.rs/v/?vl=synthetic",
            resolver=resolver,
            connection_factory=factory,
            timeout=10,
        )
        self.assertIn("MAXI 722", result)
        connects = [event for event in events if event[0] == "connect"]
        self.assertEqual(
            [event[1] for event in connects],
            ["93.184.216.34", "93.184.216.35"],
        )
        self.assertTrue(all(0 < event[2] <= 10 for event in connects))

    def test_enforces_one_monotonic_deadline_across_all_addresses(self):
        now = [0.0]
        attempted = []

        def clock():
            return now[0]

        def resolver(host, port, **kwargs):
            return [
                (2, 1, 6, "", (f"93.184.216.{value}", port))
                for value in range(30, 35)
            ]

        def factory(host, port, pinned_ip, timeout):
            attempted.append((pinned_ip, timeout))
            now[0] += min(0.6, timeout)
            raise TimeoutError("synthetic timeout")

        with self.assertRaises(TimeoutError):
            fe.fetch_fiscal_page(
                "https://suf.purs.gov.rs/v/?vl=synthetic",
                resolver=resolver,
                connection_factory=factory,
                timeout=2,
                clock=clock,
            )
        self.assertEqual(now[0], 2.0)
        self.assertEqual(len(attempted), 4)
        self.assertGreater(attempted[0][1], attempted[-1][1])

    def test_pinned_connection_requires_matching_peer_and_verified_hostname(self):
        connection = fe.PinnedHTTPSConnection(
            "suf.purs.gov.rs",
            443,
            "93.184.216.34",
            1,
        )
        self.assertTrue(connection._context.check_hostname)
        self.assertEqual(connection._context.verify_mode, ssl.CERT_REQUIRED)

        class RawSocket:
            def getpeername(self):
                return ("93.184.216.35", 443)

            def close(self):
                pass

        with patch.object(fe.socket, "create_connection", return_value=RawSocket()):
            with self.assertRaises(fe.FiscalSecurityError):
                connection.connect()

    def test_rejects_redirect_without_following(self):
        events = []
        response = FakeResponse(
            status=302,
            headers={"Location": "https://evil.example/", "Content-Type": "text/html"},
            body=b"",
        )
        with self.assertRaises(fe.FiscalSecurityError):
            fe.fetch_fiscal_page(
                "https://suf.purs.gov.rs/v/?vl=synthetic",
                resolver=public_resolver,
                connection_factory=self.factory(response, events),
            )
        self.assertEqual(sum(event[0] == "connect" for event in events), 1)

    def test_rejects_content_type_encoding_and_response_limit(self):
        cases = [
            FakeResponse(headers={"Content-Type": "application/json"}, body=b"{}"),
            FakeResponse(
                headers={
                    "Content-Type": "text/html; charset=windows-1251",
                    "Content-Encoding": "identity",
                }
            ),
            FakeResponse(
                headers={
                    "Content-Type": "text/html",
                    "Content-Encoding": "gzip",
                }
            ),
            FakeResponse(
                headers={
                    "Content-Type": "text/html",
                    "Content-Encoding": "identity",
                    "Content-Length": str(fe.MAX_RESPONSE_BYTES + 1),
                }
            ),
            FakeResponse(
                headers={
                    "Content-Type": "text/html",
                    "Content-Encoding": "identity",
                },
                body=b"x" * (fe.MAX_RESPONSE_BYTES + 1),
            ),
        ]
        for response in cases:
            with self.subTest(response=response.headers), self.assertRaises(
                fe.FiscalSecurityError
            ):
                fe.fetch_fiscal_page(
                    "https://suf.purs.gov.rs/v/?vl=synthetic",
                    resolver=public_resolver,
                    connection_factory=self.factory(response, []),
                )


class ParserTests(unittest.TestCase):
    def test_parses_complete_representative_journal(self):
        parsed = fe.parse_fiscal_journal(COMPLETE_HTML)
        self.assertEqual(parsed["merchant"], "MAXI 722")
        self.assertEqual(parsed["date"], "2026-08-24")
        self.assertEqual(parsed["fiscal_receipt_id"], "123/150493ПР")
        self.assertEqual(parsed["total_minor"], 20100)
        self.assertEqual([item["total_minor"] for item in parsed["items"]], [5000, 15100])

    def test_parses_current_official_page_shape_and_journal_items(self):
        parsed = fe.parse_fiscal_journal(REAL_SHAPE_HTML)
        self.assertEqual(parsed["merchant"], "1000000-001-TEST")
        self.assertEqual(parsed["date"], "2026-08-24")
        self.assertEqual(
            parsed["fiscal_receipt_id"],
            "SYNTHETIC-SIGNER-000001",
        )
        self.assertEqual(parsed["total_minor"], 150000)
        self.assertEqual(parsed["currency"], "RSD")
        self.assertEqual(parsed["currency_source"], "serbian-fiscal-default")
        self.assertEqual(
            [(item["quantity"], item["total_minor"]) for item in parsed["items"]],
            [(1, 50000), (2, 100000)],
        )

    def test_rejects_partial_or_inconsistent_journal(self):
        partial = "<div>Продавац: MAXI</div><div>Укупан износ: 201,00</div>"
        inconsistent = COMPLETE_HTML.replace("Укупан износ: 201,00", "Укупан износ: 999,00")
        malformed_row = REAL_SHAPE_HTML.replace(
            "Test Item B/KOM (Ђ) 500,00 2 1.000,00",
            "MALFORMED ITEM ROW",
        )
        missing_time = REAL_SHAPE_HTML.replace(
            "24.8.2026. 20:23:01",
            "24.8.2026.",
        )
        invalid_time = REAL_SHAPE_HTML.replace(
            "24.8.2026. 20:23:01",
            "24.8.2026. 99:99:99",
        )
        timezone_without_time = REAL_SHAPE_HTML.replace(
            "24.8.2026. 20:23:01",
            "24.8.2026. +02:00",
        )
        timestamp_with_garbage = REAL_SHAPE_HTML.replace(
            "24.8.2026. 20:23:01",
            "24.8.2026. 20:23:01 garbage",
        )
        duplicate_journal = REAL_SHAPE_HTML.replace(
            "</body>",
            "<pre>Укупан<br>износ: 1.500,00</pre></body>",
        )
        unclosed_duplicate_journal = REAL_SHAPE_HTML.replace(
            "</body>",
            "<pre>Укупан износ: 1.500,00</body>",
        )
        for html in (
            partial,
            inconsistent,
            malformed_row,
            missing_time,
            invalid_time,
            timezone_without_time,
            timestamp_with_garbage,
            duplicate_journal,
            unclosed_duplicate_journal,
        ):
            with self.subTest(html=html[:40]), self.assertRaises(fe.FiscalParseError):
                fe.parse_fiscal_journal(html)


class EnrichmentTests(unittest.TestCase):
    def test_enriches_fiscal_fields_and_preserves_scan_payment_fields(self):
        result = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": SCAN,
                "known_fiscal_receipt_ids": [],
            },
            fetch_fn=lambda url: COMPLETE_HTML,
        )
        self.assertEqual(result["status"], "enriched")
        self.assertTrue(result["safe_to_plan"])
        self.assertEqual(result["receipt"]["merchant"], "MAXI 722")
        self.assertEqual(result["receipt"]["charge_account"], "Visa *9999")
        self.assertEqual(result["breaker"]["consecutive_failures"], 0)

    def test_exact_fiscal_id_is_a_hard_duplicate(self):
        result = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": SCAN,
                "known_fiscal_receipt_ids": ["123/150493ПР"],
            },
            fetch_fn=lambda url: COMPLETE_HTML,
        )
        self.assertEqual(result["status"], "duplicate")
        self.assertFalse(result["safe_to_plan"])

        mismatched_scan = dict(SCAN, total_minor=99900)
        mismatched = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": mismatched_scan,
                "known_fiscal_receipt_ids": ["123/150493ПР"],
            },
            fetch_fn=lambda url: COMPLETE_HTML,
        )
        self.assertEqual(mismatched["status"], "duplicate")
        self.assertFalse(mismatched["safe_to_plan"])

    def test_cross_source_fiscal_id_mismatch_uses_whole_scan_fallback(self):
        scan = dict(SCAN, fiscal_receipt_id="SCAN-ID")
        result = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": scan,
            },
            fetch_fn=lambda url: COMPLETE_HTML,
        )
        self.assertEqual(result["status"], "fallback")
        self.assertEqual(result["receipt"], scan)

    def test_merge_preserves_fiscal_currency_provenance(self):
        fiscal = fe.parse_fiscal_journal(REAL_SHAPE_HTML)
        merged, mismatch = fe.merge_fiscal_and_scan(
            fiscal,
            dict(SCAN, total_minor=150000, currency_source="scan"),
        )
        self.assertIsNone(mismatch)
        self.assertEqual(
            merged["currency_source"],
            "serbian-fiscal-default",
        )

    def test_network_parser_and_cross_source_failures_use_full_scan(self):
        mismatch = dict(SCAN, total_minor=99900)
        network = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": SCAN,
                "breaker": {"consecutive_failures": 1},
            },
            fetch_fn=lambda url: (_ for _ in ()).throw(TimeoutError()),
        )
        self.assertEqual(network["status"], "fallback")
        self.assertEqual(network["receipt"], SCAN)
        self.assertEqual(network["breaker"]["consecutive_failures"], 1)

        dns_failure = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": SCAN,
                "breaker": {"consecutive_failures": 1},
            },
            fetch_fn=lambda url: (_ for _ in ()).throw(
                fe.FiscalNetworkError("temporary DNS failure")
            ),
        )
        self.assertEqual(dns_failure["status"], "fallback")
        self.assertEqual(dns_failure["breaker"]["consecutive_failures"], 1)

        invalid_qr_fetches = []
        invalid_qr = fe.enrich(
            {
                "qr_url": "https://evil.example/receipt",
                "scan_receipt": SCAN,
                "breaker": {"consecutive_failures": 1},
            },
            fetch_fn=lambda url: invalid_qr_fetches.append(url),
        )
        self.assertEqual(invalid_qr["status"], "fallback")
        self.assertEqual(invalid_qr["breaker"]["consecutive_failures"], 1)
        self.assertEqual(invalid_qr_fetches, [])

        protocol_rejection = fe.enrich(
            {
                "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                "scan_receipt": SCAN,
                "breaker": {"consecutive_failures": 1},
            },
            fetch_fn=lambda url: (_ for _ in ()).throw(
                fe.FiscalSecurityError("redirect forbidden")
            ),
        )
        self.assertEqual(protocol_rejection["status"], "fallback")
        self.assertEqual(protocol_rejection["receipt"], SCAN)
        self.assertEqual(
            protocol_rejection["breaker"]["consecutive_failures"],
            2,
        )

        cases = [
            (SCAN, lambda url: "<html>drift</html>"),
            (mismatch, lambda url: COMPLETE_HTML),
        ]
        for scan, fetch in cases:
            with self.subTest(scan=scan, fetch=fetch):
                result = fe.enrich(
                    {
                        "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
                        "scan_receipt": scan,
                        "breaker": {"consecutive_failures": 1},
                    },
                    fetch_fn=fetch,
                )
                self.assertEqual(result["status"], "fallback")
                self.assertEqual(result["receipt"], scan)
                self.assertEqual(result["breaker"]["consecutive_failures"], 2)

    def test_kill_switch_and_open_breaker_never_fetch(self):
        calls = []

        def forbidden(url):
            calls.append(url)
            raise AssertionError("network must remain disabled")

        disabled = fe.enrich(
            {"enabled": False, "scan_receipt": SCAN},
            fetch_fn=forbidden,
        )
        opened = fe.enrich(
            {
                "scan_receipt": SCAN,
                "breaker": {
                    "consecutive_failures": 3,
                    "max_consecutive_failures": 3,
                },
            },
            fetch_fn=forbidden,
        )
        with patch.dict(os.environ, {fe.DISABLE_ENV: "true"}):
            env_disabled = fe.enrich({"scan_receipt": SCAN}, fetch_fn=forbidden)
        self.assertEqual(
            [disabled["status"], opened["status"], env_disabled["status"]],
            ["disabled", "circuit_open", "disabled"],
        )
        self.assertEqual(calls, [])

    def test_scan_duplicate_stops_before_disabled_or_missing_qr(self):
        scan = dict(SCAN, fiscal_receipt_id="KNOWN")
        result = fe.enrich(
            {
                "enabled": False,
                "scan_receipt": scan,
                "known_fiscal_receipt_ids": ["KNOWN"],
            }
        )
        self.assertEqual(result["status"], "duplicate")
        self.assertFalse(result["safe_to_plan"])

    def test_missing_qr_does_not_increment_online_failure_breaker(self):
        result = fe.enrich(
            {
                "scan_receipt": SCAN,
                "breaker": {
                    "consecutive_failures": 2,
                    "max_consecutive_failures": 3,
                },
            }
        )
        self.assertEqual(result["status"], "fallback")
        self.assertEqual(result["breaker"]["consecutive_failures"], 2)

    def test_malformed_known_id_checkpoint_fails_closed_in_every_mode(self):
        for value in ("", 0, False, None):
            with self.subTest(value=value), self.assertRaises(ValueError):
                fe.enrich(
                    {
                        "enabled": False,
                        "scan_receipt": SCAN,
                        "known_fiscal_receipt_ids": value,
                    }
                )

    def test_consecutive_failures_open_the_next_run(self):
        payload = {
            "qr_url": "https://suf.purs.gov.rs/v/?vl=x",
            "scan_receipt": SCAN,
            "breaker": {
                "consecutive_failures": 2,
                "max_consecutive_failures": 3,
            },
        }
        third = fe.enrich(
            payload,
            fetch_fn=lambda url: "<html>schema drift</html>",
        )
        calls = []
        next_run = fe.enrich(
            {"scan_receipt": SCAN, "breaker": third["breaker"]},
            fetch_fn=lambda url: calls.append(url),
        )
        self.assertEqual(third["breaker"]["consecutive_failures"], 3)
        self.assertEqual(next_run["status"], "circuit_open")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main()
