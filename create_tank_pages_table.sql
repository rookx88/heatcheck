-- Heatchecks Tank generated pages
-- Run this SQL file against the main app database to create the table.
-- Execute: psql "$DATABASE_URL" -f create_tank_pages_table.sql

CREATE TABLE IF NOT EXISTS tank_pages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug VARCHAR(255),
    provider VARCHAR(50) NOT NULL,         -- which PropProvider produced the source prop ("mock" | "polymarket")
    league VARCHAR(50) NOT NULL,
    angle TEXT NOT NULL,                   -- curator's one-line reason this prop has a story
    game_snapshot JSONB NOT NULL,          -- frozen { prop, game } exactly as the curator saw it
    model_output JSONB,                    -- parsed TankArticle (seo/body/hook/cards/call), null if generation failed
    raw_output TEXT,                       -- raw model text, populated only when parsing/validation failed
    generation_error TEXT,
    status VARCHAR(20) NOT NULL DEFAULT 'draft', -- 'draft' | 'published'
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    published_at TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tank_pages_slug ON tank_pages(slug) WHERE slug IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tank_pages_status ON tank_pages(status);
CREATE INDEX IF NOT EXISTS idx_tank_pages_league ON tank_pages(league);
CREATE INDEX IF NOT EXISTS idx_tank_pages_created_at ON tank_pages(created_at DESC);
