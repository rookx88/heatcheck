// GET /api/picks/mine - the picks this account has made, split into pending
// (result IS NULL) and settled, joined to each Tank's display fields. Powers the
// /my-portfolio/ page (Tanks tab). Same session/auth conventions as ./today.ts: identity comes only
// from the validated hc_session cookie; 401 = logged out (client redirects to
// /login/), 403 = not onboarded.
//
// Pending is returned whole (bounded by nature: the daily cap throttles accumulation
// and games settle within days), sorted by kickoff so the next game to settle leads.
// Settled is keyset-paginated (settled_at DESC, id DESC tiebreak): the first call
// returns the newest PAGE_SIZE plus pending + the all-time record; passing
// ?before=<cursor from the previous response> returns just the next settled page.
//
// Ember earned per settled pick is NOT stored on the picks row - settleCall()
// (lib/pages-functions/ledger.ts) writes it to ember_ledger with metadata.pickId, so
// it's read back via a correlated SUM (SUM rather than a bare subselect so a
// hypothetical duplicate ledger row can never make the query error). Displayed only,
// never recomputed. The record's emberTotal aggregates the same subquery over ALL
// settled picks, so it never changes as pages load.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../../lib/pages-functions/session';
import { deriveTaglineFallback } from '../../../tank-deck-format';

const PAGE_SIZE = 25;

interface PendingRow {
    side: string;
    tank_slug: string;
    created_at: string;
    implied_prob_at_lock: number | null;
    model_output: unknown;
    kickoff: string | null;
}

interface SettledRow {
    id: string;
    side: string;
    tank_slug: string;
    created_at: string;
    result: 'correct' | 'incorrect';
    settled_at: string | null;
    model_output: unknown;
    ember_awarded: number | null;
}

function taglineOf(modelOutput: unknown, slug: string): string {
    const parsed = typeof modelOutput === 'string' ? safeParse(modelOutput) : modelOutput;
    const mo = parsed as { tagline?: string; hook?: string } | null;
    return mo?.tagline?.trim() || (mo?.hook ? deriveTaglineFallback(mo.hook) : slug);
}

function safeParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

// Opaque-to-the-client settled-page cursor: "<settledAtISO>_<pickId>". settled_at can
// contain no underscore (ISO 8601), so splitting on the LAST underscore is unambiguous.
function parseCursor(raw: string): { settledAt: string; id: string } | null {
    const at = raw.lastIndexOf('_');
    if (at <= 0) return null;
    const settledAt = raw.slice(0, at);
    const id = raw.slice(at + 1);
    if (!UUID_RE.test(id) || isNaN(new Date(settledAt).getTime())) return null;
    return { settledAt, id };
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) {
        return jsonResponse({ message: 'Login required.' }, { status: 401 });
    }
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const before = new URL(context.request.url).searchParams.get('before');
    const cursor = before ? parseCursor(before) : null;
    if (before && !cursor) {
        return jsonResponse({ message: 'Malformed cursor.' }, { status: 400 });
    }

    const sql = getSql(context.env);

    // One page of settled picks, newest settle first. The +1 row is the hasMore probe.
    const settledRows = (await (cursor
        ? sql`
            SELECT p.id, p.side, p.tank_slug, p.created_at, p.result, p.settled_at, t.model_output,
                   (SELECT COALESCE(SUM(el.amount), 0)::int FROM ember_ledger el
                     WHERE el.user_id = p.waitlist_id AND el.metadata->>'pickId' = p.id::text) AS ember_awarded
            FROM picks p
            JOIN tank_pages t ON t.id = p.tank_page_id
            WHERE p.waitlist_id = ${session.userId} AND p.result IS NOT NULL
              AND (p.settled_at, p.id) < (${cursor.settledAt}::timestamptz, ${cursor.id}::uuid)
            ORDER BY p.settled_at DESC, p.id DESC
            LIMIT ${PAGE_SIZE + 1}
        `
        : sql`
            SELECT p.id, p.side, p.tank_slug, p.created_at, p.result, p.settled_at, t.model_output,
                   (SELECT COALESCE(SUM(el.amount), 0)::int FROM ember_ledger el
                     WHERE el.user_id = p.waitlist_id AND el.metadata->>'pickId' = p.id::text) AS ember_awarded
            FROM picks p
            JOIN tank_pages t ON t.id = p.tank_page_id
            WHERE p.waitlist_id = ${session.userId} AND p.result IS NOT NULL
            ORDER BY p.settled_at DESC, p.id DESC
            LIMIT ${PAGE_SIZE + 1}
        `)) as unknown as SettledRow[];

    const hasMore = settledRows.length > PAGE_SIZE;
    const pageRows = hasMore ? settledRows.slice(0, PAGE_SIZE) : settledRows;
    const lastRow = pageRows[pageRows.length - 1];
    const settledCursor = hasMore && lastRow?.settled_at
        ? `${new Date(lastRow.settled_at).toISOString()}_${lastRow.id}`
        : null;
    const settled = pageRows.map((p) => ({
        slug: p.tank_slug,
        side: p.side,
        createdAt: p.created_at,
        settledAt: p.settled_at,
        result: p.result,
        tagline: taglineOf(p.model_output, p.tank_slug),
        emberAwarded: p.ember_awarded ?? 0,
    }));

    // Subsequent pages only need the settled rows - pending and the all-time record
    // were delivered on the first response and don't change while paging.
    if (cursor) {
        return jsonResponse({ settled, settledCursor }, { headers: authHeaders });
    }

    const [pendingRows, recordRows] = await Promise.all([
        sql`
            SELECT p.side, p.tank_slug, p.created_at,
                   p.implied_prob_at_lock::float8 AS implied_prob_at_lock,
                   t.model_output,
                   t.game_snapshot->'game'->>'kickoff' AS kickoff
            FROM picks p
            JOIN tank_pages t ON t.id = p.tank_page_id
            WHERE p.waitlist_id = ${session.userId} AND p.result IS NULL
            ORDER BY (t.game_snapshot->'game'->>'kickoff') ASC NULLS LAST, p.created_at DESC
        `,
        sql`
            SELECT COUNT(*) FILTER (WHERE p.result = 'correct')::int AS correct,
                   COUNT(*) FILTER (WHERE p.result = 'incorrect')::int AS incorrect,
                   COALESCE(SUM((SELECT COALESCE(SUM(el.amount), 0) FROM ember_ledger el
                     WHERE el.user_id = p.waitlist_id AND el.metadata->>'pickId' = p.id::text)), 0)::int AS ember_total
            FROM picks p
            WHERE p.waitlist_id = ${session.userId} AND p.result IS NOT NULL
        `,
    ]);

    const pending = (pendingRows as unknown as PendingRow[]).map((p) => ({
        slug: p.tank_slug,
        side: p.side,
        createdAt: p.created_at,
        kickoff: p.kickoff,
        impliedProb: Number.isFinite(p.implied_prob_at_lock) ? p.implied_prob_at_lock : null,
        tagline: taglineOf(p.model_output, p.tank_slug),
    }));
    const recordRow = (recordRows as unknown as Array<{ correct: number; incorrect: number; ember_total: number }>)[0];

    return jsonResponse(
        {
            pending,
            settled,
            settledCursor,
            record: {
                correct: recordRow?.correct ?? 0,
                incorrect: recordRow?.incorrect ?? 0,
                emberTotal: recordRow?.ember_total ?? 0,
            },
        },
        { headers: authHeaders }
    );
};
