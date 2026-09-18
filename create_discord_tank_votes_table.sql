-- Discord-only Tank calls: a member taps a side on a Tank card without an Ember pick
-- behind it (no linked account, onboarding not finished, or today's Ember picks used
-- up). The call still counts for the SERVER - Community Points, leaderboard, draws,
-- SR/XP - but never for Ember. Same isolation as create_community_picks_tables.sql:
-- no foreign key into and no write path to picks / ember_ledger / ember_balances.
--
-- One call per person per Tank, ACROSS guilds (UNIQUE tank_page_id, discord_user_id):
-- guild_id records where the call was made, which is the only guild it scores in. The
-- interactions handler also refuses a vote when a linked Ember pick already exists and
-- vice versa, so a person never has both on one Tank.
--
-- result/settled_at are written by functions/api/discord-settlement-sweep.ts from the
-- Tank's own market resolution (not inferred from other people's picks).
-- Execute: psql "$DATABASE_URL" -f create_discord_tank_votes_table.sql

CREATE TABLE IF NOT EXISTS discord_tank_votes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL,
    tank_page_id UUID NOT NULL REFERENCES tank_pages(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    -- Nullable, same as community_picks_votes: set when the voter was linked but
    -- couldn't make an Ember pick (not onboarded / daily cap).
    linked_heatchecks_user_id UUID REFERENCES waitlist(id) ON DELETE SET NULL,
    side TEXT NOT NULL,
    outcome_index SMALLINT NOT NULL,
    -- Frozen snapshot price of the chosen side at vote time - SR's difficulty term,
    -- the same role picks.implied_prob_at_lock plays for Ember picks.
    implied_prob_at_vote NUMERIC(6, 5) NOT NULL,
    result VARCHAR(10) CHECK (result IN ('correct', 'incorrect')),
    settled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tank_page_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_tank_votes_guild_user ON discord_tank_votes (guild_id, discord_user_id);
CREATE INDEX IF NOT EXISTS idx_discord_tank_votes_pending ON discord_tank_votes (guild_id, tank_page_id) WHERE result IS NULL;
