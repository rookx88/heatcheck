-- Six indexes for production predicates that had no supporting index (efficiency audit,
-- 2026-09-04, category 3). Every partial-index WHERE clause below is copied
-- character-for-character from the query it serves: Postgres only uses a partial index
-- when the query's own predicate implies the index's, so the shapes must match.
--
-- CONCURRENTLY: the database is live (shared by preview and production), so each index
-- is built without blocking reads or writes. CONCURRENTLY cannot run inside a
-- transaction block, which is why this file has no BEGIN/COMMIT - psql runs each
-- statement in autocommit. If a CONCURRENTLY build is interrupted it leaves an INVALID
-- index behind; `DROP INDEX` it and re-run this file (IF NOT EXISTS would otherwise
-- skip the invalid one).
--
-- Additive only: no query changes results because an index exists, so the acceptance
-- harness must pass identically before and after (verified 2026-09-04).
-- Execute: psql "$DATABASE_URL" -f add_hot_path_indexes.sql

-- tank_pages: every hot read (the SSR homepage's live-Tank query, discord-sweep's
-- per-guild unposted scan, notify-sweep's 24h count, ticker-sweep's untagged window,
-- the Discord admin commands) filters status='published' AND visibility='app' and then
-- filters or sorts on published_at. The existing (status) index has near-zero
-- selectivity (almost every row is published). The homepage additionally sorts on
-- (game_snapshot->'game'->>'kickoff')::timestamptz - that cast is STABLE, not
-- IMMUTABLE, so it cannot be indexed; this index narrows its scan to the app-visible
-- published rows, which is the win available without a stored kickoff column.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_tank_pages_app_published
    ON tank_pages (published_at DESC)
    WHERE status = 'published' AND visibility = 'app';

-- index_positions: the daily-close aggregation in functions/api/index-settle.ts reads
-- every settled-but-unclosed position (5 runs/day). The existing (ticker_key,
-- settled_at) index leads with a column that query does not constrain, and the
-- pending partial index covers the opposite predicate (settled_at IS NULL) - so it
-- was a full sequential scan of a table that grows ~30-40 rows/day forever.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_index_positions_unclosed
    ON index_positions (ticker_key)
    WHERE settled_at IS NOT NULL AND close_id IS NULL;

-- polymarket_props: functions/api/index-lock.ts selects the games kicking off inside
-- a 9-hour window from the largest table in the system (4 runs/day). The window on
-- event_start_time is the only selective predicate and had no index; `closed IS
-- DISTINCT FROM TRUE` is the query's exact open-market filter.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_polymarket_props_open_start
    ON polymarket_props (event_start_time)
    WHERE closed IS DISTINCT FROM TRUE;

-- discord_guild_posts: functions/api/discord-settlement-sweep.ts's candidate scan
-- (settlement_posted_at IS NULL, ordered by posted_at). Only the PK existed, and
-- nearly every row is permanently non-NULL once announced, so the full scan degraded
-- while the useful result set stayed near-empty.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_discord_guild_posts_unannounced
    ON discord_guild_posts (posted_at)
    WHERE settlement_posted_at IS NULL;

-- community_picks: functions/api/community-pick-settlement-sweep.ts's open-pick scan
-- (status = 'open', ordered by created_at). The only index leads with guild_id, which
-- that query does not constrain. Settled rows are never pruned and the table grows by
-- games x guilds every Tuesday (league-slate-sweep).
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_community_picks_open
    ON community_picks (created_at)
    WHERE status = 'open';

-- ticker_tags: getTickerNews (lib/pages-functions/tickers.ts) ranks tags with
-- ROW_NUMBER() OVER (PARTITION BY ticker_key ORDER BY tagged_at DESC) on every SSR
-- homepage request and every /api/tickers/detail call; the table only had indexes on
-- tank_id and the (now dormant) pending partial. (getTickerResults used to rank here
-- too; since 2026-09-11 it reads index_positions, served by idx_index_positions_close.)
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ticker_tags_key_tagged
    ON ticker_tags (ticker_key, tagged_at DESC);
