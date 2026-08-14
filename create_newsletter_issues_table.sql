-- One row per weekly newsletter send. tank_slug is the Tank published with
-- visibility = 'newsletter_only' for that week (see add_visibility_to_tank_pages.sql);
-- this_week_recap/lore_* are authored/approved via the admin Newsletter Issue panel before
-- send-issue will send (content_approved_at gates it - see functions/api/newsletter/send-issue.ts).
-- Must run before add_newsletter_columns_to_picks.sql, which adds a FK to this table.
--
-- tank_slug is NOT a DB-enforced FK to tank_pages(slug): slug is nullable and only
-- partially unique (idx_tank_pages_slug is `UNIQUE ... WHERE slug IS NOT NULL`), which
-- Postgres won't accept as an FK target. picks.tank_slug already follows the same
-- denormalized-convenience-column precedent for the same reason (see
-- create_picks_table.sql - its real FK is tank_page_id, not tank_slug).
-- Execute: psql "$DATABASE_URL" -f create_newsletter_issues_table.sql

CREATE TABLE IF NOT EXISTS newsletter_issues (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    week_key            VARCHAR(10) NOT NULL,             -- '2026-W34'
    tank_slug           VARCHAR(255) NOT NULL,
    this_week_recap     TEXT,
    lore_title          TEXT,
    lore_body           TEXT,
    content_approved_at TIMESTAMP WITH TIME ZONE,
    sent_at             TIMESTAMP WITH TIME ZONE,
    created_at          TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_issues_week_key ON newsletter_issues(week_key);
