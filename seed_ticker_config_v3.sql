-- Ticker tunables v3: the slate-driven index. Same versioned-flip discipline as
-- seed_ticker_config.sql (insert inactive, deactivate the old, activate the new - two
-- steps, because the one-active-per-key partial unique index rejects a single-statement
-- swap). Read at runtime, so retuning any of these needs no redeploy.
--
-- WHAT CHANGED AND WHY: an index now has two legs, and they must not carry equal weight.
--   * Results (the slate) should be MOST of the movement - that is the point of the
--     change: an index reflects how its whole category of games went.
--   * News (a published Tank's 3-day price move) still moves it, the way news about a
--     company moves a stock, but as a nudge.
--
-- Planning assumption: every index sees at least one published Tank per day, so both
-- legs fire at a similar cadence (~7/week each). Frequency therefore can't do the
-- balancing - magnitude has to. Measured against the 208 real tag events in the log, a
-- tag's median |delta| is 0.50 and its mean 1.90 at the old scale, versus a daily close
-- of ~0.9 at the new one; scaling tags by 0.12 puts results at roughly 80% of weekly
-- movement, news at 20%.
--
--   tag_scale_pct     NEW. The 3-day implied-probability move is multiplied by this
--                     before clamping. At 0.12 a typical tag moves ~0.06 and a genuine
--                     repricing ~0.8 - still visible, no longer dominant.
--   tag_delta_cap_pct 10 -> 1.5. Same clamp, new magnitude. At the scale above the cap
--                     rarely binds, which is the intent: a safety rail, not the thing
--                     shaping the distribution.
--   close_scale_pct   NEW. A day's close is mean-ish contribution x this. At 10 a
--                     typical day moves ~0.9 points and a lopsided slate ~2.
--   close_smoothing   NEW. The +k in SUM(contrib)/(N+k). Slate sizes run 3-18 games/day
--                     for the broad indexes but only 0-3 for $LOCKS/$MOONSHOT, which
--                     need a lopsided price to qualify. A plain mean would make a
--                     one-game day the largest move on the board (a lock losing at
--                     p=0.85 would print -2.55); k=4 damps thin days toward zero while
--                     large slates behave exactly like the mean.
--   locks_min_prob / moonshot_max_prob / settle_scale_pct carry over unchanged.
--
-- Combined daily sd is ~1.3 points, so an index random-walks about +/-17 over a
-- 180-day season: visible, and nowhere near the +/-100 where the old flat-payout
-- scheme broke down.
--
-- These are opening numbers. Re-measure the real split after a week of live closes
-- (compare SUM(ABS(delta)) grouped by source, per ticker) and flip a v4 if needed.
-- Execute: psql "$DATABASE_URL" -f seed_ticker_config_v3.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('tickers', 3, false, '{
        "tag_delta_cap_pct": 1.5,
        "tag_scale_pct": 0.12,
        "locks_min_prob": 0.80,
        "moonshot_max_prob": 0.20,
        "settle_scale_pct": 10,
        "close_scale_pct": 10,
        "close_smoothing": 4
    }')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'tickers' AND active AND version < 3;
UPDATE game_config SET active = true
WHERE key = 'tickers' AND version = 3
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'tickers' AND g.active);
