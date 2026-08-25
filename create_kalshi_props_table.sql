-- Kalshi player-prop cache
-- Run this SQL file against the main app database to create the table.
-- Execute: psql "$DATABASE_URL" -f create_kalshi_props_table.sql
--
-- This table is a read cache populated by a background sync (see kalshi.ts), mirroring
-- polymarket_props's role for Polymarket. Admin-tool-only: production curate.ts never
-- reads this table, it calls kalshi-live.ts's fetchLiveKalshiGames() directly, the same
-- relationship polymarket_props has to tank-gamma-live.ts.
--
-- Kalshi has no CLOB/condition-id concept (its own /markets/{ticker} + /markets/trades
-- endpoints cover settlement and price history directly), so this table has no
-- clob_token_ids/condition_id/best_bid/best_ask columns the way polymarket_props does.

CREATE TABLE IF NOT EXISTS kalshi_props (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league VARCHAR(50) NOT NULL,           -- canonical league: NBA, NFL, MLB, EPL, La Liga, Serie A, Bundesliga, Ligue 1
    series_ticker VARCHAR(64) NOT NULL,    -- Kalshi series this row was fetched from (e.g. 'KXNBAPTS')
    event_ticker VARCHAR(128) NOT NULL,
    event_title TEXT,
    away VARCHAR(255),                     -- parsed from event.sub_title ("AAA vs BBB (Mon DD)")
    home VARCHAR(255),
    market_ticker VARCHAR(128) NOT NULL,   -- individual rung's ticker (ladder collapse happens in tank-providers.ts, not at sync time)
    subject_name VARCHAR(255),             -- parsed player name, e.g. "Ashton Jeanty" from "Ashton Jeanty: 1+"
    subject_key VARCHAR(128),              -- opaque player UUID from custom_strike - stable grouping key for ladder collapse
    market_key VARCHAR(100) NOT NULL,      -- canonical stat key, e.g. "basketball_player_points" (from kalshi.ts's KALSHI_SERIES_MAP)
    shape VARCHAR(10) NOT NULL,            -- 'ladder' | 'binary'
    floor_strike NUMERIC,                  -- NULL for binary markets; the O/U threshold for ladder markets
    yes_prob NUMERIC,                      -- 0-1, bid/ask midpoint or last price
    volume NUMERIC,
    open_interest NUMERIC,
    open_time TIMESTAMP WITH TIME ZONE,     -- when this specific market began trading (not the game start)
    close_time TIMESTAMP WITH TIME ZONE,    -- when this specific market stops trading (near game time, not padded like Polymarket)
    occurrence_time TIMESTAMP WITH TIME ZONE, -- the actual game/occurrence start time - use this for Game.kickoff
    status VARCHAR(20),
    raw JSONB,                             -- full source market object for anything not modeled above
    synced_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(market_ticker)
);

CREATE INDEX IF NOT EXISTS idx_kalshi_props_league ON kalshi_props(league);
CREATE INDEX IF NOT EXISTS idx_kalshi_props_event_ticker ON kalshi_props(event_ticker);
CREATE INDEX IF NOT EXISTS idx_kalshi_props_market_key ON kalshi_props(market_key);
CREATE INDEX IF NOT EXISTS idx_kalshi_props_synced_at ON kalshi_props(synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_kalshi_props_status ON kalshi_props(status);
CREATE INDEX IF NOT EXISTS idx_kalshi_props_subject_key ON kalshi_props(subject_key);
