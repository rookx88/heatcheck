-- SportsHeatCheck Database Schema - Teams, Players, Matchups, Rosters
-- Run this SQL script to set up the teams/players/matchups tables
-- This extends the existing posts table schema

-- Create teams table
CREATE TABLE IF NOT EXISTS teams (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    league VARCHAR(50) NOT NULL, -- NBA, NFL, EPL, etc.
    city VARCHAR(255),
    abbreviation VARCHAR(10),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(name, league) -- Ensure no duplicate team names per league
);

-- Create players table
CREATE TABLE IF NOT EXISTS players (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    team_id UUID REFERENCES teams(id) ON DELETE SET NULL,
    position VARCHAR(50),
    jersey_number INTEGER,
    is_active BOOLEAN DEFAULT true,
    metadata JSONB, -- Store additional info like height, weight, age, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create matchups table
CREATE TABLE IF NOT EXISTS matchups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    league VARCHAR(50) NOT NULL,
    team_a_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    team_b_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    scheduled_date DATE NOT NULL,
    scheduled_time TIME,
    game_status VARCHAR(50) DEFAULT 'scheduled', -- scheduled, in_progress, completed, cancelled
    venue VARCHAR(255),
    season VARCHAR(50), -- e.g., "2024-25"
    metadata JSONB, -- Store broadcast info, tickets, etc.
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create roster_snapshots table
CREATE TABLE IF NOT EXISTS roster_snapshots (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    matchup_id UUID REFERENCES matchups(id) ON DELETE SET NULL,
    snapshot_date DATE NOT NULL,
    players JSONB NOT NULL, -- Array of player IDs
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_teams_league ON teams(league);
CREATE INDEX IF NOT EXISTS idx_teams_name ON teams(name);
CREATE INDEX IF NOT EXISTS idx_players_team_id ON players(team_id);
CREATE INDEX IF NOT EXISTS idx_players_active ON players(is_active) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_matchups_league ON matchups(league);
CREATE INDEX IF NOT EXISTS idx_matchups_scheduled_date ON matchups(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_matchups_team_a ON matchups(team_a_id);
CREATE INDEX IF NOT EXISTS idx_matchups_team_b ON matchups(team_b_id);
CREATE INDEX IF NOT EXISTS idx_matchups_status ON matchups(game_status);
CREATE INDEX IF NOT EXISTS idx_roster_snapshots_team ON roster_snapshots(team_id);
CREATE INDEX IF NOT EXISTS idx_roster_snapshots_date ON roster_snapshots(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_roster_snapshots_matchup ON roster_snapshots(matchup_id) WHERE matchup_id IS NOT NULL;

-- Add comments
COMMENT ON TABLE teams IS 'Stores all sports teams across different leagues';
COMMENT ON TABLE players IS 'Stores player information linked to teams';
COMMENT ON TABLE matchups IS 'Stores scheduled games/matchups between teams';
COMMENT ON TABLE roster_snapshots IS 'Stores roster snapshots at specific dates for teams/matchups';












