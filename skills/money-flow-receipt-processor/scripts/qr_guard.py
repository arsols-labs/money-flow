#!/usr/bin/env python3
"""Pure validation helpers for Serbian fiscal QR destinations."""

from __future__ import annotations

import argparse
import ipaddress
import json
from dataclasses import asdict, dataclass
from urllib.parse import urlsplit


FISCAL_HOST = "suf.purs.gov.rs"


class FiscalSecurityError(ValueError):
    pass


@dataclass(frozen=True)
class ValidatedFiscalUrl:
    host: str
    port: int
    target: str


def validate_fiscal_url(url: str) -> ValidatedFiscalUrl:
    if not isinstance(url, str) or not url.isascii() or url.strip() != url:
        raise FiscalSecurityError("non-canonical fiscal URL")
    if not url.startswith("https://") or "\\" in url:
        raise FiscalSecurityError("HTTPS is required")
    parsed = urlsplit(url)
    if parsed.scheme != "https" or parsed.fragment:
        raise FiscalSecurityError("unsafe URL scheme or fragment")
    if parsed.username is not None or parsed.password is not None:
        raise FiscalSecurityError("URL userinfo is forbidden")
    if parsed.netloc not in (FISCAL_HOST, f"{FISCAL_HOST}:443"):
        raise FiscalSecurityError("unexpected fiscal host or port")
    try:
        port = parsed.port or 443
        host = (parsed.hostname or "").encode("idna").decode("ascii")
    except (UnicodeError, ValueError) as exc:
        raise FiscalSecurityError("invalid fiscal authority") from exc
    if host != FISCAL_HOST or port != 443:
        raise FiscalSecurityError("unexpected fiscal authority")
    target = parsed.path or "/"
    if parsed.query:
        target += f"?{parsed.query}"
    return ValidatedFiscalUrl(host=host, port=port, target=target)


def validate_resolved_addresses(addresses: list[str]) -> tuple[str, ...]:
    if not addresses:
        raise FiscalSecurityError("fiscal host did not resolve")
    validated: set[str] = set()
    for address in addresses:
        try:
            ip = ipaddress.ip_address(address)
        except ValueError as exc:
            raise FiscalSecurityError("DNS returned an invalid address") from exc
        if (
            not ip.is_global
            or ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            raise FiscalSecurityError("DNS returned a non-global address")
        validated.add(str(ip))
    return tuple(sorted(validated))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("url")
    parser.add_argument("--resolved-address", action="append", default=[])
    args = parser.parse_args()
    try:
        result = {"url": asdict(validate_fiscal_url(args.url)), "safe": True}
        if args.resolved_address:
            result["resolved_addresses"] = validate_resolved_addresses(
                args.resolved_address
            )
    except FiscalSecurityError as exc:
        result = {"safe": False, "error": str(exc)}
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["safe"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
