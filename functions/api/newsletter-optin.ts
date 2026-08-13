// POST /api/newsletter-optin - opts an existing waitlist row into the newsletter. Called
// from the "You're All Set" modal shown right after email verification. Idempotent: a
// second call for the same email just re-confirms true rather than clobbering the
// original newsletter_opted_in_at.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { logEvent } from '../../lib/pages-functions/events';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;
    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    const rows = await sql`
        UPDATE waitlist
        SET newsletter_opt_in = true,
            newsletter_opted_in_at = COALESCE(newsletter_opted_in_at, NOW())
        WHERE LOWER(email) = ${email}
        RETURNING id
    `;
    if (rows.length === 0) {
        return jsonResponse({ message: 'No signup found for that email.' }, { status: 404 });
    }

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId: rows[0].id as string, eventType: 'newsletter_opt_in' });
        } catch (eventErr) {
            console.error('[POST /api/newsletter-optin] Failed to log newsletter_opt_in event:', eventErr);
        }
    }

    return jsonResponse({ optedIn: true });
};
