// POST /api/picks - combined email + pick submission. The email IS the account
// identity (a row in the existing `waitlist` table, upserted here); the pick is
// enforced to one-per-account by a unique constraint on picks.waitlist_id, not by
// anything client-supplied. A verification code is sent on success, but the pick
// itself is saved and returned regardless of whether that email send succeeds.
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
import { logEvent } from '../../lib/pages-functions/events';

interface PickRow {
    side: string;
    tank_slug: string;
    created_at: string;
}

interface ExistingPickRow extends PickRow {
    email_verified: boolean;
}

interface PropOdds {
    outcomes: string[];
    outcomePrices: number[];
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const side = typeof body?.side === 'string' ? body.side.trim() : '';
    const sideIndex = Number.isInteger(body?.sideIndex) ? (body.sideIndex as number) : null;
    // Optional: the anonymous analytics visitor id (see tank-analytics-client.ts). Absent
    // or invalid just means this pick's events won't bridge to earlier anonymous history -
    // never a reason to fail the pick itself.
    const visitorId = typeof body?.visitorId === 'string' && UUID_RE.test(body.visitorId) ? body.visitorId : null;

    if (!EMAIL_RE.test(email)) {
        return jsonResponse({ message: 'Please enter a valid email address.' }, { status: 400 });
    }
    if (!slug) return jsonResponse({ message: 'Missing slug.' }, { status: 400 });
    if (!side) return jsonResponse({ message: 'Missing side.' }, { status: 400 });
    if (sideIndex === null) return jsonResponse({ message: 'Missing sideIndex.' }, { status: 400 });

    const sql = getSql(context.env);

    const tankRows = await sql`
        SELECT id, provider, game_snapshot, model_output->'call'->'sides' AS sides
        FROM tank_pages WHERE slug = ${slug} AND status = 'published' LIMIT 1
    `;
    if (tankRows.length === 0) {
        return jsonResponse({ message: 'Unknown or unpublished Tank.' }, { status: 400 });
    }
    const tankPageId = tankRows[0].id as string;
    const provider = tankRows[0].provider as string;
    if (provider !== 'polymarket') {
        return jsonResponse({ message: 'This Tank cannot be settled and is not accepting picks.' }, { status: 400 });
    }
    const rawSides = tankRows[0].sides as unknown;
    const validSides: string[] = Array.isArray(rawSides)
        ? (rawSides as string[])
        : (typeof rawSides === 'string' ? JSON.parse(rawSides) : []);
    if (validSides.length > 0 && !validSides.includes(side)) {
        return jsonResponse({ message: "Side does not match this Tank's call." }, { status: 400 });
    }

    // The difficulty snapshot (implied_prob_at_lock) is mandatory, no exceptions - reject
    // the pick rather than ever store a null. sideIndex maps positionally into the frozen
    // game_snapshot's odds, which were generated in the same order as call.sides.
    const snapshot = tankRows[0].game_snapshot as { prop?: { odds?: PropOdds | null } } | null;
    const odds = snapshot?.prop?.odds ?? null;
    if (!odds || !Array.isArray(odds.outcomes) || !Array.isArray(odds.outcomePrices)) {
        return jsonResponse({ message: 'This prop has no odds on record and cannot be picked.' }, { status: 400 });
    }
    if (odds.outcomes.length !== validSides.length) {
        return jsonResponse({ message: "Call sides do not match recorded odds for this prop." }, { status: 400 });
    }
    if (sideIndex < 0 || sideIndex >= odds.outcomes.length) {
        return jsonResponse({ message: 'sideIndex out of range.' }, { status: 400 });
    }
    const impliedProbAtLock = odds.outcomePrices[sideIndex];
    if (typeof impliedProbAtLock !== 'number' || Number.isNaN(impliedProbAtLock)) {
        return jsonResponse({ message: 'Recorded odds are malformed and cannot be picked.' }, { status: 400 });
    }

    let waitlistId: string;
    try {
        const waitlistRows = await sql`
            INSERT INTO waitlist (email) VALUES (${email})
            ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email
            RETURNING id
        `;
        waitlistId = waitlistRows[0].id as string;
    } catch (err) {
        console.error('[POST /api/picks] Error upserting waitlist row:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }

    try {
        const inserted = await sql`
            INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock)
            VALUES (${waitlistId}, ${tankPageId}, ${slug}, ${side}, ${sideIndex}, ${impliedProbAtLock})
            RETURNING side, tank_slug, created_at
        `;
        const row = inserted[0] as unknown as PickRow;

        // Fire off a verification code, but never let a Resend failure fail the pick
        // itself - the pick is already committed at this point.
        try {
            const code = generateVerificationCode();
            await sql`
                UPDATE waitlist
                SET verification_code = ${code},
                    verification_code_expires_at = NOW() + INTERVAL '15 minutes',
                    verification_attempts = 0
                WHERE id = ${waitlistId}
            `;
            await sendVerificationEmail(context.env, email, code);
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
            { pick: { slug: row.tank_slug, side: row.side, createdAt: row.created_at } },
            { status: 201 }
        );
    } catch (err: any) {
        if (err.code === '23505') { // idx_picks_waitlist_id conflict - this account already has a pick
            // Joins waitlist for email_verified so the client can cache verified
            // status too - without it, a returning visit (e.g. following this same
            // "you already made your call" conflict to view the existing pick) has no
            // way to know verification already happened, and would show the confirm-
            // your-email form again even for an already-verified account.
            const existing = await sql`
                SELECT p.side, p.tank_slug, p.created_at, w.email_verified
                FROM picks p JOIN waitlist w ON w.id = p.waitlist_id
                WHERE p.waitlist_id = ${waitlistId} LIMIT 1
            `;
            const row = existing[0] as unknown as ExistingPickRow | undefined;

            if (visitorId) {
                try {
                    await logEvent(sql, { visitorId, waitlistId, eventType: 'pick_conflict', tankSlug: slug, metadata: { attemptedSide: side } });
                } catch (eventErr) {
                    console.error('[POST /api/picks] Failed to log pick_conflict event:', eventErr);
                }
            }

            return jsonResponse(
                {
                    message: "You've already made your call.",
                    pick: row ? { slug: row.tank_slug, side: row.side, createdAt: row.created_at, verified: row.email_verified } : null,
                },
                { status: 409 }
            );
        }
        console.error('[POST /api/picks] Error inserting pick:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }
};
