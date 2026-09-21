#!/usr/bin/env python3

from __future__ import annotations

import importlib.util
import sys
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("operation_item_name.py")
SPEC = importlib.util.spec_from_file_location("operation_item_name", MODULE_PATH)
item_name = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = item_name
SPEC.loader.exec_module(item_name)


class OperationItemNameTests(unittest.TestCase):
    def test_examples_compose_exact_expected_names(self):
        examples = (
            ("Mleko 2,8% 1L", "Молоко", [], "Mleko 2,8% 1L (Молоко)"),
            ("Beli luk rinfuz", "Чеснок", [], "Beli luk rinfuz (Чеснок)"),
            (
                "Pivo Heineken 0.5l",
                "Пиво",
                ["Heineken", "Хайнекен"],
                "Pivo Heineken 0.5l (Пиво)",
            ),
        )
        for original, essence, brands, expected in examples:
            with self.subTest(original=original):
                result = item_name.compose(
                    {
                        "original_name": original,
                        "semantic_essence_ru": essence,
                        "brand_tokens": brands,
                        "brand_scan_complete": True,
                    }
                )
                self.assertTrue(result["safe"], result)
                self.assertEqual(result["operation_item"], expected)

    def test_original_name_is_preserved_exactly(self):
        original = "Jogurt 'Moja Kravica' 2.8% 500ml"
        result = item_name.compose(
            {
                "original_name": original,
                "semantic_essence_ru": "Йогурт",
                "brand_tokens": ["Moja Kravica"],
                "brand_scan_complete": True,
            }
        )
        self.assertTrue(result["safe"], result)
        self.assertEqual(result["operation_item"], f"{original} (Йогурт)")

    def test_rejects_numbers_percentages_and_measurements_in_essence(self):
        for essence in ("Молоко 2,8 процента", "Молоко один литр", "Яйца десять штук"):
            with self.subTest(essence=essence):
                result = item_name.compose(
                    {
                        "original_name": "Example",
                        "semantic_essence_ru": essence,
                        "brand_tokens": [],
                        "brand_scan_complete": True,
                    }
                )
                self.assertFalse(result["safe"])

    def test_rejects_latin_brand_in_essence(self):
        result = item_name.compose(
            {
                "original_name": "Pivo Heineken 0.5l",
                "semantic_essence_ru": "Пиво Heineken",
                "brand_tokens": ["Heineken"],
                "brand_scan_complete": True,
            }
        )
        self.assertFalse(result["safe"])

    def test_rejects_cyrillic_brand_when_declared(self):
        result = item_name.compose(
            {
                "original_name": "Pivo Heineken 0.5l",
                "semantic_essence_ru": "Пиво Хайнекен",
                "brand_tokens": ["Heineken", "Хайнекен"],
                "brand_scan_complete": True,
            }
        )
        self.assertFalse(result["safe"])
        self.assertIn(
            "semantic_essence_ru must not repeat a brand token",
            result["errors"],
        )

    def test_rejects_unknown_fields_and_parenthesized_essence(self):
        result = item_name.compose(
            {
                "original_name": "Mleko",
                "semantic_essence_ru": "(Молоко)",
                "brand_tokens": [],
                "brand_scan_complete": True,
                "translation": "Молоко",
            }
        )
        self.assertFalse(result["safe"])
        self.assertTrue(any("unknown fields" in error for error in result["errors"]))

    def test_brand_inventory_is_required_even_when_empty(self):
        result = item_name.compose(
            {
                "original_name": "Beli luk rinfuz",
                "semantic_essence_ru": "Чеснок",
            }
        )
        self.assertFalse(result["safe"])
        self.assertIn(
            "input is missing required fields: brand_scan_complete, brand_tokens",
            result["errors"],
        )

        null_result = item_name.compose(
            {
                "original_name": "Beli luk rinfuz",
                "semantic_essence_ru": "Чеснок",
                "brand_tokens": None,
                "brand_scan_complete": True,
            }
        )
        self.assertFalse(null_result["safe"])
        self.assertIn("brand_tokens must be an array", null_result["errors"])

    def test_brand_scan_must_be_positive_and_explicit(self):
        result = item_name.compose(
            {
                "original_name": "Pivo Heineken 0.5l",
                "semantic_essence_ru": "Пиво",
                "brand_tokens": ["Heineken", "Хайнекен"],
                "brand_scan_complete": False,
            }
        )
        self.assertFalse(result["safe"])
        self.assertIn(
            "brand_scan_complete must be true after semantic brand review",
            result["errors"],
        )


if __name__ == "__main__":
    unittest.main()
