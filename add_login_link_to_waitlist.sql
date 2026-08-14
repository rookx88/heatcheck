-- Magic-link login state on the waitlist row itself - same columns-on-the-row
-- precedent as the 6-digit verification code (add_email_verification_to_waitlist.sql),
-- rather than a separate login_tokens table. One outstanding login link per account:
-- issuing a new link rotates login_nonce, which invalidates the previous link, and
-- consumption NULLs it, so single-use falls out of one guarded UPDATE with no cleanup
-- job. The last three columns back the rate limit (1 per 60s, 10 per UTC day) enforced
-- in functions/api/login.ts.
-- Execute: psql "$DATABASE_URL" -f add_login_link_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS login_nonce UUID;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS login_nonce_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS login_link_last_sent_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS login_links_sent_on DATE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS login_links_sent_today SMALLINT NOT NULL DEFAULT 0;
