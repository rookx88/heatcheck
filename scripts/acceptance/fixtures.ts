// Cross-domain fixture helpers shared by every suite: user creation, session/login
// token minting (mirrors the real signing paths in lib/pages-functions/session.ts and
// functions/api/login.ts exactly, so fixtures are indistinguishable from the real
// flow to the endpoints under test), Ember-ledger totals, and the game_config
// version-flip/restore procedure generalized to any config key (the original
// scripts/acceptance-tickers.ts only ever flipped 'tickers'; Phases 2-4 need
// 'discovery' and 'feeding' too).

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { pool, registerTeardown, api } from './harness';
import { signAuthToken } from '../../lib/pages-functions/auth-tokens';
import { LIFETIME_EARNED_RULE_KEYS } from '../../lib/pages-functions/ledger';
import type { SessionTokenPayload, LoginTokenPayload } from '../../lib/auth-token-payloads';
import { KALSHI_SERIES_MAP } from '../../kalshi';

const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || '';

// ---------------------------------------------------------------------------------
// Users / sessions / login tokens
// ---------------------------------------------------------------------------------

export interface FixtureUser { userId: string; cookie: string }

// onboarded defaults true (most suites want a ready-to-use account); pass false to
// exercise the pre-onboarding gate.
export async function createUser(email: string, opts?: { onboarded?: boolean; username?: string }): Promise<{ userId: string }> {
    const onboarded = opts?.onboarded ?? true;
    const username = opts?.username ?? null;
    const { rows } = await pool.query(
        `INSERT INTO waitlist (email, email_verified, username, onboarded_at)
         VALUES ($1, true, $2, ${onboarded ? 'NOW()' : 'NULL'})
         ON CONFLICT (LOWER(email)) DO UPDATE SET
             email_verified = true,
             username = COALESCE(EXCLUDED.username, waitlist.username),
             onboarded_at = ${onboarded ? 'NOW()' : 'waitlist.onboarded_at'}
         RETURNING id`,
        [email, username],
    );
    return { userId: rows[0].id as string };
}

// Mints a real session row + signed cookie exactly as lib/pages-functions/session.ts's
// createSession() does, without going through /api/login/consume (so suites that don't
// care about the login flow itself can get straight to an authenticated fixture).
export async function mintSessionCookie(userId: string): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO sessions (user_id, expires_at) VALUES ($1, NOW() + INTERVAL '30 days') RETURNING session_id`,
        [userId],
    );
    const sessionId = rows[0].session_id as string;
    const token = await signAuthToken<SessionTokenPayload>(
        { userId, purpose: 'session', sessionId },
        SESSION_TOKEN_SECRET,
        30 * 24 * 3600,
    );
    // Dev server is plain http, so the un-prefixed cookie name is the trusted one.
    return `hc_session=${token}`;
}

export async function createSessionUser(email: string, opts?: { onboarded?: boolean; username?: string }): Promise<FixtureUser> {
    const { userId } = await createUser(email, opts);
    const cookie = await mintSessionCookie(userId);
    return { userId, cookie };
}

// Mirrors functions/api/login.ts's token-issuance exactly (nonce rotation + 15-minute
// DB expiry + signed action token), without sending real email. ttlSeconds overrides
// the signed token's own exp for boundary testing (functions/api/login.ts:20's
// LOGIN_TOKEN_TTL_SECONDS = 15*60); dbTtlSeconds independently overrides the DB-side
// login_nonce_expires_at window, since the two are separate expiry mechanisms
// (consume.ts checks both: signature/exp via verifyAuthToken, then the nonce row).
export async function mintLoginToken(userId: string, opts?: { ttlSeconds?: number; dbTtlSeconds?: number }): Promise<string> {
    const nonce = crypto.randomUUID();
    const dbTtl = opts?.dbTtlSeconds ?? 15 * 60;
    await pool.query(
        `UPDATE waitlist SET login_nonce = $1, login_nonce_expires_at = NOW() + ($2 * INTERVAL '1 second') WHERE id = $3`,
        [nonce, dbTtl, userId],
    );
    return signAuthToken<LoginTokenPayload>(
        { userId, purpose: 'login', nonce },
        SESSION_TOKEN_SECRET,
        opts?.ttlSeconds ?? 15 * 60,
    );
}

// Hand-inserts a known 6-digit code so functions/api/verify-email.ts's brute-force
// guard can be tested with a code the script actually knows (a real code is emailed,
// never returned by any endpoint).
export async function mintVerificationCode(userId: string, code: string, ttlSeconds = 15 * 60): Promise<void> {
    await pool.query(
        `UPDATE waitlist SET email_verified = false, verification_code = $1,
                verification_code_expires_at = NOW() + ($2 * INTERVAL '1 second'), verification_attempts = 0
         WHERE id = $3`,
        [code, ttlSeconds, userId],
    );
}

// ---------------------------------------------------------------------------------
// Ember ledger totals
// ---------------------------------------------------------------------------------

export interface LedgerTotals {
    balanceCache: number | null;
    ledgerSum: number;
    ledgerRows: number;
    // ember_balances.lifetime_earned (the Hall of Fame counter) and its independent
    // recompute from the definition in add_lifetime_earned_to_ember_balances.sql:
    // game-rule ledger rows + the positive floored realized_pnl of every sell. null
    // cache means no ember_balances row exists at all (same semantics as balanceCache).
    lifetimeCache: number | null;
    lifetimeRecomputed: number;
}
// Gives a fixture account Ember THROUGH the ledger: one 'adjustment' ember_ledger row
// whose amount folds into ember_balances in the same statement - the exact CTE shape
// lib/pages-functions/ledger.ts uses. Never write ember_balances directly from a suite:
// a cache row with no ledger row breaks the `balance == SUM(ledger)` invariant that
// suites/ledger-trace.ts exists to enforce, and turns every later balance assertion into
// a test of the fixture rather than of the product. rule_key='participation' version 1
// is an existing (inactive) ember_rules row referenced only to satisfy the FK;
// entry_type is what marks this as a test-only adjustment.
export async function seedBalance(userId: string, amount: number, note = 'fixture seed'): Promise<void> {
    const idempotencyKey = `acceptance-seed:${userId}:${crypto.randomUUID()}`;
    await pool.query(
        `WITH ins AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            VALUES ($1, $2, 'adjustment', 'participation', 1, $3, $4::jsonb)
            RETURNING amount
        )
        INSERT INTO ember_balances (user_id, balance, updated_at)
        SELECT $1, amount, NOW() FROM ins
        ON CONFLICT (user_id) DO UPDATE SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
        [userId, amount, idempotencyKey, JSON.stringify({ acceptance: note })],
    );
}

export async function ledgerTotals(userId: string): Promise<LedgerTotals> {
    const { rows } = await pool.query(
        `SELECT
            (SELECT balance FROM ember_balances WHERE user_id = $1) AS balance_cache,
            (SELECT COALESCE(SUM(amount), 0)::int FROM ember_ledger WHERE user_id = $1) AS ledger_sum,
            (SELECT COUNT(*)::int FROM ember_ledger WHERE user_id = $1) AS ledger_rows,
            (SELECT lifetime_earned FROM ember_balances WHERE user_id = $1) AS lifetime_cache,
            (SELECT COALESCE(SUM(amount), 0)::int FROM ember_ledger WHERE user_id = $1 AND entry_type = 'earn' AND rule_key = ANY($2::text[]))
              + (SELECT COALESCE(SUM(GREATEST(FLOOR(realized_pnl), 0)), 0)::int FROM share_trades WHERE user_id = $1 AND side = 'sell')
              AS lifetime_recomputed`,
        [userId, [...LIFETIME_EARNED_RULE_KEYS]],
    );
    const r = rows[0];
    return {
        balanceCache: r.balance_cache === null ? null : Number(r.balance_cache),
        ledgerSum: Number(r.ledger_sum),
        ledgerRows: Number(r.ledger_rows),
        lifetimeCache: r.lifetime_cache === null ? null : Number(r.lifetime_cache),
        lifetimeRecomputed: Number(r.lifetime_recomputed),
    };
}

// ---------------------------------------------------------------------------------
// game_config version-flip / restore, generalized to any key. Registers its own
// teardown so an aborted suite still restores every key it touched.
// ---------------------------------------------------------------------------------

const originalConfigVersion = new Map<string, number>();
let teardownRegistered = false;

export async function flipConfig(key: string, overrides: Record<string, unknown>): Promise<void> {
    if (!teardownRegistered) {
        teardownRegistered = true;
        registerTeardown(restoreAllConfigs);
    }
    const { rows } = await pool.query(`SELECT version, config FROM game_config WHERE key = $1 AND active`, [key]);
    if (rows.length !== 1) throw new Error(`game_config['${key}'] has no active row - seed it first.`);
    if (!originalConfigVersion.has(key)) originalConfigVersion.set(key, rows[0].version as number);
    const merged = { ...rows[0].config, ...overrides };
    const { rows: maxRows } = await pool.query(`SELECT MAX(version) AS v FROM game_config WHERE key = $1`, [key]);
    const nextVersion = (maxRows[0].v as number) + 1;
    await pool.query(`UPDATE game_config SET active = false WHERE key = $1 AND active`, [key]);
    await pool.query(`INSERT INTO game_config (key, version, active, config) VALUES ($1, $2, true, $3)`, [key, nextVersion, JSON.stringify(merged)]);
}

export async function restoreConfig(key: string): Promise<void> {
    const orig = originalConfigVersion.get(key);
    if (orig === undefined) return;
    await pool.query(`UPDATE game_config SET active = false WHERE key = $1 AND active`, [key]);
    await pool.query(`DELETE FROM game_config WHERE key = $1 AND version > $2`, [key, orig]);
    await pool.query(`UPDATE game_config SET active = true WHERE key = $1 AND version = $2`, [key, orig]);
    originalConfigVersion.delete(key);
}

export async function restoreAllConfigs(): Promise<void> {
    for (const key of [...originalConfigVersion.keys()]) await restoreConfig(key);
}

export async function activeConfig(key: string): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(`SELECT config FROM game_config WHERE key = $1 AND active`, [key]);
    if (rows.length !== 1) throw new Error(`game_config['${key}'] has no active row.`);
    return rows[0].config;
}

// Deactivates a config row entirely (no active row left for that key) so getGameConfig()
// throws, per pets.ts:20 - used by the discovery no-pet-no-roll dynamic proof (Phase 4E).
// Restored the same way as flipConfig (tracked by version, reactivated in the finally).
export async function deactivateConfig(key: string): Promise<void> {
    if (!teardownRegistered) {
        teardownRegistered = true;
        registerTeardown(restoreAllConfigs);
    }
    const { rows } = await pool.query(`SELECT version FROM game_config WHERE key = $1 AND active`, [key]);
    if (rows.length !== 1) throw new Error(`game_config['${key}'] has no active row.`);
    if (!originalConfigVersion.has(key)) originalConfigVersion.set(key, rows[0].version as number);
    await pool.query(`UPDATE game_config SET active = false WHERE key = $1 AND active`, [key]);
}

// ---------------------------------------------------------------------------------
// Tank fixtures (shared by tickers/settlement/boundaries/security suites)
// ---------------------------------------------------------------------------------

export interface TankFixture {
    slug: string;
    provider?: string;
    visibility?: string;
    marketId: string;
    outcomes: string[];
    outcomePrices?: number[]; // omit to build a snapshot with NO odds.outcomePrices (settle fallback path)
    league?: string;
    market?: string; // snapshot prop.market - batch-2 totals eligibility ('totals' etc.)
}
export async function insertTank(f: TankFixture): Promise<string> {
    const snapshot = {
        prop: {
            id: f.marketId,
            player: 'Acceptance Fixture',
            team: 'FIX',
            market: f.market ?? 'acceptance_market',
            line: 0,
            prominence: 1,
            odds: { outcomes: f.outcomes, outcomePrices: f.outcomePrices },
            settleDate: new Date().toISOString(),
        },
        game: { id: `acceptance-${f.slug}`, home: 'FIX', away: 'TURE' },
    };
    const modelOutput = { call: { question: 'Acceptance fixture call?', sides: f.outcomes } };
    const { rows } = await pool.query(
        `INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, status, visibility)
         VALUES ($1, $2, $3, 'acceptance fixture', $4, $5, 'published', $6) RETURNING id`,
        [f.slug, f.provider ?? 'polymarket', f.league ?? 'NBA', JSON.stringify(snapshot), JSON.stringify(modelOutput), f.visibility ?? 'app'],
    );
    return rows[0].id as string;
}

// ---------------------------------------------------------------------------------
// Cleanup - one prefix-scoped sweep, reusable across suites. Deletes in FK-safe order;
// tank_pages deletion cascades picks/ticker_tags/ticker_events via their tank_id FKs.
// Never touches collectible_pools.minted_count (see suites/discovery.ts's comment) -
// that rule is restated here so every suite that calls this inherits it.
// ---------------------------------------------------------------------------------

export async function cleanupUsersByEmailPrefix(prefix: string): Promise<void> {
    const { rows: users } = await pool.query(`SELECT id FROM waitlist WHERE email LIKE $1`, [`${prefix}%@example.com`]);
    for (const u of users) {
        await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [u.id]);
        // TANKDAQ share trading: trades FK the ledger row that paid for them, so they go
        // before ember_ledger; holdings only FK the user.
        await pool.query(`DELETE FROM share_trades WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM share_holdings WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_ledger WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_balances WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM inventory_items WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM pets WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM picks WHERE waitlist_id = $1`, [u.id]);
        // Community tables link an account opportunistically (linked_heatchecks_user_id,
        // no ON DELETE clause) - a leftover row here was blocking every later run's
        // cleanup with an FK violation on the waitlist delete.
        await pool.query(`DELETE FROM community_picks_votes WHERE linked_heatchecks_user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM community_points WHERE linked_heatchecks_user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM waitlist WHERE id = $1`, [u.id]);
    }
}

export async function cleanupTanksBySlugPrefix(prefix: string): Promise<void> {
    await pool.query(`DELETE FROM tank_pages WHERE slug LIKE $1`, [`${prefix}%`]);
}

// ---------------------------------------------------------------------------------
// Gamma/Polymarket market discovery + settlement fixtures - shared by suites/tickers.ts,
// suites/settlement.ts, suites/boundaries.ts, and suites/security.ts, all of which need
// a real live market (for tag eligibility/CLOB tests) and a real cleanly-resolved market
// (so /api/settle exercises genuine resolution instead of a stubbed one).
// ---------------------------------------------------------------------------------

interface GammaMarket {
    id: string;
    question?: string;
    outcomes?: string;
    outcomePrices?: string;
    clobTokenIds?: string;
    closed?: boolean;
    volumeNum?: number;
}
function parseArr(v: string | undefined): string[] {
    try {
        const parsed = JSON.parse(v ?? '');
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

export interface ResolvedMarket { id: string; outcomes: string[]; winningIndex: number }
export interface LiveMarket { id: string; outcomes: string[] }

let cachedMarkets: { resolved: ResolvedMarket; live: LiveMarket } | null = null;

// Cached per process run - every suite that needs "a real resolved market" and "a real
// live market" can share the same pair instead of re-querying Gamma per suite.
export async function findMarkets(): Promise<{ resolved: ResolvedMarket; live: LiveMarket }> {
    if (cachedMarkets) return cachedMarkets;
    const liveRes = await fetch('https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=40', { headers: { Accept: 'application/json' } });
    const liveMarkets = (await liveRes.json()) as GammaMarket[];
    const live = liveMarkets
        .filter((m) => parseArr(m.clobTokenIds).length === 2 && parseArr(m.outcomes).length === 2)
        .sort((a, b) => (b.volumeNum ?? 0) - (a.volumeNum ?? 0))[0];
    if (!live) throw new Error('No usable live Gamma market found.');

    const closedRes = await fetch('https://gamma-api.polymarket.com/markets?closed=true&limit=100', { headers: { Accept: 'application/json' } });
    const closedMarkets = (await closedRes.json()) as GammaMarket[];
    const resolved = closedMarkets.find((m) => {
        const outcomes = parseArr(m.outcomes);
        const prices = parseArr(m.outcomePrices).map(Number);
        return m.closed === true && outcomes.length === 2 && prices.length === 2 && prices.some((p) => p >= 0.99) && prices.some((p) => p <= 0.01);
    });
    if (!resolved) throw new Error('No cleanly resolved Gamma market found.');
    const resolvedPrices = parseArr(resolved.outcomePrices).map(Number);
    cachedMarkets = {
        resolved: {
            id: resolved.id,
            outcomes: parseArr(resolved.outcomes),
            winningIndex: resolvedPrices[0] > resolvedPrices[1] ? 0 : 1,
        },
        live: { id: live.id, outcomes: parseArr(live.outcomes) },
    };
    return cachedMarkets;
}

// ---------------------------------------------------------------------------------
// Kalshi market discovery - the same role findMarkets() plays for Polymarket/Gamma
// above, returning the identical { resolved, live } shape so suite code parameterized
// by provider doesn't need separate destructuring logic. Only searches series in
// KALSHI_SERIES_MAP (kalshi.ts) - the player-prop series this app actually curates
// from - not Kalshi's full market catalog.
// ---------------------------------------------------------------------------------

interface KalshiMarketRaw {
    ticker: string;
    status: string;
    result: string | null;
    yes_bid_dollars?: string;
    yes_ask_dollars?: string;
    volume?: number; // contracts traded, lifetime - the trade-history source fetchKalshiTagDelta pages
}

function kalshiOutcomesFor(ticker: string): string[] {
    const seriesTicker = ticker.split('-')[0];
    const info = KALSHI_SERIES_MAP[seriesTicker];
    return info?.shape === 'ladder' ? ['Over', 'Under'] : ['Yes', 'No'];
}

let cachedKalshiMarkets: { resolved: ResolvedMarket; live: LiveMarket } | null = null;

export async function findKalshiMarkets(): Promise<{ resolved: ResolvedMarket; live: LiveMarket }> {
    if (cachedKalshiMarkets) return cachedKalshiMarkets;
    const seriesTickers = Object.keys(KALSHI_SERIES_MAP);

    let live: KalshiMarketRaw | undefined;
    let resolved: KalshiMarketRaw | undefined;
    for (const seriesTicker of seriesTickers) {
        if (!live) {
            const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=open&limit=100`, { headers: { Accept: 'application/json' } });
            const body = (await res.json()) as { markets?: KalshiMarketRaw[] };
            const quoted = (body.markets ?? []).filter((m) => {
                const bid = Number(m.yes_bid_dollars);
                const ask = Number(m.yes_ask_dollars);
                return Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask < 1;
            });
            // A quoted market can still have ZERO trades (a freshly listed prop with a
            // market-maker spread and nobody through it yet) - and the tag path's
            // delta comes from Kalshi's /trades history, so such a market fails the
            // suite with empty_price_history through no fault of the code (seen on
            // three runs the week the NFL props listed). Prefer the most-traded quoted
            // market; fall back to any quoted one only if nothing has traded.
            live = quoted
                .filter((m) => Number(m.volume) > 0)
                .sort((a, b) => Number(b.volume) - Number(a.volume))[0]
                ?? quoted[0];
        }
        if (!resolved) {
            const res = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?series_ticker=${seriesTicker}&status=settled&limit=100`, { headers: { Accept: 'application/json' } });
            const body = (await res.json()) as { markets?: KalshiMarketRaw[] };
            resolved = (body.markets ?? []).find((m) => m.result === 'yes' || m.result === 'no');
        }
        if (live && resolved) break;
    }
    if (!live) throw new Error('No usable open Kalshi market found across KALSHI_SERIES_MAP.');
    if (!resolved) throw new Error('No cleanly resolved (yes/no) Kalshi market found across KALSHI_SERIES_MAP.');

    cachedKalshiMarkets = {
        resolved: {
            id: resolved.ticker,
            outcomes: kalshiOutcomesFor(resolved.ticker),
            winningIndex: resolved.result === 'yes' ? 0 : 1,
        },
        live: { id: live.ticker, outcomes: kalshiOutcomesFor(live.ticker) },
    };
    return cachedKalshiMarkets;
}

// Hand-inserted tag - the retrotagging path: settlement must fire for these even though
// no pick and no endpoint call ever touched them. Mirrors the same construction
// /api/ticker-tags uses when it writes a tag + its 'tag' event.
export async function insertTagDirect(tankId: string, tickerKey: string, relevantSide: number, tagDelta: number): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO ticker_tags (tank_id, ticker_key, relevant_side, retroactive) VALUES ($1, $2, $3, true) RETURNING id`,
        [tankId, tickerKey, relevantSide],
    );
    const tagId = rows[0].id as string;
    await pool.query(
        `INSERT INTO ticker_events (ticker_tag_id, ticker_key, tank_id, event_type, delta, metadata)
         VALUES ($1, $2, $3, 'tag', $4, '{"acceptance": true}')`,
        [tagId, tickerKey, tankId, tagDelta],
    );
    return tagId;
}

export async function insertUserWithPick(email: string, tankId: string, tankSlug: string, outcomeIndex: number, impliedProb: number): Promise<{ userId: string; pickId: string }> {
    const { rows: userRows } = await pool.query(
        `INSERT INTO waitlist (email) VALUES ($1)
         ON CONFLICT (LOWER(email)) DO UPDATE SET email = EXCLUDED.email RETURNING id`,
        [email],
    );
    const userId = userRows[0].id as string;
    const { rows: pickRows } = await pool.query(
        `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock)
         VALUES ($1, $2, $3, 'Acceptance side', $4, $5) RETURNING id`,
        [userId, tankId, tankSlug, outcomeIndex, impliedProb],
    );
    return { userId, pickId: pickRows[0].id as string };
}

export async function tickerValue(key: string): Promise<number> {
    const res = await api('GET', '/api/tickers');
    const t = res.json?.tickers?.find((x: any) => x.key === key);
    return typeof t?.value === 'number' ? t.value : NaN;
}

export async function settleEventDelta(tagId: string): Promise<number | null> {
    const { rows } = await pool.query(`SELECT delta::float8 AS delta FROM ticker_events WHERE ticker_tag_id = $1 AND event_type = 'settle'`, [tagId]);
    return rows.length ? (rows[0].delta as number) : null;
}

// ---------------------------------------------------------------------------------
// Slate fixtures - index_positions rows and the daily 'close' event they roll into
// (create_index_positions_table.sql / alter_ticker_events_for_slate.sql). These feed
// the Recent Results path (getTickerResults, lib/pages-functions/tickers.ts), which
// reads settled win/loss positions joined to their close.
//
// Constraint hazards, and how the helpers dodge them:
//   * ticker_events has a partial UNIQUE (ticker_key, close_date) WHERE source='slate',
//     so a fixture close dated today would collide with the REAL daily close. Fixture
//     closes take a far-past date (1999-01-01 by convention in suites/index-results.ts).
//   * A slate close's delta counts toward the live ticker value while it exists - same
//     precedent as insertTagDirect's live-counting tag events - so cleanup must run.
//   * index_positions has no tank FK: cleanupTanksBySlugPrefix does NOT cascade here.
//     Fixture rows carry INDEX_FIXTURE_PREFIX on event_id/market_id and are deleted by
//     cleanupIndexFixtures below; close_id is ON DELETE SET NULL, so positions go first.
// ---------------------------------------------------------------------------------

export const INDEX_FIXTURE_PREFIX = 'acceptance-index-';

export interface SlateCloseMeta { positionsCounted: number; positionsWon: number; scalePct: number; smoothing: number }

export async function insertSlateCloseDirect(tickerKey: string, closeDate: string, delta: number, meta: SlateCloseMeta): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO ticker_events (ticker_key, event_type, source, close_date, delta, metadata)
         VALUES ($1, 'close', 'slate', $2::date, $3, $4::jsonb) RETURNING id`,
        [tickerKey, closeDate, delta, JSON.stringify({ ...meta, acceptance: true })],
    );
    return rows[0].id as string;
}

export interface IndexPositionFixture {
    tickerKey: string;
    eventId: string;   // must start with INDEX_FIXTURE_PREFIX
    marketId: string;  // likewise; no polymarket_props row exists for it (LEFT JOIN tolerance)
    league?: string;
    away: string;
    home: string;
    marketType: 'totals' | 'moneyline';
    marketLine?: number | null;
    sideIndex: number;
    sideLabel: string;
    entryProb: number;
    result: 'win' | 'loss';
    closeId: string;
    settledAt?: string; // ISO; defaults to NOW() so the row ranks newest
}

// Mirrors what index-lock + index-settle leave behind for one game, in one insert.
export async function insertIndexPositionDirect(f: IndexPositionFixture): Promise<{ id: string; contrib: number }> {
    if (!f.eventId.startsWith(INDEX_FIXTURE_PREFIX) || !f.marketId.startsWith(INDEX_FIXTURE_PREFIX)) {
        throw new Error(`index fixture ids must start with ${INDEX_FIXTURE_PREFIX}`);
    }
    const won = f.result === 'win';
    const contrib = Number((won ? 1 - f.entryProb : -f.entryProb).toFixed(3)); // contributionFor, index-slate.ts
    const { rows } = await pool.query(
        `INSERT INTO index_positions (
             ticker_key, provider, market_id, league, event_id, away, home, kickoff,
             market_type, market_line, side_index, side_label, entry_prob, locked_at,
             result, winning_index, settled_at, contrib, close_id)
         VALUES ($1, 'polymarket', $2, $3, $4, $5, $6, NOW() - INTERVAL '6 hours',
                 $7, $8, $9, $10, $11, NOW() - INTERVAL '7 hours',
                 $12, $13, COALESCE($14::timestamptz, NOW()), $15, $16)
         RETURNING id`,
        [
            f.tickerKey, f.marketId, f.league ?? 'ACCEPTANCE', f.eventId, f.away, f.home,
            f.marketType, f.marketLine ?? null, f.sideIndex, f.sideLabel, f.entryProb,
            f.result, won ? f.sideIndex : 1 - f.sideIndex, f.settledAt ?? null, contrib, f.closeId,
        ],
    );
    return { id: rows[0].id as string, contrib };
}

export async function cleanupIndexFixtures(): Promise<void> {
    await pool.query(`DELETE FROM index_positions WHERE event_id LIKE $1`, [`${INDEX_FIXTURE_PREFIX}%`]);
    await pool.query(`DELETE FROM ticker_events WHERE source = 'slate' AND metadata @> '{"acceptance": true}'::jsonb`);
}

// The SqlReader shape lib/pages-functions/tickers.ts's read helpers take, adapted onto
// the harness pool - the same 3-line adapter scripts/generate-static-site.ts uses at
// build time, so a suite that runs a helper through this proves the statement is plain
// parameterised SQL and not Neon-only.
export const sqlViaPool = async (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]> => {
    const text = strings.reduce((acc, part, i) => acc + `$${i}` + part);
    return (await pool.query(text, values as unknown[])).rows;
};

// The fuller NeonQueryFunction shape the WRITE helpers in lib/pages-functions/ledger.ts
// need: a tagged template that runs on await, PLUS sql.transaction([...]) over the
// un-awaited tagged calls (settleCall, buyShares and sellShares all use it). Runs the
// array on one pooled client inside BEGIN/COMMIT (ROLLBACK on any failure), which is
// what Neon's HTTP driver does server-side - so a suite can drive the real ledger
// functions against the harness pool instead of re-implementing their statements.
// Returns rows arrays exactly like the Neon driver's default (non-fullResults) mode.
interface LazyQuery { text: string; values: unknown[] }
export function sqlViaPoolTx(): NeonQueryFunction<false, false> {
    const tagged = (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.reduce((acc, part, i) => acc + `$${i}` + part);
        const lazy: LazyQuery & PromiseLike<Record<string, unknown>[]> = {
            text,
            values,
            then: (onFulfilled, onRejected) =>
                pool.query(text, values).then((r) => r.rows).then(onFulfilled, onRejected),
        };
        return lazy;
    };
    tagged.transaction = async (queries: LazyQuery[]) => {
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            const out: Record<string, unknown>[][] = [];
            for (const q of queries) out.push((await client.query(q.text, q.values)).rows);
            await client.query('COMMIT');
            return out;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => undefined);
            throw err;
        } finally {
            client.release();
        }
    };
    return tagged as unknown as NeonQueryFunction<false, false>;
}

// ---------------------------------------------------------------------------------
// Live catalog SKU lookup - shared by suites/pets.ts, suites/concurrency.ts, and
// suites/security.ts. The catalog is retuned independently of this harness (SKUs get
// deactivated/replaced), so a suite that hardcodes a SKU key silently starts testing a
// 404 instead of a purchase the moment that key goes inactive - query for a real one
// instead, exactly like suites/ledger-trace.ts already does for the same reason.
// ---------------------------------------------------------------------------------

export interface SkuInfo { catalogKey: string; priceRuleKey: string; price: number; config: Record<string, unknown> }

export async function cheapestActiveSku(itemType: 'egg' | 'food'): Promise<SkuInfo> {
    const { rows } = await pool.query(
        `SELECT c.key AS catalog_key, c.price_rule_key, c.config, (r.config->>'amount')::int AS price
         FROM items_catalog c
         JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
         WHERE c.item_type = $1 AND c.active = true
           AND (c.available_from IS NULL OR c.available_from <= NOW())
           AND (c.available_until IS NULL OR c.available_until > NOW())
         ORDER BY (r.config->>'amount')::int ASC
         LIMIT 1`,
        [itemType],
    );
    if (rows.length === 0) throw new Error(`No active ${itemType} SKU found - seed the catalog first.`);
    return {
        catalogKey: rows[0].catalog_key as string,
        priceRuleKey: rows[0].price_rule_key as string,
        price: Number(rows[0].price),
        config: rows[0].config as Record<string, unknown>,
    };
}

// A second active SKU of the same item_type, distinct from `excludeKey` - used where a
// test needs two different real eggs/foods (e.g. "buy egg A, then egg B").
export async function secondActiveSku(itemType: 'egg' | 'food', excludeKey: string): Promise<SkuInfo> {
    const { rows } = await pool.query(
        `SELECT c.key AS catalog_key, c.price_rule_key, c.config, (r.config->>'amount')::int AS price
         FROM items_catalog c
         JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
         WHERE c.item_type = $1 AND c.active = true AND c.key != $2
           AND (c.available_from IS NULL OR c.available_from <= NOW())
           AND (c.available_until IS NULL OR c.available_until > NOW())
         ORDER BY (r.config->>'amount')::int ASC
         LIMIT 1`,
        [itemType, excludeKey],
    );
    if (rows.length === 0) throw new Error(`No second active ${itemType} SKU found besides "${excludeKey}".`);
    return {
        catalogKey: rows[0].catalog_key as string,
        priceRuleKey: rows[0].price_rule_key as string,
        price: Number(rows[0].price),
        config: rows[0].config as Record<string, unknown>,
    };
}
