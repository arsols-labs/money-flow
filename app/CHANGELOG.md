# Changelog

All notable changes to the Money Flow app are documented here.

## 2.38.5 - 2026-11-12

### Changed

- Analytics labels for individual local shops use synthetic names. Global brands and large regional chains are unchanged.
- The statement template schema id is `https://www.money-flow.arsols.com/schemas/statement-template/v1`.
- The app package version is 2.38.5.

### Fixed

- Analytics → Receipts shows the same dated manual receipt groups as Data. A grouped receipt is not also a loose card. There is no Group button, and analytics totals and charts stay as they were.
- On Data, the Group control stays visible under the measured filter bar while the receipts section is expanded. The name, selected count, confirm, and cancel stay with that bar. The bar leaves when the receipts section scrolls away.
- A receipt group row matches a receipt row: date, title, amount, and expand control. Under the title is a group icon and the localized words “Receipt group”.
- An expanded group can rename its title from a pencil next to the title. A typed name is kept. Clearing a custom name falls back to the resolved place, or the save is refused when that place cannot be resolved. Membership, date, amounts, balances, and analytics totals stay unchanged. `PATCH /api/v2/receipt-groups/:id` is the update route. MCP `receipt_group_rename` still asks for confirmation and refuses `auto_confirm`. Migration `0027_receipt_group_rename.sql` records the rename idempotency row.
- Manual receipt groups in Data → Receipts sit in the single date-sorted receipt list alongside ordinary receipts instead of being pinned above the list, and every group card carries a calendar date.
- Creating a manual group requires two or more distinct receipts from the same calendar date (`RECEIPT_GROUP_DATE_MISMATCH` refuses mixed dates without saving). Existing groups whose receipts already span dates are preserved and sorted on their latest member date.
- A manual group card is titled with the user's explicit name or the place where the goods were bought (restaurant kitchen and bar receipts resolve to the restaurant; a seller receipt plus a Wolt/delivery receipt resolves to the seller). When the place cannot be determined, `RECEIPT_GROUP_PLACE_REQUIRED` asks for a name instead of guessing or inventing a placeholder title.

## 2.38.0 - 2026-11-08

### Added

- Data → Receipts can group two or more receipts into one collapsible manual group. The optional name defaults to “Receipt group #N”. Exclude removes one receipt. The group stays when one receipt remains and is deleted when the last receipt is removed. Delete group removes the links only. Operations, balances, analytics, and duplicate checks stay unchanged. Migration `0026_receipt_groups.sql` is additive.
- A receipt without a PFR can be a group member through `operations.receipt_identity_token`. The token is nullable metadata, minted when a receipt is listed for grouping, unique while set, and deleted with its operation row. Existing rows are not backfilled. A reused operation id does not keep the old token.
- Manual groups and provider-order PFR links share one membership claim, so one receipt cannot be in both. Create is one atomic batch with an idempotency key kept until reset or backup replace. Conflicts return `RECEIPT_ALREADY_GROUPED`, `STALE_RECEIPT`, or `IDEMPOTENCY_CONFLICT`.
- MCP: `receipt_groups_list`, `receipt_group_get`, `receipt_group_create`, `receipt_group_receipt_unlink`, `receipt_group_delete`. Create may use `auto_confirm`. Unlink and delete refuse it.

## 2.37.0 - 2026-11-07

### Added

- MCP can list, search, and page purchase orders, read one order with its receipts and reconciliation, edit order metadata, edit a component role or PFR link, add an existing receipt, unlink it, and delete the group. Unlink and delete leave fiscal documents, operations, balances, and analytics unchanged. A shared date does not create a group.

## 2.36.0 - 2026-11-07

### Added

- Data → Receipts can group fiscal documents into one purchase order. The key is an explicit provider slug plus provider order id. Links are canonical PFR only (NFKC, whitespace, case). An optional declared total is compared with posted spend net of refunds. Expected components are display-only. Conflict is a separate flag and does not replace status. Migration `0025_purchase_orders.sql` is additive and has no foreign key into existing tables.
- Operation-id links are unsupported (`OPERATION_LINK_UNSUPPORTED`). Operation ids are reusable, and a date/account/kind/amount/currency fingerprint does not identify a row after the newest operation is deleted on a rolled-back Worker.
- Full backup stays the default. `GET /api/v2/backup/export?compat=v2.35` is an explicit older-version file that omits order groupings, warns, and reports the omitted counts. Restoring a file with no groupings asks before it removes existing ones. `purchase_orders_epoch` is reserved: `PUT /settings` and MCP `setting_set` cannot change it.
- MCP: `purchase_orders_list`, `purchase_order_upsert`, `purchase_order_component_link`, `purchase_order_component_unlink`, `purchase_order_delete`. Writes confirm by default. Unlink and delete refuse `auto_confirm`. `purchase_order_component_reconfirm` returns the unsupported operation-link error.

### Fixed

- A full or v2.35-compatible backup export still succeeds when `purchase_orders_epoch` is missing. The stored component epochs are exported and imported unchanged, so those links stay unresolved.
- A repeated link or a cross-order conflict does not create `purchase_orders_epoch`.
- `purchase_orders_epoch` is omitted from every settings response. The full backup still contains it when order rows need it.
- A conflicting receipt is shown once, in the normal receipts list. The order card keeps the conflict reason. Income or transfers on that conflict are listed as not counted and are not added to the posted total.

## 2.35.1 - 2026-11-07

### Fixed

- Analytics merchant labels match a rule needle only on Unicode letter and digit boundaries. A store name such as `GUBERNIJA` is no longer labeled Uber. Multi-word needles, dotted names such as `DR.MAX`, and non-ASCII needles such as a Cyrillic post-office name still match. Fiscal receipt grouping, the manual group key, and the unmatched-name truncation are unchanged.

## 2.35.0 - 2026-11-06

### Added

- Text-layer PDF statement import in the Worker. A pure-JS PDF.js build (`unpdf`) reads glyph positions. No OCR, no native modules, no model. Known layouts are BPS RSD `IZVOD`, BPS FX `PROMENE U PERIODU` (USD and EUR), and Bank of America Adv SafeBalance. Built-in templates `rs-bps-pdf` and `us-bofa-pdf` select those layouts. Auto, the Data screen, inline MCP, and the upload PUT detect `%PDF` bytes or a `.pdf` name before CSV.
- A missing text layer is `PDF_NO_TEXT_LAYER`, an unrecognized layout is `PDF_UNKNOWN_LAYOUT`, and an encrypted file is `PDF_ENCRYPTED`. The whole request fails and no batch is written. Where the statement prints a closing balance, a mismatch with opening plus the rows is a preview warning.

### Fixed

- BPS RSD `IZVOD` text drawn column-by-column, with no space between cells, is split on horizontal gaps before the row is read. Credit and debit still come from the `Potražuje` and `Duguje` columns, and `Prethodno stanje` / `Novo stanje` still check the closing balance.

## 2.34.1 - 2026-11-06

### Fixed

- `operation_add` no longer rejects a separate delivery fee as `DUPLICATE_EXPENSE` only because its comment shares a delivery order id with an already booked seller receipt. The fee is stored only when both sides have a fiscal id, explicit or parsed from a PURS verification URL, and those ids differ. An opaque `vl` or any other URL difference does not bypass the order-id guard. Equal normalized verification URLs are still one document. The same fiscal-receipt line, and the same date + account + store + amount, are still duplicates. Retrying the same idempotency key still returns the original operation. `auto_confirm` does not skip the check.

## 2.34.0 - 2026-11-04

### Added

- MCP statement templates: `template_list`, `template_get`, `template_create`, `template_update`, and `template_delete`. Built-in BPS and Bank of America templates stay read-only. `template_create` accepts `auto_confirm`. `template_update` accepts it only when the same MCP client created the template and no import batch has used it (`created_via`, `created_by_client_id`, `used_batch_id` on migration `0024`, including the demo ledger). `template_delete` always needs a human confirmation.
- MCP statement import: `statement_import_preview`, `statement_import_commit`, `statement_import_undo`, and `statement_import_upload_create`. Preview uses the shared parser and returns the detected template, account mapping, rows, duplicates, totals, and a confirm token. An empty parse is an error. Commit accepts `auto_confirm`, skips duplicates, and returns `added`, `skipped_duplicates`, `batch_id`, and `#/data/import`. Undo always needs confirmation and removes the whole batch.
- One-time statement upload: `PUT /api/v2/statement-imports/uploads/:token`. The token lasts 10 minutes and accepts one raw PUT. Inline MCP content, that PUT, and the Data screen share one raw-byte cap, `STATEMENT_IMPORT_MAX_FILE_BYTES` (1048576 bytes, 1 MiB). The row cap is `STATEMENT_IMPORT_MAX_ROWS` (2000). Base64 overhead is allowed in the JSON call and is not a higher file cap. Bytes stay in D1 until use or a later lazy delete. A 2000-row commit is one D1 batch of 5-row insert chunks.
- Example skill `skills/money-flow-bank-statement-import` for those tools. `template_delete` and `statement_import_undo` are in the set of tools that refuse `auto_confirm`.

## 2.33.0 - 2026-11-04

### Added

- Statement templates are data. Each known bank is one JSON file under `app/src/shared/statement-import/templates/`, checked by a shared JSON Schema (`schemaVersion` 1, `additionalProperties: false`). Built-in BPS (Excel, English and Serbian headers, credit/debit columns, per-row currency) and Bank of America (CSV) presets moved out of the preset module into those files. The schema also names CSV, XLS, OFX, and text-layer PDF layouts. PDF parsing is not implemented yet.
- User templates are stored in the signed-in user's D1 (`statement_templates`, migration `0023`) and in the demo Durable Object ledger. Backup export is version 2 and includes them. A version 1 backup that has no template table still imports.
- Data → Statement import lists built-in and user templates. A user template can be chosen in the preset picker. A manual column mapping can be saved as a template. User templates can be renamed, deleted (with confirmation), exported to a `.json` file, and imported back. Built-in templates stay read-only; Duplicate copies one into the user's templates. The same schema validator reports file errors. Strings are in en, ru, sr, de, es, fr, and pt.
- `GET/POST /api/v2/statement-templates` and `GET/PATCH/DELETE /api/v2/statement-templates/:id`. Writes are schema-checked. Built-in ids cannot be changed.

### Changed

- The user-visible application title is Money Flow: the document title, the PWA manifest `name` and `short_name`, the sign-in eyebrow, and the backup-file error text. Worker, D1, package, and URL names are unchanged.
- Statement import accepts 2000 rows in one batch. A CSV template or generic mapping with no currency uses the target account selected for the preview, and says so on the row (`Currency: USD (from account)`). It is an error only when that account is missing too. Generic CSV dates such as `04/23/2026` are read as MM/DD/YYYY when the selected format does not fit.

### Fixed

- A user-template commit no longer looks stuck when the browser drops the response: the same idempotency key is sent once more, and a unique idempotency key that lost the race returns the batch already saved. Preview is not called again from commit.

## 2.32.0 - 2026-10-29

### Added

- Statement import on the Data screen, above Backup, collapsed until opened. Upload several CSV, OFX/QFX, CAMT.053 XML, or Excel 97 `.xls` files; pick auto, `us-bofa`, `rs-bps`, or a generic CSV column mapping; preview matched accounts, currency warnings, duplicates, and categories; confirm one batch with a client idempotency key. Import history can undo a batch after the phrase `UNDO IMPORT`. The category-rules editor (list, create, edit, delete, priority) is in the same section. Every user-visible string is in en, ru, sr, de, es, fr, and pt.

### Fixed

- Statement import headings, file names, and preview date/description cells use the theme text color in light and dark. Category fields are themed inputs that accept a new name. An existing duplicate expense stays unchecked, is warned before commit, and a `DUPLICATE_EXPENSE` failure names that row.
- Re-uploading a statement flags every row as a duplicate even when the preview has not matched an account yet. Import and undo dialogs stay open on the result until OK, a click outside, or Escape. Batch details list the file, preset, account, date range, currency totals, and operations. File counts use plural forms.
- BPS `.xls` statements match English or Serbian headers wherever the header row sits, including per-row currency. Imports of more than five rows no longer fail with a false balance-range error: D1 allows only five `SELECT`s in one `UNION ALL`. A successful import keeps the Data screen mounted, so the result dialog stays open and the section stays expanded. Duplicate rows name the earlier batch, and the preview counts new rows and duplicates.

## 2.31.1 - 2026-10-29

### Fixed

- A production deploy applies database migrations before the new Worker goes live. If migrations fail, the new Worker is not deployed. Migrations stay additive, forward-only, and compatible with the Worker version still serving traffic.

## 2.31.0 - 2026-10-29

### Added

- Bulk bank statement import for the worker API. Parsers cover CSV (generic column mapping), OFX/QFX, CAMT.053, and legacy Excel 97 `.xls`. Presets `us-bofa` and `rs-bps` are data in a preset list. `POST /api/v2/statement-imports/preview` is read-only. `POST /api/v2/statement-imports` writes one batch, stores `import_batch_id` on operations, and is idempotent. `POST /api/v2/statement-imports/:id/undo` requires `confirm: true` and the phrase `UNDO IMPORT`, then deletes the batch and restores balances. Category mode is `manual` or `rules` (`category_rules`). Limits: 1 MiB body, 256 KiB per file, 8 files, 500 rows.
- Excel `.xls` reading uses SheetJS `0.20.3` from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (not the npm `xlsx@0.18.5` package). The reader is loaded only when a workbook is parsed.

## 2.30.4 - 2026-10-29

### Fixed

- MCP `auto_confirm` is refused for every delete tool and for `data_reset`, with the same English error as the tools that already refused it. The tools that refuse `auto_confirm` are exactly `account_delete`, `account_alias_delete`, `transfer_delete`, `backup_import`, `operation_delete`, `planned_item_delete`, `recurring_item_delete`, `fx_rate_delete`, `data_reset`, and `setting_set` when the key is `base_currency`. `fx_rate_set` still accepts `auto_confirm` and still defaults it to true.

## 2.30.2 - 2026-10-29

### Changed

- Document the existing MCP `fx_rate_set` behavior. An authenticated client writes immediately by default, and MRTR confirmation runs only when `auto_confirm: false` is passed. The tool description matches that. Behavior is unchanged.
- Name the tools that refuse `auto_confirm`: `account_delete`, `account_alias_delete`, `transfer_delete`, `backup_import`, and `setting_set` when the key is `base_currency`. `operation_delete`, `planned_item_delete`, `recurring_item_delete`, `fx_rate_delete`, and `data_reset` accept `auto_confirm`.

## 2.30.1 - 2026-10-29

### Fixed

- The README MCP tool list now names every registered read tool and includes `backup_import` among the tools that refuse `auto_confirm`.

## 2.30.0 - 2026-10-29

### Added

- MCP settings tools: `settings_get` and `setting_set`. `setting_set` accepts every key the settings API accepts (`base_currency`, `low_balance_threshold_minor`) and its preview shows the old and new value. A base-currency change shows an explicit warning that all conversions and reports will be recalculated, and `auto_confirm` is refused for that key.
- MCP backup tools: `backup_export` returns the full backup JSON up to 512 KiB and a table and row count summary above that, with a pointer to the app export. `backup_import` offers a dry run that validates and counts without writing, then needs the `IMPORT` phrase and a human confirmation. `auto_confirm` is refused. MCP imports are limited by the 64 KiB MCP request body; larger backups are imported in the app.

## 2.29.0 - 2026-10-29

### Added

- MCP transfer tools: `transfer_update` (atomic update of both legs through the existing transfer handler) and `transfer_delete` (explicit deletion of a whole transfer). `transfer_delete` always needs a human confirmation (`auto_confirm` is refused), and its preview lists both legs with accounts, amounts, currencies and dates.

### Changed

- The MCP `operation_delete` preview for a transfer leg now warns that the whole transfer (both legs) will be deleted and points to `transfer_delete`. Behaviour is unchanged.

### Fixed

- Editing a transfer without sending a date now keeps the existing transfer date instead of failing with an invalid-date error.

## 2.28.0 - 2026-10-29

### Added

- MCP account management and alias tools: `account_add`, `account_update`, `account_delete`, `account_alias_add`, `account_alias_delete`, `pending_account_bind` (writes) and `account_aliases_list`, `account_resolve`, `pending_accounts_list` (reads). They reuse the existing `/api/v2` handlers, MRTR confirmation, idempotency keys and the MCP audit log.
- `account_delete` and `account_alias_delete` always need a human confirmation (`auto_confirm` is refused), and their preview lists exactly what is removed. An account still used by operations, planned items or recurring rules cannot be deleted.

## 2.27.4 - 2026-10-28

### Changed

- Internal maintenance: test configuration, skill documentation, test identifiers, and early database migration comments are now in English with neutral wording. Database schema and app behavior are unchanged.

## 2.27.3 - 2026-10-28

### Changed

- Branch previews now use Cloudflare Workers Previews: each branch gets its own reachable preview URL with isolated demo-session storage. Production is unchanged.

## 2.27.2 - 2026-10-28

### Changed

- Internal maintenance: the remaining source, test, and database migration comments use neutral wording, and security test files have descriptive names. Database schema and app behavior are unchanged.

## 2.27.1 - 2026-10-28

### Changed

- Internal maintenance: source comments and test names use neutral wording, and the release tooling now checks that private-only files never reach a public copy of the repository. No user-visible behavior changes.

## 2.27.0 - 2026-10-28

### Added

- MCP widgets (Pulse, Analytics and the write confirmation) are localized in all seven supported languages and follow the language of the MCP host, falling back to the browser language and then English. Numbers and currencies are formatted for that language.

### Changed

- MCP tool descriptions, tool error messages, confirmation prompts and server-side errors are now in English. Surfaces without a language choice default to English.
- Default names for transfer operations created without an item are now English (`Transfer to "…"` / `Transfer from "…"`). Existing operations are not changed.

## 2.26.5 - 2026-10-28

### Changed

- Source comments and changelog wording cleaned up to English. No user-visible behavior changes.

## 2.26.4 - 2026-10-28

### Changed

- The OAuth consent page is now localized.
- The OAuth provider library was updated. When a client refreshes a token for a resource the server no longer serves, it now gets `invalid_grant` and must re-authorize, instead of `invalid_target`.
- Routine dependency updates for the app and its build tooling.

### Fixed

- OAuth grants are now recorded with an id derived from the authorization code, so each authorization is tracked reliably.

### Security

- Patched versions of `undici` and `zod` are now enforced in the build and test tooling, fixing known vulnerabilities in those packages.

## Known Limitations

- Consent CSRF tokens are stored in eventually consistent KV; a rare concurrent double-submit may fail and require retrying authorization.
- Clients may register private-use URI scheme redirect URIs (native app callbacks) alongside https or loopback ones, but authorization requests that use a private-use scheme redirect URI are rejected; use https or loopback redirect URIs.
