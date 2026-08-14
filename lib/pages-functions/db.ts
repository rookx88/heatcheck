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
    SETTLE_SECRET: string;
    CURATE_SECRET: string;
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
    return new Response(JSON.stringify(body), {
        status: init.status ?? 200,
        headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string> | undefined) },
    });
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
