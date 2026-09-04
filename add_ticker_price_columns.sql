-- TANKDAQ tradeable prices, step 1 of 3: the two inputs to an index's Ember price.
--
--   price = price_baseline * exp(value / price_scale)
--
-- where `value` is the SAME SUM(delta) getTickerValues() already returns for the
-- percentage display (lib/pages-functions/tickers.ts) - the price is a second READ of
-- that number, never a second computation of it. exp() of any real number is strictly
-- positive, so a price can approach zero under sustained bad results but can never reach
-- it or go negative; no floor, clamp, or "delisted" state exists anywhere, and none is
-- needed. That property matters because these tickers are permanent, brand-load-bearing
-- names ($DOGS, $CHALK...) that must always be able to recover once results turn.
--
-- Per ticker, not global: a broad index like $DOGS swings ~14 points a day while a thin
-- one like $LOCKS swings ~5, so one shared scale would make one of them either inert or
-- wild. seed_ticker_prices_v1.sql tunes each from its own measured history.
--
-- Defaults (100, 100) mean every existing and future row is priced the moment this runs,
-- so the read path never needs a NULL branch; NUMERIC(12,4) matches the 4-dp precision
-- the transform rounds to in ticker-price.ts.
--
-- DEPLOY ORDER: run this BEFORE pushing the code. getTickerValues() selects these columns,
-- and Cloudflare's build runs generate-static-site.ts against this database - pushing
-- first would 500 every ticker read and fail the build. Under old code the new columns
-- are simply unread.
-- Execute: psql "$DATABASE_URL" -f add_ticker_price_columns.sql

BEGIN;

ALTER TABLE tickers ADD COLUMN IF NOT EXISTS price_baseline NUMERIC(12,4) NOT NULL DEFAULT 100;
ALTER TABLE tickers ADD COLUMN IF NOT EXISTS price_scale    NUMERIC(12,4) NOT NULL DEFAULT 100;

-- exp() needs a positive scale to be meaningful and a positive baseline to be a price at
-- all. Dropped-then-added so the file is re-runnable.
ALTER TABLE tickers DROP CONSTRAINT IF EXISTS tickers_price_positive_check;
ALTER TABLE tickers ADD CONSTRAINT tickers_price_positive_check
    CHECK (price_baseline > 0 AND price_scale > 0);

COMMIT;
