// ===================================================================================
// Shared helpers for Cloudflare Pages Functions (functions/api/*).
//
// Kept outside functions/ deliberately: only _middleware.ts is documented as excluded
// from Cloudflare's file-based routing, so a shared-code folder under functions/ risks
// accidentally becoming a routable endpoint. This directory is plain source, imported
// by the functions, never routed to directly.
//
// Uses Neon's HTTP driver (neon(), tagged-template queries) rather than the WebSocket
// Pool/Client - Cloudflare Pages Functions run on the Workers runtime, which can't use
// backend.ts's pg/TCP Pool. The HTTP driver needs no nodejs_compat flag and is a good
// fit here since each request only ever needs one or two queries, not a pooled session.
// ===================================================================================

import { neon, type NeonQueryFunction } from '@neondatabase/serverless';

export interface Env {
    DATABASE_URL: string;
    RESEND_API_KEY: string;
    RESEND_AUDIENCE_ID: string;
    NEWSLETTER_TOKEN_SECRET: string;
    // Signs login-link + session-cookie tokens (lib/pages-functions/auth-tokens.ts).
    // Deliberately separate from NEWSLETTER_TOKEN_SECRET: tokens signed under one
    // secret can never verify under the other, on top of the purpose-claim check.
    SESSION_TOKEN_SECRET: string;
    // Canonical site origin (e.g. https://heatchecks.io), set per Cloudflare
    // environment. Used as the fallback when a login-link request arrives with an
    // untrusted Host, so the emailed link can never point at an attacker domain
    // (see resolveLoginOrigin in session.ts). Optional so local/dev still works.
    BASE_URL?: string;
    SETTLE_SECRET: string;
    CURATE_SECRET: string;
    // Shared-secret auth for POST /api/ticker-tags (X-Ticker-Secret header), sent by
    // the curator tooling when tagging a Tank to an Exchange ticker. Separate from
    // CURATE_SECRET on purpose: different caller trust domain (local curator tool vs
    // the worker-curate cron), so each can rotate without breaking the other.
    TICKER_SECRET: string;
    ANTHROPIC_API_KEY: string;
    MODEL?: string;
    MAX_TOKENS?: string;
    MARKET_WHITELIST?: string;
    MIN_PROMINENCE?: string;
    PER_GAME_CAP?: string;
    CURATE_WINDOW_HOURS?: string;
    CURATE_DEDUPE_DAYS?: string;
    CURATE_MAX_CANDIDATES?: string;
    CURATE_MAX_MATCHES_PER_RUN?: string;
    CURATE_WEB_SEARCH_MAX_USES?: string;
    CURATE_MATCH_MAX_TOKENS?: string;
    // Gates the daily pick volume separately from code deploys - defaults to 1 (see
    // functions/api/picks.ts) until explicitly raised via this env var when Phase 1
    // is actually ready to go, no redeploy needed to flip it.
    DAILY_PICK_CAP?: string;
}

export function getSql(env: Env): NeonQueryFunction<false, false> {
    if (!env.DATABASE_URL) throw new Error('DATABASE_URL is not configured for this Pages Function.');
    return neon(env.DATABASE_URL);
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
    // no-store + nosniff by default: these are all dynamic API responses, several of
    // them authenticated (session/balance/picks-today), so they must never be cached
    // by a proxy or a future Cloudflare Cache Rule and must not be MIME-sniffed. A
    // caller can still override via init.headers (spread last).
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
            ...(init.headers as Record<string, string> | undefined),
        },
    });
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
