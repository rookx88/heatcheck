-- Exchange tickers, batch 6: the per-league soccer slices - the Exchange's FIRST THREE-
-- LEVEL indexes.
--
--   $CHALK <- $FOOTY   <- $EPLCHALK, $LALIGACHALK, $BUNDESCHALK, $LIGUE1CHALK,
--                         $MLSCHALK, $EFLCHALK   (+3 dormant)
--   $DOGS  <- $SOCDOGS <- $EPLDOGS,  $LALIGADOGS,  $BUNDESDOGS,  $LIGUE1DOGS,
--                         $MLSDOGS,  $EFLDOGS     (+3 dormant)
--
-- $FOOTY and $SOCDOGS are UNCHANGED. They keep scoring all ten soccer competitions, keep
-- their own history, and keep their place under $CHALK/$DOGS. The new rows are filtered
-- views of them, exactly as level 2 is a filtered view of level 1: because
-- positionsForGame memoizes ONE canonical market per market type per game, $EPLCHALK
-- holds the identical market, line and entry price $FOOTY holds on that game. That is
-- what makes a third level mean something rather than just being smaller tiles.
--
-- WHY THE FAMILY IS PARTIAL. Six of the ten soccer competitions get a slice. This follows
-- add_tickers_batch4.sql's precedent verbatim ("do NOT read the header of
-- add_tickers_batch3.sql as requiring completeness here") - a parent keeps scoring
-- everything, and a child claims part of it. The level-1 -> level-2 partition
-- (nba + nfl + mlb + soccer = the thirteen leagues in league-tags.ts) is untouched and
-- still exact.
--
-- WHY THREE PAIRS SHIP DORMANT (active = false). Measured 2026-09-13, upcoming
-- moneyline/totals games per day over the next fortnight:
--     MLS 4.71   La Liga 2.86   EFL Championship 2.00   EPL 1.57
--     Bundesliga 1.29   Ligue 1 1.29
--     Champions League 0   Carabao Cup 0 (in-window)   DFB-Pokal 0
-- getActiveTickers and getTickerValues both filter WHERE active, so a dormant row locks
-- nothing, draws nothing and is absent from /api/tickers - but switching it on is one
-- line with no code deploy, no migration review and no price decision (its scale is
-- seeded now, in seed_ticker_prices_v4.sql, while nothing holds it):
--     UPDATE tickers SET active = true WHERE key IN ('uclchalk', 'ucldogs');
-- The Champions League league phase opens ~2026-09-16, and Polymarket posts UCL fixtures
-- only for the imminent matchday, so that pair is expected to be switched on within days.
-- The two domestic cups run in bursts and will come and go.
--
-- WHY SERIE A GETS NO ROW AT ALL. It is the one soccer competition in league-tags.ts with
-- NO evidence Polymarket carries its fixtures: zero typed game markets EVER, zero
-- moneylines ever, zero rows carrying event_start_time - only season-long futures (Top
-- Goalscorer, 2027 Champion, relegation). A $SERIEACHALK would be a permanently dead
-- 0-value tile, which is worse than an absence. Serie A deliberately STAYS in
-- LEAGUE_GROUPS.soccer, so $FOOTY would score it the moment a fixture appeared; what it
-- does not get is a ticker of its own. Revisit if a typed Serie A moneyline ever lands.
--
-- Rule types parse through lib/pages-functions/league-rules.ts, which gained nine
-- single-token leaf group keys for this batch. No key may contain an underscore
-- (parseLeagueRule splits on the first one), which is why 'La Liga' is spelled 'laliga'
-- and 'Ligue 1' is 'ligue1' - ticker-copy.ts's WORD_OVERRIDES spells them back out for
-- readers.
--
-- Prices are set by seed_ticker_prices_v4.sql, which must run with this file - the column
-- defaults are (100, 100) and these want 65. A mirror pair MUST share (baseline, scale).
--
-- DEPLOY ORDER: run AFTER the code that knows these rule types is live, and run
-- scripts/retro-soccer-league-indexes.ts after BOTH - it back-fills each slice's history
-- by COPYING the rows its parent already owns, so these launch with a real chart instead
-- of twelve flat lines.
-- Execute: psql "$DATABASE_URL" -f add_tickers_batch6.sql
--       then psql "$DATABASE_URL" -f seed_ticker_prices_v4.sql
--       then npx tsx scripts/retro-soccer-league-indexes.ts --dry-run

BEGIN;

INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order, parent_key) VALUES
    -- Live: the six competitions with fixtures on the board right now.
    ('mlschalk',    '$MLSCHALK',    'The MLS slice of the favorites.',              'mls_favorite',        5, 5, true, 21, 'footy'),
    ('mlsdogs',     '$MLSDOGS',     'The MLS slice of the underdogs.',              'mls_underdog',        5, 5, true, 22, 'socdogs'),
    ('laligachalk', '$LALIGACHALK', 'The La Liga slice of the favorites.',          'laliga_favorite',     5, 5, true, 23, 'footy'),
    ('laligadogs',  '$LALIGADOGS',  'The La Liga slice of the underdogs.',          'laliga_underdog',     5, 5, true, 24, 'socdogs'),
    ('eflchalk',    '$EFLCHALK',    'The EFL Championship slice of the favorites.', 'efl_favorite',        5, 5, true, 25, 'footy'),
    ('efldogs',     '$EFLDOGS',     'The EFL Championship slice of the underdogs.', 'efl_underdog',        5, 5, true, 26, 'socdogs'),
    ('eplchalk',    '$EPLCHALK',    'The Premier League slice of the favorites.',   'epl_favorite',        5, 5, true, 27, 'footy'),
    ('epldogs',     '$EPLDOGS',     'The Premier League slice of the underdogs.',   'epl_underdog',        5, 5, true, 28, 'socdogs'),
    ('bundeschalk', '$BUNDESCHALK', 'The Bundesliga slice of the favorites.',       'bundesliga_favorite', 5, 5, true, 29, 'footy'),
    ('bundesdogs',  '$BUNDESDOGS',  'The Bundesliga slice of the underdogs.',       'bundesliga_underdog', 5, 5, true, 30, 'socdogs'),
    ('ligue1chalk', '$LIGUE1CHALK', 'The Ligue 1 slice of the favorites.',          'ligue1_favorite',     5, 5, true, 31, 'footy'),
    ('ligue1dogs',  '$LIGUE1DOGS',  'The Ligue 1 slice of the underdogs.',          'ligue1_underdog',     5, 5, true, 32, 'socdogs'),
    -- Dormant: real competitions with no fixtures on the board today. See header.
    ('uclchalk',    '$UCLCHALK',    'The Champions League slice of the favorites.', 'ucl_favorite',        5, 5, false, 33, 'footy'),
    ('ucldogs',     '$UCLDOGS',     'The Champions League slice of the underdogs.', 'ucl_underdog',        5, 5, false, 34, 'socdogs'),
    ('carachalk',   '$CARACHALK',   'The Carabao Cup slice of the favorites.',      'carabao_favorite',    5, 5, false, 35, 'footy'),
    ('caradogs',    '$CARADOGS',    'The Carabao Cup slice of the underdogs.',      'carabao_underdog',    5, 5, false, 36, 'socdogs'),
    ('dfbchalk',    '$DFBCHALK',    'The DFB-Pokal slice of the favorites.',        'dfb_favorite',        5, 5, false, 37, 'footy'),
    ('dfbdogs',     '$DFBDOGS',     'The DFB-Pokal slice of the underdogs.',        'dfb_underdog',        5, 5, false, 38, 'socdogs')
ON CONFLICT (key) DO NOTHING;

COMMIT;
