-- Adds Ember-ledger and settlement columns to the existing picks table. outcome_index +
-- implied_prob_at_lock are stamped at submission time from the frozen game_snapshot
-- (functions/api/picks.ts); result/settled_at are written once by settleCall()
-- (lib/pages-functions/ledger.ts), called from functions/api/settle.ts.
-- call_date defaults to CURRENT_DATE but is NOT enforced by any constraint yet — the
-- beta-launch daily-cap flip (unique(waitlist_id, call_date)) is a future one-line
-- migration once idx_picks_waitlist_id (one pick ever) is dropped. That flip is
-- deliberately NOT part of this migration.
-- Execute: psql "$DATABASE_URL" -f add_ember_columns_to_picks.sql

ALTER TABLE picks ADD COLUMN IF NOT EXISTS outcome_index SMALLINT;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS implied_prob_at_lock NUMERIC;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS call_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE picks ADD COLUMN IF NOT EXISTS result TEXT;              -- 'correct' | 'incorrect' | NULL (unsettled)
ALTER TABLE picks ADD COLUMN IF NOT EXISTS settled_at TIMESTAMPTZ;

-- Note: unlike the ADD COLUMN lines above, this isn't safely re-runnable (Postgres has
-- no ADD CONSTRAINT IF NOT EXISTS) — acceptable since this file is run once by hand,
-- matching this repo's existing manual-migration convention.
ALTER TABLE picks ADD CONSTRAINT picks_result_valid
    CHECK (result IS NULL OR result IN ('correct', 'incorrect'));

-- Speeds up the settle endpoint's "find unresolved picks" scan.
CREATE INDEX IF NOT EXISTS idx_picks_unsettled ON picks(id) WHERE result IS NULL;
