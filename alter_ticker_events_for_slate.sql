-- Phase 2 of slate-driven indexes: let a ticker_event exist without a Tank behind it.
--
-- Until now every event was structurally a Tank fact - ticker_events.tank_id and
-- .ticker_tag_id are both NOT NULL FKs, and every read query JOINs tank_pages. That was
-- correct when an index only moved because we published something. It stops being
-- correct once the totality of a category's results is the main driver: most games have
-- no article behind them.
--
-- After this migration an index has two legs, and `source` says which one an event is:
--   'tank'  - the news leg. A published Tank's 3-day implied-probability move, exactly
--             as before, like news repricing a stock. Still carries tank_id/ticker_tag_id.
--   'slate' - the results leg. One 'close' event per index per day, aggregating that
--             day's settled index_positions. No Tank, so both FK columns are NULL.
--
-- Nothing is rewritten: existing rows are all 'tank' by default, keep their FKs, and
-- keep contributing exactly what they contribute today (values continue, no rebase).
--
-- Run alongside seed_ticker_config_v3.sql, and BEFORE deploying the code that writes
-- closes. Safe under the current code: it only widens constraints and adds columns.
-- Execute: psql "$DATABASE_URL" -f alter_ticker_events_for_slate.sql

BEGIN;

-- 1. A slate event has no Tank. Widening these two is the whole migration.
ALTER TABLE ticker_events ALTER COLUMN tank_id DROP NOT NULL;
ALTER TABLE ticker_events ALTER COLUMN ticker_tag_id DROP NOT NULL;

-- 2. Which leg produced this event. Defaulted so every existing row reads 'tank'.
ALTER TABLE ticker_events ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'tank';
ALTER TABLE ticker_events DROP CONSTRAINT IF EXISTS ticker_events_source_check;
ALTER TABLE ticker_events ADD CONSTRAINT ticker_events_source_check
    CHECK (source IN ('tank', 'slate'));

-- 3. The day a slate close covers. NULL for tank events.
ALTER TABLE ticker_events ADD COLUMN IF NOT EXISTS close_date DATE;

-- 4. 'close' joins 'tag' and 'settle' as an event type.
ALTER TABLE ticker_events DROP CONSTRAINT IF EXISTS ticker_events_event_type_check;
ALTER TABLE ticker_events ADD CONSTRAINT ticker_events_event_type_check
    CHECK (event_type IN ('tag', 'settle', 'close'));

-- 5. Shape invariants, so a malformed event can't be written by any future code path:
--    a tank event keeps both FKs; a slate event has neither and carries its close date.
ALTER TABLE ticker_events DROP CONSTRAINT IF EXISTS ticker_events_source_shape_check;
ALTER TABLE ticker_events ADD CONSTRAINT ticker_events_source_shape_check CHECK (
    (source = 'tank'  AND tank_id IS NOT NULL AND ticker_tag_id IS NOT NULL)
 OR (source = 'slate' AND tank_id IS NULL     AND ticker_tag_id IS NULL AND close_date IS NOT NULL)
);

-- 6. Close idempotency. The Tank side gets this from UNIQUE (ticker_tag_id, event_type)
--    plus the calculated_at CTE guard; a slate close has no tag row to guard on, so the
--    natural key (index, day) is the guarantee that re-running settlement in the same
--    day can never write a second close.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticker_events_slate_close
    ON ticker_events(ticker_key, close_date) WHERE source = 'slate';

COMMIT;
