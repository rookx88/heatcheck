-- Links a Heatchecks account (waitlist row) to the Discord account it verified via
-- OAuth2 (functions/api/discord/link.ts + callback.ts). One-to-one both directions:
-- a Heatchecks account has at most one linked Discord account, and vice versa - the
-- interactions endpoint (functions/api/discord/interactions.ts) looks up waitlist_id
-- by discord_user_id to resolve who a button click in Discord belongs to.
-- Execute: psql "$DATABASE_URL" -f create_discord_links_table.sql

CREATE TABLE IF NOT EXISTS discord_links (
    waitlist_id UUID PRIMARY KEY REFERENCES waitlist(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    discord_username VARCHAR(255) NOT NULL,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_discord_links_discord_user_id ON discord_links(discord_user_id);
