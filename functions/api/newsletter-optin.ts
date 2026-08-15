// POST /api/newsletter-optin - opts the logged-in account into the newsletter. Called
// from the "You're All Set" modal, which is only reachable after a successful
// verify-email - and verify-email now issues a session cookie, so a session always
// exists by the time this runs. Idempotent: a second call just re-confirms true rather
// than clobbering the original newsletter_opted_in_at.
//
// Session-REQUIRED (no email fallback). The old unauthenticated fallback let anyone
// opt an arbitrary third-party address in AND push it to the Resend marketing audience
// (a real consent/CAN-SPAM problem, M4), and doubled as an unlimited account-existence
// oracle (M3). Requiring the session closes both: you can only opt in the account you
// hold the cookie for.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../lib/pages-functions/session';
import { logEvent } from '../../lib/pages-functions/events';
import { upsertResendAudienceContact } from '../../lib/resend-audience';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    const sql = getSql(context.env);

    await sql`
        UPDATE waitlist
        SET newsletter_opt_in = true,
            newsletter_opted_in_at = COALESCE(newsletter_opted_in_at, NOW())
        WHERE id = ${session.userId}
    `;

    // Fire-and-forget - a Resend failure never fails the opt-in itself, same pattern as
    // the verification email in functions/api/picks.ts. Uses the session's own email, so
    // only a consenting, logged-in account is ever added to the audience.
    if (context.env.RESEND_AUDIENCE_ID) {
        try {
            await upsertResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, session.email);
        } catch (audienceErr) {
            console.error('[POST /api/newsletter-optin] Resend audience upsert failed:', audienceErr);
        }
    }

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: session.userId, eventType: 'newsletter_opt_in' });
        } catch (eventErr) {
            console.error('[POST /api/newsletter-optin] Failed to log newsletter_opt_in event:', eventErr);
        }
    }

    return jsonResponse(
        { optedIn: true },
        session.refreshedSetCookie ? { headers: { 'Set-Cookie': session.refreshedSetCookie } } : {}
    );
};
