-- Per-guild Discord config: which channel a given server wants Tank posts delivered
-- to. Set/updated by the /heatchecks-setup slash command (functions/api/discord/
-- interactions.ts). Replaces the old single flat DISCORD_CHANNEL_ID env var as the
-- bot moves from one hardcoded server to installable-anywhere.
-- Execute: psql "$DATABASE_URL" -f create_discord_guild_configs_table.sql

CREATE TABLE IF NOT EXISTS discord_guild_configs (
    guild_id VARCHAR(32) PRIMARY KEY,
    channel_id VARCHAR(32) NOT NULL,
    configured_by_discord_user_id VARCHAR(32) NOT NULL,
    configured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
