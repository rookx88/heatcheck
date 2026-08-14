-- Stateful login sessions for the magic-link auth flow. The session cookie
-- (hc_session, see lib/pages-functions/session.ts) carries a signed pointer to a row
-- here; the row - not the token - is the source of truth for expiry and revocation.
-- 30-day sliding expiry, refreshed (throttled) on authenticated requests; logout sets
-- revoked_at rather than deleting, so a leaked cookie is killable server-side and the
-- row remains as an audit trail. Multiple live rows per user are expected - one per
-- device/login, no single-session constraint.
-- Execute: psql "$DATABASE_URL" -f create_sessions_table.sql

CREATE TABLE IF NOT EXISTS sessions (
    session_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
