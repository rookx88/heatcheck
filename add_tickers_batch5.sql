-- Exchange tickers, batch 5: $COVER/$CUSHION and $BOTHSCORE/$CLEANSHEET - the first
-- indexes that read a market type the Exchange has never scored.
--
--   $COVER      spread_favorite   the side laying the points
--   $CUSHION    spread_underdog   the side taking them
--   $BOTHSCORE  btts_yes          both teams find the net
--   $CLEANSHEET btts_no           at least one side is shut out
--
-- All four are TOP-LEVEL, not slices of anything. Every child shipped so far ($NBACHALK,
-- $NFLO, ...) is a filtered VIEW of its parent's positions - same market, same line, same
-- entry price, fewer leagues. These are not: they hold a different market on the same
-- game, so $COVER is not a subset of $CHALK and nesting it under one would be a lie the
-- board would then draw as a partition.
--
-- WHY THESE TWO, OUT OF THE ~100 MARKET TYPES ON THE FEED (measured 2026-09-13):
--   spreads             9 leagues, 793 open events, median liquidity 4,164 - the
--                       broadest unused type, and the only one spanning MLB + NFL +
--                       seven soccer leagues.
--   both_teams_to_score 7 leagues, 322 open events, median liquidity 13,256 - roughly 3x
--                       the liquidity of any other candidate, exactly one market per game
--                       (322 of 322), and a clean binary Yes/No with no line and no draw
--                       ambiguity. The cleanest index it is possible to build here.
-- Until this batch the slate read only 'moneyline' and 'totals'.
--
-- WHY SPREADS NEEDED A NEW SELECTION RULE (lib/pages-functions/index-slate.ts). A game
-- lists a whole spread ladder, quoted from BOTH teams' perspectives - one NFL game
-- carried "Spread: 49ers (-8.5)" at [0.48, 0.52] AND "Spread: Dolphins (-8.5)" at
-- [0.19, 0.81]. The existing volume-first ranking cannot choose between them: spreads
-- carry volume on almost nothing (NULL or 0 on nearly every market in that game) while
-- liquidity is always populated, so the old MIN_SELECTION_VOLUME gate would have rejected
-- the market type entirely, on every game, forever. And the old "lowest line" tiebreak is
-- actively wrong here because market_line is ALWAYS negative (4398 of 4398 rows, -21.5 to
-- -0.5): it would systematically pick the most lopsided novelty rung on the ladder.
-- So spreads rank on distance from a coin flip - the true line is the one priced nearest
-- 50/50 - and that same sort is what discards the wrong-team mirror, since the mirror is
-- by construction far from even.
--
-- WHY THE SIDE IS STRUCTURAL, NOT PRICED. Because the canonical spread sits at ~50/50,
-- an argmax would flip which team $COVER held from game to game on noise, and the mirror
-- pair would stop mirroring. The question names the team laying the points and outcome 0
-- is always that team, so the side is read from the question instead. $COVER/$CUSHION and
-- $BOTHSCORE/$CLEANSHEET are each exact mirror pairs: opposite sides of ONE market.
--
-- NO NEWS LEG. These four take no Tank tags - checkEligibility refuses them explicitly.
-- A tag context carries no question, so the points-laying side of a spread is unknowable
-- there; and curate's whitelist (moneyline/spreads/totals) means no Tank ever holds a
-- BTTS market at all. They are pure slate indexes, scored only through index_positions.
--
-- NO RETRO PATH, AND THEY WILL START FLAT. scripts/retro-soccer-league-indexes.ts can
-- give the batch-6 league slices real history because their parents already locked those
-- exact markets. Nothing has ever locked a spread or a BTTS market, and
-- polymarket_props keeps no price history, so these four have no past that can be
-- recovered. They sit at exactly 100.00 until the first index-lock run after deploy
-- writes their first positions. That is expected on launch day, not a bug.
--
-- Prices are set by seed_ticker_prices_v3.sql, which must run with this file - the column
-- defaults are (100, 100) and a mirror pair MUST share (baseline, scale) or buying one
-- stops being a clean short of the other, which is why both pairs live in paired UPDATEs
-- there rather than here.
--
-- DEPLOY ORDER: run AFTER the code that knows these rule types is live. Under older code
-- marketTypeForRule returns null for them, so the rows are harmless (no tags, no slate
-- positions) but would show as dead 0-value tiles on the board.
-- Execute: psql "$DATABASE_URL" -f add_tickers_batch5.sql
--       then psql "$DATABASE_URL" -f seed_ticker_prices_v3.sql

BEGIN;

-- Fallback pcts symmetric 5/5 like the other broad indexes (the odds-aware settle
-- supersedes them whenever a snapshot prob exists). tab_order continues after batch 4;
-- the boards nest by parent_key, so this only orders the tape and the API listing.
INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order, parent_key) VALUES
    ('cover',      '$COVER',      'The favorite laying the points on every spread.',   'spread_favorite', 5, 5, true, 17, NULL),
    ('cushion',    '$CUSHION',    'The underdog taking the points on every spread.',   'spread_underdog', 5, 5, true, 18, NULL),
    ('bothscore',  '$BOTHSCORE',  'Both teams finding the net, across the soccer board.', 'btts_yes',     5, 5, true, 19, NULL),
    ('cleansheet', '$CLEANSHEET', 'At least one side shut out, across the soccer board.', 'btts_no',      5, 5, true, 20, NULL)
ON CONFLICT (key) DO NOTHING;

COMMIT;
