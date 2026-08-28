-- Heatchecks Exchange editorial tickers ($DOGS/$CHALK/$LOCKS/$MOONSHOT). Display layer
-- ONLY - no Ember source or sink, nothing here touches ember_ledger (see
-- lib/pages-functions/ledger.ts for why that boundary matters). ticker_events is
-- append-only: a ticker's current value IS SUM(delta) over its events (restricted to
-- visibility='app' tanks at read time, never at write time), and the same events
-- ordered by occurred_at ARE the trading chart - there is no separate chart storage
-- and no cached total anywhere that could drift from this log.
--
-- Exactly two event types, both mechanical, neither anyone's opinion:
--   'tag'    - fired once when a curator tags a Tank: the tagged side's real 3-day
--              implied-probability movement from Polymarket's CLOB price history,
--              clamped to +/- game_config['tickers'].tag_delta_cap_pct.
--   'settle' - fired once by /api/settle after the real market outcome is known:
--              odds-aware fair payout, +(1-p)*settle_scale_pct on a win and
--              -p*settle_scale_pct on a loss, p = the tagged side's frozen snapshot
--              probability (computeSettleDelta in lib/pages-functions/tickers.ts).
--              Zero expected value per settle on a calibrated market keeps every
--              ticker hovering near 0 instead of drifting (flat payouts sent
--              chalk/dogs past +/-100). Deliberately NOT bound by the tag cap - a
--              genuinely shocking real result (a longshot hitting pays close to the
--              full scale) may outweigh three days of pre-game narrative movement.
-- The per-ticker settle_win_pct/settle_loss_pct magnitudes below are the FALLBACK for
-- tags whose snapshot carries no usable probability; the odds-aware rule supersedes
-- them whenever p exists and already produces the same character (a surprising outcome
-- moves a ticker more than an expected one) without per-ticker tuning.
-- Values are retrospective, never predictive - they reflect how tagged storylines
-- have gone, not a signal about anything upcoming.
--
-- Run seed_ticker_config.sql alongside this file - the tag endpoint fails loud if the
-- game_config['tickers'] row is missing.
-- Execute: psql "$DATABASE_URL" -f create_ticker_tables.sql

-- Hand-curated, small. Never auto-populated or computed from popularity.
CREATE TABLE IF NOT EXISTS tickers (
    key             TEXT PRIMARY KEY,            -- 'dogs' | 'chalk' | 'locks' | 'moonshot'
    display_name    TEXT NOT NULL,               -- '$DOGS' etc, the UI label
    description     TEXT NOT NULL,
    rule_type       TEXT NOT NULL,               -- eligibility strategy: 'underdog'|'favorite'|'heavy_favorite'|'longshot'
    settle_win_pct  NUMERIC(6,3) NOT NULL,       -- FALLBACK win magnitude (positive) when the snapshot prob is unusable
    settle_loss_pct NUMERIC(6,3) NOT NULL,       -- FALLBACK loss magnitude (positive) when the snapshot prob is unusable
    active          BOOLEAN NOT NULL DEFAULT true,
    tab_order       SMALLINT NOT NULL DEFAULT 0,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Static curator fact: which ticker cares about which side of which Tank. Never
-- mutated after creation except calculated_at (the settle idempotency marker).
CREATE TABLE IF NOT EXISTS ticker_tags (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tank_id       UUID NOT NULL REFERENCES tank_pages(id) ON DELETE CASCADE,
    ticker_key    TEXT NOT NULL REFERENCES tickers(key),
    -- Outcome index into the frozen game_snapshot.prop.odds arrays - same positional
    -- convention as picks.outcome_index (see functions/api/picks.ts:11-15).
    relevant_side SMALLINT NOT NULL,
    tagged_at     TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    calculated_at TIMESTAMP WITH TIME ZONE,      -- NULL until the settle event fires
    retroactive   BOOLEAN NOT NULL DEFAULT false,
    UNIQUE (tank_id, ticker_key)
);

-- Append-only. Never updated or deleted. This table IS the chart data source.
CREATE TABLE IF NOT EXISTS ticker_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticker_tag_id UUID NOT NULL REFERENCES ticker_tags(id) ON DELETE CASCADE,
    ticker_key    TEXT NOT NULL REFERENCES tickers(key),   -- denormalized for ticker-level chart/sum queries
    tank_id       UUID NOT NULL REFERENCES tank_pages(id) ON DELETE CASCADE, -- denormalized for a Tank's own-page highlight
    event_type    TEXT NOT NULL CHECK (event_type IN ('tag', 'settle')),
    -- Signed percentage points (e.g. 4.250 or -9.800), summed into a cumulative
    -- percentage starting at 0% - NOT an indexed price against a base of 100.
    delta         NUMERIC(6,3) NOT NULL,
    occurred_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Audit trail (mirrors ember_ledger.metadata): every delta stays explainable after
    -- the fact - raw pre-clamp delta, CLOB prices/token, winning index, etc.
    metadata      JSONB NOT NULL DEFAULT '{}',
    -- Structural guarantee on top of the calculated_at CTE guard: at most one 'tag'
    -- and one 'settle' event can ever exist per tag row, even if a future code path
    -- bypasses the guarded write.
    UNIQUE (ticker_tag_id, event_type)
);

CREATE INDEX IF NOT EXISTS idx_ticker_events_key_time ON ticker_events(ticker_key, occurred_at);
CREATE INDEX IF NOT EXISTS idx_ticker_events_tank ON ticker_events(tank_id);
CREATE INDEX IF NOT EXISTS idx_ticker_tags_tank ON ticker_tags(tank_id);
CREATE INDEX IF NOT EXISTS idx_ticker_tags_pending ON ticker_tags(id) WHERE calculated_at IS NULL;

-- Fallback magnitudes only (see settle rule above). LOCKS/MOONSHOT asymmetric: a lock
-- hitting is expected and barely moves it, a lock failing is the surprise and carries
-- the weight; MOONSHOT is the mirror. DOGS/CHALK symmetric (and deliberately inverse
-- of each other in what they tag).
INSERT INTO tickers (key, display_name, description, rule_type, settle_win_pct, settle_loss_pct, active, tab_order) VALUES
    ('dogs',     '$DOGS',     'Underdog storylines - sides priced below 50%.',        'underdog',       5,  5,  true, 1),
    ('chalk',    '$CHALK',    'Favorite storylines - sides priced at 50% or better.', 'favorite',       5,  5,  true, 2),
    ('locks',    '$LOCKS',    'Heavy favorites - the near-sure things.',              'heavy_favorite', 5,  15, true, 3),
    ('moonshot', '$MOONSHOT', 'Longshots - low-probability sides with big upside.',   'longshot',       20, 5,  true, 4)
ON CONFLICT (key) DO NOTHING;
