-- Polymarket prop odds cache
-- Run this SQL file against the main app database to create the table.
-- Execute: psql "$DATABASE_URL" -f create_polymarket_props_table.sql
--
-- This table is a read cache populated by a background sync (see polymarket.ts).
-- The API never calls Polymarket directly on a client request; it only reads
-- from this table, so client traffic can never cause Polymarket rate limiting.

CREATE TABLE IF NOT EXISTS polymarket_props (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league VARCHAR(50) NOT NULL,           -- canonical league: NBA, NFL, MLB, EPL, La Liga, Serie A, Bundesliga, Ligue 1
    source_tag VARCHAR(50) NOT NULL,       -- Polymarket tag_slug this row was fetched from (e.g. 'nba', 'la-liga')
    event_id VARCHAR(64),
    event_slug VARCHAR(255) NOT NULL,
    event_title TEXT,
    event_end_date TIMESTAMP WITH TIME ZONE,
    market_id VARCHAR(64) NOT NULL,
    market_slug VARCHAR(255) NOT NULL,
    condition_id VARCHAR(128),
    question TEXT NOT NULL,
    subject_name VARCHAR(255),             -- parsed player/team name, e.g. "Alejandro Kirk" from "Alejandro Kirk: Home Runs O/U 0.5"
    is_player_prop BOOLEAN NOT NULL DEFAULT FALSE,
    outcomes JSONB,                        -- e.g. ["Over", "Under"]
    outcome_prices JSONB,                  -- e.g. ["0.5", "0.5"] (implied probability, 0-1)
    clob_token_ids JSONB,
    best_bid NUMERIC,
    best_ask NUMERIC,
    volume NUMERIC,
    liquidity NUMERIC,
    active BOOLEAN,
    closed BOOLEAN,
    event_teams JSONB,                     -- event.teams: [{name, abbreviation, ordering: "away"|"home", ...}]
    event_start_time TIMESTAMP WITH TIME ZONE, -- event.startTime (actual game start, distinct from market endDate)
    market_type VARCHAR(100),              -- market.sportsMarketType, e.g. "baseball_player_home_runs"
    market_line NUMERIC,                   -- market.line (structured, no regex parsing needed)
    market_metadata JSONB,                 -- market.marketMetadata (player id, selection, etc.)
    raw JSONB,                             -- full source market object for anything not modeled above
    synced_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    UNIQUE(market_id)
);

-- Idempotent migration for installs created before these columns existed.
ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS event_teams JSONB;
ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS event_start_time TIMESTAMP WITH TIME ZONE;
ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_type VARCHAR(100);
ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_line NUMERIC;
ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_metadata JSONB;

CREATE INDEX IF NOT EXISTS idx_polymarket_props_league ON polymarket_props(league);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_event_slug ON polymarket_props(event_slug);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_subject_name ON polymarket_props(subject_name);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_is_player_prop ON polymarket_props(is_player_prop);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_synced_at ON polymarket_props(synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_active_closed ON polymarket_props(active, closed);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_market_type ON polymarket_props(market_type);
CREATE INDEX IF NOT EXISTS idx_polymarket_props_event_id ON polymarket_props(event_id);
