-- Setup-wizard settings (lib/pages-functions/discord-setup-wizard.ts) + per-pick
-- giveaways. All defaults preserve current behavior exactly - existing guilds change
-- nothing until an admin walks the wizard or touches /heatchecks-config.
-- Execute: psql -f add_setup_wizard_columns.sql "$DATABASE_URL"

-- Tank posting on/off (step 6) - the daily sweep skips guilds that turned it off.
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS tank_posts_enabled BOOLEAN NOT NULL DEFAULT TRUE;

-- Daily Tank post cap (step 6): NULL = post everything (today's behavior), else max
-- per sweep-day, newest first after the sport filter.
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS daily_post_limit SMALLINT;

-- Extra channels Community Picks may be posted into (step 4) - the main channel_id
-- always remains valid too.
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS community_pick_channel_ids JSONB NOT NULL DEFAULT '[]';

-- Weekly leaderboard auto-post (step 9): array of views to post, subset of
-- ["community","accuracy","sr"]. Empty = off.
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS weekly_leaderboard JSONB NOT NULL DEFAULT '[]';

-- Step 10: when TRUE, member-facing commands (/leaderboard, /me) reply ephemerally.
ALTER TABLE discord_guild_configs ADD COLUMN IF NOT EXISTS ephemeral_user_commands BOOLEAN NOT NULL DEFAULT FALSE;

-- Per-pick giveaway (companion feature): how many winners to draw from CORRECT
-- voters at settlement. 0 = no giveaway (default). The standing non-negotiable is
-- unchanged: winners are named, never paid - no prize column exists anywhere.
ALTER TABLE community_picks ADD COLUMN IF NOT EXISTS giveaway_winner_count SMALLINT NOT NULL DEFAULT 0;

-- Multi-winner draws: one row per winner slot. Existing rows become slot 1; the old
-- one-draw-per-source unique key widens to include the slot so N-winner draws stay
-- DB-enforced idempotent per slot.
ALTER TABLE community_giveaway_draws ADD COLUMN IF NOT EXISTS winner_slot SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE community_giveaway_draws DROP CONSTRAINT IF EXISTS community_giveaway_draws_guild_id_source_type_source_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS idx_giveaway_draws_source_slot
    ON community_giveaway_draws(guild_id, source_type, source_id, winner_slot);
