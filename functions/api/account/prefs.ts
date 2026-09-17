// POST /api/account/prefs - the account page's notification switches. Partial body:
// any subset of the four keys, each a real boolean; anything else (an unknown key, a
// string "true", an empty body) is a 400 rather than silently ignored, so a client
// typo can never look like a saved preference.
//
//   emailSettlementResults -> waitlist.email_settlement_results (functions/api/settle.ts)
//   newsletterOptIn        -> waitlist.newsletter_opt_in (scripts/send-newsletter-issue.ts)
//   notifyPetHungry        -> waitlist.notify_pet_hungry (functions/api/notify-sweep.ts)
//   notifyDailyDrop        -> waitlist.notify_daily_drop (functions/api/notify-sweep.ts)
//
// One UPDATE with COALESCE per column: an absent key leaves its column alone. This is
// also the newsletter's first opt-OUT path - functions/api/newsletter-optin.ts (the
// post-verification "All Set" modal) only ever sets true and stays as it is; both
// keep the Resend Audience in step, fire-and-forget, because the DB flag is the source
// of truth for the send script and a Resend hiccup must never fail the save.
//
// Session + same-origin required, like every state-changing account action.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin } from '../../../lib/pages-functions/session';
import { logEvent } from '../../../lib/pages-functions/events';
import { unsubscribeResendAudienceContact, upsertResendAudienceContact } from '../../../lib/resend-audience';

const PREF_KEYS = ['emailSettlementResults', 'newsletterOptIn', 'notifyPetHungry', 'notifyDailyDrop'] as const;
type PrefKey = (typeof PREF_KEYS)[number];
type PrefPatch = Partial<Record<PrefKey, boolean>>;

function parsePatch(body: unknown): PrefPatch | null {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const entries = Object.entries(body as Record<string, unknown>);
    if (entries.length === 0) return null;
    const patch: PrefPatch = {};
    for (const [key, value] of entries) {
        if (!(PREF_KEYS as readonly string[]).includes(key)) return null;
        if (typeof value !== 'boolean') return null;
        patch[key as PrefKey] = value;
    }
    return patch;
}

interface PrefsRow {
    email_settlement_results: boolean;
    newsletter_opt_in: boolean;
    notify_pet_hungry: boolean;
    notify_daily_drop: boolean;
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: unknown;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }
    const patch = parsePatch(body);
    if (!patch) {
        return jsonResponse(
            { message: `Send one or more of ${PREF_KEYS.join(', ')}, each true or false.` },
            { status: 400 },
        );
    }

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const v = (key: PrefKey): boolean | null => (patch[key] === undefined ? null : patch[key]!);

    const rows = await sql`
        UPDATE waitlist SET
            email_settlement_results = COALESCE(${v('emailSettlementResults')}::boolean, email_settlement_results),
            notify_pet_hungry        = COALESCE(${v('notifyPetHungry')}::boolean, notify_pet_hungry),
            notify_daily_drop        = COALESCE(${v('notifyDailyDrop')}::boolean, notify_daily_drop),
            newsletter_opt_in        = COALESCE(${v('newsletterOptIn')}::boolean, newsletter_opt_in),
            newsletter_opted_in_at   = CASE WHEN ${v('newsletterOptIn')}::boolean IS TRUE
                                            THEN COALESCE(newsletter_opted_in_at, NOW())
                                            ELSE newsletter_opted_in_at END
        WHERE id = ${session.userId} AND deleted_at IS NULL
        RETURNING email_settlement_results, newsletter_opt_in, notify_pet_hungry, notify_daily_drop
    `;
    if (rows.length === 0) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const row = rows[0] as unknown as PrefsRow;

    // Newsletter side effects, fire-and-forget (the newsletter-optin.ts posture).
    if (patch.newsletterOptIn !== undefined) {
        if (context.env.RESEND_AUDIENCE_ID) {
            try {
                if (patch.newsletterOptIn) {
                    await upsertResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, session.email);
                } else {
                    await unsubscribeResendAudienceContact(context.env.RESEND_API_KEY, context.env.RESEND_AUDIENCE_ID, session.email);
                }
            } catch (audienceErr) {
                console.error('[POST /api/account/prefs] Resend audience sync failed:', audienceErr);
            }
        }
        try {
            // No anonymous visitor id on the account page (it is session-only), so a
            // fresh synthetic one - same as settle.ts's cron-triggered events.
            await logEvent(sql, {
                visitorId: crypto.randomUUID(),
                waitlistId: session.userId,
                eventType: patch.newsletterOptIn ? 'newsletter_opt_in' : 'newsletter_opt_out',
                metadata: { source: 'account_page' },
            });
        } catch (eventErr) {
            console.error('[POST /api/account/prefs] Failed to log newsletter event:', eventErr);
        }
    }

    return jsonResponse(
        {
            prefs: {
                emailSettlementResults: row.email_settlement_results,
                newsletterOptIn: row.newsletter_opt_in,
                notifyPetHungry: row.notify_pet_hungry,
                notifyDailyDrop: row.notify_daily_drop,
            },
        },
        { headers: authHeaders },
    );
};
