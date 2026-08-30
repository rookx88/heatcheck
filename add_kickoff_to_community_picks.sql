-- Game start time for Community Picks - voting closes at kickoff (previously votes
-- stayed open until the pick's generous 30-day resolve_date, letting people vote on
-- games already in progress). Populated at creation from the market's own
-- gameStartTime (admin flow) or the game's kickoff (weekly slate); nullable because
-- some markets (futures) have no discrete game start - those keep resolving-date
-- gating only.
-- Execute: psql -f add_kickoff_to_community_picks.sql "$DATABASE_URL"

ALTER TABLE community_picks ADD COLUMN IF NOT EXISTS kickoff_at TIMESTAMPTZ;
