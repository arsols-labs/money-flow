-- File names and presets for an import batch, so history can show them
-- after the preview is gone. Nullable: batches written before this column
-- have no file list. Forward-only and additive.

ALTER TABLE import_batches ADD COLUMN files_json TEXT;
