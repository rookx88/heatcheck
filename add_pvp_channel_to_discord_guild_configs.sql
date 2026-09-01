-- A dedicated channel for PvP, plus separate control over the challenge announcement.
--
-- Until now both PvP posts (the challenge ping and the settlement recap) went to the
-- guild's main channel, and only the recap could be silenced. A server that wants a
-- #pvp channel had no way to say so, and a server that wanted results announced but
-- challenges quiet (or the reverse) had one switch for two different posts.
--
-- pvp_channel_id is nullable and means "use the main channel" when unset, so existing
-- guilds keep their current behavior with no backfill. It is read only at challenge
-- creation - pvp_battles.channel_id is snapshotted there, so battles already running
-- when an admin changes this still post their result where they started.
--
-- Execute: psql "$DATABASE_URL" -f add_pvp_channel_to_discord_guild_configs.sql

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS pvp_channel_id VARCHAR(32);

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS pvp_announce_challenges BOOLEAN NOT NULL DEFAULT TRUE;
