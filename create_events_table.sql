-- Heatchecks analytics events - append-only funnel/read-depth ledger.
-- visitor_id is a separate, ANONYMOUS, analytics-only identifier (localStorage,
-- crypto.randomUUID()) - it has no bearing on the one-pick-per-account limit,
-- which stays keyed to email/waitlist_id. waitlist_id here is populated once/if
-- a visitor converts, so anonymous pre-signup history can be bridged to the
-- permanent account by matching visitor_id across rows.
-- Execute: psql "$DATABASE_URL" -f create_events_table.sql

CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    visitor_id UUID NOT NULL,
    waitlist_id UUID REFERENCES waitlist(id) ON DELETE SET NULL,
    event_type VARCHAR(50) NOT NULL,   -- 'page_view' | 'tank_opened' | 'wall_viewed' | 'pick_submitted' | 'pick_conflict' | 'email_verified' | 'newsletter_opt_in'
    path VARCHAR(255),                 -- URL path, for page_view
    tank_slug VARCHAR(255),            -- which tank, when applicable
    wall_kind VARCHAR(20),             -- 'hook' | 'card' | 'call', for wall_viewed
    metadata JSONB,                    -- room for anything event-specific without a migration
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_events_visitor_id ON events(visitor_id);
CREATE INDEX IF NOT EXISTS idx_events_waitlist_id ON events(waitlist_id);
CREATE INDEX IF NOT EXISTS idx_events_type_created ON events(event_type, created_at DESC);
