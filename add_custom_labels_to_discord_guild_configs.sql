-- Per-guild display-name overrides for "Community Points" and "Leaderboard", set via
-- /heatchecks-config. NULL means "use the default" everywhere these render
-- (lib/pages-functions/discord-api.ts#getGuildLabels is the one place that resolves
-- the fallback) - purely cosmetic, no effect on the underlying points/ranking logic.
-- Execute: psql "$DATABASE_URL" -f add_custom_labels_to_discord_guild_configs.sql

ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS community_points_label TEXT;
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS leaderboard_label TEXT;
