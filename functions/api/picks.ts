// POST /api/picks - combined email + pick submission. The email IS the account
// identity (a row in the existing `waitlist` table, upserted here). Up to
// DAILY_PICK_CAP picks per account per UTC day, one pick per Tank per account
// (idx_picks_waitlist_tank, add_daily_pick_cap.sql) - not one pick ever, that changed
// with the settlement finalization's daily-cap spec. A verification code is sent on
// success, but the pick itself is saved and returned regardless of whether that email
// send succeeds.
//
// Only polymarket-sourced Tanks accept picks: settlement (functions/api/settle.ts)
// resolves outcomes against Polymarket's Gamma API, and mock/custom-provider Tanks have
// no resolution source, so a pick on one could never be settled. sideIndex (the position
// of the chosen side in call.sides) is the authoritative signal for scoring - it maps
// positionally to game_snapshot.prop.odds.outcomes/outcomePrices, which were frozen at
// generation time in the same order call.sides was written in. implied_prob_at_lock is
// captured here, once, from that snapshot - it is never recomputed later.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, EMAIL_RE, UUID_RE, type Env } from '../../lib/pages-functions/db';
import { sendVerificationEmail, generateVerificationCode } from '../../lib/pages-functions/email';
import { getSession, requireSameOrigin, requireOnboarded } from '../../lib/pages-functions/session';
import { logEvent } from '../../lib/pages-functions/events';
import { submitPick, type SubmitPickResult } from '../../lib/pages-functions/picks';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const side = typeof body?.side === 'string' ? body.side.trim() : '';
    const sideIndex = Number.isInteger(body?.sideIndex) ? (body.sideIndex as number) : null;
    // Optional: the anonymous analytics visitor id (see tank-analytics-client.ts). Absent
    // or invalid just means this pick's events won't bridge to earlier anonymous history -
    // never a reason to fail the pick itself.
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    // Session-preferred identity: with a valid session cookie, the session decides who
    // this pick belongs to and any body email is ignored (a logged-in user must not be
    // able to submit picks onto some other address). Without a session, the body email
    // is still accepted - that's the deliberate first-ever-pick funnel entry point,
    // where email doubles as account creation.
    const session = await getSession(context.request, context.env);
    // A logged-in account must finish onboarding before it can act. Only the session
    // path is gated: the no-session email path below is the pre-account funnel entry
    // (a first-ever pick), which by definition happens before onboarding exists.
    if (session) {
        const gate = requireOnboarded(session);
        if (gate) return gate;
    }
    const email = session
        ? session.email.toLowerCase()
        : (typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '');

    if (!session && !EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!slug) return jsonResponse({ message: 'Missing slug.' }, { status: 400 });
    if (!side) return jsonResponse({ message: 'Missing side.' }, { status: 400 });
    if (sideIndex === null) return jsonResponse({ message: 'Missing sideIndex.' }, { status: 400 });

    const sql = getSql(context.env);

    let waitlistId: string;
    if (session) {
        // Identity already established - no upsert, the account row necessarily exists.
        waitlistId = session.userId;
    } else {
        try {
            const waitlistRows = await sql`
                INSERT INTO waitlist (email) VALUES (${email})
                ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email
                RETURNING id, email_verified
            `;
            // H2: the email path is the first-ever-pick funnel entry only. Once an
            // account is claimed (email_verified - which both login paths set), it can no
            // longer be picked-for by anyone who merely knows the address; a real session
            // is required. This blocks the write-side hijack (submitting picks as a
            // verified victim, burning their daily cap, locking them out of Tanks) while
            // leaving brand-new/unverified accounts free to make their first pick.
            if (waitlistRows[0].email_verified) {
                return jsonResponse(
                    { message: 'Please log in to make a pick.', loginRequired: true },
                    { status: 401 }
                );
            }
            waitlistId = waitlistRows[0].id as string;
        } catch (err) {
            console.error('[POST /api/picks] Error upserting waitlist row:', err);
            return jsonResponse({ message: 'Internal server error' }, { status: 500 });
        }
    }

    // Sliding-session refresh (lib/pages-functions/session.ts): when getSession slid
    // the expiry this request, the re-signed cookie rides back on whichever response
    // this handler ends up returning.
    const authHeaders = session?.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let result: SubmitPickResult;
    try {
        result = await submitPick(sql, context.env, { waitlistId, slug, side, sideIndex, source: 'app' });
    } catch (err) {
        console.error('[POST /api/picks] Error submitting pick:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }

    switch (result.status) {
        case 'not_found':
            return jsonResponse({ message: 'Unknown or unpublished Tank.' }, { status: 400 });
        case 'not_settleable':
            return jsonResponse({ message: 'This Tank cannot be settled and is not accepting picks.' }, { status: 400 });
        case 'side_mismatch':
            return jsonResponse({ message: "Side does not match this Tank's call." }, { status: 400 });
        case 'game_started':
            return jsonResponse({ message: 'This game has already started - picks are closed.' }, { status: 400 });
        case 'no_odds':
            return jsonResponse({ message: 'This prop has no odds on record and cannot be picked.' }, { status: 400 });
        case 'odds_mismatch':
            return jsonResponse({ message: "Call sides do not match recorded odds for this prop." }, { status: 400 });
        case 'side_index_out_of_range':
            return jsonResponse({ message: 'sideIndex out of range.' }, { status: 400 });
        case 'malformed_odds':
            return jsonResponse({ message: 'Recorded odds are malformed and cannot be picked.' }, { status: 400 });
        case 'cap_reached':
            // A 429 here has nothing to do with whether the email is verified - it's purely
            // a volume rejection - but the client has no other signal to learn verification
            // status from on a brand new session (no cached account => it never called
            // GET /api/picks/today before this). Without `verified` here, an
            // already-verified account hitting the cap on a fresh device/incognito session
            // would see a confusing "confirm your email" prompt it doesn't need.
            return jsonResponse(
                { message: "You've used today's picks — back tomorrow.", picksToday: result.picksToday, remaining: 0, verified: result.verified },
                { status: 429, headers: authHeaders }
            );
        case 'conflict':
            if (visitorId) {
                try {
                    await logEvent(sql, { visitorId, waitlistId, eventType: 'pick_conflict', tankSlug: slug, metadata: { attemptedSide: side } });
                } catch (eventErr) {
                    console.error('[POST /api/picks] Failed to log pick_conflict event:', eventErr);
                }
            }
            // `code` is the machine-readable marker (clients historically matched on the
            // 409 status alone, which still works - this is additive).
            return jsonResponse(
                { code: 'already_picked', message: 'You already made this call.', pick: result.pick },
                { status: 409, headers: authHeaders }
            );
    }

    // status === 'ok' past this point (switch above returns/handles every other case).

    // Fire off a verification code, but never let a Resend failure fail the pick
    // itself - the pick is already committed at this point. session.verified is
    // fresh (getSession joins waitlist on every request), so a verified session
    // skips the extra read entirely.
    let verified = session?.verified ?? result.verified;
    try {
        if (!verified) {
            const code = generateVerificationCode();
            await sql`
                UPDATE waitlist
                SET verification_code = ${code},
                    verification_code_expires_at = NOW() + INTERVAL '15 minutes',
                    verification_attempts = 0
                WHERE id = ${waitlistId}
            `;
            await sendVerificationEmail(context.env, email, code);
        }
    } catch (emailErr) {
        console.error('[POST /api/picks] Verification email failed to send:', emailErr);
    }

    if (visitorId) {
        try {
            await logEvent(sql, { visitorId, waitlistId, eventType: 'pick_submitted', tankSlug: slug, metadata: { side, sideIndex } });
        } catch (eventErr) {
            console.error('[POST /api/picks] Failed to log pick_submitted event:', eventErr);
        }
    }

    return jsonResponse(
        {
            pick: result.pick,
            verified,
            picksToday: result.picksToday,
            remaining: result.dailyCap - result.picksToday,
        },
        { status: 201, headers: authHeaders }
    );
};
