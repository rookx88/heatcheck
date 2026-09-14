-- Team pages tunables, v1. Same versioned-row discipline as seed_ticker_config.sql: read
-- at build time (scripts/generate-static-site.ts), so retuning needs a rebuild, not a
-- redeploy of code.
--
--   min_games   Below this many settled DIRECTIONAL games (a moneyline side the slate
--               held on the club - see team-records.ts), a club's page lists its games
--               but posts no market residual, and its tile on the league board stays
--               grey. The residual is a sum of per-game surprises, and at n=3 it is one
--               game's surprise dressed as a team stat. 5 is the number team-records.ts
--               carries as DEFAULT_MIN_GAMES; the build falls back to that if this row
--               is absent, so a fresh environment renders rather than failing.
--
-- Measured 2026-09-13: every MLB club clears 5 (daily slate); no club in any weekly
-- league does yet. Retune to a v2 row (insert inactive, deactivate v1, activate v2 -
-- the one-active-per-key index rejects a single-statement swap) once the weekly
-- leagues have a month of fixtures.
--
-- Execute: psql "$DATABASE_URL" -f seed_team_records_config.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('team_records', 1, true, '{"min_games": 5}')
ON CONFLICT (key, version) DO NOTHING;
