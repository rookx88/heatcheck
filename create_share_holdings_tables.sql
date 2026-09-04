-- TANKDAQ tradeable prices, step 2 of 3: a user's share positions and their trade diary.
--
-- share_holdings - one row per (user, index) they currently hold. Deliberately NOT named
-- index_positions: that table already exists and is the INDEX's own per-game scoring
-- record (create_index_positions_table.sql, keyed on ticker_key + event_id, no user).
-- These are two unrelated concepts and sharing a name would have been a real collision.
--
-- share_trades - the append-only diary of every buy and sell, mirroring ember_ledger's
-- discipline: rows are never UPDATEd or DELETEd. Every trade moves Ember, so every trade
-- row pairs with exactly one ember_ledger row, and the two share the SAME idempotency_key
-- (buildIdempotencyKey('shares_buy'|'shares_sell', userId, tradeToken)) - a replayed
-- trade token therefore can no more write a second trade than it can a second debit.
-- ledger_id makes the pairing navigable in both directions.
--
-- Whole shares only (a user decision): shares is NUMERIC(18,0). Ember is INT, so a
-- trade's ember_amount is ceil(shares * price) on a buy and floor(shares * price) on a
-- sell - rounding never favours the trader. avg_buy_price is Ember ACTUALLY PAID divided
-- by shares (so it includes the ceil), which is what lets unrealized P/L reconcile to
-- real ledger flows rather than to a theoretical price.
--
-- Prices are read-only with respect to ticker_events: nothing in the trading layer ever
-- writes that table. Stories and results move the price; trading only consumes it.
--
-- The two ember_rules rows are the first with no {amount} in config: a trade's amount is
-- computed per trade from the live price and stamped into ember_ledger.metadata
-- ({tickerKey, shares, price, tradeToken, pricingVersion}). pricingVersion lets a future
-- change to the price formula ship as version 2 without touching a single historical row.
--
-- Safe under old code (nothing reads these yet). Run after add_ticker_price_columns.sql.
-- Execute: psql "$DATABASE_URL" -f create_share_holdings_tables.sql

BEGIN;

CREATE TABLE IF NOT EXISTS share_holdings (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES waitlist(id),
    ticker_key    TEXT NOT NULL REFERENCES tickers(key),
    shares        NUMERIC(18,0) NOT NULL CHECK (shares >= 0),
    avg_buy_price NUMERIC(14,6) NOT NULL CHECK (avg_buy_price >= 0),
    updated_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, ticker_key)
);
CREATE INDEX IF NOT EXISTS idx_share_holdings_user ON share_holdings(user_id);

CREATE TABLE IF NOT EXISTS share_trades (
    id              UUID PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES waitlist(id),
    ticker_key      TEXT NOT NULL REFERENCES tickers(key),
    side            TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
    shares          NUMERIC(18,0) NOT NULL CHECK (shares > 0),
    -- The server's quote at the moment of the trade, to the 4 dp the transform rounds to.
    -- Persisted so every ember_amount is auditable against the price that produced it.
    price           NUMERIC(14,4) NOT NULL CHECK (price > 0),
    ember_amount    INT NOT NULL CHECK (ember_amount >= 0),
    -- Sells only: credit - shares * avg_buy_price at the time of the sale. NULL on buys.
    realized_pnl    NUMERIC(14,4),
    trade_token     UUID NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    ledger_id       BIGINT REFERENCES ember_ledger(id),
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_share_trades_user_created ON share_trades(user_id, created_at DESC);

INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('shares_buy',  1, 'sink',   true, '{"pricingVersion": 1}'),
    ('shares_sell', 1, 'source', true, '{"pricingVersion": 1}')
ON CONFLICT (key, version) DO NOTHING;

COMMIT;
