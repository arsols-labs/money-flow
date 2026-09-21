# Smart purchase item naming

Use this contract for the `item` or materializing `title` of every newly
created purchase operation. The receipt remains the source of truth for the
original product name; the Russian text is a compact search and analytics aid.

## Canonical form

```text
<exact original name> (<Russian semantic essence>)
```

- Preserve the extracted original name exactly. Do not translate, reorder,
  shorten, normalize, or remove its brand, quantity, size, punctuation, or
  spelling.
- Translate only the kind or semantic basis of the product. Prefer a short
  noun or noun phrase, normally one to three words.
- Do not repeat digits, percentages, quantities, counts, weights, volumes,
  package sizes, or measurement units inside the parentheses.
- Do not repeat a brand, manufacturer, product line, marketing descriptor, or
  model inside the parentheses, including a Cyrillic transliteration.
- The parenthetical text must be Russian Cyrillic. If the product meaning or a
  brand boundary is uncertain, stop with `action_required`; do not invent a
  translation.

Examples:

```text
Mleko 2,8% 1L (Молоко)
Beli luk rinfuz (Чеснок)
Pivo Heineken 0.5l (Пиво)
```

Invalid examples include `Mleko 2,8% 1L (Молоко 2,8% 1 л)`, because it repeats
numeric and volume details, and `Pivo Heineken 0.5l (Пиво Хайнекен)`, because it
repeats the brand.

## Deterministic validation

Create a JSON object for each line:

```json
{
  "original_name": "Pivo Heineken 0.5l",
  "semantic_essence_ru": "Пиво",
  "brand_tokens": ["Heineken", "Хайнекен"],
  "brand_scan_complete": true
}
```

Include every explicitly visible brand and any known Cyrillic transliteration
in `brand_tokens`. Set `brand_scan_complete=true` only after inspecting the
original line for brands, manufacturers, product lines, models, and marketing
names. An empty array means the scan positively found none; it is not a default.
Brand discovery is a semantic agent responsibility because no finite local
validator can recognize every brand. If the scan is unavailable or uncertain,
stop with `action_required`. Then run:

```bash
python3 scripts/operation_item_name.py compose item-name-input.json
```

Only `safe=true` yields an `operation_item`. The helper mechanically validates
the asserted brand review, Russian form, numbers, percentages, common written
number words, measurements, and declared brand tokens; it does not discover
brands. A validation error is `action_required`; do not bypass the helper by
writing the unvalidated name. The helper is stateless and never calls Money
Flow.
