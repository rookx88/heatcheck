-- Underdog-weighted Community Points: side_a_points/side_b_points are computed ONCE
-- at pick creation from the market's own implied probability (see
-- lib/pages-functions/community-pick-creation.ts) and never recomputed - the number
-- shown on the card the moment it posts is exactly what pays out for that pick's
-- whole life. DEFAULT 50/50 is a safety net only; the application always computes
-- and sets both explicitly at insert time.
-- Execute: psql "$DATABASE_URL" -f add_weighted_community_pick_scoring.sql

ALTER TABLE community_picks ADD COLUMN IF NOT EXISTS side_a_points INT NOT NULL DEFAULT 50;
ALTER TABLE community_picks ADD COLUMN IF NOT EXISTS side_b_points INT NOT NULL DEFAULT 50;

-- Sport tag, needed by the NFL league leaderboard's filter ("this pick counts toward
-- the NFL league") - nullable since older/ad-hoc picks may not have one.
ALTER TABLE community_picks ADD COLUMN IF NOT EXISTS sport VARCHAR(20);

-- Auto-generated weekly league-slate picks have no admin behind them.
ALTER TABLE community_picks ALTER COLUMN created_by DROP NOT NULL;

-- Idempotency for the weekly slate job: the same market can't create two Community
-- Picks for the same guild, whether from a retried cron run or an admin accidentally
-- re-searching a market the slate already posted.
CREATE UNIQUE INDEX IF NOT EXISTS idx_community_picks_guild_market ON community_picks(guild_id, source_market_id);
