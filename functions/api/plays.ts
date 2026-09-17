// GET /api/plays - My Playbook. The account's Plays, split into current and completed,
// each with its progress and, once completed, a receipt.
//
// Everything is read from the same facts statement toolbar-state batches (so the numbers
// the Playbook shows are the numbers the completion rule uses - see plays.ts
// playProgress), plus the pet's feed counter. Nothing is written here: completing a Play
// is toolbar-state's job, on the page load that satisfies it.
//
// The receipt needs no storage of its own:
//   gave - the stored objective's items (a delivery takes exactly those, all or nothing)
//   got  - the reward encounter's grants, found by plays.reward_encounter_key among the
//          encounter rows the facts already carry; null while that scene has not fired
//
// Petless accounts get two empty lists: the facts statement returns no row for them,
// and every Play belongs to a scene that talked to a pet.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';
import { buildFacts, encounterFactsStatement, type EncounterFactsRow } from '../../lib/pages-functions/encounters/evaluate';
import { playProgress, type PlayView } from '../../lib/pages-functions/encounters/plays';
import { PLAY_BY_KEY } from '../../lib/pages-functions/encounters/index';

function iso(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    const t = new Date(value as string).getTime();
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    try {
        const [petRows, factsRows] = await sql.transaction([
            sql`SELECT feed_count FROM pets WHERE user_id = ${session.userId} LIMIT 1`,
            encounterFactsStatement(sql, session.userId),
        ]);
        if (petRows.length === 0 || factsRows.length === 0) {
            return jsonResponse({ current: [], completed: [] }, { headers: authHeaders });
        }
        const feedCount = Number((petRows[0] as unknown as { feed_count: number }).feed_count ?? 0);
        const facts = buildFacts(factsRows[0] as unknown as EncounterFactsRow, feedCount, null);
        const grantsByKey = new Map(facts.encounters.map((e) => [e.key, e.grants]));

        const views: PlayView[] = facts.plays.map((p) => {
            const def = PLAY_BY_KEY[p.key];
            const completedAt = iso(p.completedAt);
            const gave = p.objective.kind === 'deliver_items'
                ? p.objective.items.map((i) => ({ catalogKey: i.catalogKey, count: i.count, name: i.name, art: i.art ?? null }))
                : [];
            return {
                id: p.id,
                key: p.key,
                character: def?.character ?? '',
                // Frozen title first; the registry covers rows written before titles
                // were stored.
                title: p.objective.title ?? def?.title ?? 'An errand',
                kind: p.objective.kind,
                objective: p.objective,
                progress: playProgress(p, facts),
                startedAt: iso(p.startedAt),
                completedAt,
                receipt: completedAt
                    ? { gave, got: grantsByKey.get(p.rewardEncounterKey) ?? null, completedAt }
                    : null,
            };
        });

        const current = views.filter((v) => !v.completedAt);
        const completed = views
            .filter((v) => v.completedAt)
            .sort((a, b) => new Date(b.completedAt as string).getTime() - new Date(a.completedAt as string).getTime());
        return jsonResponse({ current, completed }, { headers: authHeaders });
    } catch (err) {
        console.error('[GET /api/plays] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
