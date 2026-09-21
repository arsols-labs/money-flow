#!/usr/bin/env python3
"""Defensive Serbian fiscal-page enrichment for normalized receipt facts.

This helper is deliberately stateless. The host supplies and persists the
circuit-breaker snapshot and the exact fiscal IDs that it has already verified.
No Money Flow or provider writes are performed here.
"""

from __future__ import annotations

import argparse
import http.client
import ipaddress
import json
import os
import re
import socket
import ssl
import subprocess
import sys
import time
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Callable


SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

from qr_guard import (  # noqa: E402
    FiscalSecurityError,
    validate_fiscal_url,
    validate_resolved_addresses,
)


MAX_RESPONSE_BYTES = 2 * 1024 * 1024
ALLOWED_CONTENT_TYPES = {"text/html", "application/xhtml+xml"}
DEFAULT_TIMEOUT_SECONDS = 10.0
DEFAULT_BREAKER_THRESHOLD = 3
DISABLE_ENV = "MONEY_FLOW_FISCAL_QR_DISABLED"
ROUNDING_TOLERANCE_MINOR = 2
_SYSTEM_RESOLVER = socket.getaddrinfo
_DNS_HELPER = (
    "import json,socket,sys; "
    "rows=socket.getaddrinfo(sys.argv[1],int(sys.argv[2]),"
    "type=socket.SOCK_STREAM,proto=socket.IPPROTO_TCP); "
    "print(json.dumps(sorted({row[4][0] for row in rows})))"
)


class FiscalParseError(ValueError):
    """The public page is incomplete or internally inconsistent."""


class FiscalNetworkError(OSError):
    """A transient DNS or transport failure, not a content/security failure."""


@dataclass(frozen=True)
class BreakerState:
    consecutive_failures: int = 0
    max_consecutive_failures: int = DEFAULT_BREAKER_THRESHOLD

    @classmethod
    def from_value(cls, value: Any) -> "BreakerState":
        raw = value if isinstance(value, dict) else {}
        try:
            failures = max(0, int(raw.get("consecutive_failures", 0)))
            threshold = max(
                1,
                int(
                    raw.get(
                        "max_consecutive_failures",
                        raw.get("max", DEFAULT_BREAKER_THRESHOLD),
                    )
                ),
            )
        except (TypeError, ValueError) as exc:
            raise ValueError("invalid circuit-breaker snapshot") from exc
        return cls(failures, threshold)

    @property
    def open(self) -> bool:
        return self.consecutive_failures >= self.max_consecutive_failures

    def success(self) -> "BreakerState":
        return BreakerState(0, self.max_consecutive_failures)

    def failure(self) -> "BreakerState":
        return BreakerState(
            self.consecutive_failures + 1,
            self.max_consecutive_failures,
        )

    def as_dict(self) -> dict[str, int]:
        return {
            "consecutive_failures": self.consecutive_failures,
            "max_consecutive_failures": self.max_consecutive_failures,
        }


class PinnedHTTPSConnection(http.client.HTTPSConnection):
    """Validate TLS for the hostname while pinning TCP to a checked DNS IP."""

    def __init__(self, host: str, port: int, pinned_ip: str, timeout: float):
        super().__init__(
            host,
            port=port,
            timeout=timeout,
            context=ssl.create_default_context(),
        )
        self.pinned_ip = pinned_ip

    def connect(self) -> None:
        raw = socket.create_connection(
            (self.pinned_ip, self.port),
            self.timeout,
            self.source_address,
        )
        try:
            if ipaddress.ip_address(raw.getpeername()[0]) != ipaddress.ip_address(
                self.pinned_ip
            ):
                raise FiscalSecurityError(
                    "connected peer did not match pinned DNS address"
                )
            self.sock = self._context.wrap_socket(raw, server_hostname=self.host)
        except Exception:
            raw.close()
            raise


def resolve_fiscal_addresses(
    host: str,
    port: int,
    *,
    resolver: Callable[..., Any] = _SYSTEM_RESOLVER,
    timeout: float | None = None,
) -> tuple[str, ...]:
    if resolver is _SYSTEM_RESOLVER and timeout is not None:
        try:
            completed = subprocess.run(
                [sys.executable, "-c", _DNS_HELPER, host, str(port)],
                check=True,
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as exc:
            raise TimeoutError(
                "fiscal DNS resolution exceeded the total timeout"
            ) from exc
        except subprocess.CalledProcessError as exc:
            raise FiscalNetworkError("fiscal DNS resolution failed") from exc
        try:
            addresses = json.loads(completed.stdout)
        except json.JSONDecodeError as exc:
            raise FiscalSecurityError(
                "fiscal DNS helper returned invalid output"
            ) from exc
        if not isinstance(addresses, list) or not all(
            isinstance(address, str) for address in addresses
        ):
            raise FiscalSecurityError("fiscal DNS helper returned invalid output")
    else:
        answers = resolver(
            host,
            port,
            type=socket.SOCK_STREAM,
            proto=socket.IPPROTO_TCP,
        )
        addresses = [answer[4][0] for answer in answers]
    return validate_resolved_addresses(addresses)


def _connection_factory(
    host: str,
    port: int,
    pinned_ip: str,
    timeout: float,
) -> PinnedHTTPSConnection:
    return PinnedHTTPSConnection(host, port, pinned_ip, timeout)


def fetch_fiscal_page(
    url: str,
    *,
    resolver: Callable[..., Any] = _SYSTEM_RESOLVER,
    connection_factory: Callable[..., Any] | None = None,
    timeout: float = DEFAULT_TIMEOUT_SECONDS,
    clock: Callable[[], float] = time.monotonic,
) -> str:
    """Fetch one allowlisted page without redirects, compression, or DNS drift."""

    try:
        timeout_value = float(timeout)
    except (TypeError, ValueError) as exc:
        raise ValueError("fiscal timeout must be numeric") from exc
    if timeout_value <= 0:
        raise ValueError("fiscal timeout must be positive")
    deadline = clock() + timeout_value
    validated = validate_fiscal_url(url)
    addresses = resolve_fiscal_addresses(
        validated.host,
        validated.port,
        resolver=resolver,
        timeout=timeout_value,
    )
    if clock() > deadline:
        raise TimeoutError("fiscal DNS resolution exceeded the total timeout")
    factory = connection_factory or _connection_factory
    last_connection_error: OSError | None = None
    for pinned_ip in addresses:
        connection = None
        try:
            remaining = deadline - clock()
            if remaining <= 0:
                break
            connection = factory(
                validated.host,
                validated.port,
                pinned_ip,
                remaining,
            )
            connection.request(
                "GET",
                validated.target,
                headers={
                    "Host": validated.host,
                    "Accept": "text/html, application/xhtml+xml",
                    "Accept-Encoding": "identity",
                    "User-Agent": "MoneyFlowReceiptSkill/1.0",
                },
            )
            remaining = deadline - clock()
            if remaining <= 0:
                raise TimeoutError("fiscal request exceeded the total timeout")
            if getattr(connection, "sock", None) is not None:
                connection.sock.settimeout(remaining)
            response = connection.getresponse()
            if response.status != 200:
                raise FiscalSecurityError(
                    "fiscal endpoint returned a non-200 response; redirects are forbidden"
                )

            raw_content_type = response.getheader("Content-Type", "") or ""
            content_type, _, parameters = raw_content_type.partition(";")
            if content_type.strip().lower() not in ALLOWED_CONTENT_TYPES:
                raise FiscalSecurityError(
                    "fiscal endpoint returned an unsupported content type"
                )
            charset_match = re.search(
                r"charset\s*=\s*[\"']?([^;\"']+)",
                parameters,
                re.I,
            )
            if charset_match and charset_match.group(1).strip().casefold() not in {
                "utf-8",
                "utf8",
            }:
                raise FiscalSecurityError(
                    "fiscal response declared a non-UTF-8 charset"
                )

            content_encoding = (
                response.getheader("Content-Encoding", "identity") or "identity"
            ).strip().casefold()
            if content_encoding not in {"", "identity"}:
                raise FiscalSecurityError("compressed fiscal responses are forbidden")

            length_header = response.getheader("Content-Length")
            if length_header:
                try:
                    content_length = int(length_header)
                except ValueError as exc:
                    raise FiscalSecurityError("invalid fiscal response length") from exc
                if content_length < 0 or content_length > MAX_RESPONSE_BYTES:
                    raise FiscalSecurityError("fiscal response is too large")

            body = bytearray()
            while len(body) <= MAX_RESPONSE_BYTES:
                remaining = deadline - clock()
                if remaining <= 0:
                    raise TimeoutError(
                        "fiscal response exceeded the total timeout"
                    )
                if getattr(connection, "sock", None) is not None:
                    connection.sock.settimeout(remaining)
                chunk = response.read(
                    min(64 * 1024, MAX_RESPONSE_BYTES + 1 - len(body))
                )
                if clock() > deadline:
                    raise TimeoutError(
                        "fiscal response exceeded the total timeout"
                    )
                if not chunk:
                    break
                body.extend(chunk)
            if len(body) > MAX_RESPONSE_BYTES:
                raise FiscalSecurityError("fiscal response exceeded the byte limit")
            try:
                return bytes(body).decode("utf-8")
            except UnicodeDecodeError as exc:
                raise FiscalSecurityError("fiscal response is not UTF-8") from exc
        except OSError as exc:
            last_connection_error = exc
        finally:
            if connection is not None:
                connection.close()
    if last_connection_error is not None:
        raise last_connection_error
    raise FiscalSecurityError("fiscal endpoint could not be reached")


class _JournalHTMLParser(HTMLParser):
    """Project untrusted HTML into text lines and table rows."""

    _LINE_BREAKS = {"br", "div", "p", "li", "section", "h1", "h2", "h3"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.lines: list[str] = []
        self.rows: list[list[str]] = []
        self.pre_blocks: list[str] = []
        self.raw_text_parts: list[str] = []
        self._line_parts: list[str] = []
        self._row: list[str] | None = None
        self._cell_parts: list[str] | None = None
        self._pre_parts: list[str] | None = None
        self.pre_malformed = False
        self._ignored_depth = 0

    @staticmethod
    def _clean(parts: list[str]) -> str:
        return re.sub(r"\s+", " ", " ".join(parts)).strip()

    def _flush_line(self) -> None:
        line = self._clean(self._line_parts)
        if line:
            self.lines.append(line)
        self._line_parts = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "noscript"}:
            self._ignored_depth += 1
            return
        if self._ignored_depth:
            return
        if tag in self._LINE_BREAKS:
            self._flush_line()
            if self._pre_parts is not None:
                self._pre_parts.append(" ")
        if tag == "tr":
            self._row = []
        elif tag in {"td", "th"} and self._row is not None:
            self._cell_parts = []
        elif tag == "pre":
            if self._pre_parts is not None:
                self.pre_malformed = True
            self._pre_parts = []

    def handle_endtag(self, tag: str) -> None:
        tag = tag.casefold()
        if tag in {"script", "style", "noscript"}:
            if self._ignored_depth:
                self._ignored_depth -= 1
            return
        if self._ignored_depth:
            return
        if tag in self._LINE_BREAKS and self._pre_parts is not None:
            self._pre_parts.append(" ")
        if tag in {"td", "th"} and self._cell_parts is not None:
            cell = self._clean(self._cell_parts)
            if self._row is not None:
                self._row.append(cell)
            self._cell_parts = None
        elif tag == "tr" and self._row is not None:
            if any(self._row):
                self.rows.append(self._row)
            self._row = None
        elif tag == "pre" and self._pre_parts is not None:
            block = "".join(self._pre_parts).strip()
            if block:
                self.pre_blocks.append(block)
            self._pre_parts = None
        if tag in self._LINE_BREAKS:
            self._flush_line()

    def handle_data(self, data: str) -> None:
        if self._ignored_depth:
            return
        self.raw_text_parts.append(data)
        if self._pre_parts is not None:
            self._pre_parts.append(data)
        cleaned = re.sub(r"\s+", " ", data).strip()
        if not cleaned:
            return
        self._line_parts.append(cleaned)
        if self._cell_parts is not None:
            self._cell_parts.append(cleaned)

    def close(self) -> None:
        super().close()
        if self._pre_parts is not None:
            self.pre_malformed = True
            self._pre_parts = None
        self._flush_line()


def _money_minor(value: str) -> int:
    raw = re.sub(r"[\s\u00a0]", "", value or "")
    raw = re.sub(r"[^0-9,.-]", "", raw)
    if not raw or raw in {"-", ".", ","}:
        raise FiscalParseError("invalid monetary value")
    if "," in raw and "." in raw:
        decimal_separator = "," if raw.rfind(",") > raw.rfind(".") else "."
        thousands_separator = "." if decimal_separator == "," else ","
        raw = raw.replace(thousands_separator, "").replace(decimal_separator, ".")
    elif "," in raw:
        raw = raw.replace(".", "").replace(",", ".")
    elif raw.count(".") > 1:
        parts = raw.split(".")
        raw = "".join(parts[:-1]) + "." + parts[-1]
    try:
        amount = Decimal(raw)
    except InvalidOperation as exc:
        raise FiscalParseError("invalid monetary value") from exc
    return int((amount * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def _quantity(value: str) -> Decimal:
    raw = re.sub(r"[\s\u00a0]", "", value or "").replace(",", ".")
    try:
        quantity = Decimal(raw)
    except InvalidOperation as exc:
        raise FiscalParseError("invalid item quantity") from exc
    if quantity <= 0:
        raise FiscalParseError("item quantity must be positive")
    return quantity


def _label_value(lines: list[str], *labels: str) -> str | None:
    for index, line in enumerate(lines):
        for label in labels:
            match = re.search(
                rf"(?:^|\s){re.escape(label)}\s*:?\s*(.+)$",
                line,
                re.IGNORECASE,
            )
            if match and match.group(1).strip():
                return match.group(1).strip()
            normalized_line = line.strip().rstrip(":").casefold()
            normalized_label = label.strip().rstrip(":").casefold()
            if normalized_line == normalized_label and index + 1 < len(lines):
                value = lines[index + 1].strip()
                if value:
                    return value
    return None


def _parse_date(value: str) -> str:
    match = re.fullmatch(
        r"(\d{1,2})[.]\s*(\d{1,2})[.]\s*(\d{4})[.]?\s+"
        r"(\d{1,2}):(\d{2})(?::(\d{2}))?\b",
        value.strip(),
    )
    if not match:
        raise FiscalParseError("unsupported fiscal timestamp")
    day, month, year, hour, minute, second = (
        int(part) if part is not None else 0 for part in match.groups()
    )
    try:
        return datetime(year, month, day, hour, minute, second).date().isoformat()
    except ValueError as exc:
        raise FiscalParseError("invalid fiscal timestamp") from exc


def _normalized_item(
    name: str,
    quantity_raw: str,
    unit_raw: str,
    total_raw: str,
) -> dict[str, Any]:
    quantity = _quantity(quantity_raw)
    unit_minor = _money_minor(unit_raw)
    total_minor = _money_minor(total_raw)
    if not name or unit_minor <= 0 or total_minor <= 0:
        raise FiscalParseError("fiscal item fields must be positive")
    computed = int(
        (quantity * Decimal(unit_minor)).quantize(
            Decimal("1"),
            rounding=ROUND_HALF_UP,
        )
    )
    if abs(computed - total_minor) > ROUNDING_TOLERANCE_MINOR:
        raise FiscalParseError("fiscal item arithmetic does not reconcile")
    quantity_value: int | str
    if quantity == quantity.to_integral_value():
        quantity_value = int(quantity)
    else:
        quantity_value = format(quantity.normalize(), "f")
    return {
        "name": name,
        "quantity": quantity_value,
        "unit_minor": unit_minor,
        "total_minor": total_minor,
    }


def _parse_items(
    rows: list[list[str]],
    lines: list[str],
    raw_text: str,
) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    amount = r"\d{1,3}(?:[.]\d{3})*,\d{2}|\d+,\d{2}"
    section_match = re.search(
        r"Назив\s+Цена\s+Кол[.]?\s+Укупно\s+(.*?)"
        r"[-=]+\s*Укупан износ\s*:",
        raw_text,
        re.IGNORECASE | re.DOTALL,
    )
    if section_match:
        section = section_match.group(1).strip()
        candidate_lines = [
            line.strip()
            for line in section.splitlines()
            if line.strip() and not re.fullmatch(r"[-=]+", line.strip())
        ]
        line_pattern = re.compile(
            rf"^(?P<name>.+?)\s+(?P<unit>{amount})\s+"
            rf"(?P<quantity>\d+(?:[.,]\d+)?)\s+"
            rf"(?P<total>{amount})$",
        )
        numeric_pattern = re.compile(
            rf"^(?P<unit>{amount})\s+"
            rf"(?P<quantity>\d+(?:[.,]\d+)?)\s+"
            rf"(?P<total>{amount})$",
        )
        if len(candidate_lines) > 1:
            pending_name: list[str] = []
            for line in candidate_lines:
                match = line_pattern.fullmatch(line)
                if match:
                    if pending_name:
                        raise FiscalParseError(
                            "fiscal journal contains an unparsed item row"
                        )
                    name = match.group("name").strip()
                else:
                    match = numeric_pattern.fullmatch(line)
                    if not match:
                        pending_name.append(line)
                        continue
                    if not pending_name:
                        raise FiscalParseError(
                            "fiscal journal item amount has no name"
                        )
                    name = " ".join(pending_name).strip()
                    pending_name = []
                items.append(
                    _normalized_item(
                        name,
                        match.group("quantity"),
                        match.group("unit"),
                        match.group("total"),
                    )
                )
            if pending_name:
                raise FiscalParseError(
                    "fiscal journal contains an unparsed item row"
                )
        elif candidate_lines:
            collapsed = candidate_lines[0]
            item_pattern = re.compile(
                rf"(?P<name>.+?)\s+(?P<unit>{amount})\s+"
                rf"(?P<quantity>\d+(?:[.,]\d+)?)\s+"
                rf"(?P<total>{amount})(?=\s|$)",
            )
            matches = list(item_pattern.finditer(collapsed))
            cursor = 0
            for match in matches:
                if collapsed[cursor : match.start()].strip(" -="):
                    raise FiscalParseError(
                        "fiscal journal contains unparsed item content"
                    )
                items.append(
                    _normalized_item(
                        match.group("name").strip(),
                        match.group("quantity"),
                        match.group("unit"),
                        match.group("total"),
                    )
                )
                cursor = match.end()
            if collapsed[cursor:].strip(" -="):
                raise FiscalParseError(
                    "fiscal journal contains unparsed item content"
                )

    if not items:
        for row in rows:
            if len(row) < 4:
                continue
            name, quantity_raw, unit_raw, total_raw = row[-4:]
            try:
                items.append(
                    _normalized_item(name, quantity_raw, unit_raw, total_raw)
                )
            except FiscalParseError:
                if any(re.search(r"\d", cell) for cell in row[-3:]):
                    raise FiscalParseError(
                        "fiscal table contains an unparsed item row"
                    )
    if not items:
        raise FiscalParseError("fiscal journal has no complete item rows")
    return items


def parse_fiscal_journal(raw_html: str) -> dict[str, Any]:
    """Parse a complete public Journal page into the planner's normalized shape."""

    if not isinstance(raw_html, str) or not raw_html.strip():
        raise FiscalParseError("empty fiscal journal")
    parser = _JournalHTMLParser()
    try:
        parser.feed(raw_html)
        parser.close()
    except Exception as exc:
        raise FiscalParseError("invalid fiscal HTML") from exc
    if parser.pre_malformed:
        raise FiscalParseError("fiscal page contains malformed Journal markup")

    text = "\n".join(parser.lines)
    journal_pre_blocks = [
        re.sub(r"\s+", " ", block).strip()
        for block in parser.pre_blocks
        if any(
            marker in re.sub(r"\s+", " ", block).casefold()
            for marker in ("укупан износ", "фискални рачун", "промет")
        )
    ]
    if len(journal_pre_blocks) > 1:
        raise FiscalParseError("fiscal page contains multiple Journal blocks")
    required_marker_groups = (
        ("ПРОМЕТ",),
        ("Име продајног места", "Продавац", "Предузеће"),
        ("ПФР време", "Датум"),
        ("Затражио - Потписао - Бројач", "Број рачуна", "Бројач рачуна"),
        ("Укупан износ",),
        ("Журнал",),
    )
    for alternatives in required_marker_groups:
        if not any(marker.casefold() in text.casefold() for marker in alternatives):
            raise FiscalParseError("fiscal journal missing required section")

    merchant = _label_value(
        parser.lines,
        "Име продајног места",
        "Продавац",
        "Предузеће",
    )
    timestamp = _label_value(
        parser.lines,
        "ПФР време (временска зона сервера)",
        "ПФР време",
        "Датум и време",
        "Датум",
    )
    fiscal_id = _label_value(
        parser.lines,
        "Затражио - Потписао - Бројач",
        "Број рачуна",
        "Бројач рачуна",
    )
    pib = _label_value(parser.lines, "ПИБ", "Пиб")
    explicit_currency = _label_value(parser.lines, "Валута")
    currency = (explicit_currency or "RSD").upper()
    total_raw = _label_value(parser.lines, "Укупан износ")
    if not merchant or not timestamp or not fiscal_id or not total_raw:
        raise FiscalParseError("fiscal journal missing core fields")
    if not re.fullmatch(r"[A-Z]{3}", currency):
        raise FiscalParseError("invalid fiscal currency")

    total_minor = _money_minor(total_raw)
    if total_minor <= 0:
        raise FiscalParseError("fiscal total must be positive")
    items = _parse_items(
        parser.rows,
        parser.lines,
        "\n".join(parser.raw_text_parts),
    )
    if abs(sum(item["total_minor"] for item in items) - total_minor) > ROUNDING_TOLERANCE_MINOR:
        raise FiscalParseError("fiscal item sum does not match total")

    return {
        "merchant": merchant,
        "date": _parse_date(timestamp),
        "fiscal_timestamp": timestamp,
        "fiscal_receipt_id": fiscal_id,
        "pib": pib,
        "currency": currency,
        "currency_source": "page" if explicit_currency else "serbian-fiscal-default",
        "total_minor": total_minor,
        "items": items,
    }


def merge_fiscal_and_scan(
    fiscal: dict[str, Any],
    scan: dict[str, Any],
) -> tuple[dict[str, Any], str | None]:
    """Return a complete hybrid or the untouched scan plus a mismatch reason."""

    checks = (
        ("date", scan.get("date"), fiscal.get("date")),
        ("currency", scan.get("currency"), fiscal.get("currency")),
        ("total", scan.get("total_minor"), fiscal.get("total_minor")),
        (
            "fiscal receipt ID",
            scan.get("fiscal_receipt_id"),
            fiscal.get("fiscal_receipt_id"),
        ),
    )
    for field, scan_value, fiscal_value in checks:
        if scan_value is not None and fiscal_value is not None and scan_value != fiscal_value:
            return dict(scan), f"scan and fiscal {field} disagree"

    merged = dict(scan)
    for field in (
        "merchant",
        "date",
        "currency",
        "total_minor",
        "fiscal_receipt_id",
        "fiscal_timestamp",
        "pib",
        "items",
        "currency_source",
    ):
        merged[field] = fiscal.get(field)
    return merged, None


def _disabled(payload: dict[str, Any]) -> bool:
    if payload.get("enabled") is False:
        return True
    return os.getenv(DISABLE_ENV, "").strip().casefold() in {
        "1",
        "true",
        "yes",
        "on",
    }


def _result(
    *,
    status: str,
    receipt: dict[str, Any],
    breaker: BreakerState,
    safe_to_plan: bool,
    warning: str | None = None,
    fiscal_record: dict[str, Any] | None = None,
) -> dict[str, Any]:
    result: dict[str, Any] = {
        "status": status,
        "safe_to_plan": safe_to_plan,
        "receipt": receipt,
        "breaker": breaker.as_dict(),
        "warnings": [warning] if warning else [],
    }
    if fiscal_record is not None:
        result["fiscal_record"] = fiscal_record
    return result


def enrich(
    payload: dict[str, Any],
    *,
    fetch_fn: Callable[[str], str] = fetch_fiscal_page,
    parse_fn: Callable[[str], dict[str, Any]] = parse_fiscal_journal,
) -> dict[str, Any]:
    """Enrich one normalized scan receipt with deterministic fallback semantics."""

    scan = payload.get("scan_receipt")
    if not isinstance(scan, dict):
        raise ValueError("scan_receipt must be an object")
    breaker = BreakerState.from_value(payload.get("breaker"))

    known_ids = payload.get("known_fiscal_receipt_ids", [])
    if not isinstance(known_ids, list) or not all(
        isinstance(value, str) for value in known_ids
    ):
        raise ValueError("known_fiscal_receipt_ids must be an array of strings")
    scan_fiscal_id = scan.get("fiscal_receipt_id")
    if (
        isinstance(scan_fiscal_id, str)
        and scan_fiscal_id
        and scan_fiscal_id in known_ids
    ):
        return _result(
            status="duplicate",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=False,
            warning="exact fiscal receipt ID is already present in verified host state",
        )

    if _disabled(payload):
        return _result(
            status="disabled",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=True,
            warning="fiscal enrichment is disabled; using complete scan fallback",
        )
    if breaker.open:
        return _result(
            status="circuit_open",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=True,
            warning="fiscal circuit breaker is open; using complete scan fallback",
        )

    qr_url = payload.get("qr_url")
    if not isinstance(qr_url, str) or not qr_url:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=True,
            warning="missing fiscal QR URL; using complete scan fallback",
        )

    try:
        validate_fiscal_url(qr_url)
    except FiscalSecurityError as exc:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=True,
            warning=f"invalid fiscal QR ({type(exc).__name__}); using complete scan fallback",
        )

    try:
        raw_html = fetch_fn(qr_url)
    except (FiscalSecurityError, ssl.SSLError) as exc:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker.failure(),
            safe_to_plan=True,
            warning=(
                f"fiscal fetch security validation failed ({type(exc).__name__}); "
                "using complete scan fallback"
            ),
        )
    except OSError as exc:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker,
            safe_to_plan=True,
            warning=f"fiscal network fetch failed ({type(exc).__name__}); using complete scan fallback",
        )
    except Exception as exc:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker.failure(),
            safe_to_plan=True,
            warning=f"unexpected fiscal fetch failure ({type(exc).__name__}); using complete scan fallback",
        )

    try:
        fiscal = parse_fn(raw_html)
        if fiscal["fiscal_receipt_id"] in known_ids:
            merged, _mismatch = merge_fiscal_and_scan(fiscal, scan)
            return _result(
                status="duplicate",
                receipt=merged,
                breaker=breaker.success(),
                safe_to_plan=False,
                warning="exact fiscal receipt ID is already present in verified host state",
                fiscal_record=fiscal,
            )
        merged, mismatch = merge_fiscal_and_scan(fiscal, scan)
        if mismatch:
            return _result(
                status="fallback",
                receipt=merged,
                breaker=breaker.failure(),
                safe_to_plan=True,
                warning=f"{mismatch}; using complete scan fallback",
                fiscal_record=fiscal,
            )
        return _result(
            status="enriched",
            receipt=merged,
            breaker=breaker.success(),
            safe_to_plan=True,
            fiscal_record=fiscal,
        )
    except Exception as exc:
        return _result(
            status="fallback",
            receipt=dict(scan),
            breaker=breaker.failure(),
            safe_to_plan=True,
            warning=f"fiscal parse failed ({type(exc).__name__}); using complete scan fallback",
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    subparsers = parser.add_subparsers(dest="command", required=True)
    enrich_parser = subparsers.add_parser("enrich")
    enrich_parser.add_argument("input", type=Path)
    args = parser.parse_args(argv)

    payload = json.loads(args.input.read_text(encoding="utf-8"))
    result = enrich(payload)
    json.dump(result, sys.stdout, ensure_ascii=False, indent=2, sort_keys=True)
    sys.stdout.write("\n")
    return 0 if result["safe_to_plan"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
