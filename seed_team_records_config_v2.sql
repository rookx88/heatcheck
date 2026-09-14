-- Team pages tunables, v2: the team ticker price. Same versioned-flip discipline as the
-- ticker config (insert inactive, deactivate v1, activate v2 - the one-active-per-key
-- index rejects a single-statement swap). Read at build time and by the acceptance suite.
--
--   min_games       Unchanged from v1 (5). Below it a club posts no residual AND no price,
--                   and its league tile stays grey.
--   price_baseline  100, like every index.
--   price_scale     20, ONE number shared by every club. Indexes carry per-ticker scales
--                   (20 to 115) because they aggregate slates of very different sizes; a
--                   club's day is almost always one game, so its daily close is ~+/-1.3
--                   everywhere and its measured daily sd is ~1.0 in every league (MLB 1.03,
--                   MLS 0.97, EPL 0.88, NFL 1.22 on 2026-09-13). The indexes' literal
--                   tuning rule (scale ~= sd / 0.12) gives 8, which priced the best club
--                   of the first fortnight at 196 - honest volatility that reads absurd
--                   beside indexes near 100. 20 is $MLBCHALK's scale: a win-day moves a
--                   club ~6-7% and that same club sits at 131. A deliberate call (Sammy,
--                   2026-09-13), provisional like every index scale; re-measure after a
--                   month of fixtures.
--
-- CHANGING price_scale RE-PRICES EVERY CLUB - display-only today, so it costs nothing
-- beyond the chart; if clubs ever become tradeable this note becomes v1's warning.
--
-- Execute: psql "$DATABASE_URL" -f seed_team_records_config_v2.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('team_records', 2, false, '{"min_games": 5, "price_baseline": 100, "price_scale": 20}')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'team_records' AND active AND version < 2;
UPDATE game_config SET active = true
WHERE key = 'team_records' AND version = 2
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'team_records' AND g.active);
