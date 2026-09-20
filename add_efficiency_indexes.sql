-- Six indexes for predicates found unsupported by the efficiency audit's Category 3
-- completion pass (2026-09-19). Same rules as add_hot_path_indexes.sql, which this
-- continues: every partial WHERE below is copied character-for-character from the query
-- it serves (Postgres only uses a partial index when the query's predicate implies the
-- index's), CONCURRENTLY because the database is live and shared, and therefore no
-- BEGIN/COMMIT - psql runs each statement in autocommit. An interrupted CONCURRENTLY
-- build leaves an INVALID index; DROP it and re-run (IF NOT EXISTS would skip it).
--
-- Additive only: an index never changes a result, so the acceptance harness must pass
-- identically before and after.
-- Execute: psql "$DATABASE_URL" -f add_efficiency_indexes.sql

-- ops_events / ops_job_runs (create_ops_tables.sql, shipped 2026-09-19): five of the six
-- queries behind the hourly health check are time-RANGE scans with no equality on the
-- leading column of either existing index, so they scan the whole table. ops_events is
-- written by functions/_middleware.ts on every rejection and 5xx - it grows fastest
-- exactly during an attack, which is when the detector must still finish on time.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ops_events_created
    ON ops_events (created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ops_job_runs_created
    ON ops_job_runs (created_at DESC);

-- picks: the pick-history page (functions/api/picks/mine.ts) paginates by keyset on
-- (settled_at, id) and orders by the same pair, but the only index leading with
-- waitlist_id orders by created_at - so every page re-reads and re-sorts the account's
-- entire settled history. Also serves functions/api/tankdaq/overlay.ts's settled window.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_picks_waitlist_settled
    ON picks (waitlist_id, settled_at DESC, id DESC)
    WHERE result IS NOT NULL;

-- ticker_events: the held_through_close EXISTS inside toolbar-state's encounter facts
-- (lib/pages-functions/encounters/evaluate.ts) runs on EVERY page load for a pet owner.
-- The existing (ticker_key, occurred_at) index covers the range, but source/event_type
-- stay heap rechecks over a set that grows with every tag and settle on that ticker -
-- to find the ~1 close row per day that matters.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticker_events_slate_close_time
    ON ticker_events (ticker_key, occurred_at)
    WHERE source = 'slate' AND event_type = 'close';

-- index_positions: getTickerResults (lib/pages-functions/tickers.ts) ranks each index's
-- recent settled positions for the homepage and the detail page. The existing
-- (ticker_key, settled_at) index gives the ordering but both filters recheck the heap
-- across every position ever locked.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_index_positions_results
    ON index_positions (ticker_key, settled_at DESC)
    WHERE result IN ('win', 'loss') AND close_id IS NOT NULL;

-- ember_balances: lib/pages-functions/standing.ts counts the prefix of accounts above
-- the viewer's lifetime_earned on every account-page load, and hall-of-fame orders the
-- same set. Narrowing to accounts that have actually earned keeps both off the rows
-- that can never rank.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ember_balances_earned_positive
    ON ember_balances (lifetime_earned DESC)
    WHERE lifetime_earned > 0;

-- waitlist: notify-sweep's daily digest inserts one notification per opted-in onboarded
-- account, three times a day, via a full scan of the user table. Linear in signups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_waitlist_daily_drop
    ON waitlist (id)
    WHERE onboarded_at IS NOT NULL AND notify_daily_drop;
