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
--   settle_scale_pct:  odds-aware settle scale (v2) - a settled tag moves its ticker
--                      +(1-p)*this on a win, -p*this on a loss, p = the tagged side's
--                      frozen snapshot probability (computeSettleDelta in
--                      lib/pages-functions/tickers.ts). Zero expected value per settle
--                      on a calibrated market, so no ticker drifts unboundedly the way
--                      flat +/-settle_win/loss_pct payouts made chalk/dogs do; those
--                      flat pcts remain the fallback for tags with no snapshot prob.
-- dogs/chalk pivot on 0.5 by definition - that is not a tunable (module const in
-- lib/pages-functions/tickers.ts).
--
-- Run alongside create_ticker_tables.sql, before deploying the ticker endpoints.
-- v2 (settle_scale_pct) is a DEPLOY PREREQUISITE for the odds-aware settle code -
-- getTickerConfig fails loud without it. Safe under the old code (extra key ignored).
-- Execute: psql "$DATABASE_URL" -f seed_ticker_config.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('tickers', 1, true, '{"tag_delta_cap_pct": 10, "locks_min_prob": 0.80, "moonshot_max_prob": 0.20}')
ON CONFLICT (key, version) DO NOTHING;

-- v2: same tunables + settle_scale_pct. Versioned-flip, never mutate in place: insert
-- inactive, deactivate v1, then activate v2 - two steps because the one-active-per-key
-- partial unique index would reject a single-statement swap mid-update. Idempotent,
-- and a hand-flipped LATER version (if one ever exists) is left alone.
INSERT INTO game_config (key, version, active, config) VALUES
    ('tickers', 2, false, '{"tag_delta_cap_pct": 10, "locks_min_prob": 0.80, "moonshot_max_prob": 0.20, "settle_scale_pct": 10}')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'tickers' AND active AND version < 2;
UPDATE game_config SET active = true
WHERE key = 'tickers' AND version = 2
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'tickers' AND g.active);
