-- Per-(guild, Tank) posting idempotency, replacing tank_pages.discord_posted_at now
-- that a Tank can post to N guilds independently (that column could only ever express
-- "posted somewhere", not "posted to guild A but not yet to guild B" - left in place,
-- just unused going forward, not worth migrating one guild's existing rows over).
-- settlement_posted_at is the matching idempotency marker for the settlement-
-- announcement sweep (functions/api/discord-settlement-sweep.ts) - a second lifecycle
-- event against the same (guild, Tank) pair, not a new table, since it only ever
-- applies to a pair that already has an original post row.
-- Execute: psql "$DATABASE_URL" -f create_discord_guild_posts_table.sql

CREATE TABLE IF NOT EXISTS discord_guild_posts (
    guild_id VARCHAR(32) NOT NULL,
    tank_page_id UUID NOT NULL REFERENCES tank_pages(id) ON DELETE CASCADE,
    message_id VARCHAR(32) NOT NULL,
    posted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    settlement_posted_at TIMESTAMPTZ,
    PRIMARY KEY (guild_id, tank_page_id)
);
