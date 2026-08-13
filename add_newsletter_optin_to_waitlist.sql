-- Adds newsletter opt-in state to the existing waitlist table. Opt-in happens from the
-- "You're All Set" modal shown right after email verification - a separate action from
-- verification itself, so it gets its own flag/timestamp rather than piggybacking on
-- email_verified.
-- Execute: psql "$DATABASE_URL" -f add_newsletter_optin_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS newsletter_opt_in BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS newsletter_opted_in_at TIMESTAMP WITH TIME ZONE;
