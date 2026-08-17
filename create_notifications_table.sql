-- User-facing notifications (the pet toolbar's message feed). `type` maps to the two
-- exclamation-point colors: 'informational' vs 'claimable'. Settlement writes a
-- 'claimable' row from settleCall() (lib/pages-functions/ledger.ts), inside the same
-- transaction as the payout, keyed by idempotency_key so a re-run of settlement no-ops
-- the notification too.
--
-- read_at and claimed_at are DELIBERATELY INDEPENDENT: viewing/dismissing a message is
-- not the same action as collecting/revealing a reward, and conflating them was a real
-- bug caught during toolbar design. Neither field's write may imply the other. Claiming
-- is presentational this build - it stamps claimed_at and reveals what already happened
-- (the Ember was paid at settlement); it moves no Ember and rolls no item.
-- Execute: psql "$DATABASE_URL" -f create_notifications_table.sql

CREATE TABLE IF NOT EXISTS notifications (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id         UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    type            TEXT NOT NULL,             -- 'informational' | 'claimable'
    message         TEXT NOT NULL,
    ref_type        TEXT,                      -- what it's about, e.g. 'pick'; nullable/extensible
    ref_id          TEXT,                      -- e.g. the pick id for a settlement notification
    idempotency_key TEXT UNIQUE,               -- e.g. 'settle:call:<pickId>'; makes the settle insert a no-op on re-run
    read_at         TIMESTAMP WITH TIME ZONE,   -- viewing/dismissing - independent of claimed_at
    claimed_at      TIMESTAMP WITH TIME ZONE,   -- collecting/revealing - independent of read_at
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_created ON notifications(user_id, created_at DESC);
