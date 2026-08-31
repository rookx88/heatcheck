-- Per-guild PvP controls (see create_pvp_tables.sql for the feature itself).
--
-- pvp_results_visibility is deliberately SEPARATE from settlement_visibility rather
-- than reusing it: a server can want its Tank/Community Pick settlement recaps kept
-- private (members pull them with /my-results) while still wanting head-to-head PvP
-- results announced in the channel - a battle is a public event, its challenge was
-- already pinged there. Defaulting to 'channel' means PvP results post unless a guild
-- opts out, independent of whatever settlement_visibility is set to.
--
-- Execute: psql "$DATABASE_URL" -f add_pvp_config_to_discord_guild_configs.sql

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS pvp_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS pvp_results_visibility VARCHAR(20) NOT NULL DEFAULT 'channel';
