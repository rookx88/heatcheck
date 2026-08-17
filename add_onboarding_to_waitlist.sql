-- First-login welcome gate. NULL = the account has never signed the welcome letter
-- and every authenticated surface routes to /welcome/ until it does. Set exactly once
-- by the guarded UPDATE in functions/api/onboarding/complete.ts (WHERE onboarded_at IS
-- NULL), never by any other path - which is what makes the flow resumable if the tab
-- closes mid-letter. Existing accounts all start NULL, deliberately: they get the
-- founding-era variant of the letter on their next authenticated load.
-- No index: only ever read via the PK-joined waitlist row in getSession().
-- Execute: psql "$DATABASE_URL" -f add_onboarding_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS onboarded_at TIMESTAMP WITH TIME ZONE;
