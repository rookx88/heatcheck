-- SportsHeatCheck Database Schema
-- Run this SQL script to set up your PostgreSQL database
-- This schema uses JSONB for maximum flexibility - allows any content structure

-- Create the posts table with JSONB storage
-- Using JSONB allows flexible, schema-less content creation
CREATE TABLE IF NOT EXISTS posts (
    id UUID PRIMARY KEY,
    "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    "createdAt" TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    data JSONB NOT NULL
);

-- Create indexes for common query patterns (all use IF NOT EXISTS for safety)
-- These indexes help with performance but don't restrict what data can be stored
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts ((data->>'status')) WHERE data->>'status' IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_slug ON posts ((data->'websiteStory'->'seo'->>'slug')) WHERE data->'websiteStory'->'seo'->>'slug' IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_posts_updated_at ON posts ("updatedAt" DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts ("createdAt" DESC);
CREATE INDEX IF NOT EXISTS idx_posts_league ON posts ((data->>'league')) WHERE data->>'league' IS NOT NULL;

-- GIN index for full-text search on JSONB data (enables flexible querying)
-- This allows searching within the JSON structure without strict schema requirements
CREATE INDEX IF NOT EXISTS idx_posts_data_gin ON posts USING GIN (data);

-- Add a comment explaining the flexible structure
COMMENT ON TABLE posts IS 'Stores all post content as JSONB for maximum flexibility. No strict schema constraints.';
COMMENT ON COLUMN posts.data IS 'JSONB column containing the full post structure. Allows any valid JSON structure.';

-- Example queries to verify setup:
-- SELECT id, "updatedAt", data->>'status', data->'websiteStory'->>'headline' FROM posts ORDER BY "updatedAt" DESC LIMIT 10;
-- SELECT COUNT(*) FROM posts;


