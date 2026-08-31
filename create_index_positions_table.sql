-- Slate ledger for the Exchange indexes: one row per (index, game), locked BEFORE
-- kickoff, settled after. This is what turns an index from "how the Tanks we published
-- went" into "how this category of games went" - the Tank tag events remain as the news
-- leg, but the totality of results here is most of an index's movement.
--
-- The Tank-side analogue is ticker_tags (create_ticker_tables.sql): same shape of idea -
-- a frozen pre-game fact plus a settle marker - but keyed on the GAME rather than on a
-- tank_page, because there is no article behind most of these.
--
-- WHY ENTRY PRICE IS CAPTURED AND NEVER DERIVED: polymarket_props is upserted in place
-- every sync with no price history, so once a game finishes its pre-game price is gone
-- forever. Nothing here can be backfilled - the row must be written before kickoff or
-- that game is lost to the index permanently. That is why locking ships before any of
-- the scoring code.
--
-- Settlement writes result/contrib per row; a separate daily close aggregates a day's
-- settled rows into ONE ticker_event per index (see lib/pages-functions/index-slate.ts).
--
-- Execute: psql "$DATABASE_URL" -f create_index_positions_table.sql

CREATE TABLE IF NOT EXISTS index_positions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker_key    TEXT NOT NULL REFERENCES tickers(key),

    -- The market this index is holding for this game.
    provider      TEXT NOT NULL DEFAULT 'polymarket',
    market_id     TEXT NOT NULL,
    condition_id  TEXT,
    league        TEXT NOT NULL,
    event_id      TEXT NOT NULL,        -- the GAME key (polymarket_props.event_id)
    away          TEXT,
    home          TEXT,
    kickoff       TIMESTAMP WITH TIME ZONE,
    market_type   TEXT NOT NULL,        -- 'totals' | 'moneyline' | ...
    market_line   NUMERIC,              -- the total's number; NULL for moneylines

    -- The side this index holds, and the price it holds it at. entry_prob is the whole
    -- point of locking early: the settle payout is odds-aware against THIS number.
    side_index    SMALLINT NOT NULL,
    side_label    TEXT,
    entry_prob    NUMERIC(6,4) NOT NULL CHECK (entry_prob > 0 AND entry_prob < 1),
    locked_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

    -- Selection audit: why THIS market represented the game. A game offers ~9.2 totals
    -- (max 28), so the choice is load-bearing and must stay explainable after the fact.
    -- sel_median_agreed tracks whether the volume pick matched the ladder-median pick -
    -- if that starts trending down, the ladder shape or our rule has drifted.
    sel_volume         NUMERIC,
    sel_liquidity      NUMERIC,
    sel_runner_up_line NUMERIC,
    sel_median_agreed  BOOLEAN,

    -- Settlement. result stays NULL until the market resolves; 'void' covers markets
    -- that resolved ambiguously or were cancelled (they contribute nothing).
    result        TEXT CHECK (result IN ('win', 'loss', 'void')),
    winning_index SMALLINT,
    settled_at    TIMESTAMP WITH TIME ZONE,
    -- The odds-aware contribution: +(1 - entry_prob) on a win, -entry_prob on a loss.
    -- EV-neutral on a calibrated market, so an index measures surprise, not win rate.
    contrib       NUMERIC(6,3),
    -- The daily close event this row rolled into; NULL until that close is written.
    close_id      UUID REFERENCES ticker_events(id) ON DELETE SET NULL,

    -- One position per index per game. This is the natural key that plays the role
    -- UNIQUE(tank_id, ticker_key) plays for Tank tags: it makes re-locking a no-op at
    -- the ROW level, so the lock job can be re-run any number of times a day.
    UNIQUE (ticker_key, event_id)
);

-- The lock job's "is this game already locked?" probe and the settle job's work queue.
CREATE INDEX IF NOT EXISTS idx_index_positions_pending
    ON index_positions(kickoff) WHERE settled_at IS NULL;
-- The daily close's aggregation, and the "what moved it today" reads behind it.
CREATE INDEX IF NOT EXISTS idx_index_positions_close
    ON index_positions(ticker_key, settled_at);
CREATE INDEX IF NOT EXISTS idx_index_positions_event ON index_positions(event_id);
