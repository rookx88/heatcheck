-- Publish-time distribution for Tank content. 'newsletter_only' Tanks are excluded from
-- the static site build (scripts/generate-static-site.ts) and from the public pick
-- endpoint (functions/api/picks.ts) - the only surface that can render one is the signed
-- newsletter-pick landing page. Set once at publish time via PUT /api/tank/pages/:id
-- (backend.ts) and not changed afterward - same "first published" discipline as
-- published_at.
-- Execute: psql "$DATABASE_URL" -f add_visibility_to_tank_pages.sql

ALTER TABLE tank_pages ADD COLUMN IF NOT EXISTS visibility VARCHAR(20) NOT NULL DEFAULT 'app';
-- 'app' | 'newsletter_only'

CREATE INDEX IF NOT EXISTS idx_tank_pages_visibility ON tank_pages(visibility);
