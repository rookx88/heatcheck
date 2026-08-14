-- Adds newsletter-exclusive pick tracking to the existing picks table. source and
-- newsletter_issue_id are purely additive - independent of whatever base uniqueness
-- constraint governs picks.waitlist_id (one-pick-ever's idx_picks_waitlist_id, or the
-- daily-cap system's idx_picks_waitlist_tank from add_daily_pick_cap.sql, developed in
-- parallel with this file - whichever lands, this migration doesn't touch it).
--
-- IMPORTANT integration note for whichever migration/query owns the daily-cap count
-- (see functions/api/picks/today.ts and the DAILY_PICK_CAP check in
-- functions/api/picks.ts as of this writing): those COUNT(*) queries currently have no
-- source filter, so a newsletter_exclusive pick DOES count toward today's app cap unless
-- `AND source = 'app'` is added to them. That's the one-line change needed to make "an
-- exclusive pick doesn't count toward the daily cap" actually true once both features
-- are live together.
-- Execute: psql "$DATABASE_URL" -f add_newsletter_columns_to_picks.sql

ALTER TABLE picks ADD COLUMN IF NOT EXISTS source VARCHAR(20) NOT NULL DEFAULT 'app';
-- 'app' | 'newsletter_exclusive'
ALTER TABLE picks ADD COLUMN IF NOT EXISTS newsletter_issue_id UUID REFERENCES newsletter_issues(id);

-- One newsletter-exclusive pick per account per issue, enforced regardless of whatever
-- else governs picks.waitlist_id.
CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_newsletter_issue_per_user
    ON picks(waitlist_id, newsletter_issue_id) WHERE newsletter_issue_id IS NOT NULL;
