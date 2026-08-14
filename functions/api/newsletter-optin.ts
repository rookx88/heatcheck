// POST /api/newsletter-optin - opts an existing waitlist row into the newsletter. Called
// from the "You're All Set" modal shown right after email verification. Idempotent: a
// second call for the same email just re-confirms true rather than clobbering the
// original newsletter_opted_in_at.
//
// Session-preferred: with a valid session cookie the opt-in targets the session's own
// account and any body email is ignored. The unauthenticated email fallback stays for
// now (the modal can fire before any session exists for legacy users) and is logged
// below - this is the last email-trusting write in the API, slated to drop once
// sessions bake. Worst-case abuse is "opt someone else in": low blast radius,
// unchanged from before auth existed.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';
import { logEvent } from '../../lib/pages-functions/events';
import { upsertResendAudienceContact } from '../../lib/resend-audience';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const session = await getSession(context.request, context.env);
    const email = session
        ? session.email.toLowerCase()
        : (typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '');
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;
    if (!session && !EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }

    if (!session) {
        // Interim safeguard breadcrumb for the unauthenticated fallback, same pattern
        // balance.ts used before it required sessions.
        console.log('[POST /api/newsletter-optin] no-session fallback', {
            email,
            ip: context.request.headers.get('CF-Connecting-IP'),
            timestamp: new Date().toISOString(),
        });
    }

    const sql = getSql(context.env);

    const rows = session
        ? await sql`
            UPDATE waitlist
            SET newsletter_opt_in = true,
                newsletter_opted_in_at = COALESCE(newsletter_opted_in_at, NOW())
            WHERE id = ${session.userId}
            RETURNING id
        `
        : await sql`
            UPDATE waitlist
            SET newsletter_opt_in = true,
                newsletter_opted_in_at = COALESCE(newsletter_opted_in_at, NOW())
            WHERE LOWER(email) = ${email}
            RETURNING id
        `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'No signup found for that email.' }, { status: 404 });
    }

    // Fire-and-forget - a Resend failure never fails the opt-in itself, same pattern as
    // the verification email in functions/api/picks.ts.
    if (context.env.RESEND_AUDIENCE_ID) {
        try {
            await upsertResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, email);
        } catch (audienceErr) {
            console.error('[POST /api/newsletter-optin] Resend audience upsert failed:', audienceErr);
        }
    }

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: rows[0].id as string, eventType: 'newsletter_opt_in' });
        } catch (eventErr) {
            console.error('[POST /api/newsletter-optin] Failed to log newsletter_opt_in event:', eventErr);
        }
    }

    return jsonResponse(
        { optedIn: true },
        session?.refreshedSetCookie ? { headers: { 'Set-Cookie': session.refreshedSetCookie } } : {}
    );
};
