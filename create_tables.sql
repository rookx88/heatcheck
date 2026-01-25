-- Run this SQL file to create the teams, players, and matchups tables
-- Execute: psql -U postgres -d heatchecks -f create_tables.sql

-- Create teams table
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    league VARCHAR(50) NOT NULL,
    city VARCHAR(255),
    abbreviation VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(name, league)
);

-- Create matchups table
CREATE TABLE IF NOT EXISTS matchups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league VARCHAR(50) NOT NULL,
    team_a_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    team_b_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    scheduled_date DATE NOT NULL,
    scheduled_time TIME,
    game_status VARCHAR(50) DEFAULT 'scheduled',
    venue VARCHAR(255),
    metadata JSONB,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league);
CREATE INDEX IF NOT EXISTS idx_matchups_league ON matchups(league);
CREATE INDEX IF NOT EXISTS idx_matchups_scheduled_date ON matchups(scheduled_date);














