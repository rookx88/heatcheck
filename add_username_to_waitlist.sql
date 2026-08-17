-- The in-world "signature" chosen when signing the first-login welcome letter
-- (functions/api/onboarding/complete.ts). Stored exactly as typed so display case is
-- the user's choice; uniqueness is case-insensitive via the partial index on
-- LOWER(username) - same pattern as idx_waitlist_email - which also skips the
-- (initially universal) NULL rows. username_updated_at is written now even though
-- rate-limited renaming isn't built yet: cheap to record today, expensive to backfill
-- "when was this last changed" later.
-- Execute: psql "$DATABASE_URL" -f add_username_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS username TEXT;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS username_updated_at TIMESTAMP WITH TIME ZONE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_username_lower
    ON waitlist (LOWER(username)) WHERE username IS NOT NULL;
