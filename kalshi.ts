// ===================================================================================
// KALSHI PLAYER-PROP SYNC (kalshi.ts)
// ===================================================================================
// Pulls player-prop markets from Kalshi's public trade-api for NBA, NFL, MLB, and the
// major soccer leagues, and caches them in Postgres (kalshi_props table). Mirrors
// polymarket.ts's structure and rate-limit philosophy, but Kalshi's read endpoints
// (markets/events/series/trades) need no API key at all - only trading endpoints
// (orders, portfolio) require the RSA-signed auth this module never touches.
//
// Kalshi represents a single player-stat prop as a LADDER of separate binary Yes/No
// markets (one per threshold - "75+ passing yards", "50+", "100+" are three distinct
// markets sharing one event_ticker), not one market with an O/U line the way Polymarket
// does. This module only fetches and flattens raw markets; the ladder collapse into one
// representative Prop per player+stat lives in tank-providers.ts's
// buildGamesFromKalshiFlatProps, alongside Polymarket's analogous classification logic,
// so both the cached-DB path and the live path (kalshi-live.ts) share it and can't drift.
// ===================================================================================

import type { Pool } from 'pg';

export const KALSHI_BASE_URL = 'https://api.elections.kalshi.com/trade-api/v2';

// Canonical league name -> the Kalshi series tickers that carry that league's player
// props, and the <sport>_player_<stat> market key each maps to. This exact key
// convention (verified against tank-deck-format.ts's formatMarketLabel prefix-strip
// regex and index.tsx's MARKET_INFO/DEFAULT_MARKET_WHITELIST) is what marketWhitelist
// config keys off - a Kalshi row emits nothing outside this table's marketKey values.
//
// shape: 'binary' = a single Yes/No market per player+game (no ladder - anytime-TD,
// anytime-goalscorer, double/triple-double all only ever have one threshold in
// practice). 'ladder' = multiple threshold markets per player+game that must be
// collapsed to one representative Prop (see buildGamesFromKalshiFlatProps).
export interface KalshiSeriesInfo {
    league: string;
    marketKey: string;
    shape: 'binary' | 'ladder';
}

export const KALSHI_SERIES_MAP: Record<string, KalshiSeriesInfo> = {
    // NBA
    KXNBAPTS: { league: 'NBA', marketKey: 'basketball_player_points', shape: 'ladder' },
    KXNBAREB: { league: 'NBA', marketKey: 'basketball_player_rebounds', shape: 'ladder' },
    KXNBAAST: { league: 'NBA', marketKey: 'basketball_player_assists', shape: 'ladder' },
    KXNBA3PT: { league: 'NBA', marketKey: 'basketball_player_threes', shape: 'ladder' },
    KXNBASTL: { league: 'NBA', marketKey: 'basketball_player_steals', shape: 'ladder' },
    KXNBABLK: { league: 'NBA', marketKey: 'basketball_player_blocks', shape: 'ladder' },
    KXNBAFTM: { league: 'NBA', marketKey: 'basketball_player_free_throws_made', shape: 'ladder' },
    KXNBAPRA: { league: 'NBA', marketKey: 'basketball_player_points_rebounds_assists', shape: 'ladder' },
    KXNBAPA: { league: 'NBA', marketKey: 'basketball_player_points_assists', shape: 'ladder' },
    KXNBARA: { league: 'NBA', marketKey: 'basketball_player_rebounds_assists', shape: 'ladder' },
    KXNBA2D: { league: 'NBA', marketKey: 'basketball_player_double_double', shape: 'binary' },
    KXNBA3D: { league: 'NBA', marketKey: 'basketball_player_triple_double', shape: 'binary' },

    // NFL
    KXNFLPASSYDS: { league: 'NFL', marketKey: 'football_player_passing_yards', shape: 'ladder' },
    KXNFLRSHYDS: { league: 'NFL', marketKey: 'football_player_rushing_yards', shape: 'ladder' },
    KXNFLRECYDS: { league: 'NFL', marketKey: 'football_player_receiving_yards', shape: 'ladder' },
    // KXNFLANYTD is currently empty (0 live markets) but mapped defensively in case
    // Kalshi starts using it - see kalshi-integration research notes.
    KXNFLTD: { league: 'NFL', marketKey: 'football_player_anytime_td', shape: 'binary' },
    KXNFLANYTD: { league: 'NFL', marketKey: 'football_player_anytime_td', shape: 'binary' },
    KXNFLREC: { league: 'NFL', marketKey: 'football_player_receptions', shape: 'ladder' },
    KXNFLPASSCOMP: { league: 'NFL', marketKey: 'football_player_pass_completions', shape: 'ladder' },
    KXNFLPASSATT: { league: 'NFL', marketKey: 'football_player_pass_attempts', shape: 'ladder' },
    KXNFLPASSINT: { league: 'NFL', marketKey: 'football_player_interceptions_thrown', shape: 'ladder' },
    KXNFLFFPTS: { league: 'NFL', marketKey: 'football_player_fantasy_points', shape: 'ladder' },

    // MLB
    KXMLBHR: { league: 'MLB', marketKey: 'baseball_player_home_runs', shape: 'ladder' },
    KXMLBHIT: { league: 'MLB', marketKey: 'baseball_player_hits', shape: 'ladder' },
    KXMLBRBI: { league: 'MLB', marketKey: 'baseball_player_rbis', shape: 'ladder' },
    KXMLBKS: { league: 'MLB', marketKey: 'baseball_player_strikeouts', shape: 'ladder' },

    // Soccer - one anytime-scorer + one first-goalscorer series per league Tank tracks.
    KXEPLGOAL: { league: 'EPL', marketKey: 'soccer_player_anytime_scorer', shape: 'binary' },
    KXEPLFIRSTGOAL: { league: 'EPL', marketKey: 'soccer_player_first_goalscorer', shape: 'binary' },
    KXLALIGAGOAL: { league: 'La Liga', marketKey: 'soccer_player_anytime_scorer', shape: 'binary' },
    KXLALIGAFIRSTGOAL: { league: 'La Liga', marketKey: 'soccer_player_first_goalscorer', shape: 'binary' },
    KXSERIEAGOAL: { league: 'Serie A', marketKey: 'soccer_player_anytime_scorer', shape: 'binary' },
    KXSERIEAFIRSTGOAL: { league: 'Serie A', marketKey: 'soccer_player_first_goalscorer', shape: 'binary' },
    KXBUNDESLIGAGOAL: { league: 'Bundesliga', marketKey: 'soccer_player_anytime_scorer', shape: 'binary' },
    KXBUNDESLIGAFIRSTGOAL: { league: 'Bundesliga', marketKey: 'soccer_player_first_goalscorer', shape: 'binary' },
    KXLIGUE1GOAL: { league: 'Ligue 1', marketKey: 'soccer_player_anytime_scorer', shape: 'binary' },
    KXLIGUE1FIRSTGOAL: { league: 'Ligue 1', marketKey: 'soccer_player_first_goalscorer', shape: 'binary' },
};

export const SUPPORTED_KALSHI_LEAGUES: string[] = Array.from(
    new Set(Object.values(KALSHI_SERIES_MAP).map(info => info.league))
);

export function seriesTickersForLeague(league: string): string[] {
    return Object.keys(KALSHI_SERIES_MAP).filter(ticker => KALSHI_SERIES_MAP[ticker].league === league);
}

// --- Rate limiting -----------------------------------------------------------------
// Own module-level queue/constants, separate from polymarket.ts's - no documented
// Kalshi rate limit was found, so this stays as conservative as Polymarket's.

const MIN_REQUEST_INTERVAL_MS = 300;
let lastRequestAt = 0;
let requestQueue: Promise<void> = Promise.resolve();

function throttledKalshiFetch(url: string): Promise<Response> {
    const run = requestQueue.then(async () => {
        const wait = Math.max(0, lastRequestAt + MIN_REQUEST_INTERVAL_MS - Date.now());
        if (wait > 0) await sleep(wait);
        lastRequestAt = Date.now();
    });
    requestQueue = run;
    return run.then(() => fetchKalshiWithRetry(url));
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchKalshiWithRetry(url: string, attempt = 0): Promise<Response> {
    const MAX_ATTEMPTS = 4;
    const response = await fetch(url, { headers: { 'Accept': 'application/json' } });

    if (response.status === 429 || response.status >= 500) {
        if (attempt >= MAX_ATTEMPTS - 1) return response;
        const retryAfterHeader = response.headers.get('retry-after');
        const backoffMs = retryAfterHeader
            ? Number(retryAfterHeader) * 1000
            : 1000 * Math.pow(2, attempt);
        console.warn(`[Kalshi] ${response.status} from trade-api, retrying in ${backoffMs}ms (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
        await sleep(backoffMs);
        return fetchKalshiWithRetry(url, attempt + 1);
    }

    return response;
}

// --- Kalshi API types (only the fields we use) --------------------------------------

export interface KalshiMarket {
    ticker: string;
    event_ticker: string;
    title: string;
    yes_sub_title: string;
    no_sub_title: string;
    floor_strike: number | null;
    market_type: string;
    custom_strike: Record<string, string> | null;
    yes_bid_dollars: string;
    yes_ask_dollars: string;
    last_price_dollars: string;
    no_bid_dollars: string;
    no_ask_dollars: string;
    volume_fp: string;
    liquidity_dollars: string;
    open_interest_fp: string;
    status: string;
    result: string | null;
    settlement_ts: string | null;
    settlement_value_dollars: string | null;
    close_time: string;
    open_time: string;
    expiration_time: string;
    // The actual game/occurrence start time - distinct from close_time (when this
    // specific market stops trading, generally shortly after the game itself starts)
    // and open_time (when this market began trading, which can be well before game
    // day). This is the field Game.kickoff should be built from, not open_time.
    occurrence_datetime: string;
}

export interface KalshiEvent {
    event_ticker: string;
    series_ticker: string;
    title: string;
    sub_title: string;
    category: string;
}

interface KalshiMarketsPage {
    markets: KalshiMarket[];
    cursor?: string;
}

interface KalshiSingleEventResponse {
    event: KalshiEvent;
    markets?: KalshiMarket[];
}

// /markets accepts limit up to 1000 and a status filter - confirmed live. The list
// /events endpoint does NOT: it 400s on any `status` param at all, and its max limit is
// 200, not 1000 (both confirmed live) - so it's unusable for a status-filtered bulk
// fetch. fetchAllEventsForSeries below works around this entirely by never calling the
// events LIST endpoint; see its comment.
const PAGE_LIMIT = 1000;
const MAX_PAGES_PER_SERIES = 20; // safety valve, mirrors polymarket.ts's MAX_PAGES_PER_TAG

async function fetchAllMarketsPages(seriesTicker: string, status?: string): Promise<KalshiMarket[]> {
    const markets: KalshiMarket[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_SERIES; page++) {
        const params = new URLSearchParams({ series_ticker: seriesTicker, limit: String(PAGE_LIMIT) });
        if (status) params.set('status', status);
        if (cursor) params.set('cursor', cursor);
        const response = await throttledKalshiFetch(`${KALSHI_BASE_URL}/markets?${params.toString()}`);
        if (!response.ok) {
            throw new Error(`Kalshi markets ${response.status} for series "${seriesTicker}"`);
        }
        const data = await response.json() as KalshiMarketsPage;
        markets.push(...(data.markets ?? []));
        if (!data.cursor || (data.markets ?? []).length === 0) break;
        cursor = data.cursor;
    }
    return markets;
}

async function fetchSingleEvent(eventTicker: string): Promise<KalshiEvent | null> {
    const response = await throttledKalshiFetch(`${KALSHI_BASE_URL}/events/${encodeURIComponent(eventTicker)}`);
    if (!response.ok) return null;
    const data = await response.json() as KalshiSingleEventResponse;
    return data.event ?? null;
}

// Bulk-fetches status-filtered markets for a series (the one endpoint that actually
// supports both status filtering and a useful page size), then looks up each distinct
// event_ticker individually via GET /events/{ticker} for its title/sub_title metadata
// only - that single-event endpoint nests markets too, but this deliberately ignores
// them and keeps the already-status-filtered set from the bulk call instead, so a
// closed/settled market never sneaks back in through the per-event fetch. This avoids
// the broken /events list endpoint entirely (see the comment above PAGE_LIMIT) and is
// naturally bounded: only events that currently have a market in this status get an
// event-metadata lookup, not a series' entire history.
export async function fetchAllEventsForSeries(seriesTicker: string, status = 'open'): Promise<Array<{ event: KalshiEvent; markets: KalshiMarket[] }>> {
    const markets = await fetchAllMarketsPages(seriesTicker, status);

    const marketsByEvent = new Map<string, KalshiMarket[]>();
    for (const market of markets) {
        if (!marketsByEvent.has(market.event_ticker)) marketsByEvent.set(market.event_ticker, []);
        marketsByEvent.get(market.event_ticker)!.push(market);
    }

    const results: Array<{ event: KalshiEvent; markets: KalshiMarket[] }> = [];
    for (const [eventTicker, eventMarkets] of marketsByEvent) {
        const event = await fetchSingleEvent(eventTicker);
        if (event) results.push({ event, markets: eventMarkets });
    }
    return results;
}

// Parses Kalshi's "AAA vs BBB (Mon DD)" event.sub_title convention. Display-only field
// (doesn't touch settlement/odds/picks) - first-listed team is treated as away, second
// as home, matching event.title's word order and the event_ticker's team-code suffix
// order observed live (e.g. "Arizona vs Las Vegas" / "ARI vs LV" / ticker "...ARILV").
export function parseKalshiMatchup(subTitle: string | undefined | null): { away: string; home: string } | null {
    if (!subTitle) return null;
    const withoutDate = subTitle.replace(/\s*\([^)]*\)\s*$/, '').trim();
    const match = withoutDate.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
    if (!match) return null;
    return { away: match[1].trim(), home: match[2].trim() };
}

// Kalshi's sports event tickers encode the game's real start time directly -
// "KXMLBHIT-26AUG241840BOSMIA" -> 2026-08-24 18:40 Eastern - the standard convention
// across every series in KALSHI_SERIES_MAP. This exists as a cross-check against
// KalshiMarket.occurrence_datetime, not a replacement for it: occurrence_datetime has
// been observed wrong on a live market (its value was 3 hours later than the game
// time Kalshi's own rules text advertised for that same event, which let a pick land
// after the real game had already started - functions/api/discord/interactions.ts and
// functions/api/picks.ts both gate on Game.kickoff via hasKickoffPassed). Parsing the
// ticker gives an independent second source not subject to that same bug; callers
// should take whichever of the two resolves earlier, never later, so a wrong-and-late
// occurrence_datetime can never win.
const KALSHI_TICKER_DATETIME_RE = /(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})(\d{2})(\d{2})/;
const MONTH_INDEX: Record<string, number> = {
    JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11,
};

// The target zone's UTC offset (ms, negative for zones behind UTC) as of `instant` -
// looked up via Intl.DateTimeFormat.formatToParts rather than a
// toLocaleString()-and-reparse round trip: that common trick silently depends on the
// HOST's own system-default timezone to reparse the formatted string (confirmed live -
// it gave a different, wrong answer on this Pacific-timezone dev machine than it would
// on a UTC-default server), which is exactly the kind of environment-dependent bug this
// function exists to avoid.
function timeZoneOffsetMs(instant: Date, timeZone: string): number {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone, hourCycle: 'h23',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(instant);
    const get = (type: string) => Number(parts.find(p => p.type === type)?.value ?? 0);
    const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
    return asUtc - instant.getTime();
}

// Converts a wall-clock date/time in a named IANA zone to the UTC instant it actually
// represents, DST-aware - a fixed UTC-4/-5 offset for "Eastern" would be wrong part of
// the year (Kalshi's MLB season runs through DST changeovers).
function zonedTimeToUtc(year: number, monthIndex: number, day: number, hour: number, minute: number, timeZone: string): Date {
    const naiveUtc = Date.UTC(year, monthIndex, day, hour, minute);
    const offsetMs = timeZoneOffsetMs(new Date(naiveUtc), timeZone);
    return new Date(naiveUtc - offsetMs);
}

export function parseKalshiTickerKickoff(eventTicker: string): string | null {
    const match = eventTicker.match(KALSHI_TICKER_DATETIME_RE);
    if (!match) return null;
    const [, yy, mon, dd, hh, mm] = match;
    const monthIndex = MONTH_INDEX[mon];
    const day = Number(dd);
    const hour = Number(hh);
    const minute = Number(mm);
    if (monthIndex === undefined || day < 1 || day > 31 || hour > 23 || minute > 59) return null;
    const kickoff = zonedTimeToUtc(2000 + Number(yy), monthIndex, day, hour, minute, 'America/New_York');
    return Number.isNaN(kickoff.getTime()) ? null : kickoff.toISOString();
}

// Text before the first ':' in yes_sub_title/title ("Ashton Jeanty: 1+" -> "Ashton Jeanty").
export function parseKalshiSubjectName(text: string | undefined | null): string | null {
    if (!text) return null;
    const idx = text.indexOf(':');
    const name = (idx === -1 ? text : text.slice(0, idx)).trim();
    return name || null;
}

// Every Kalshi ticker observed (market, event, and series tickers alike) starts with
// "KX"; Polymarket's market/condition ids never do. Cheap, reliable way to tell which
// source a Prop.id came from without threading an explicit provider field through
// Game/Prop/SelectedProp - used by backend.ts's admin generate route to stamp the
// correct tank_pages.provider value regardless of which PROP_PROVIDER mode produced
// the selection (single-source or the composed 'both' mode).
export function isKalshiPropId(id: string): boolean {
    return id.startsWith('KX');
}

export function toNumberOrNull(value: string | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

// Kalshi's custom_strike map keys vary by sport ("football_player", "basketball_player",
// "baseball_player", ...) but always carries exactly one opaque player UUID alongside a
// team UUID. This is the stable grouping key the ladder collapse (buildGamesFromKalshiFlatProps
// in tank-providers.ts) uses to group threshold rungs for the same player+game - exact
// and stable, unlike matching on the human-readable name string.
export function extractSubjectKey(market: KalshiMarket): string | null {
    const strike = market.custom_strike;
    if (!strike) return null;
    for (const [key, value] of Object.entries(strike)) {
        if (key.endsWith('_player') && value) return value;
    }
    const firstValue = Object.values(strike)[0];
    return firstValue || null;
}

// --- DB setup -------------------------------------------------------------------------

export async function ensureKalshiTable(pool: Pool): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS kalshi_props (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            league VARCHAR(50) NOT NULL,
            series_ticker VARCHAR(64) NOT NULL,
            event_ticker VARCHAR(128) NOT NULL,
            event_title TEXT,
            away VARCHAR(255),
            home VARCHAR(255),
            market_ticker VARCHAR(128) NOT NULL,
            subject_name VARCHAR(255),
            subject_key VARCHAR(128),
            market_key VARCHAR(100) NOT NULL,
            shape VARCHAR(10) NOT NULL,
            floor_strike NUMERIC,
            yes_prob NUMERIC,
            volume NUMERIC,
            open_interest NUMERIC,
            open_time TIMESTAMP WITH TIME ZONE,
            close_time TIMESTAMP WITH TIME ZONE,
            occurrence_time TIMESTAMP WITH TIME ZONE,
            status VARCHAR(20),
            raw JSONB,
            synced_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
            UNIQUE(market_ticker)
        );
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_league ON kalshi_props(league);
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_event_ticker ON kalshi_props(event_ticker);
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_market_key ON kalshi_props(market_key);
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_synced_at ON kalshi_props(synced_at DESC);
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_status ON kalshi_props(status);
        CREATE INDEX IF NOT EXISTS idx_kalshi_props_subject_key ON kalshi_props(subject_key);
    `);
}

// --- Sync -------------------------------------------------------------------------
// Admin-tool-only, same caveat as polymarket.ts's syncAllLeagues: nothing runs this in
// production (backend.ts, which calls startKalshiScheduler, isn't deployed there).

interface LeagueSyncResult {
    league: string;
    marketsUpserted: number;
    eventsSeen: number;
    error: string | null;
    syncedAt: string;
}

export const lastKalshiSyncResults: Record<string, LeagueSyncResult> = {};

let syncInProgress = false;

function bidAskMidOrLast(market: KalshiMarket): number {
    const bid = toNumberOrNull(market.yes_bid_dollars);
    const ask = toNumberOrNull(market.yes_ask_dollars);
    if (bid !== null && ask !== null && bid > 0 && ask < 1) return (bid + ask) / 2;
    return toNumberOrNull(market.last_price_dollars) ?? 0;
}

async function upsertMarkets(
    pool: Pool,
    league: string,
    seriesTicker: string,
    info: KalshiSeriesInfo,
    pairs: Array<{ event: KalshiEvent; markets: KalshiMarket[] }>
): Promise<number> {
    let count = 0;
    for (const { event, markets } of pairs) {
        const matchup = parseKalshiMatchup(event.sub_title);
        for (const market of markets) {
            const subjectName = parseKalshiSubjectName(market.yes_sub_title || market.title);
            const subjectKey = extractSubjectKey(market);
            await pool.query(
                `INSERT INTO kalshi_props (
                    league, series_ticker, event_ticker, event_title, away, home,
                    market_ticker, subject_name, subject_key, market_key, shape, floor_strike, yes_prob,
                    volume, open_interest, open_time, close_time, occurrence_time, status, raw, synced_at, updated_at
                ) VALUES (
                    $1, $2, $3, $4, $5, $6,
                    $7, $8, $9, $10, $11, $12, $13,
                    $14, $15, $16, $17, $18, $19, $20, NOW(), NOW()
                )
                ON CONFLICT (market_ticker) DO UPDATE SET
                    league = EXCLUDED.league,
                    series_ticker = EXCLUDED.series_ticker,
                    event_title = EXCLUDED.event_title,
                    away = EXCLUDED.away,
                    home = EXCLUDED.home,
                    subject_name = EXCLUDED.subject_name,
                    subject_key = EXCLUDED.subject_key,
                    market_key = EXCLUDED.market_key,
                    shape = EXCLUDED.shape,
                    floor_strike = EXCLUDED.floor_strike,
                    yes_prob = EXCLUDED.yes_prob,
                    volume = EXCLUDED.volume,
                    open_interest = EXCLUDED.open_interest,
                    open_time = EXCLUDED.open_time,
                    close_time = EXCLUDED.close_time,
                    occurrence_time = EXCLUDED.occurrence_time,
                    status = EXCLUDED.status,
                    raw = EXCLUDED.raw,
                    synced_at = NOW(),
                    updated_at = NOW()
                `,
                [
                    league, seriesTicker, event.event_ticker, event.title,
                    matchup?.away ?? null, matchup?.home ?? null,
                    market.ticker, subjectName, subjectKey, info.marketKey, info.shape,
                    market.floor_strike, bidAskMidOrLast(market),
                    toNumberOrNull(market.volume_fp), toNumberOrNull(market.open_interest_fp),
                    market.open_time || null, market.close_time || null, market.occurrence_datetime || null,
                    market.status || null, JSON.stringify(market),
                ]
            );
            count++;
        }
    }
    return count;
}

async function syncSeries(pool: Pool, league: string, seriesTicker: string): Promise<{ events: number; markets: number }> {
    const info = KALSHI_SERIES_MAP[seriesTicker];
    if (!info) throw new Error(`Unknown Kalshi series: ${seriesTicker}`);
    const pairs = await fetchAllEventsForSeries(seriesTicker, 'open');
    const marketsUpserted = await upsertMarkets(pool, league, seriesTicker, info, pairs);
    return { events: pairs.length, markets: marketsUpserted };
}

async function syncLeague(pool: Pool, league: string): Promise<void> {
    const seriesTickers = seriesTickersForLeague(league);
    let eventsSeen = 0;
    let marketsUpserted = 0;
    try {
        for (const seriesTicker of seriesTickers) {
            const result = await syncSeries(pool, league, seriesTicker);
            eventsSeen += result.events;
            marketsUpserted += result.markets;
        }
        lastKalshiSyncResults[league] = {
            league, marketsUpserted, eventsSeen, error: null, syncedAt: new Date().toISOString(),
        };
        console.log(`[Kalshi] Synced ${league}: ${marketsUpserted} markets across ${eventsSeen} events`);
    } catch (error: any) {
        lastKalshiSyncResults[league] = {
            league, marketsUpserted, eventsSeen, error: error.message, syncedAt: new Date().toISOString(),
        };
        console.error(`[Kalshi] Sync failed for ${league}:`, error.message);
    }
}

export async function syncAllKalshiLeagues(pool: Pool, leagues: string[] = SUPPORTED_KALSHI_LEAGUES): Promise<{ skipped: boolean }> {
    if (syncInProgress) {
        console.log('[Kalshi] Sync already in progress, skipping this trigger.');
        return { skipped: true };
    }
    syncInProgress = true;
    try {
        for (const league of leagues) {
            await syncLeague(pool, league);
        }
        return { skipped: false };
    } finally {
        syncInProgress = false;
    }
}

export function isKalshiSyncInProgress(): boolean {
    return syncInProgress;
}

const DEFAULT_SYNC_INTERVAL_MS = 15 * 60 * 1000;

export function startKalshiScheduler(pool: Pool, intervalMs: number = DEFAULT_SYNC_INTERVAL_MS): NodeJS.Timeout {
    setTimeout(() => {
        syncAllKalshiLeagues(pool).catch(err => console.error('[Kalshi] Initial sync error:', err));
    }, 5000);

    return setInterval(() => {
        syncAllKalshiLeagues(pool).catch(err => console.error('[Kalshi] Scheduled sync error:', err));
    }, intervalMs);
}
