-- Exchange tickers, batch 4: $NFLO and $NFLU - the NFL slices of $OVERS and $UNDERS.
--
--   $OVERS  <- $NFLO
--   $UNDERS <- $NFLU
--
-- The first children the totals pair has had. Every child before them ($NBACHALK,
-- $NFLDOGS, ...) was a slice of $CHALK or $DOGS and therefore read a moneyline; these
-- read the same canonical totals market their parents do, filtered to NFL.
--
-- WHY THE FAMILY IS PARTIAL, AND WHY THAT IS FINE. The chalk and dogs families cover
-- every league the sync ingests, so each partitions its parent exactly. This one covers
-- NFL only: $OVERS keeps scoring all thirteen leagues, and $NFLO claims one of them. The
-- board nests a child inside its parent's tile, which still reads correctly - the tile
-- just isn't fully subdivided. Do NOT read the header of add_tickers_batch3.sql as
-- requiring completeness here; adding MLBO/MLBU etc. later is additive and needs no
-- change to anything shipped with this batch.
--
-- Rule types parse through lib/pages-functions/league-rules.ts, whose grammar was widened
-- for this batch: parseLeagueRule now splits on the FIRST underscore and accepts the two
-- totals sides, so 'nfl_total_over' is group 'nfl' + side 'total_over'. The side strings
-- deliberately match the GLOBAL rule_types of the same meaning, which is what lets
-- ticker-copy.ts's READ_CLAUSES serve parent and child from one table.
--
-- Prices are set by seed_ticker_prices_v2.sql, which must run with this file - the
-- column defaults are (100, 100) and this pair wants scale 65, matching the other NFL
-- indexes. A mirror pair MUST share (baseline, scale) or buying one stops being a clean
-- short of the other; that is why the two live in one paired UPDATE there rather than
-- here.
--
-- DEPLOY ORDER: run AFTER the code that knows these rule types is live. Under older code
-- parseLeagueRule returns null for them, so the rows are harmless (every tag rejected, no
-- slate positions) but would show as dead 0-value tiles on the board.
-- Execute: psql "$DATABASE_URL" -f add_tickers_batch4.sql
--       then psql "$DATABASE_URL" -f seed_ticker_prices_v2.sql
--       then npx tsx scripts/retro-nfl-totals-indexes.ts --dry-run

BEGIN;

-- Fallback pcts symmetric 5/5 like their parents (the odds-aware settle supersedes them
-- whenever a snapshot prob exists). tab_order continues after the batch-3 rows; the
-- boards nest by parent_key, so this only orders the tape and the API listing.
INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order, parent_key) VALUES
    ('nflo', '$NFLO', 'The NFL slice of the overs.',  'nfl_total_over',  5, 5, true, 15, 'overs'),
    ('nflu', '$NFLU', 'The NFL slice of the unders.', 'nfl_total_under', 5, 5, true, 16, 'unders')
ON CONFLICT (key) DO NOTHING;

COMMIT;
