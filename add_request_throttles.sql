-- Per-IP request throttles + a daily cap on verification-code resends (launch audit,
-- 2026-09-07). See lib/pages-functions/throttle.ts for the model and the buckets.
--
-- request_throttles: one row per (endpoint bucket, client IP), fixed windows. The
-- upsert in throttle.ts is the only writer; functions/api/notify-sweep.ts prunes rows
-- whose window ended more than a day ago, so the table never grows past active IPs.
--
-- waitlist.verification_codes_sent_on / _today: the same daily-cap pair
-- add_login_link_to_waitlist.sql gave login links, for the 6-digit verification
-- code. Before this, functions/api/resend-verification.ts had only a 60-second
-- cooldown - 1,440 emails a day per address, from anyone, at any address that
-- /api/login had ever upserted - and every resend reset verification_attempts, so
-- the 5-attempt guard in verify-email.ts never actually locked anything out.
-- Execute: psql "$DATABASE_URL" -f add_request_throttles.sql

CREATE TABLE IF NOT EXISTS request_throttles (
    bucket       TEXT NOT NULL,
    subject      TEXT NOT NULL,                     -- the client IP (CF-Connecting-IP)
    window_start TIMESTAMP WITH TIME ZONE NOT NULL,
    count        INT NOT NULL,
    PRIMARY KEY (bucket, subject)
);

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS verification_codes_sent_on DATE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS verification_codes_sent_today SMALLINT NOT NULL DEFAULT 0;
