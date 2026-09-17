// GET /api/account - everything the account page (account-client.tsx) needs in ONE
// request: identity, the notification switches, how many devices are signed in, the
// Discord link, and the viewer's standing (the strip above the tabs). The
// toolbar-state.ts posture: one getSession() round-trip, then one batched
// sql.transaction([...]) of independent reads.
//
// Gate semantics match toolbar-state, not the requireOnboarded endpoints: an
// un-onboarded session gets `standing: null` rather than a 403, because Profile /
// Notifications / Security are all meaningful before the welcome letter is signed and
// the page must not bounce someone who came here to turn an email off.
//
// Never returns anything another account could use: no other users' data, no
// session ids (the count is enough for "log out of other devices" to make sense).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';
import { standingStatement, readStanding } from '../../lib/pages-functions/standing';

interface PrefsRow {
    created_at: string;
    email_settlement_results: boolean;
    newsletter_opt_in: boolean;
    notify_pet_hungry: boolean;
    notify_daily_drop: boolean;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);

    const [prefsRows, sessionRows, standingRows, recordRows] = await sql.transaction([
        sql`
            SELECT created_at, email_settlement_results, newsletter_opt_in, notify_pet_hungry, notify_daily_drop
            FROM waitlist WHERE id = ${session.userId} LIMIT 1
        `,
        sql`
            SELECT COUNT(*)::int AS n FROM sessions
            WHERE user_id = ${session.userId} AND revoked_at IS NULL AND expires_at > NOW()
        `,
        standingStatement(sql, session.userId),
        // The all-time record, same aggregate as functions/api/picks/mine.ts minus its
        // Ember-per-pick CTE (the strip shows W-L; Ember totals live on the portfolio).
        sql`
            SELECT COUNT(*) FILTER (WHERE result = 'correct')::int AS correct,
                   COUNT(*) FILTER (WHERE result = 'incorrect')::int AS incorrect
            FROM picks WHERE waitlist_id = ${session.userId} AND result IS NOT NULL
        `,
    ]);

    // getSession() just validated this row exists (and is not soft-deleted).
    const prefs = prefsRows[0] as unknown as PrefsRow;
    const standing = readStanding(standingRows);
    const record = recordRows[0] as unknown as { correct: number; incorrect: number } | undefined;

    return jsonResponse(
        {
            userId: session.userId,
            email: session.email,
            verified: session.verified,
            username: session.username,
            onboarded: session.onboarded,
            createdAt: prefs.created_at,
            discord: { linked: session.discordLinked, username: session.discordUsername },
            prefs: {
                emailSettlementResults: prefs.email_settlement_results,
                newsletterOptIn: prefs.newsletter_opt_in,
                notifyPetHungry: prefs.notify_pet_hungry,
                notifyDailyDrop: prefs.notify_daily_drop,
            },
            sessions: { active: Number((sessionRows[0] as unknown as { n: number }).n) },
            standing: session.onboarded
                ? {
                    balance: standing.balance,
                    lifetimeEarned: standing.lifetime_earned,
                    rank: standing.rank,
                    record: { correct: record?.correct ?? 0, incorrect: record?.incorrect ?? 0 },
                }
                : null,
        },
        { headers: authHeaders },
    );
};
