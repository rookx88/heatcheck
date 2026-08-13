-- Moves picks from "one per account, ever" to "up to 3 per account per day" (still one
-- pick per Tank per account - no re-picking the same prop). Part of the settlement
-- finalization spec's daily pick cap.
--
-- idx_picks_waitlist_id enforced the old one-ever rule with no per-tank concept at all;
-- simply dropping it without replacing it would silently allow picking the SAME tank
-- twice, which nothing else in the schema prevents. idx_picks_waitlist_tank replaces it
-- with a DB-enforced, race-safe "at most one pick per (account, tank)" instead.
--
-- The "at most 3 per day" volume cap itself is NOT a DB constraint (Postgres can't
-- express "at most N rows" declaratively) - it's an app-level COUNT(*) check in
-- functions/api/picks.ts. idx_picks_waitlist_created just makes that count query fast.
-- Execute: psql "$DATABASE_URL" -f add_daily_pick_cap.sql

DROP INDEX IF EXISTS idx_picks_waitlist_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_waitlist_tank ON picks(waitlist_id, tank_page_id);
CREATE INDEX IF NOT EXISTS idx_picks_waitlist_created ON picks(waitlist_id, created_at);
