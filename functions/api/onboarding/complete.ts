// POST /api/onboarding/complete - signs the welcome letter: stores the username
// ("signature"), records the Terms/Privacy acceptance, and stamps onboarded_at, exactly
// once. The WHERE onboarded_at IS NULL guard is the whole idempotency story: a
// double-submit or second tab matches zero rows and gets reported the already-settled
// state, never an error and never a second mutation.
//
// acceptTerms: true is required - the letter's checkbox. No tick, no signature: the
// account stays un-onboarded and nothing is written.
//
// Exactly one provision on first login: Sports McLaren's welcome gift of Ember
// (ledger.welcomeGiftEmber, ember_rules['welcome_gift'] - decided 2026-09-18, reversing
// the earlier "no bonus Ember" rule). No pet, no starter item. The gift is a balance-only
// credit, never lifetime_earned.
//
// Username uniqueness is server-authoritative via idx_waitlist_username_lower
// (case-insensitive partial index); the expected collision path surfaces as a clean
// 409, not a 500.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../../lib/pages-functions/session';
import { validateUsername } from '../../../lib/pages-functions/username';
import { logEvent } from '../../../lib/pages-functions/events';
import { insertNotificationIdempotent } from '../../../lib/pages-functions/notifications';
import { welcomeGiftEmber } from '../../../lib/pages-functions/ledger';
import { TERMS_VERSION } from '../../../lib/pages-functions/terms';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }

    const check = validateUsername(body?.username);
    if (!check.ok) {
        return jsonResponse({ message: check.message }, { status: 400, headers: authHeaders });
    }
    if (body?.acceptTerms !== true) {
        return jsonResponse(
            { message: 'The Terms of Service and Privacy Policy need your tick before the signature counts.' },
            { status: 400, headers: authHeaders }
        );
    }
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    const sql = getSql(context.env);
    try {
        const rows = await sql`
            UPDATE waitlist
            SET username = ${check.username},
                username_updated_at = NOW(),
                onboarded_at = NOW(),
                terms_accepted_at = NOW(),
                terms_version = ${TERMS_VERSION}
            WHERE id = ${session.userId} AND onboarded_at IS NULL
            RETURNING id, username
        `;
        if (rows.length === 0) {
            // Another tab/device already signed. Report the settled state so the
            // client proceeds into the app under the name that actually won.
            const cur = await sql`SELECT username FROM waitlist WHERE id = ${session.userId} LIMIT 1`;
            return jsonResponse(
                { ok: true, alreadyOnboarded: true, username: (cur[0]?.username as string) ?? null },
                { headers: authHeaders }
            );
        }

        if (visitorId) {
            try {
                await logEvent(sql, { visitorId, waitlistId: session.userId, eventType: 'onboarding_completed' });
            } catch (eventErr) {
                console.error('[POST /api/onboarding/complete] Failed to log event:', eventErr);
            }
        }

        // McLaren's welcome gift. Only reachable by the one request whose UPDATE won the
        // onboarded_at guard, and the ledger's per-account idempotency key backstops
        // that. Never fails onboarding - a missed gift is logged, the signature stands.
        let giftAmount = 0;
        try {
            const gift = await welcomeGiftEmber(sql, { userId: session.userId });
            if (gift.credited) giftAmount = gift.amount;
        } catch (giftErr) {
            console.error('[POST /api/onboarding/complete] Failed to credit welcome gift:', giftErr);
        }

        // First inbox entry - welcomes the account and points the gift at the Hatchery
        // (a standard egg costs what the gift is). Fire-and-forget: onboarding must
        // never fail because a notification insert did. Idempotent on welcome:<userId>.
        try {
            await insertNotificationIdempotent(sql, {
                userId: session.userId,
                type: 'informational',
                message:
                    giftAmount > 0
                        ? `Welcome aboard — your record is signed, and McLaren’s ${giftAmount} Ember is in your account. The Hatchery has an egg that costs about that.`
                        : 'Welcome aboard — your record is signed. There’s an egg in the Hatchery with your name on it.',
                refType: 'onboarding',
                refId: null,
                idempotencyKey: `welcome:${session.userId}`,
                mood: 'happy',
            });
        } catch (notifErr) {
            console.error('[POST /api/onboarding/complete] Failed to insert welcome notification:', notifErr);
        }

        return jsonResponse({ ok: true, username: rows[0].username as string, giftAmount }, { headers: authHeaders });
    } catch (err: any) {
        // unique_violation on idx_waitlist_username_lower - the one expected
        // contention path (a popular name, or a case-variant of one).
        if (err?.code === '23505') {
            return jsonResponse(
                { message: "That name's taken — try another signature." },
                { status: 409, headers: authHeaders }
            );
        }
        console.error('[POST /api/onboarding/complete] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
