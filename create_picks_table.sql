-- Heatchecks Tank pick tracking - ONE pick total per account (email), ever.
-- Enforced by the unique index on waitlist_id below - that's the actual limit.
-- Run this SQL file against the main app database to create the table.
-- Execute: psql "$DATABASE_URL" -f create_picks_table.sql

CREATE TABLE IF NOT EXISTS picks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    waitlist_id UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    tank_page_id UUID NOT NULL REFERENCES tank_pages(id) ON DELETE CASCADE,
    tank_slug VARCHAR(255) NOT NULL,
    side VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_picks_waitlist_id ON picks(waitlist_id);
CREATE INDEX IF NOT EXISTS idx_picks_tank_page_id ON picks(tank_page_id);
