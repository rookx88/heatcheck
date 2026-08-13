-- Adds email-verification state to the existing waitlist table. A code (not a link)
-- is emailed on signup; verifying is independent of the pick itself, which locks in
-- immediately regardless of verified status.
-- Execute: psql "$DATABASE_URL" -f add_email_verification_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS verification_code VARCHAR(6);
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS verification_code_expires_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS verification_attempts SMALLINT NOT NULL DEFAULT 0;
