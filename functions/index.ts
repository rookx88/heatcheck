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
// ===================================================================================

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, type Env } from '../lib/pages-functions/db';
import { getSession, type Session } from '../lib/pages-functions/session';
import { balance } from '../lib/pages-functions/ledger';
import { fetchHomepageData, emptyHomepageData, type HomepageData } from '../lib/pages-functions/homepage/data';
import { renderHomepage } from '../lib/pages-functions/homepage/render';

export const onRequestGet: PagesFunction<Env> = async (context) => {
    let session: Session | null = null;
    try {
        session = await getSession(context.request, context.env);
    } catch {
        // Render logged-out rather than failing the page.
    }
    const setCookie = session?.refreshedSetCookie ?? null;

    // Onboarding gate, before any content work: a session that never signed the
    // welcome letter must not see this page (same hard gate the client enforces
    // everywhere else - this is its first server-side enforcement).
    if (session && !session.onboarded) {
        const headers = new Headers({
            Location: new URL('/welcome/', context.request.url).toString(),
            'Cache-Control': 'no-store',
        });
        if (setCookie) headers.set('Set-Cookie', setCookie);
        return new Response(null, { status: 302, headers });
    }

    let data: HomepageData = emptyHomepageData();
    let emberBalance = 0;
    try {
        const sql = getSql(context.env);
        [data, emberBalance] = await Promise.all([
            fetchHomepageData(sql),
            session ? balance(sql, session.userId) : Promise.resolve(0),
        ]);
    } catch (err) {
        console.error('Homepage data fetch failed; rendering empty sections:', err);
    }

    const baseUrl = context.env.BASE_URL || new URL(context.request.url).origin;
    const html = renderHomepage({
        baseUrl,
        user: session ? { username: session.username ?? session.email, balance: emberBalance } : null,
        data,
    });

    const headers = new Headers({
        'Content-Type': 'text/html; charset=utf-8',
        // Session-dependent HTML: must never land in a shared cache. Set here because
        // public/_headers does not apply to Pages Function responses.
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    if (setCookie) headers.set('Set-Cookie', setCookie);
    return new Response(html, { headers });
};
