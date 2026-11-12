---
name: money-flow-bank-statement-import
description: Import one bank statement into Money Flow v2 through MCP. Use when an authorized agent has a CSV, Excel 97 .xls, OFX/QFX, or text-layer PDF file and must preview it, book it, or undo the batch. Do not use for scans or photos.
---

# Money Flow bank statement import

Use this skill to import one statement file into Money Flow v2 through its MCP
server. The server parses the file. Do not reimplement CSV, Excel, or OFX
parsing in the client.

Synthetic examples are fine. Never paste a real customer's statement, account
number, or transaction text into chat, logs, or this repository.

## Preconditions

- The caller has an authorized Money Flow MCP client with both `read` and
  `write` scopes.
- The user has asked for this file to be imported, or has already authorized
  the run that invokes this skill.
- Inspect `tools/list` and use the server's current schemas.

Supported files are CSV, Excel 97 `.xls` / `.xlsx` workbooks the statement
parser accepts, OFX/QFX, and text-layer PDF for BPS (`rs-bps-pdf`) and Bank of
America (`us-bofa-pdf`). A file whose bytes start with `%PDF`, or whose name
ends in `.pdf`, is parsed as PDF on inline content, base64, and upload. A scan
returns `PDF_NO_TEXT_LAYER`. An unrecognized layout returns `PDF_UNKNOWN_LAYOUT`.
An encrypted file returns `PDF_ENCRYPTED`. Photos and scans are out of scope.

## Templates

1. Call `template_list`. Built-in templates (`us-bofa`, `us-bofa-pdf`, `rs-bps`, `rs-bps-pdf`) are
   read-only.
2. Call `template_get` when you need the document.
3. To change a built-in layout, call `template_create` with `copy_from` set
   to that id and a new `id`. Do not call `template_update` on a built-in id.
4. `template_create` accepts `auto_confirm: true` for an authenticated client.
5. `template_update` accepts `auto_confirm: true` only when this same MCP
   client created the template and no import batch has used it. Otherwise
   repeat the call with the returned `requestState`.
6. `template_delete` never accepts `auto_confirm`. Confirm with `requestState`.

A template document must pass the server's strict schema. The server rejects
an invalid document; do not guess missing fields.

## Send the file

Use one source per call. The raw file must be at most 1048576 bytes (1 MiB)
and the parsed statement at most 2000 rows. Those are the same caps as the
Data screen. Inline base64 and the upload PUT do not raise either number.
Base64 makes the JSON call larger; that overhead is allowed.

- `content` for UTF-8 CSV or OFX up to 1048576 bytes. A string that starts with `%PDF` is a PDF, not CSV.
- `content_base64` for the same 1048576 raw bytes when the file is not text, including PDF.
- `upload_id` when you would rather PUT the raw bytes than embed base64.
  The PUT is also limited to 1048576 bytes.

For `upload_id`:

1. Call `statement_import_upload_create` with the filename.
2. `PUT` the raw bytes to `upload_url` once, before `expires_at`. A second
   PUT is refused. The URL is the capability; do not log it.
3. Pass the returned `upload_id` to preview or commit. The server deletes
   the bytes when preview or commit uses them, and deletes expired rows on
   a later call. There is no separate cleanup job.

Do not split a file to get past 2000 rows or 1048576 bytes.

## Preview, then commit

1. Call `statement_import_preview` with the file, `account_id` when the user
   has already chosen the account, and an `idempotency_key` you will reuse.
2. A parser failure or a file with no rows is an error. `requestState` is
   absent. Stop and show the error. Do not invent rows.
3. On success, show the user the detected template, account mapping, row
   count, duplicate count, and totals. `written` is false. Nothing is booked.
4. If `committable` is false, the preview names the missing account or the
   currency mismatch. Ask the user. Do not commit.
5. Book only after the user agrees, unless the user already authorized
   `auto_confirm` for this run.
   - Agreed: call `statement_import_commit` with the same `idempotency_key`
     and the preview `requestState`.
   - Authorized unattended run: call `statement_import_commit` with the file
     (or `upload_id`) and `auto_confirm: true`. Duplicates are skipped.
6. Treat the commit as booked only when `resultType` is `complete`. Read
   `added`, `skipped_duplicates`, and `batch_id`. Tell the user the app path
   in `view_path` (`#/data/import`) and that the whole batch can be undone
   with `statement_import_undo`.

If the connection fails after a commit attempt, retry with the same
`idempotency_key`. Do not create a second key for the same file.

## Undo

`statement_import_undo` always needs a human confirmation. `auto_confirm` is
refused.

1. Call it with `batch_id`, `phrase` exactly `UNDO IMPORT`, and a fresh
   `idempotency_key`. The first response writes nothing.
2. Show the user what will be removed.
3. Repeat the call with the returned `requestState`.
4. The whole batch is undone. Balances move back with those operations.

Do not undo a batch the user has not identified.
