// ===================================================================================
// POLYMARKET PROP ODDS SYNC (polymarket.ts)
// ===================================================================================
// Pulls prop markets from Polymarket's public Gamma API for NBA, NFL, MLB, and the
// major soccer leagues, and caches them in Postgres (polymarket_props table).
//
// Rate-limit strategy: the app's API endpoints never call Polymarket on a client
// request. A background poller is the only thing that ever talks to Polymarket, and
// it is throttled (min delay between requests, sequential across leagues, capped
// pagination, retry-with-backoff on 429s, and a single-flight lock so overlapping
// syncs can't happen). Clients only ever read the Postgres cache.
// ===================================================================================

import type { Pool } from 'pg';

const GAMMA_BASE_URL = 'https://gamma-api.polymarket.com';

// Canonical league name -> Polymarket tag_slug(s) that carry that league's markets.
// Soccer is split across its major leagues since Polymarket has no single umbrella tag
// with full coverage; naming matches the league strings already used across the app.
export const LEAGUE_TAGS: Record<string, string[]> = {
    'NBA': ['nba'],
    'NFL': ['nfl'],
    'MLB': ['mlb'],
    'EPL': ['epl'],
    'La Liga': ['la-liga'],
    'Serie A': ['serie-a'],
    'Bundesliga': ['bundesliga'],
    'Ligue 1': ['ligue-1'],
    // The four below are DISCORD PICK MENU ONLY - deliberately absent from
    // functions/api/curate.ts's SPORT_GROUPS, sport-map.ts, tickers.ts, index-slate.ts
    // and ticker-copy.ts, so they never produce a Tank page, a homepage slot or a
    // ticker constituent. They exist because the eight leagues above all go dark
    // together during international breaks and the NBA/NFL offseason, leaving /pvp and
    // Community Pick search with nothing to offer; these keep playing through it (the
    // EFL Championship alone carried 56 games inside 24h on the day this was added).
    // Don't "fix" the asymmetry by adding them to curate - that spends Anthropic
    // credits generating Tank articles for lower-profile matches.
    'EFL Championship': ['efl-championship'],
    'MLS': ['mls'],
    'DFB-Pokal': ['dfb-pokal'],
    'Carabao Cup': ['carabao-cup'],
    // Coppa Italia is NOT here on purpose: Polymarket has no tag carrying it (probed
    // 'coppa-italia' -> 0 events). Champions/Europa League tags exist but currently
    // carry only season futures, not fixtures - revisit when the group stage starts.
};

export const SUPPORTED_LEAGUES = Object.keys(LEAGUE_TAGS);

// --- Rate limiting -----------------------------------------------------------------

const MIN_REQUEST_INTERVAL_MS = 300; // hard floor between any two outbound Gamma requests
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function throttledFetch(url: string): Promise<Response> {
    const run = requestQueue.then(async () => {
        const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    requestQueue = run;
    return run.then(() => fetchWithRetry(url));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, attempt = 0): Promise<Response> {
    const MAX_ATTEMPTS = 4;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

    if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS - 1) return response;
        const retryAfterHeader = response.headers.get('retry-after');
        const backoffMs = retryAfterHeader
            ? Number(retryAfterHeader) * 1000
            : 1000 * Math.pow(2, attempt); // 1s, 2s, 4s, 8s
        console.warn(`[Polymarket] ${response.status} from Gamma API, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(backoffMs);
        return fetchWithRetry(url, attempt + 1);
    }

    return response;
}

// --- Gamma API types (only the fields we use) ---------------------------------------

export interface GammaMarket {
    id: string;
    slug: string;
    question: string;
    conditionId?: string;
    outcomes?: string; // JSON-encoded string array
    outcomePrices?: string; // JSON-encoded string array
    clobTokenIds?: string; // JSON-encoded string array
    bestBid?: number | null;
    bestAsk?: number | null;
    volume?: number | string | null;
    liquidity?: number | string | null;
    active?: boolean;
    closed?: boolean;
    sportsMarketType?: string | null; // canonical stat key, e.g. "baseball_player_home_runs"
    line?: number | string | null;
    marketMetadata?: Record<string, any> | null;
    // This market's own resolution deadline - distinct from the parent event's endDate,
    // which Polymarket sets per-event (e.g. keeping a moneyline market open longer for
    // disputes) and does NOT reflect when this specific market actually resolves.
    endDate?: string;
}

export interface GammaEventTeam {
    name: string;
    abbreviation?: string;
    ordering?: string; // "away" | "home"
}

export interface GammaEvent {
    id: string;
    slug: string;
    title: string;
    endDate?: string;
    startTime?: string; // actual game start; distinct from endDate (market resolution deadline)
    teams?: GammaEventTeam[];
    markets?: GammaMarket[];
}

// A player-prop question on Polymarket follows "<Subject>: <Stat> O/U <line>".
// This regex extracts the subject name, but on its own it is NOT a reliable
// player-vs-team signal: team/game-level markets (corners, team totals, half
// totals) follow the exact same "Subject: ... O/U ..." shape, e.g.
// "Elche CF vs. FC Barcelona: Elche CF O/U 2.5 Corners" - matches fine, but the
// "subject" is a whole matchup, not a player.
const PLAYER_PROP_PATTERN = /^(.+?):\s.*\bO\/U\b/i;

// Real player-prop market types are always "<sport>_player_<stat>" (confirmed via
// live inspection - "baseball_player_home_runs", "soccer_player_anytime_scorer",
// etc.), while team/game-level types never contain "_player_" ("team_totals",
// "soccer_team_total_corners", "first_half_totals"). This is the reliable signal;
// the question-text regex is only a fallback for the rare row with no market type.
const PLAYER_MARKET_TYPE_PATTERN = /_player_/;

export function parsePropShape(question: string, sportsMarketType?: string | null): { isPlayerProp: boolean; subjectName: string | null } {
    const match = question.match(PLAYER_PROP_PATTERN);
    if (sportsMarketType) {
        const isPlayerProp = PLAYER_MARKET_TYPE_PATTERN.test(sportsMarketType);
        return { isPlayerProp, subjectName: isPlayerProp && match ? match[1].trim() : null };
    }
    if (match) {
        return { isPlayerProp: true, subjectName: match[1].trim() };
    }
    return { isPlayerProp: false, subjectName: null };
}

export function safeJsonParse<T>(value: string | undefined | null): T | null {
    if (!value) return null;
    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
}

export function toNumberOrNull(value: number | string | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// --- DB setup -------------------------------------------------------------------------

export async function ensurePolymarketTable(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS polymarket_props (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            league VARCHAR(50) NOT NULL,
            source_tag VARCHAR(50) NOT NULL,
            event_id VARCHAR(64),
            event_slug VARCHAR(255) NOT NULL,
            event_title TEXT,
            event_end_date TIMESTAMP WITH TIME ZONE,
            market_id VARCHAR(64) NOT NULL,
            market_slug VARCHAR(255) NOT NULL,
            condition_id VARCHAR(128),
            question TEXT NOT NULL,
            subject_name VARCHAR(255),
            is_player_prop BOOLEAN NOT NULL DEFAULT FALSE,
            outcomes JSONB,
            outcome_prices JSONB,
            clob_token_ids JSONB,
            best_bid NUMERIC,
            best_ask NUMERIC,
            volume NUMERIC,
            liquidity NUMERIC,
            active BOOLEAN,
            closed BOOLEAN,
            raw JSONB,
            synced_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            UNIQUE(market_id)
        );
        ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS event_teams JSONB;
        ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS event_start_time TIMESTAMP WITH TIME ZONE;
        ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_type VARCHAR(100);
        ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_line NUMERIC;
        ALTER TABLE polymarket_props ADD COLUMN IF NOT EXISTS market_metadata JSONB;
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_league ON polymarket_props(league);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_event_slug ON polymarket_props(event_slug);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_subject_name ON polymarket_props(subject_name);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_is_player_prop ON polymarket_props(is_player_prop);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_synced_at ON polymarket_props(synced_at DESC);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_active_closed ON polymarket_props(active, closed);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_market_type ON polymarket_props(market_type);
        CREATE INDEX IF NOT EXISTS idx_polymarket_props_event_id ON polymarket_props(event_id);
    `);
}

// --- Sync -------------------------------------------------------------------------

interface LeagueSyncResult {
    league: string;
    marketsUpserted: number;
    eventsSeen: number;
    error: string | null;
    syncedAt: string;
}

// In-memory status, exposed via GET /api/polymarket/status. Reset on process restart;
// that's fine since it's just observability, not the cache itself (which lives in Postgres).
export const lastSyncResults: Record<string, LeagueSyncResult> = {};

let syncInProgress = false;

async function fetchEventsPage(tagSlug: string, offset: number, limit: number): Promise<GammaEvent[]> {
    const params = new URLSearchParams({
        tag_slug: tagSlug,
        closed: 'false',
        limit: String(limit),
        offset: String(offset),
    });
    const url = `${GAMMA_BASE_URL}/events?${params.toString()}`;
    const response = await throttledFetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} for tag "${tagSlug}" (offset ${offset})`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

const PAGE_LIMIT = 100;
const MAX_PAGES_PER_TAG = 20; // safety valve: 2000 events per tag per sync

export async function fetchAllEventsForTag(tagSlug: string): Promise<GammaEvent[]> {
    const events: GammaEvent[] = [];
    for (let page = 0; page < MAX_PAGES_PER_TAG; page++) {
        const batch = await fetchEventsPage(tagSlug, page * PAGE_LIMIT, PAGE_LIMIT);
        events.push(...batch);
        if (batch.length < PAGE_LIMIT) break;
    }
    return events;
}

/**
 * ONE page of a tag's events, ordered by kickoff ascending and filtered to markets that
 * haven't ended - i.e. the soonest games first, in a single request.
 *
 * Exists for the interactive Discord search paths, which run inside one Worker
 * invocation on the Free plan's 50-subrequest ceiling: /pvp's "any sport" mode fans out
 * across every league a guild has enabled, and fetchAllEventsForTag's up-to-20-pages
 * would blow that budget several times over. Because Gamma sorts by start time here,
 * one 100-event page provably contains every game inside a few days - measured
 * 2026-09-01 against a full multi-page scan, identical counts per tag (MLB 65, EFL
 * Championship 84, DFB-Pokal 14).
 *
 * Deliberately NOT used by the sync/curation paths: they want the complete set,
 * including season futures with distant or absent start times, and they aren't
 * latency-bound. If Gamma ever stops honoring these params the failure mode is a
 * shorter menu, never a wrong one - callers still filter by window client-side.
 */
export async function fetchSoonEventsForTag(tagSlug: string): Promise<GammaEvent[]> {
    const params = new URLSearchParams({
        tag_slug: tagSlug,
        closed: 'false',
        limit: String(PAGE_LIMIT),
        // Drops markets whose end date has already passed; start-time filtering is not
        // supported server-side (start_date_min/start_ts both return nothing), so the
        // window filter stays client-side in tank-gamma-live.ts.
        end_date_min: new Date().toISOString(),
        order: 'startTime',
        ascending: 'true',
    });
    const url = `${GAMMA_BASE_URL}/events?${params.toString()}`;
    const response = await throttledFetch(url);
    if (!response.ok) {
        throw new Error(`Gamma API ${response.status} for tag "${tagSlug}" (soonest)`);
    }
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

async function upsertMarkets(pool: Pool, league: string, sourceTag: string, events: GammaEvent[]): Promise<number> {
    let count = 0;
    for (const event of events) {
        for (const market of event.markets ?? []) {
            const { isPlayerProp, subjectName } = parsePropShape(market.question || '', market.sportsMarketType);
            await pool.query(
                `INSERT INTO polymarket_props (
                    league, source_tag, event_id, event_slug, event_title, event_end_date,
                    market_id, market_slug, condition_id, question, subject_name, is_player_prop,
                    outcomes, outcome_prices, clob_token_ids, best_bid, best_ask, volume, liquidity,
                    active, closed, event_teams, event_start_time, market_type, market_line,
                    market_metadata, raw, synced_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12,
                    $13, $14, $15, $16, $17, $18, $19,
                    $20, $21, $22, $23, $24, $25,
                    $26, $27, NOW(), NOW()
                )
                ON CONFLICT (market_id) DO UPDATE SET
                    league = EXCLUDED.league,
                    source_tag = EXCLUDED.source_tag,
                    event_title = EXCLUDED.event_title,
                    event_end_date = EXCLUDED.event_end_date,
                    question = EXCLUDED.question,
                    subject_name = EXCLUDED.subject_name,
                    is_player_prop = EXCLUDED.is_player_prop,
                    outcomes = EXCLUDED.outcomes,
                    outcome_prices = EXCLUDED.outcome_prices,
                    clob_token_ids = EXCLUDED.clob_token_ids,
                    best_bid = EXCLUDED.best_bid,
                    best_ask = EXCLUDED.best_ask,
                    volume = EXCLUDED.volume,
                    liquidity = EXCLUDED.liquidity,
                    active = EXCLUDED.active,
                    closed = EXCLUDED.closed,
                    event_teams = EXCLUDED.event_teams,
                    event_start_time = EXCLUDED.event_start_time,
                    market_type = EXCLUDED.market_type,
                    market_line = EXCLUDED.market_line,
                    market_metadata = EXCLUDED.market_metadata,
                    raw = EXCLUDED.raw,
                    synced_at = NOW(),
                    updated_at = NOW()
                `,
                [
                    league, sourceTag, event.id, event.slug, event.title, event.endDate || null,
                    market.id, market.slug, market.conditionId || null, market.question, subjectName, isPlayerProp,
                    JSON.stringify(safeJsonParse(market.outcomes) ?? []),
                    JSON.stringify(safeJsonParse(market.outcomePrices) ?? []),
                    JSON.stringify(safeJsonParse(market.clobTokenIds) ?? []),
                    toNumberOrNull(market.bestBid), toNumberOrNull(market.bestAsk),
                    toNumberOrNull(market.volume), toNumberOrNull(market.liquidity),
                    market.active ?? null, market.closed ?? null,
                    JSON.stringify(event.teams ?? []), event.startTime || null,
                    market.sportsMarketType || null, toNumberOrNull(market.line),
                    JSON.stringify(market.marketMetadata ?? {}),
                    JSON.stringify(market),
                ]
            );
            count++;
        }
    }
    return count;
}

async function syncLeague(pool: Pool, league: string): Promise<void> {
    const tags = LEAGUE_TAGS[league];
    if (!tags) throw new Error(`Unknown league: ${league}`);

    let eventsSeen = 0;
    let marketsUpserted = 0;
    try {
        for (const tag of tags) {
            const events = await fetchAllEventsForTag(tag);
            eventsSeen += events.length;
            marketsUpserted += await upsertMarkets(pool, league, tag, events);
        }
        lastSyncResults[league] = {
            league, marketsUpserted, eventsSeen, error: null, syncedAt: new Date().toISOString(),
        };
        console.log(`[Polymarket] Synced ${league}: ${marketsUpserted} markets across ${eventsSeen} events`);
    } catch (error: any) {
        lastSyncResults[league] = {
            league, marketsUpserted, eventsSeen, error: error.message, syncedAt: new Date().toISOString(),
        };
        console.error(`[Polymarket] Sync failed for ${league}:`, error.message);
    }
}

// Syncs leagues one at a time (never in parallel) to keep our request rate to
// Polymarket low and predictable regardless of how many leagues we track.
export async function syncAllLeagues(pool: Pool, leagues: string[] = SUPPORTED_LEAGUES): Promise<{ skipped: boolean }> {
    if (syncInProgress) {
        console.log('[Polymarket] Sync already in progress, skipping this trigger.');
        return { skipped: true };
    }
    syncInProgress = true;
    try {
        for (const league of leagues) {
            if (!LEAGUE_TAGS[league]) continue;
            await syncLeague(pool, league);
        }
        return { skipped: false };
    } finally {
        syncInProgress = false;
    }
}

export function isSyncInProgress(): boolean {
    return syncInProgress;
}

// A full cycle across all 8 leagues takes ~8-10 min in practice (throttled at ~3
// req/sec against ~1,000+ paginated requests for NFL/MLB's large market counts),
// so a shorter interval would just mean every tick gets skipped by the single-flight
// lock. 15 min keeps the cache fresh without the poller running continuously.
const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export function startPolymarketScheduler(pool: Pool, intervalMs: number = DEFAULT_SYNC_INTERVAL_MS): NodeJS.Timeout {
    // Kick off an initial sync shortly after boot so the cache isn't empty, then
    // repeat on a fixed interval. syncAllLeagues's single-flight lock guarantees
    // this never overlaps with a manually-triggered sync.
    setTimeout(() => {
        syncAllLeagues(pool).catch(err => console.error('[Polymarket] Initial sync error:', err));
    }, 5000);

    return setInterval(() => {
        syncAllLeagues(pool).catch(err => console.error('[Polymarket] Scheduled sync error:', err));
    }, intervalMs);
}
