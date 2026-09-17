// Root Pages middleware: security headers on EVERY response - Function routes (the SSR
// homepage, all of /api/*) and static assets alike, since a root _middleware runs
// before either. public/_headers carries the same set for static files as a second
// layer, but that file never applies to Function responses, which is why nothing on
// the site had these before (launch audit, 2026-09-07): every authenticated page was
// framable, and there was no HSTS or referrer policy.
//
// Deliberately NOT a full Content-Security-Policy yet: the pages inline styles and
// JSON payloads and pull Google Fonts, so an enforced CSP needs its own inventory
// pass. frame-ancestors is the one directive independent of all that, so it ships
// here (with X-Frame-Options for older browsers). Never touches Cache-Control - each
// route owns its own caching decision (functions/index.ts's anonymous cache relies on
// its `private, no-store` staying exactly as set).

import type { PagesFunction } from '@cloudflare/workers-types';

const HSTS = 'max-age=31536000; includeSubDomains'; // no `preload`: irreversible, add deliberately later

export const onRequest: PagesFunction = async (context) => {
    const response = await context.next();
    const headers = new Headers(response.headers);
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
