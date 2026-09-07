// ===================================================================================
// GET / — the server-rendered homepage (the site's front door).
// ===================================================================================
// The first request-time HTML route in the repo (everything else is build-time static
// files; functions/api/* is JSON-only). Pages routes functions/index.ts to exactly
// "/", taking precedence over the static dist/index.html - which remains as the
// logged-out build-time fallback written by scripts/generate-static-site.ts through
// the same renderHomepage() template.
//
// Fail-open philosophy: this is the most SEO-critical page on the site, so a broken
// session or a failed content query must degrade (logged-out header / empty sections),
// never 500 for a crawler.
//
// COST (efficiency audit, 2026-09-04): a fully live render was seven Neon round-trips
// per hit - session, balance, the live-Tanks query and the four ticker aggregates
// (getTickerSeries alone is a window-function pass over all of ticker_events) - paid
// identically by every crawler. Two bounded caches now sit in front of that, with a
// strict rule about what may be shared:
//
//   1. ANONYMOUS requests (no session cookie of either name - checked on the raw
//      Cookie header, BEFORE any token verification, so a stale or forged cookie is a
//      cache bypass, never a hit) may be served the whole HTML from this function's
//      own Cache API entry, ANON_CACHE_SECONDS TTL, keyed on the canonical URL. This
//      is the function consulting a cache it controls, after the cookie check - NOT
//      a public Cache-Control header: Cloudflare's edge keys HTML by URL and ignores
//      Vary: Cookie, so a public header on "/" would hand an anonymous page to a
//      logged-in user (the hazard public/_headers documents for the static fallback).
//      The browser-facing headers stay `private, no-store` on every response, cached
//      or not, so no CDN, proxy or browser ever holds this page.
//   2. The CONTENT queries (Tanks + market movers - identical for every visitor) are
//      memoized in this isolate for CONTENT_MEMO_MS, sharing the in-flight promise so
//      a burst at expiry refetches once. Session and balance are NEVER memoized: a
//      logged-in render still validates its session and reads its balance live on
//      every request, and only the content section can be up to 30s old.
//
// Un-onboarded sessions, every /api/* route, and the ticker reads' other callers
// (trade pricing above all) are untouched by either cache.
// ===================================================================================

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../lib/pages-functions/db';
import { getSession, getCookieValue, SESSION_COOKIE, HOST_SESSION_COOKIE, type Session } from '../lib/pages-functions/session';
import { balance } from '../lib/pages-functions/ledger';
import { fetchHomepageData, emptyHomepageData, type HomepageData } from '../lib/pages-functions/homepage/data';
import { renderHomepage } from '../lib/pages-functions/homepage/render';

const ANON_CACHE_SECONDS = 60;
const CONTENT_MEMO_MS = 30_000;

// Verification/observability headers - what the response was built from. Never a
// cache signal to anything downstream (Cache-Control stays private, no-store).
const CACHE_HEADER = 'X-Homepage-Cache';     // HIT | MISS | BYPASS
const CONTENT_HEADER = 'X-Homepage-Content'; // memo | fresh

interface ContentMemo {
    promise: Promise<HomepageData>;
    expiresAt: number;
}
let contentMemo: ContentMemo | null = null;

// The content-only queries, memoized per isolate. A rejected fetch evicts itself so
// the next request retries instead of serving a cached failure for 30 seconds.
function loadHomepageContent(env: Env): { data: Promise<HomepageData>; fromMemo: boolean } {
    const now = Date.now();
    if (contentMemo && contentMemo.expiresAt > now) {
        return { data: contentMemo.promise, fromMemo: true };
    }
    const entry: ContentMemo = {
        promise: fetchHomepageData(getSql(env)),
        expiresAt: now + CONTENT_MEMO_MS,
    };
    contentMemo = entry;
    entry.promise.catch(() => {
        if (contentMemo === entry) contentMemo = null;
    });
    return { data: entry.promise, fromMemo: false };
}

function hasSessionCookie(cookieHeader: string | null): boolean {
    return getCookieValue(cookieHeader, SESSION_COOKIE) !== null
        || getCookieValue(cookieHeader, HOST_SESSION_COOKIE) !== null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const { request, env } = context;
    const cookieBearing = hasSessionCookie(request.headers.get('Cookie'));

    // Anonymous only: the cache is consulted solely when no session cookie exists.
    // Query string stripped from the key - the page ignores it, so /?utm=... shares
    // the one entry rather than fragmenting the cache per campaign link.
    const cache = (caches as unknown as { default: Cache }).default;
    const cacheKey = cookieBearing ? null : new Request(new URL('/', request.url).toString(), { method: 'GET' });
    if (cacheKey) {
        const hit = await cache.match(cacheKey);
        if (hit) {
            const headers = new Headers(hit.headers);
            headers.set('Cache-Control', 'private, no-store');
            headers.set(CACHE_HEADER, 'HIT');
            return new Response(hit.body, { status: hit.status, headers });
        }
    }

    let session: Session | null = null;
    if (cookieBearing) {
        try {
            session = await getSession(request, env);
        } catch {
            // Render logged-out rather than failing the page.
        }
    }
    const setCookie = session?.refreshedSetCookie ?? null;

    // Onboarding gate, before any content work: a session that never signed the
    // welcome letter must not see this page (same hard gate the client enforces
    // everywhere else - this is its first server-side enforcement).
    if (session && !session.onboarded) {
        const headers = new Headers({
            Location: new URL('/welcome/', request.url).toString(),
            'Cache-Control': 'no-store',
        });
        if (setCookie) headers.set('Set-Cookie', setCookie);
        return new Response(null, { status: 302, headers });
    }

    let data: HomepageData = emptyHomepageData();
    let emberBalance = 0;
    let contentOk = false;
    let fromMemo = false;
    try {
        const sql = getSql(env);
        const content = loadHomepageContent(env);
        fromMemo = content.fromMemo;
        [data, emberBalance] = await Promise.all([
            content.data,
            session ? balance(sql, session.userId) : Promise.resolve(0),
        ]);
        contentOk = true;
    } catch (err) {
        console.error('Homepage data fetch failed; rendering empty sections:', err);
    }

    const baseUrl = env.BASE_URL || new URL(request.url).origin;
    const html = renderHomepage({
        baseUrl,
        user: session ? { username: session.username ?? session.email, balance: emberBalance } : null,
        data,
    });

    const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        // Session-dependent HTML: must never land in a shared cache. Set here because
        // public/_headers does not apply to Pages Function responses. Unchanged for
        // the anonymous render too - the only cache is the one above, which this
        // function consults itself after the cookie check.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        [CACHE_HEADER]: cacheKey ? 'MISS' : 'BYPASS',
        [CONTENT_HEADER]: fromMemo ? 'memo' : 'fresh',
    });
    if (setCookie) headers.set('Set-Cookie', setCookie);
    const response = new Response(html, { headers });

    // Store the anonymous render only when it is a complete, healthy page: never the
    // fail-open empty render (a transient DB error must not be pinned for a minute),
    // never a render whose market-movers section fell back to empty inside
    // fetchHomepageData, and never anything carrying a Set-Cookie (an anonymous
    // request has no session to refresh, so this is belt-and-braces). The stored copy
    // carries the Cache API's own TTL signal; the client copy above does not.
    const healthy = contentOk && data.marketMovers.movers.length > 0;
    if (cacheKey && healthy && !setCookie) {
        const stored = new Response(html, {
            headers: {
                'Content-Type': 'text/html; charset=utf-8',
                'Cache-Control': `public, s-maxage=${ANON_CACHE_SECONDS}`,
                'X-Content-Type-Options': 'nosniff',
                [CONTENT_HEADER]: fromMemo ? 'memo' : 'fresh',
            },
        });
        context.waitUntil(cache.put(cacheKey, stored));
    }
    return response;
};
