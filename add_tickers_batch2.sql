-- Exchange tickers, batch 2: $OVERS / $UNDERS / $GRIDIRON / $FOOTY. Same display-layer
-- contract as create_ticker_tables.sql (run that file first; this one only INSERTs
-- rows). Each new ticker rides the existing two-event pipeline unchanged - a 'tag'
-- event at publish/sweep time (3-day implied-probability movement of the tagged side)
-- and a 'settle' event when the market resolves (odds-aware +(1-p)/-p payout). Only
-- eligibility differs, keyed on rule_type (checkEligibility in
-- lib/pages-functions/tickers.ts):
--   total_over / total_under - totals/team_totals markets only; the side whose outcome
--       label is Over/Under (Kalshi Yes/No totals: index 0 = Over by fixed convention).
--       On the same tank these two take opposite sides, so they move inversely off one
--       market - the dogs/chalk pattern.
--   nfl_favorite / soccer_favorite - league-scoped (NFL; EPL + La Liga + Serie A +
--       Bundesliga + Ligue 1); the market-favored side (argmax snapshot probability,
--       ties to the lowest index so exactly one side per market qualifies - also what
--       makes 3-way soccer moneylines work, where no side may reach 0.5).
-- League sets and totals membership are definitional (module consts), not tunables -
-- no game_config change ships with this batch.
--
-- DEPLOY ORDER: run AFTER the code that knows these rule_types is live. Under older
-- code the rows are harmless (unknown rule_type -> every tag rejected) but would show
-- as dead 0-value tickers on the homepage.
-- Execute: psql "$DATABASE_URL" -f add_tickers_batch2.sql

-- Fallback magnitudes only (odds-aware settle supersedes them whenever the snapshot
-- prob exists). Symmetric 5/5 across the batch: favorites and totals sides live in the
-- broad middle of the probability range, the same profile as dogs/chalk.
INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order) VALUES
    ('overs',    '$OVERS',    'Totals storylines - the Over side of every total.',                                          'total_over',      5, 5, true, 5),
    ('unders',   '$UNDERS',   'Totals storylines - the Under side of every total.',                                         'total_under',     5, 5, true, 6),
    ('gridiron', '$GRIDIRON', 'NFL storylines - the market-favored side of every NFL market.',                              'nfl_favorite',    5, 5, true, 7),
    ('footy',    '$FOOTY',    'Soccer storylines - the market-favored side across EPL, La Liga, Serie A, Bundesliga, Ligue 1.', 'soccer_favorite', 5, 5, true, 8)
ON CONFLICT (key) DO NOTHING;
