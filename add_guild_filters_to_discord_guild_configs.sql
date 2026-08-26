-- Per-guild sport filtering (/heatchecks-config) and the auto-draw opt-in
-- (/heatchecks-draw's automatic-trigger mode). Opt-OUT model for sports: an empty
-- array is the default, so every existing server keeps posting every sport with zero
-- behavior change until an admin actually runs /heatchecks-config.
-- Execute: psql "$DATABASE_URL" -f add_guild_filters_to_discord_guild_configs.sql

ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS disabled_sports JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS auto_draw_enabled BOOLEAN NOT NULL DEFAULT false;
