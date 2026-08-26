-- The Community Picks / Community Points / giveaway-draw system - a fully isolated
-- side-ledger the Discord bot's admin commands feed into. Deliberately ZERO foreign
-- keys into and zero write paths from anywhere in this file to ember_ledger,
-- ember_balances, picks, or any shop/inventory table - this isolation is enforced at
-- the schema level (see the columns below), not just by application-code discipline.
-- linked_heatchecks_user_id only ever references waitlist directly, the same loose
-- reference the real Ember ledger itself uses - never the ledger tables themselves.
-- Execute: psql "$DATABASE_URL" -f create_community_picks_tables.sql

CREATE TABLE IF NOT EXISTS community_picks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guild_configs(guild_id),
    created_by VARCHAR(32) NOT NULL,
    source_market_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    side_a_label TEXT NOT NULL,
    side_b_label TEXT NOT NULL,
    -- Snapshotted live outcome NAMES at creation, positionally parallel to
    -- [side_a_label, side_b_label] - required for outcome-order-mismatch hardening at
    -- resolution (functions/api/community-pick-settlement-sweep.ts), the same
    -- protection functions/api/settle.ts already applies to real picks via
    -- lib/pages-functions/gamma.ts's outcomeOrderMismatch(). Without this, a market
    -- whose outcome order Polymarket changes between creation and resolution could
    -- silently mis-score every vote.
    source_outcomes JSONB NOT NULL,
    resolve_date TIMESTAMPTZ NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'open', -- 'open' | 'settled' | 'unresolvable'
    winning_side SMALLINT, -- 0 or 1, NULL until settled
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS community_picks_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    community_pick_id UUID NOT NULL REFERENCES community_picks(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    -- Nullable - unlinked Discord users can vote (this ledger never touches the real
    -- economy, so there's no integrity reason to require account linking here the way
    -- real picks do). Backfillable later if the user links afterward.
    linked_heatchecks_user_id UUID REFERENCES waitlist(id),
    side_chosen SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (community_pick_id, discord_user_id)
);

CREATE TABLE IF NOT EXISTS community_points (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL,
    discord_user_id VARCHAR(32) NOT NULL,
    linked_heatchecks_user_id UUID REFERENCES waitlist(id),
    points INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (guild_id, discord_user_id)
);

-- Append-only, source of truth (community_points.points is a derived cache kept in
-- sync incrementally at write time) - same "ledger is truth, balance is cache"
-- convention lib/pages-functions/ledger.ts's ember_ledger/ember_balances pair already
-- follows.
CREATE TABLE IF NOT EXISTS community_points_transactions (
    id BIGSERIAL PRIMARY KEY,
    guild_id VARCHAR(32) NOT NULL,
    discord_user_id VARCHAR(32) NOT NULL,
    delta INT NOT NULL,
    source_type VARCHAR(20) NOT NULL, -- 'tank' | 'community_pick'
    source_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE, -- 'points:<guildId>:<discordUserId>:<sourceType>:<sourceId>'
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_community_points_transactions_user ON community_points_transactions(guild_id, discord_user_id, created_at);

-- Heatchecks never supplies, holds, or distributes an actual prize - deliberately no
-- prize-value column here or anywhere in this file. This row's only output is which
-- Discord user was randomly selected; what a community does with that is entirely
-- outside this system.
CREATE TABLE IF NOT EXISTS community_giveaway_draws (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL,
    source_type VARCHAR(20) NOT NULL, -- 'tank' | 'community_pick'
    source_id TEXT NOT NULL,
    winner_discord_user_id VARCHAR(32) NOT NULL,
    drawn_by VARCHAR(32), -- NULL when auto-triggered rather than run by an admin
    drawn_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (guild_id, source_type, source_id) -- DB-enforced idempotency: a source can only ever be drawn once per guild
);
