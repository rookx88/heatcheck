-- Hall of Fame (the Tank Land leaderboard, 2026-09-10): a second derived counter on
-- ember_balances - lifetime_earned - so the top-100-by-Ember-earned ranking is one
-- indexed ORDER BY rather than a full aggregate over every user's ledger per request.
--
-- Definition (the backfill below, ledger.ts's rebuildBalance(), and every incremental
-- write in ledger.ts MUST agree on it):
--
--   lifetime_earned =
--       SUM(amount) over ember_ledger
--           WHERE entry_type = 'earn' AND rule_key IN ('correct_call','participation','discovery_find')
--     + SUM(GREATEST(FLOOR(realized_pnl), 0)) over share_trades WHERE side = 'sell'
--
-- i.e. game earnings (settlement payouts, the loss consolation, pet discovery finds)
-- plus the PROFIT half of TANKDAQ sells. Share-sell proceeds themselves are not
-- earnings (a buy/sell round trip at one price must not inflate the number), losses
-- never subtract, and 'adjustment' rows never count - the entry_type guard matters
-- because the acceptance harness's seed rows borrow the 'participation' rule key with
-- entry_type 'adjustment' (scripts/acceptance/fixtures.ts seedBalance). Per-trade FLOOR so an
-- integer counter can be maintained incrementally and re-derived identically;
-- realized_pnl is NUMERIC(14,4), and the incremental write in ledger.ts rounds to 4 dp
-- before flooring for the same reason.
--
-- Like balance, this column is a derived cache, never the source of truth: the ledger
-- and share_trades remain reconstructable inputs (rebuildBalance() resets both columns).
--
-- Deploy ORDER matters: run this before deploying the ledger.ts that writes the column,
-- or every settle / discovery / sell write fails on the missing column.
--
-- CONCURRENTLY for the index (the database is live, shared by preview and production)
-- cannot run inside a transaction block, so this file has no BEGIN/COMMIT - psql runs
-- each statement in autocommit. The ALTER and the backfill are each idempotent
-- (IF NOT EXISTS / a pure recompute), so re-running the whole file is safe.
-- Execute: psql "$DATABASE_URL" -f add_lifetime_earned_to_ember_balances.sql

ALTER TABLE ember_balances ADD COLUMN IF NOT EXISTS lifetime_earned INT NOT NULL DEFAULT 0;

-- Defensive: every ledger write upserts an ember_balances row in the same statement,
-- so no ledger user should lack one - but a missing row would drop that user from the
-- backfill's UPDATE (and the leaderboard) silently. Give them a zero row first.
INSERT INTO ember_balances (user_id, balance, updated_at)
SELECT l.user_id, COALESCE(SUM(l.amount), 0), NOW()
FROM ember_ledger l
LEFT JOIN ember_balances b ON b.user_id = l.user_id
WHERE b.user_id IS NULL
GROUP BY l.user_id
ON CONFLICT (user_id) DO NOTHING;

-- Backfill from the definition. A pure recompute over every row, so re-running it after
-- the incremental writes have been live for a while is a consistency check, not a
-- double count.
UPDATE ember_balances b
SET lifetime_earned = COALESCE(g.total, 0) + COALESCE(t.profit, 0)
FROM ember_balances b2
LEFT JOIN (
    SELECT user_id, SUM(amount)::int AS total
    FROM ember_ledger
    WHERE entry_type = 'earn' AND rule_key IN ('correct_call', 'participation', 'discovery_find')
    GROUP BY user_id
) g ON g.user_id = b2.user_id
LEFT JOIN (
    SELECT user_id, SUM(GREATEST(FLOOR(realized_pnl), 0))::int AS profit
    FROM share_trades
    WHERE side = 'sell'
    GROUP BY user_id
) t ON t.user_id = b2.user_id
WHERE b.user_id = b2.user_id;

-- The leaderboard's ORDER BY. Rows with lifetime_earned = 0 are excluded by the query
-- (WHERE lifetime_earned > 0), but a partial index would need that predicate copied
-- exactly and buys little on a table with one row per user - a plain DESC index serves
-- both the ranked page and the "1 + COUNT(*) WHERE lifetime_earned > mine" rank probe.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ember_balances_lifetime_earned
    ON ember_balances (lifetime_earned DESC);
