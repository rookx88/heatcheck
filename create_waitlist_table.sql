-- Heatchecks beta waitlist signups
-- Run this SQL file against the main app database to create the table.
-- Execute: psql "$DATABASE_URL" -f create_waitlist_table.sql

CREATE TABLE IF NOT EXISTS waitlist (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    email VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(LOWER(email));
