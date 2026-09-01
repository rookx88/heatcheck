-- PvP battles - a head-to-head, 3-pick ladder between two members of one guild.
-- Structurally its OWN thing: nothing in this file references (or is referenced by)
-- ember_ledger, ember_balances, picks, community_picks(_votes),
-- community_points(_transactions), or any shop/inventory table. Stricter than the
-- Community Picks ledger even - there is no linked_heatchecks_user_id column here at
-- all, so this file has no reference to waitlist either. A PvP pick awards ZERO
-- Community Points; a battle's only outputs are its own result row and one public
-- recap post. That isolation is the whole reason the feature can exist without
-- touching the site's Ember economy.
--
-- Scoring reuses the SAME underdog-weighted formula Community Points use
-- (lib/pages-functions/community-points-formula.ts#computePointsSplit): a correct
-- pick pays round(100 x the OPPOSING side's implied probability), locked once from a
-- fresh Gamma fetch at submission and never recomputed. Reusing the formula is
-- deliberate; reusing the ledger is forbidden.
--
-- Execute: psql "$DATABASE_URL" -f create_pvp_tables.sql

CREATE TABLE IF NOT EXISTS pvp_battles (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id VARCHAR(32) NOT NULL REFERENCES discord_guild_configs(guild_id),
    -- Snapshotted at creation so the result lands where the challenge line landed,
    -- even if an admin repoints the guild's main channel mid-battle.
    channel_id VARCHAR(32) NOT NULL,
    challenger_id VARCHAR(32) NOT NULL,
    opponent_id VARCHAR(32) NOT NULL,
    -- 'pending' -> 'active' (accepted) -> 'settled'
    -- 'pending' -> 'declined' (opponent said no) | 'cancelled' (challenger withdrew)
    --            | 'expired'  (nobody answered inside 24h)
    -- There is deliberately NO 'void' state: once accepted, a battle ALWAYS scores.
    -- A player who submitted nothing scores 0 and loses; partial submissions (1 or 2
    -- picks) score on what was submitted. See functions/api/pvp-settlement-sweep.ts.
    status VARCHAR(20) NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- An unanswered challenge dies on its own rather than sitting on the ladder
    -- forever (and permanently blocking this pair via the live-pair index below).
    expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours',
    accepted_at TIMESTAMPTZ,
    -- accepted_at + 24h, materialized rather than computed so the settlement sweep's
    -- "submission window has closed" predicate is a plain indexable comparison.
    picks_close_at TIMESTAMPTZ,
    settled_at TIMESTAMPTZ,
    -- NULL until settled. Sum of points_awarded over that player's own picks.
    challenger_score INT,
    opponent_score INT,
    -- 'challenger' | 'opponent' | 'draw' - the AUTHORITATIVE result field.
    outcome VARCHAR(12),
    -- Convenience denormalization; NULL on a draw and while unsettled, which is why
    -- lib/pages-functions/pvp-record.ts keys losses off outcome <> 'draw' first.
    winner_discord_user_id VARCHAR(32),
    -- TRUE when the sweep's 7-day backstop force-settled with picks still unresolved
    -- (those picks counted 0), rather than letting one dead Polymarket market pin
    -- this pair out of PvP forever.
    stale_settled BOOLEAN NOT NULL DEFAULT FALSE,
    -- The public one-line @mention announcing the challenge. Nullable: the battle
    -- still exists if that post failed.
    challenge_message_id VARCHAR(32),
    -- Idempotency marker for the public result post, stamped only AFTER a successful
    -- post - same posted-once posture as discord_guild_posts.settlement_posted_at.
    result_posted_at TIMESTAMPTZ,
    CONSTRAINT pvp_battles_distinct_players CHECK (challenger_id <> opponent_id)
);

-- One live battle per PAIR per guild, direction-agnostic: while A vs B is pending or
-- active, neither A->B nor B->A can be created again. LEAST/GREATEST normalizes the
-- pair so the index doesn't care who challenged whom.
CREATE UNIQUE INDEX IF NOT EXISTS idx_pvp_battles_live_pair
    ON pvp_battles (guild_id, LEAST(challenger_id, opponent_id), GREATEST(challenger_id, opponent_id))
    WHERE status IN ('pending', 'active');

-- The sweep's two hot predicates.
CREATE INDEX IF NOT EXISTS idx_pvp_battles_active ON pvp_battles(status, picks_close_at);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_pending ON pvp_battles(status, expires_at);
-- The /pvp hub listing and the /me W-D-L read.
CREATE INDEX IF NOT EXISTS idx_pvp_battles_challenger ON pvp_battles(guild_id, challenger_id, status);
CREATE INDEX IF NOT EXISTS idx_pvp_battles_opponent ON pvp_battles(guild_id, opponent_id, status);

CREATE TABLE IF NOT EXISTS pvp_battle_picks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    battle_id UUID NOT NULL REFERENCES pvp_battles(id) ON DELETE CASCADE,
    discord_user_id VARCHAR(32) NOT NULL,
    -- 1..3. Together with the (battle, user, slot) unique index below, this is what
    -- caps a player at three picks AT THE DATABASE LEVEL - not an application
    -- COUNT(*) check that two concurrent submits could both pass.
    slot SMALLINT NOT NULL CHECK (slot BETWEEN 1 AND 3),
    sport VARCHAR(20),
    source_market_id TEXT NOT NULL,
    question_text TEXT NOT NULL,
    side_a_label TEXT NOT NULL,
    side_b_label TEXT NOT NULL,
    -- LIVE Gamma outcome names snapshotted at submission, positionally parallel to
    -- [side_a_label, side_b_label]. Exists for exactly the reason
    -- community_picks.source_outcomes does: without it, a market Polymarket reorders
    -- could silently invert a settled battle.
    source_outcomes JSONB NOT NULL,
    side_chosen SMALLINT NOT NULL CHECK (side_chosen IN (0, 1)),
    -- The underdog-weighted payout for THE CHOSEN SIDE, locked from a fresh Gamma
    -- fetch at submission and never recomputed - same discipline as
    -- community_picks.side_a_points / side_b_points.
    points_if_correct INT NOT NULL,
    -- Game start. A pick can only be made before this, and the sweep doesn't spend a
    -- Gamma request on it until it has passed. Nullable for markets with no discrete
    -- game start (futures).
    kickoff_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    -- Resolution. points_awarded IS NULL is the sweep's "this battle is still waiting
    -- on something" predicate; once resolved it is either 0 or points_if_correct.
    winning_side SMALLINT,
    points_awarded INT,
    resolved_at TIMESTAMPTZ,
    -- Can't pick the same market twice in one battle.
    UNIQUE (battle_id, discord_user_id, source_market_id),
    -- Three slots, one row each - the hard 3-pick cap.
    UNIQUE (battle_id, discord_user_id, slot)
);

CREATE INDEX IF NOT EXISTS idx_pvp_battle_picks_battle_user ON pvp_battle_picks(battle_id, discord_user_id);
-- Phase 1 of the sweep: unresolved picks whose game has already kicked off.
CREATE INDEX IF NOT EXISTS idx_pvp_battle_picks_unresolved ON pvp_battle_picks(kickoff_at) WHERE points_awarded IS NULL;
