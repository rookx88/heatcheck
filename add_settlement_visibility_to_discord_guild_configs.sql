-- Lets an admin make settlement announcements private instead of posting to the
-- channel - 'channel' (today's behavior) or 'private' (no recap posted; members
-- check their own results via /my-results instead, an ephemeral response Discord
-- shows only to them). Community Points are still awarded either way regardless of
-- this setting - only the channel announcement is gated. Defaults to 'channel' so
-- every existing guild's behavior is unchanged until an admin opts in.
-- Execute: psql -f add_settlement_visibility_to_discord_guild_configs.sql "$DATABASE_URL"

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS settlement_visibility VARCHAR(10) NOT NULL DEFAULT 'channel';
