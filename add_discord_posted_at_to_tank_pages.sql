-- Idempotency marker for functions/api/discord-sweep.ts: NULL means "not yet posted
-- to the Discord channel", same convention published_at already uses for the site
-- itself. Set once, on successful post, and never touched again.
-- Execute: psql "$DATABASE_URL" -f add_discord_posted_at_to_tank_pages.sql

ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS discord_posted_at TIMESTAMPTZ;
