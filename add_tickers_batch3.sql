-- Exchange tickers, batch 3: league slices of $CHALK and $DOGS, plus the parent_key
-- column that makes "sub-index" a real relationship rather than a naming convention.
--
-- Each child measures exactly what its parent measures, for one league. Together the
-- four children of each parent cover every league the sync ingests (NBA, NFL, MLB and
-- the five soccer leagues), so a family partitions its parent - which is what lets the
-- board draw the children INSIDE the parent's tile and have that mean something.
--
--   $CHALK  <- $NBACHALK, $MLBCHALK, $GRIDIRON (NFL), $FOOTY (soccer)
--   $DOGS   <- $NBADOGS,  $MLBDOGS,  $NFLDOGS,        $SOCDOGS
--
-- $GRIDIRON and $FOOTY are NOT new and are NOT renamed: they already were the NFL and
-- soccer chalk ("the market-favored side of every NFL market"), so they simply take
-- their place under $CHALK. Adding $NFLCHALK/$SOCCHALK alongside them would have
-- double-counted the same games on the board and in the tape.
--
-- The parent keeps scoring every game directly - nothing here changes $CHALK's or
-- $DOGS's own math or history. The children are filtered views of the same positions.
--
-- Rule types parse through lib/pages-functions/league-rules.ts (<league>_favorite /
-- <league>_underdog), so no eligibility code needed a per-league branch. Children take
-- the market-favored / least-favored side, which is what nfl_favorite and
-- soccer_favorite already did.
--
-- DEPLOY ORDER: run AFTER the code that knows these rule types is live. Under older
-- code the rows are harmless (unknown rule_type -> every tag rejected, no slate
-- positions) but would show as dead 0-value tiles.
-- Execute: psql "$DATABASE_URL" -f add_tickers_batch3.sql

BEGIN;

-- Sub-index relationship. Self-referencing and nullable: a NULL parent means a
-- top-level index, which is every row that existed before this migration.
ALTER TABLE tickers ADD COLUMN IF NOT EXISTS parent_key TEXT REFERENCES tickers(key);
CREATE INDEX IF NOT EXISTS idx_tickers_parent ON tickers(parent_key) WHERE parent_key IS NOT NULL;

-- Fallback pcts symmetric 5/5 like their parents (odds-aware settle supersedes them
-- whenever a snapshot prob exists). tab_order continues after the batch-2 rows; the
-- boards nest by parent_key, so this only orders the tape and the API listing.
INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order, parent_key) VALUES
    ('nbachalk', '$NBACHALK', 'The NBA slice of the favorites.',                     'nba_favorite',    5, 5, true,  9, 'chalk'),
    ('mlbchalk', '$MLBCHALK', 'The baseball slice of the favorites.',                'mlb_favorite',    5, 5, true, 10, 'chalk'),
    ('nbadogs',  '$NBADOGS',  'The NBA slice of the underdogs.',                     'nba_underdog',    5, 5, true, 11, 'dogs'),
    ('mlbdogs',  '$MLBDOGS',  'The baseball slice of the underdogs.',                'mlb_underdog',    5, 5, true, 12, 'dogs'),
    ('nfldogs',  '$NFLDOGS',  'The NFL slice of the underdogs.',                     'nfl_underdog',    5, 5, true, 13, 'dogs'),
    ('socdogs',  '$SOCDOGS',  'The soccer slice of the underdogs, across the big five.', 'soccer_underdog', 5, 5, true, 14, 'dogs')
ON CONFLICT (key) DO NOTHING;

-- The two that were already the NFL and soccer chalk take their place in the family.
UPDATE tickers SET parent_key = 'chalk' WHERE key IN ('gridiron', 'footy') AND parent_key IS NULL;

COMMIT;
