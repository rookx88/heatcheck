// GET|POST /api/email/unsubscribe?token=... - one-click email unsubscribe, the target of
// every footer link and List-Unsubscribe header we send (lib/pages-functions/
// unsubscribe-links.ts mints the token; the settlement email and the weekly newsletter
// carry it). No login: the reader may be on a phone with no session, and asking them to
// log in to stop an email is the failure mode this exists to avoid.
//
// The token IS the authorization - purpose 'email_unsubscribe' (lib/auth-token-
// payloads.ts), so nothing minted for login or a session verifies here and nothing
// verified here can act as either. It names one account and one kind, and this flips
// exactly that one switch off. Deliberately never reads the session cookie: a signed-in
// reader clicking a link from another account's email turns off THAT account's email,
// which is what the link promised, and touches nothing of the viewer's.
//
// GET  -> the footer link. Writes, then 302s to the static /unsubscribed/ page with
//         ?kind= so a logged-out reader sees a confirmation (or, for a dead/expired
//         token, "invalid" copy pointing at the account page). no-store: nothing
//         about this response may be cached.
// POST -> RFC 8058 one-click (Gmail/Apple/Yahoo post `List-Unsubscribe=One-Click` to
//         the header URL, token still in the query). Writes, answers JSON, no redirect.
//
// A mail scanner prefetching the GET could flip a flag the reader didn't click;
// accepted - the harm is one missing email and the switch is right there on the
// account page. Never touches deleted accounts' Resend state (their address is scrubbed).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { verifyAuthToken } from '../../../lib/pages-functions/auth-tokens';
import { resolveLoginOrigin } from '../../../lib/pages-functions/session';
import { logEvent } from '../../../lib/pages-functions/events';
import { unsubscribeResendAudienceContact } from '../../../lib/resend-audience';
import type { EmailUnsubscribeTokenPayload } from '../../../lib/auth-token-payloads';

type Kind = EmailUnsubscribeTokenPayload['kind'];
const KINDS: readonly Kind[] = ['settlement', 'newsletter'];

async function applyUnsubscribe(context: Parameters<PagesFunction<Env>>[0]): Promise<Kind | null> {
    const token = new URL(context.request.url).searchParams.get('token');
    if (!token) return null;
    const payload = await verifyAuthToken<EmailUnsubscribeTokenPayload>(token, context.env.SESSION_TOKEN_SECRET, 'email_unsubscribe');
    // The newsletter dry run signs a link for userId 'preview' so the QA render has a
    // real-looking footer; the UUID check is what makes that link inert.
    if (!payload || !UUID_RE.test(payload.userId) || !KINDS.includes(payload.kind)) return null;

    const sql = getSql(context.env);
    let email: string | null = null;
    let deleted = false;
    if (payload.kind === 'settlement') {
        const rows = await sql`
            UPDATE waitlist SET email_settlement_results = false WHERE id = ${payload.userId}
            RETURNING email, deleted_at
        `;
        if (rows.length === 0) return null;
        email = rows[0].email as string;
        deleted = rows[0].deleted_at !== null;
    } else {
        const rows = await sql`
            UPDATE waitlist SET newsletter_opt_in = false WHERE id = ${payload.userId}
            RETURNING email, deleted_at
        `;
        if (rows.length === 0) return null;
        email = rows[0].email as string;
        deleted = rows[0].deleted_at !== null;
        if (context.env.RESEND_AUDIENCE_ID && !deleted) {
            try {
                await unsubscribeResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, email);
            } catch (audienceErr) {
                console.error('[/api/email/unsubscribe] Resend audience unsubscribe failed:', audienceErr);
            }
        }
    }

    try {
        await logEvent(sql, {
            visitorId: crypto.randomUUID(),
            waitlistId: payload.userId,
            eventType: 'email_unsubscribed',
            metadata: { kind: payload.kind, method: context.request.method },
        });
    } catch (eventErr) {
        console.error('[/api/email/unsubscribe] Failed to log event:', eventErr);
    }
    return payload.kind;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const kind = await applyUnsubscribe(context);
    const origin = resolveLoginOrigin(context.request.url, context.env);
    return new Response(null, {
        status: 302,
        headers: {
            Location: `${origin}/unsubscribed/?kind=${kind ?? 'invalid'}`,
            'Cache-Control': 'no-store',
        },
    });
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const kind = await applyUnsubscribe(context);
    if (!kind) return jsonResponse({ message: 'This unsubscribe link is invalid or has expired.' }, { status: 400 });
    return jsonResponse({ unsubscribed: true, kind });
};
