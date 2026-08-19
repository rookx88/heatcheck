-- Ticker tunables in game_config (versioned pattern - create_game_config_table.sql):
-- one active version per key, never mutate config in place - insert (key, version+1)
-- and flip active. Read at runtime by lib/pages-functions/tickers.ts, so retuning any
-- of these needs no redeploy.
--   tag_delta_cap_pct: tag-event delta clamp, +/- percentage points. Bounds how much a
--                      noisy thin-liquidity historical price point can move a ticker
--                      (accepted risk, mitigated by the cap, not filtered out).
--                      Settle events are deliberately NOT capped by this.
--   locks_min_prob:    locks eligibility - the tagged side's frozen snapshot implied
--                      probability must be >= this.
--   moonshot_max_prob: moonshot eligibility - frozen snapshot prob must be < this
--                      (mirror of locks_min_prob).
-- dogs/chalk pivot on 0.5 by definition - that is not a tunable (module const in
-- lib/pages-functions/tickers.ts).
--
-- Run alongside create_ticker_tables.sql, before deploying the ticker endpoints.
-- Execute: psql "$DATABASE_URL" -f seed_ticker_config.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('tickers', 1, true, '{"tag_delta_cap_pct": 10, "locks_min_prob": 0.80, "moonshot_max_prob": 0.20}')
ON CONFLICT (key, version) DO NOTHING;
