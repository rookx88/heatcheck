// GET /api/hall-of-fame?page=N - the Tank Land Hall of Fame: the top 100 accounts by
// lifetime Ember EARNED (ember_balances.lifetime_earned - game payouts plus TANKDAQ
// profit, see add_lifetime_earned_to_ember_balances.sql), ten to a page. Public: the
// rotunda on the map opens it for anyone, logged out included, so this is the one
// surface that shows other accounts' usernames site-wide. It shows the username and
// the earned total and nothing else - no email, no balance, no id.
//
// Two halves with two caching stories:
//   rows  - identical for every viewer, so the ranked page is cached in caches.default
//           for CACHE_SECONDS (the tank-market.ts pattern) and served from there while
//           it lasts. The ORDER BY rides idx_ember_balances_lifetime_earned.
//   me    - the viewer's own rank + total, only when a valid session cookie rides
//           along (never a 401: a logged-out viewer still gets the board). Computed per
//           request, which is why the response itself stays no-store.
// Rank is competition rank (RANK(): ties share a rank, the next rank skips), and the
// viewer's rank is 1 + the count of accounts above them - the same arithmetic, so a
// viewer inside the top 100 sees the same number in both places. Ties within the
// board break by account age (oldest first) purely so pagination is stable.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';

const PAGE_SIZE = 10;
const MAX_RANKED = 100;
const MAX_PAGES = MAX_RANKED / PAGE_SIZE;
const CACHE_SECONDS = 60;

interface RankedRow {
    rank: number;
    username: string;
    earned: number;
}

interface RankedPage {
    page: number;
    pageSize: number;
    totalPages: number;
    totalRanked: number;
    rows: RankedRow[];
}

async function loadRankedPage(sql: ReturnType<typeof getSql>, page: number): Promise<RankedPage> {
    const offset = (page - 1) * PAGE_SIZE;
    const [rows, countRows] = await Promise.all([
        sql`
            SELECT RANK() OVER (ORDER BY b.lifetime_earned DESC)::int AS rank,
                   w.username,
                   b.lifetime_earned AS earned
            FROM ember_balances b
            JOIN waitlist w ON w.id = b.user_id
            WHERE b.lifetime_earned > 0 AND w.username IS NOT NULL
            ORDER BY b.lifetime_earned DESC, w.created_at ASC
            LIMIT ${PAGE_SIZE} OFFSET ${offset}
        `,
        sql`
            SELECT COUNT(*)::int AS n
            FROM ember_balances b
            JOIN waitlist w ON w.id = b.user_id
            WHERE b.lifetime_earned > 0 AND w.username IS NOT NULL
        `,
    ]);
    const totalRanked = Math.min(Number((countRows[0] as { n: number }).n), MAX_RANKED);
    return {
        page,
        pageSize: PAGE_SIZE,
        totalPages: Math.max(1, Math.ceil(totalRanked / PAGE_SIZE)),
        totalRanked,
        rows: (rows as unknown as RankedRow[]).map((r) => ({ rank: Number(r.rank), username: r.username, earned: Number(r.earned) })),
    };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const rawPage = url.searchParams.get('page');
    const page = rawPage === null ? 1 : Number(rawPage);
    if (!Number.isInteger(page) || page < 1 || page > MAX_PAGES) {
        return jsonResponse({ message: `page must be a whole number from 1 to ${MAX_PAGES}.` }, { status: 400 });
    }

    const sql = getSql(context.env);

    // The viewer half first (it never touches the cache), so the cookie slide happens
    // regardless of a cache hit.
    const session = await getSession(context.request, context.env);
    const authHeaders = session?.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const cacheKey = new Request(`${url.origin}/api/hall-of-fame?page=${page}`, { method: 'GET' });
    const cache = caches.default;
    let ranked: RankedPage;
    let cacheState: 'HIT' | 'MISS' = 'MISS';
    const hit = await cache.match(cacheKey);
    if (hit) {
        ranked = (await hit.json()) as RankedPage;
        cacheState = 'HIT';
    } else {
        ranked = await loadRankedPage(sql, page);
        const stored = new Response(JSON.stringify(ranked), {
            headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': `public, s-maxage=${CACHE_SECONDS}` },
        });
        context.waitUntil(cache.put(cacheKey, stored));
    }

    let me: { rank: number; username: string; earned: number } | null = null;
    if (session && session.username) {
        const meRows = await sql`
            SELECT b.lifetime_earned AS earned,
                   (1 + (SELECT COUNT(*) FROM ember_balances b2
                         JOIN waitlist w2 ON w2.id = b2.user_id
                         WHERE b2.lifetime_earned > b.lifetime_earned AND w2.username IS NOT NULL))::int AS rank
            FROM ember_balances b
            WHERE b.user_id = ${session.userId}
            LIMIT 1
        `;
        const row = meRows[0] as { earned: number; rank: number } | undefined;
        if (row && Number(row.earned) > 0) {
            me = { rank: Number(row.rank), username: session.username, earned: Number(row.earned) };
        }
    }

    // The debug header says whether the ranked half came from the edge cache (the
    // tank-market.ts convention); the acceptance suite reads it to know whether the
    // rows it sees can be expected to reflect its own fixtures yet.
    return jsonResponse(
        { ...ranked, loggedIn: session !== null, me },
        { headers: { 'X-Hall-Of-Fame-Cache': cacheState, ...(authHeaders ?? {}) } },
    );
};
