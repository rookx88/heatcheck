-- Season-long, opt-in leagues layered on top of the existing Community Points
-- system - purely a filtered view over community_points_transactions/community_picks,
-- no new points/economy of its own. Isolation from the real Ember/collectibles
-- economy is inherited from those tables; nothing here introduces a new write path
-- into them.
-- Execute: psql -f create_league_tables.sql "$DATABASE_URL"

CREATE TABLE IF NOT EXISTS league_seasons (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guild_configs(guild_id),
    -- Plain string, not a hard enum - 'NFL' only for now, but the schema doesn't
    -- assume it stays that way.
    sport VARCHAR(20) NOT NULL,
    start_date TIMESTAMPTZ NOT NULL,
    end_date TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- "At most one active season per (guild, sport)" is enforced at the application
-- level (end_date > NOW() isn't an immutable predicate, so it can't be a partial
-- unique index) - this index just makes that lookup fast. Historical seasons are
-- never deleted, so past standings stay queryable indefinitely.
CREATE INDEX IF NOT EXISTS idx_league_seasons_guild_sport ON league_seasons(guild_id, sport, end_date);

CREATE TABLE IF NOT EXISTS league_memberships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league_season_id UUID NOT NULL REFERENCES league_seasons(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (league_season_id, discord_user_id)
);
