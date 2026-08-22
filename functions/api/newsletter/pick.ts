// GET/POST /api/newsletter/pick - the no-login exclusive-pick flow. The email link
// (see emails/NewsletterIssue.tsx) carries a signed token (lib/pages-functions/tokens.ts's
// generic signToken/verifyToken) instead of a session, so this route authenticates the
// token, not a cookie.
//
// Deliberately self-contained rather than importing shared validation from
// functions/api/picks.ts: that file (and its cap-check logic) is under active
// concurrent development as part of the daily-cap/settlement-finalization work, so this
// duplicates the small odds/side validation slice rather than coupling to a moving
// target. It goes through the exact same picks table, same implied_prob_at_lock capture,
// same settleCall() path as any other pick - only the auth mechanism and the
// source/newsletter_issue_id stamp differ.
//
// source = 'app' was added to the daily-cap queries in functions/api/picks.ts and
// functions/api/picks/today.ts specifically so a newsletter_exclusive pick inserted here
// never counts toward or shows up in a user's daily app-pick cap.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { verifyToken } from '../../../lib/pages-functions/tokens';
import { logEvent } from '../../../lib/pages-functions/events';
import { hasKickoffPassed } from '../../../tank-deck-format';
import type { NewsletterPickTokenPayload } from '../../../lib/newsletter-pick-token';

interface PropOdds {
    outcomes: string[];
    outcomePrices: number[];
}

async function loadExclusiveTank(sql: ReturnType<typeof getSql>, newsletterIssueId: string) {
    const rows = await sql`
        SELECT t.id, t.slug, t.provider, t.game_snapshot,
               t.model_output->'hook' AS hook,
               t.model_output->'call'->'question' AS question,
               t.model_output->'call'->'sides' AS sides,
               ni.week_key, ni.sent_at
        FROM newsletter_issues ni
        JOIN tank_pages t ON t.slug = ni.tank_slug
        WHERE ni.id = ${newsletterIssueId} AND t.visibility = 'newsletter_only' AND t.status = 'published'
        LIMIT 1
    `;
    return rows[0] as any | undefined;
}

// GET /api/newsletter/pick?token=...&issue=... - preview data for the landing page.
export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const token = url.searchParams.get('token') || '';
    const issue = url.searchParams.get('issue') || '';

    const payload = await verifyToken<NewsletterPickTokenPayload>(token, context.env.NEWSLETTER_TOKEN_SECRET);
    if (!payload || payload.newsletterIssueId !== issue) {
        return jsonResponse({ message: 'This link is invalid or has expired.' }, { status: 400 });
    }

    const sql = getSql(context.env);
    const tank = await loadExclusiveTank(sql, payload.newsletterIssueId);
    if (!tank) {
        return jsonResponse({ message: 'This week’s exclusive Tank is not available.' }, { status: 404 });
    }

    const sides: string[] = Array.isArray(tank.sides) ? tank.sides : JSON.parse(tank.sides || '[]');

    return jsonResponse({
        weekKey: tank.week_key,
        slug: tank.slug,
        hook: tank.hook,
        question: tank.question,
        sides,
    });
};

// POST /api/newsletter/pick - body: { token, issue, side, sideIndex }
export const onRequestPost: PagesFunction<Env> = async (context) => {
    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }

    const token = typeof body?.token === 'string' ? body.token : '';
    const issue = typeof body?.issue === 'string' ? body.issue : '';
    const side = typeof body?.side === 'string' ? body.side.trim() : '';
    const sideIndex = Number.isInteger(body?.sideIndex) ? (body.sideIndex as number) : null;
    const visitorId = typeof body?.visitorId === 'string' ? body.visitorId : null;

    const payload = await verifyToken<NewsletterPickTokenPayload>(token, context.env.NEWSLETTER_TOKEN_SECRET);
    if (!payload || payload.newsletterIssueId !== issue) {
        return jsonResponse({ message: 'This link is invalid or has expired.' }, { status: 400 });
    }
    if (!side) return jsonResponse({ message: 'Missing side.' }, { status: 400 });
    if (sideIndex === null) return jsonResponse({ message: 'Missing sideIndex.' }, { status: 400 });

    const sql = getSql(context.env);

    const tank = await loadExclusiveTank(sql, payload.newsletterIssueId);
    if (!tank) {
        return jsonResponse({ message: 'This week’s exclusive Tank is not available.' }, { status: 404 });
    }
    if (tank.sent_at === null) {
        // send-issue sets sent_at right before actually sending - a token minted ahead
        // of that (e.g. from a preview) shouldn't be postable yet.
        return jsonResponse({ message: 'This issue has not been sent yet.' }, { status: 400 });
    }
    if (tank.provider !== 'polymarket') {
        return jsonResponse({ message: 'This Tank cannot be settled and is not accepting picks.' }, { status: 400 });
    }

    const sides: string[] = Array.isArray(tank.sides) ? tank.sides : JSON.parse(tank.sides || '[]');
    if (sides.length > 0 && !sides.includes(side)) {
        return jsonResponse({ message: "Side does not match this Tank's call." }, { status: 400 });
    }

    const snapshot = tank.game_snapshot as { prop?: { odds?: PropOdds | null }; game?: { kickoff?: string } } | null;
    if (hasKickoffPassed(snapshot?.game?.kickoff)) {
        return jsonResponse({ message: 'This game has already started - picks are closed.' }, { status: 400 });
    }
    const odds = snapshot?.prop?.odds ?? null;
    if (!odds || !Array.isArray(odds.outcomes) || !Array.isArray(odds.outcomePrices)) {
        return jsonResponse({ message: 'This prop has no odds on record and cannot be picked.' }, { status: 400 });
    }
    if (odds.outcomes.length !== sides.length) {
        return jsonResponse({ message: 'Call sides do not match recorded odds for this prop.' }, { status: 400 });
    }
    if (sideIndex < 0 || sideIndex >= odds.outcomes.length) {
        return jsonResponse({ message: 'sideIndex out of range.' }, { status: 400 });
    }
    const impliedProbAtLock = odds.outcomePrices[sideIndex];
    if (typeof impliedProbAtLock !== 'number' || Number.isNaN(impliedProbAtLock)) {
        return jsonResponse({ message: 'Recorded odds are malformed and cannot be picked.' }, { status: 400 });
    }

    try {
        const inserted = await sql`
            INSERT INTO picks (
                waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock,
                source, newsletter_issue_id
            )
            VALUES (
                ${payload.userId}, ${tank.id}, ${tank.slug}, ${side}, ${sideIndex}, ${impliedProbAtLock},
                'newsletter_exclusive', ${payload.newsletterIssueId}
            )
            RETURNING side, tank_slug, created_at
        `;
        const row = inserted[0] as unknown as { side: string; tank_slug: string; created_at: string };

        if (visitorId) {
            try {
                await logEvent(sql, {
                    visitorId, waitlistId: payload.userId, eventType: 'newsletter_exclusive_pick',
                    tankSlug: tank.slug, metadata: { side, sideIndex, newsletterIssueId: payload.newsletterIssueId },
                });
            } catch (eventErr) {
                console.error('[POST /api/newsletter/pick] Failed to log newsletter_exclusive_pick event:', eventErr);
            }
        }

        return jsonResponse(
            { pick: { slug: row.tank_slug, side: row.side, createdAt: row.created_at } },
            { status: 201 }
        );
    } catch (err: any) {
        if (err.code === '23505') {
            return jsonResponse({ message: 'You’ve already made this issue’s call.' }, { status: 409 });
        }
        console.error('[POST /api/newsletter/pick] Error inserting pick:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500 });
    }
};
