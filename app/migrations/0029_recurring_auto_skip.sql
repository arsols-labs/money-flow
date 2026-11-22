-- Optional auto-skip of overdue occurrences for variable/non-mandatory recurring rules.
-- Additive and forward-only: existing rules default to opt-in OFF (auto_skip_overdue = 0)
-- with an intuitive 1-day overdue delay (auto_skip_after_days = 1).
ALTER TABLE recurring_items ADD COLUMN auto_skip_overdue INTEGER NOT NULL DEFAULT 0
  CHECK (auto_skip_overdue IN (0, 1));
ALTER TABLE recurring_items ADD COLUMN auto_skip_after_days INTEGER NOT NULL DEFAULT 1
  CHECK (auto_skip_after_days BETWEEN 1 AND 365);
