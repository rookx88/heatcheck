-- TANKDAQ tradeable prices, step 3 of 3: tune each index's price scale to its own history.
--
-- Rule: scale ~= daily_sd / 0.12, so that a one-standard-deviation day moves the price
-- by roughly 12%. Every index then FEELS equally volatile in Ember terms regardless of
-- how many points its cumulative value swings - which is the whole reason this is per
-- ticker rather than one shared number. Baseline is 100 everywhere.
--
-- MIRROR PAIRS MUST SHARE IDENTICAL (baseline, scale). $OVERS/$UNDERS and each league
-- favorite/underdog pair hold opposite sides of the same markets, so their cumulative
-- values move as exact inverses. Under exp() that becomes: ln(p_a) + ln(p_b) is constant
-- over time - the moves are inverse in LOG space (multiplicative returns), never as +/-
-- the same number of Ember. Give the two different scales and that constant drifts, and
-- buying one stops being a clean short of the other. Pairs:
--   (overs, unders)  (mlbchalk, mlbdogs)  (gridiron, nfldogs)  (footy, socdogs)  (nbachalk, nbadogs)
-- $CHALK and $DOGS are NOT an exact pair (the global 0.5 pivot sends a pick'em's both
-- sides to chalk), so they are tuned independently.
--
-- Measured 2026-09-03 on roughly two weeks of history (daily sd of the app-visible
-- cumulative, same row filter as getTickerValues):
--   dogs 13.87 | chalk 10.64 | locks 5.06 | moonshot 5.27 | overs/unders 12.28
--   footy 13.61 (5 days) | gridiron 7.71 (2 days) | mlbchalk/mlbdogs 2.27 (2 days)
--   socdogs 1.50 (2 days) | nfldogs, nbachalk, nbadogs: no usable history
-- Anything with under a week of data is PROVISIONAL and inherits its mirror-mate's
-- scale; the NBA pair borrows the MLB pair's (comparable slate sizes) until the season.
--
-- Resulting prices today: $DOGS ~45 (from -91.69), $CHALK ~222, $OVERS ~170,
-- $UNDERS ~59, $FOOTY ~135, the rest near 100.
--
-- RE-TUNE after 30 days of data (and after NFL week 4 for gridiron/nfldogs - Sundays are
-- lumpy). CHANGING A SCALE RE-PRICES EVERY OPEN HOLDING, so do it before launch or
-- announce it. The measurement, so it is reproducible:
--
--   WITH d AS (
--     SELECT e.ticker_key, e.occurred_at::date AS day, SUM(e.delta)::float8 AS day_move
--     FROM ticker_events e LEFT JOIN tank_pages t ON t.id = e.tank_id
--     WHERE (e.source = 'slate' OR t.visibility = 'app')      -- getTickerValues' filter
--     GROUP BY 1, 2)
--   SELECT ticker_key, COUNT(*) AS active_days,
--          ROUND(STDDEV_SAMP(day_move)::numeric, 2) AS daily_sd,
--          ROUND(MAX(ABS(day_move))::numeric, 2)    AS max_day,
--          ROUND((STDDEV_SAMP(day_move) / 0.12)::numeric) AS suggested_scale
--   FROM d GROUP BY 1 ORDER BY 1;
--
-- Re-runnable: plain UPDATEs. Run after add_ticker_price_columns.sql.
-- Execute: psql "$DATABASE_URL" -f seed_ticker_prices_v1.sql

BEGIN;

UPDATE tickers SET price_baseline = 100, price_scale = 115 WHERE key = 'dogs';
UPDATE tickers SET price_baseline = 100, price_scale =  90 WHERE key = 'chalk';
UPDATE tickers SET price_baseline = 100, price_scale =  42 WHERE key = 'locks';
UPDATE tickers SET price_baseline = 100, price_scale =  44 WHERE key = 'moonshot';

-- Mirror pairs: one UPDATE per pair so they can never be edited apart by accident.
UPDATE tickers SET price_baseline = 100, price_scale = 100 WHERE key IN ('overs', 'unders');
UPDATE tickers SET price_baseline = 100, price_scale = 115 WHERE key IN ('footy', 'socdogs');
UPDATE tickers SET price_baseline = 100, price_scale =  65 WHERE key IN ('gridiron', 'nfldogs');
UPDATE tickers SET price_baseline = 100, price_scale =  20 WHERE key IN ('mlbchalk', 'mlbdogs');
UPDATE tickers SET price_baseline = 100, price_scale =  20 WHERE key IN ('nbachalk', 'nbadogs');

COMMIT;
