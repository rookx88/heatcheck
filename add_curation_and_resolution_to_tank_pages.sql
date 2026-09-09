-- Curation v2 metadata + the settlement resolution callback (functions/api/curate.ts,
-- functions/api/curate-sport.ts, functions/api/tank-resolution-sweep.ts).
--
-- `curation` holds the evidence the v2 curator produced for this Tank: the trend claim,
-- the search result it came from, the independent verifier's verdicts, and any verified
-- stat. JSONB rather than typed columns on purpose - the shape is expected to churn as
-- the gates get tuned, and every added column here is a manual production step someone
-- has to remember (there is no migration runner in this repo).
--
-- `resolution` holds the Stage 3 callback: what was claimed vs. what actually happened,
-- written after the market settles. Also carries a terminal { status: 'abandoned' } for
-- markets that never resolve, so those rows leave the sweep's scan permanently.
--
-- resolution_attempts / resolution_checked_at are REAL columns, not keys inside
-- `resolution`: the sweep's hot query filters and orders on them, and incrementing a
-- counter inside JSONB is a read-modify-write that races across the preview/production
-- double-call worker-settle makes against this same database.
--
-- Every column is nullable (or defaulted) and every consumer treats NULL as "no data",
-- so this migration is safe to apply before the code that writes it, and reverting the
-- code leaves nothing broken.
-- Execute: psql "$DATABASE_URL" -f add_curation_and_resolution_to_tank_pages.sql

ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS curation JSONB;
ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution JSONB;
ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution_attempts INT NOT NULL DEFAULT 0;
ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS resolution_checked_at TIMESTAMP WITH TIME ZONE;

-- The resolution sweep's scan: published Tanks that haven't been resolved yet, fewest
-- attempts first so a never-resolving market can't hold the front of the queue forever
-- (the head-of-line failure documented for /api/index-settle in worker-curate/src/index.ts).
CREATE INDEX IF NOT EXISTS idx_tank_pages_resolution_pending
    ON tank_pages (resolution_attempts, published_at DESC)
    WHERE status = 'published' AND resolution IS NULL;
