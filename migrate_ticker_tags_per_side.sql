-- ticker_tags uniqueness becomes PER SIDE: (tank_id, ticker_key) -> (tank_id,
-- ticker_key, relevant_side).
--
-- WHY. The tag pipeline tags BOTH sides of every market, each side with every ticker
-- its frozen snapshot probability satisfies (see the side-rule note in
-- scripts/retrotag-tanks.ts). That design assumed the two sides always land on
-- DIFFERENT tickers - the underdog side on $DOGS, the favorite side on $CHALK - so one
-- row per (tank, ticker) was enough. The 0.5 pivot breaks the assumption: $CHALK's rule
-- is `p >= 0.5`, so on an exact pick'em ([0.5, 0.5]) BOTH sides are favorites and both
-- belong on $CHALK. Under the old constraint side 0's row blocked side 1's, which came
-- back 409 already_tagged and was logged as a benign skip.
--
-- The cost was not a missing row, it was a one-sided bet. Two sides of the same market
-- on one ticker cancel by construction - their tag deltas are mirror images and their
-- settle deltas are +(1-p) and -p, which at p=0.5 are exactly +/-5 - so a pick'em is
-- meant to contribute ~0 to $CHALK (the invariant isMarketFavorite's comment in
-- lib/pages-functions/tickers.ts already states). Half-tagged, it contributed a
-- coin-flip instead. Nine of the 115 Tanks published before this migration were exact
-- pick'ems, and all nine were half-tagged; two had already settled one-sided.
--
-- Also closes the latent 3-way case. The league rules explicitly anticipate three-way
-- soccer moneylines, where no side need reach 0.5 - there $DOGS (p < 0.5) and $MOONSHOT
-- (p < moonshot_max_prob) can match two or three sides of one market, and every side
-- past the first hit the same wall. No published Tank is 3-way yet.
--
-- Uniqueness itself is NOT relaxed: (tank, ticker, side) stays unique, so the 409 /
-- 23505 duplicate protection on a repeated POST is unchanged. Only the same ticker on a
-- DIFFERENT side of the same market becomes representable.
--
-- Run BEFORE deploying the matching ticker-tags.ts (its pre-check now includes
-- relevant_side; against the old constraint the second side would still fail on insert).
-- Order inside: the new index is created before the old constraint drops, so the table
-- is never briefly unprotected. The new index is strictly weaker, so every existing row
-- already satisfies it.
-- Safe to re-run: both steps are guarded.
-- Execute: psql "$DATABASE_URL" -f migrate_ticker_tags_per_side.sql

BEGIN;

-- 1. The per-side unique. Same 23505 the endpoint already maps to 409.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ticker_tags_tank_ticker_side
    ON ticker_tags(tank_id, ticker_key, relevant_side);

-- 2. Drop the old per-ticker unique (named by Postgres when create_ticker_tables.sql
--    declared it inline as UNIQUE (tank_id, ticker_key)).
ALTER TABLE ticker_tags DROP CONSTRAINT IF EXISTS ticker_tags_tank_id_ticker_key_key;

COMMIT;
