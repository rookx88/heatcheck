-- Two kinds of Tank. 'narrative' is the article Tank that has always existed; 'lines' is
-- the simplified matchup Tank: one page per game showing its canonical moneyline, spread
-- and total, each with a pick deck, no article and no ticker tag. A lines Tank is stored
-- as up to three tank_pages rows (one per market, because picks/settlement key on a row)
-- that share a page_slug and render as one page at /the-tank/lines/<page_slug>/.
--
-- Narrative wins at the line level: when an app narrative publishes on a market that a
-- lines row also covers, that row moves to status 'superseded' (superseded_by = the
-- narrative), which every public reader's status='published' predicate already excludes.
-- Existing picks on it still settle - settle.ts joins picks -> tank_pages without a status
-- filter. Unpublishing or deleting the narrative restores the row.
--
-- Apply BEFORE deploying code that reads these columns:
--   psql "$DATABASE_URL" -f add_kind_to_tank_pages.sql

ALTER TABLE tank_pages
    ADD COLUMN IF NOT EXISTS kind VARCHAR(20) NOT NULL DEFAULT 'narrative',
    ADD COLUMN IF NOT EXISTS page_slug VARCHAR(255),
    ADD COLUMN IF NOT EXISTS superseded_by UUID REFERENCES tank_pages(id) ON DELETE SET NULL;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tank_pages_kind_check') THEN
        ALTER TABLE tank_pages ADD CONSTRAINT tank_pages_kind_check CHECK (kind IN ('narrative', 'lines'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_tank_pages_kind_status ON tank_pages(kind, status);
CREATE INDEX IF NOT EXISTS idx_tank_pages_page_slug ON tank_pages(page_slug) WHERE page_slug IS NOT NULL;
