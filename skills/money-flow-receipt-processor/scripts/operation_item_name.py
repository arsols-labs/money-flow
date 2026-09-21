#!/usr/bin/env python3
"""Compose and validate smart purchase-operation item names."""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any


ALLOWED_KEYS = {
    "original_name",
    "semantic_essence_ru",
    "brand_tokens",
    "brand_scan_complete",
}
REQUIRED_KEYS = ALLOWED_KEYS
CYRILLIC = re.compile(r"[А-Яа-яЁё]")
LATIN = re.compile(r"[A-Za-z]")
ESSENCE_FORM = re.compile(r"[А-Яа-яЁё]+(?:[ -][А-Яа-яЁё]+){0,5}")
FORBIDDEN_QUANTITY_STEMS = (
    "грамм",
    "килограмм",
    "миллиграмм",
    "литр",
    "миллилитр",
    "сантилитр",
    "децилитр",
    "штук",
    "упаковк",
    "пачк",
)
FORBIDDEN_UNIT_TOKENS = {"г", "кг", "мг", "л", "мл", "шт"}
FORBIDDEN_NUMBER_WORDS = {
    "ноль",
    "один",
    "одна",
    "одно",
    "два",
    "две",
    "три",
    "четыре",
    "пять",
    "шесть",
    "семь",
    "восемь",
    "девять",
    "десять",
    "одиннадцать",
    "двенадцать",
    "тринадцать",
    "четырнадцать",
    "пятнадцать",
    "шестнадцать",
    "семнадцать",
    "восемнадцать",
    "девятнадцать",
    "двадцать",
    "тридцать",
    "сорок",
    "пятьдесят",
    "шестьдесят",
    "семьдесят",
    "восемьдесят",
    "девяносто",
    "сто",
    "двести",
    "триста",
    "четыреста",
    "пятьсот",
    "шестьсот",
    "семьсот",
    "восемьсот",
    "девятьсот",
    "тысяча",
    "тысячи",
    "тысяч",
    "миллион",
    "миллиона",
    "миллионов",
    "миллиард",
    "миллиарда",
    "миллиардов",
    "полтора",
    "полторы",
    "половина",
    "четверть",
    "пара",
    "десяток",
    "дюжина",
}


class ItemNameError(ValueError):
    pass


def _normalized_words(value: str) -> set[str]:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return set(re.findall(r"[0-9a-zа-яё]+", normalized))


def _validate_brand_tokens(value: Any) -> list[str]:
    if not isinstance(value, list):
        raise ItemNameError("brand_tokens must be an array")
    result: list[str] = []
    for index, token in enumerate(value):
        if not isinstance(token, str) or not token.strip():
            raise ItemNameError(f"brand_tokens[{index}] must be a non-empty string")
        if token != token.strip() or any(character in token for character in "\r\n"):
            raise ItemNameError(f"brand_tokens[{index}] must be a single trimmed line")
        result.append(token)
    return result


def compose(payload: Any) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(payload, dict):
        return {"safe": False, "errors": ["input must be a JSON object"]}

    unknown = sorted(set(payload) - ALLOWED_KEYS)
    if unknown:
        errors.append(f"input has unknown fields: {', '.join(unknown)}")
    missing = sorted(REQUIRED_KEYS - set(payload))
    if missing:
        errors.append(f"input is missing required fields: {', '.join(missing)}")

    original = payload.get("original_name")
    essence = payload.get("semantic_essence_ru")
    if payload.get("brand_scan_complete") is not True:
        errors.append("brand_scan_complete must be true after semantic brand review")
    if not isinstance(original, str) or not original.strip():
        errors.append("original_name must be a non-empty string")
    elif original != original.strip() or any(character in original for character in "\r\n"):
        errors.append("original_name must be a single trimmed line")
    elif len(original) > 500:
        errors.append("original_name must not exceed 500 characters")

    if not isinstance(essence, str) or not essence.strip():
        errors.append("semantic_essence_ru must be a non-empty string")
    elif essence != essence.strip() or any(character in essence for character in "\r\n"):
        errors.append("semantic_essence_ru must be a single trimmed line")
    else:
        if len(essence) > 80:
            errors.append("semantic_essence_ru must not exceed 80 characters")
        if CYRILLIC.search(essence) is None or ESSENCE_FORM.fullmatch(essence) is None:
            errors.append(
                "semantic_essence_ru must contain only one to six Cyrillic words"
            )
        if LATIN.search(essence) is not None:
            errors.append("semantic_essence_ru must not contain Latin text")
        if any(character.isdigit() for character in essence) or "%" in essence:
            errors.append("semantic_essence_ru must not contain numbers or percentages")
        essence_words = _normalized_words(essence)
        if essence_words & FORBIDDEN_NUMBER_WORDS:
            errors.append("semantic_essence_ru must not contain written number words")
        if essence_words & FORBIDDEN_UNIT_TOKENS or any(
            word.startswith(FORBIDDEN_QUANTITY_STEMS) for word in essence_words
        ):
            errors.append(
                "semantic_essence_ru must not contain quantity, package, weight, or volume details"
            )

    try:
        brands = _validate_brand_tokens(payload.get("brand_tokens"))
    except ItemNameError as exc:
        errors.append(str(exc))
        brands = []

    if isinstance(essence, str) and essence.strip():
        essence_words = _normalized_words(essence)
        for brand in brands:
            brand_words = _normalized_words(brand)
            if brand_words and brand_words.issubset(essence_words):
                errors.append("semantic_essence_ru must not repeat a brand token")
                break

    if errors:
        return {"safe": False, "errors": sorted(set(errors))}

    assert isinstance(original, str)
    assert isinstance(essence, str)
    return {
        "safe": True,
        "errors": [],
        "original_name": original,
        "semantic_essence_ru": essence,
        "operation_item": f"{original} ({essence})",
    }


def _load(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        raise ItemNameError(f"cannot read input: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ItemNameError(f"invalid JSON: {exc.msg}") from exc


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Compose a smart Money Flow purchase-operation item name"
    )
    subparsers = parser.add_subparsers(dest="command", required=True)
    compose_parser = subparsers.add_parser("compose")
    compose_parser.add_argument("path", type=Path)
    args = parser.parse_args(argv)

    try:
        result = compose(_load(args.path))
    except ItemNameError as exc:
        result = {"safe": False, "errors": [str(exc)]}

    print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if result["safe"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
