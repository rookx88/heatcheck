-- Replaces the flat placeholder Ember payouts (correct_call=10, participation=2) with
-- the real difficulty-scaled formula, per the settlement finalization spec.
--
--   correct_payout(implied_prob) = round( base * min( 1 / implied_prob, cap ) )
--   participation_payout         = flat `amount`  -- always paid on a loss
--
-- cap=2.5, NOT the spec's original starting value of 6 - scripts/simulate-ember-economy.ts
-- (run before this migration, per the spec's explicit gate) showed cap=6 actually loses to
-- longshot-chasing (a strategy that always hunts the lowest-probability pick available beats
-- honest, spread-out picking by ~2% mean Ember/month, winning 56%+ of simulated 30-day
-- trials) - a real property of this formula shape, not a rounding-error artifact: EV(p) is
-- piecewise-linear in p with a peak at exactly p=1/cap, so cap=6 (peak at ~16.7%) sits too
-- close to where "realistic" longshots actually cluster (props assumed 20%-70% absent real
-- historical data yet). cap=2.5 moves the peak to 40%, comfortably inside the honest-play
-- range, and was the smallest value the simulation showed a robust (not marginal-coinflip)
-- result at: honest play wins 68.4% of trials, ~6.8% higher mean Ember/month. Max single-pick
-- payout is base*cap = 50 Ember (vs the original spec's 120) - still a meaningful "big win"
-- multiple over the flat 5-Ember participation floor. Re-run the simulation against real
-- picks.implied_prob_at_lock data once enough exists (30+ real picks) before retuning further -
-- it automatically prefers real history over the synthetic 20%-70% fallback when available.
--
-- Per the existing versioning convention: never mutate a row's config in place. Flip the
-- old version inactive, insert the new one active - the UNIQUE ... WHERE active index on
-- ember_rules(key) means the flip must happen before (not after, not same-statement as) the
-- insert, so each key's block below is two statements in this exact order.
-- Execute: psql "$DATABASE_URL" -f update_ember_rules_payout_formula.sql

UPDATE ember_rules SET active = false WHERE key = 'correct_call' AND version = 1;
INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('correct_call', 2, 'source', true, '{"base": 20, "cap": 2.5}')
ON CONFLICT (key, version) DO NOTHING;

UPDATE ember_rules SET active = false WHERE key = 'participation' AND version = 1;
INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('participation', 2, 'source', true, '{"amount": 5}')
ON CONFLICT (key, version) DO NOTHING;
