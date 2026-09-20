-- A guild the bot can no longer reach stops being swept (2026-09-20).
--
-- Found live: the Discord posting sweep failed 10 of its posts every run against guild
-- 1543442932416249949, which returns 404 from Discord - the bot was removed from that
-- server (or the server is gone), but its config row stayed, so every sweep retried it
-- forever and the hourly health check alerted about the failing job every day.
--
-- The config is NOT deleted: it carries the admin's channel choice, sport filters, daily
-- limit and label settings, and someone re-inviting the bot should get their setup back
-- rather than a blank slate. It is marked unreachable instead, the scheduled posting
-- sweeps skip it, and the wizard clears the mark when setup runs again.
--
-- Execute: psql "$DATABASE_URL" -f add_guild_unreachable.sql

BEGIN;

ALTER TABLE discord_guild_configs
    ADD COLUMN IF NOT EXISTS unreachable_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS unreachable_reason TEXT;

COMMIT;
