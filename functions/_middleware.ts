// Root Pages middleware, run before every Function route and static asset. A chain:
//
//   1. Sentry (pre-launch Audit 4) - initialises error reporting for the request so an
//      unhandled throw anywhere below is reported with its stack, and every handled
//      console.error (the handlers' own try/catch logging) is reported too. Off when
//      SENTRY_DSN is unset (local dev), since the SDK does nothing without a DSN.
//   2. Security headers + ops events (below).
//
// Security headers go on EVERY response - Function routes (the SSR homepage, all of
// /api/*) and static assets alike. public/_headers carries the same set for static files
// as a second layer, but that file never applies to Function responses, which is why
// nothing on the site had these before (launch audit, 2026-09-07): every authenticated
// page was framable, and there was no HSTS or referrer policy.
//
// Deliberately NOT a full Content-Security-Policy yet: the pages inline styles and
// JSON payloads and pull Google Fonts, so an enforced CSP needs its own inventory
// pass. frame-ancestors is the one directive independent of all that, so it ships
// here (with X-Frame-Options for older browsers). Never touches Cache-Control - each
// route owns its own caching decision (functions/index.ts's anonymous cache relies on
// its `private, no-store` staying exactly as set).
//
// Ops events: security- and error-relevant outcomes are written to ops_events after the
// response is sent (waitUntil - no added latency), for the hourly health check's burst
// alerts and the daily summary (lib/pages-functions/ops-health.ts). Only rejections and
// errors are recorded, never ordinary traffic, and the IP only as a salted hash.

import type { PagesFunction } from '@cloudflare/workers-types';
import * as Sentry from '@sentry/cloudflare';
import { getSql, type Env } from '../lib/pages-functions/db';
import { hashIp } from '../lib/pages-functions/alerts';
import { REJECT_REASON_HEADER } from '../lib/pages-functions/session';

const HSTS = 'max-age=31536000; includeSubDomains'; // no `preload`: irreversible, add deliberately later

// Machine endpoints (cron Workers and the curator tool): a 401 here is someone without
// the secret.
const MACHINE_PATHS = new Set([
    '/api/settle', '/api/index-settle', '/api/index-lock', '/api/curate', '/api/curate-sport',
    '/api/ticker-tags', '/api/ticker-sweep', '/api/notify-sweep', '/api/discord-sweep',
    '/api/league-slate-sweep', '/api/weekly-leaderboard-sweep', '/api/community-pick-settlement-sweep',
    '/api/discord-settlement-sweep', '/api/pvp-settlement-sweep', '/api/tank-resolution-sweep',
    '/api/leaderboard-image-test', '/api/ops/health-check', '/api/ops/job-report', '/api/ops/health',
]);
// Endpoints that move Ember, items or market state: any 4xx is worth counting.
const SENSITIVE_PATHS = new Set([
    '/api/shop/buy', '/api/tankdaq/buy', '/api/tankdaq/sell', '/api/pets/hatch', '/api/pets/feed', '/api/picks',
]);

function classify(path: string, status: number, rejectReason: string | null): string | null {
    if (status >= 500) return 'server_error';
    if (rejectReason === 'csrf') return 'csrf_reject';
    if (status === 401 && MACHINE_PATHS.has(path)) return 'auth_reject';
    if (status === 429 && path.startsWith('/api/')) return 'throttle';
    if (status >= 400 && SENSITIVE_PATHS.has(path)) return 'rejected';
    return null;
}

async function recordOpsEvent(env: Env, request: Request, path: string, status: number, kind: string, detail: Record<string, unknown>): Promise<void> {
    try {
        if (!env.DATABASE_URL) return;
        const sql = getSql(env);
        const ipHash = await hashIp(env, request.headers.get('CF-Connecting-IP'));
        // The acceptance harness attacks a local dev server on purpose, against the same
        // database - its rejections are tagged `local` and the health checks ignore them,
        // so a test run never reads as an attack in the summary or trips a burst alert.
        let local = false;
        try {
            const host = new URL(request.url).hostname;
            local = host === 'localhost' || host === '127.0.0.1';
        } catch { /* not local */ }
        await sql`
            INSERT INTO ops_events (kind, path, status, ip_hash, detail)
            VALUES (${kind}, ${path.slice(0, 200)}, ${status}, ${ipHash}, ${JSON.stringify({ method: request.method, ...(local ? { local: true } : {}), ...detail })}::jsonb)
        `;
    } catch (err) {
        // Never let bookkeeping break a response - but say so, which Sentry reports.
        console.error('[_middleware] ops_events insert failed:', err);
    }
}

const headersAndOps: PagesFunction<Env> = async (context) => {
    let path = '/';
    try {
        path = new URL(context.request.url).pathname.replace(/\/+$/, '') || '/';
    } catch {
        /* keep '/' */
    }

    let response: Response;
    try {
        response = await context.next();
    } catch (err) {
        // An unhandled throw: record it for the error rate, then rethrow so Sentry's
        // wrapper (step 1) reports it and Pages answers 500 as before.
        context.waitUntil(recordOpsEvent(context.env, context.request, path, 500, 'server_error', { thrown: String(err).slice(0, 300) }));
        throw err;
    }

    const headers = new Headers(response.headers);
    const rejectReason = headers.get(REJECT_REASON_HEADER);
    headers.delete(REJECT_REASON_HEADER); // internal signal only, never sent to the client
    const kind = classify(path, response.status, rejectReason);
    if (kind) context.waitUntil(recordOpsEvent(context.env, context.request, path, response.status, kind, {}));

    headers.set('X-Frame-Options', 'DENY');
    headers.set('Content-Security-Policy', "frame-ancestors 'none'");
    headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    // HSTS is meaningless (and ignored) over plain http, which is what wrangler pages
    // dev serves; only set it where it means something.
    let secure = false;
    try {
        secure = new URL(context.request.url).protocol === 'https:';
    } catch {
        secure = false;
    }
    if (secure) headers.set('Strict-Transport-Security', HSTS);
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

const sentry = Sentry.sentryPagesPlugin<Env>((context) => ({
    dsn: context.env.SENTRY_DSN,
    // Errors only - no performance tracing, which the free tier would burn through.
    tracesSampleRate: 0,
    // The handlers catch their own errors and console.error them; report those too.
    integrations: [Sentry.captureConsoleIntegration({ levels: ['error'] })],
    sendDefaultPii: false,
}));

export const onRequest = [sentry, headersAndOps];
