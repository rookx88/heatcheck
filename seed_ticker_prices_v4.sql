-- TANKDAQ tradeable prices, v4: the per-league soccer slices added by
-- add_tickers_batch6.sql.
--
-- Everything in seed_ticker_prices_v1.sql still applies and is not restated here - the
-- scale rule (scale ~= daily_sd / 0.12), the baseline of 100, the measurement query, and
-- above all the mirror-pair contract.
--
-- WHY 65 AND NOT $FOOTY/$SOCDOGS' 115. Scale tracks DAILY volatility, and what drives
-- that is slate cadence, not which side of a market an index holds (v2's header makes the
-- same argument for $NFLO/$NFLU). $FOOTY averages across ten competitions every day, so
-- its days are smooth and 115 suits it. A single soccer league is the opposite: measured
-- 2026-09-13, the six live ones run 1.29-4.71 games a day and they are CLUSTERED on
-- matchdays rather than spread evenly - a quiet Tuesday and then seven games at once.
-- That is the same lumpiness the existing single-league pair ($GRIDIRON/$NFLDOGS, at 65)
-- was tuned for, and the lower scale is the right direction for it: a thinner index is
-- damped harder by closeDelta's (N + smoothing) denominator, so it needs more price
-- movement per point to feel comparably alive.
--
-- PROVISIONAL, by v1's own rule - these inherit a structural sibling's number rather than
-- being measured. They CAN be measured soon, though, and that is the point of running
-- scripts/retro-soccer-league-indexes.ts alongside this file: each slice back-fills the
-- history its parent already owns, so there is a real daily sd to re-tune against in 30
-- days rather than a flat line. Schedule v5 for then.
--
-- THE DORMANT PAIRS ARE SEEDED TOO, deliberately. $UCLCHALK and the two cup pairs ship
-- with active = false, so nothing holds them and nothing displays them - which makes this
-- the cheapest moment their scale will ever be set. Switching one on later is then a
-- one-line UPDATE with no price decision attached to it.
--
-- One paired UPDATE per mirror pair, the idiom v1 uses at its line 54: a mirror pair must
-- share (baseline, scale) or ln(p_a) + ln(p_b) stops being constant and buying one stops
-- being a clean short of the other. Writing each pair in a single statement is what makes
-- editing them apart by accident impossible. scripts/acceptance/suites/shares.ts asserts
-- the drift is ~0.
--
-- Add to v1's pair roster (its line 14) when that file is next touched - it is now nine
-- pairs longer than the six it lists.
--
-- CHANGING A SCALE RE-PRICES EVERY OPEN HOLDING. Nothing holds any of these yet.
--
-- Re-runnable: plain UPDATEs. Run immediately after add_tickers_batch6.sql.
-- Execute: psql "$DATABASE_URL" -f seed_ticker_prices_v4.sql

UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('mlschalk', 'mlsdogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('laligachalk', 'laligadogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('eflchalk', 'efldogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('eplchalk', 'epldogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('bundeschalk', 'bundesdogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('ligue1chalk', 'ligue1dogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('uclchalk', 'ucldogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('carachalk', 'caradogs');
UPDATE tickers SET price_baseline = 100, price_scale = 65 WHERE key IN ('dfbchalk', 'dfbdogs');
