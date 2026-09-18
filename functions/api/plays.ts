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
import { buildFacts, encounterFactsStatement, type EncounterFactsRow, type PetFacts } from '../../lib/pages-functions/encounters/evaluate';
import { deliveryOf, playProgress, type PlayView } from '../../lib/pages-functions/encounters/plays';
import { sustainedSatisfied } from '../../lib/pages-functions/discovery';
import type { FeedingConfig } from '../../lib/pages-functions/pets';
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
        const [petRows, factsRows, cfgRows] = await sql.transaction([
            sql`
                SELECT feed_count, name, satisfaction_at_last_feed, last_fed_at
                FROM pets WHERE user_id = ${session.userId} LIMIT 1
            `,
            encounterFactsStatement(sql, session.userId),
            sql`
                SELECT key, config FROM game_config
                WHERE key IN ('feeding', 'discovery') AND active = true
            `,
        ]);
        if (petRows.length === 0 || factsRows.length === 0) {
            return jsonResponse({ current: [], completed: [] }, { headers: authHeaders });
        }
        const petRow = petRows[0] as unknown as {
            feed_count: number; name: string | null; satisfaction_at_last_feed: number; last_fed_at: string;
        };
        const cfgByKey = new Map((cfgRows as unknown as Array<{ key: string; config: Record<string, number> }>)
            .map((r) => [r.key, r.config]));
        const feedingCfg = cfgByKey.get('feeding') as unknown as FeedingConfig | undefined;
        const sustainedHours = Number(cfgByKey.get('discovery')?.sustained_hours);
        // Same definition of "kept fed" the short find cooldown uses, so the Playbook's
        // tick for a care objective matches the moment it actually completes.
        const petFacts: PetFacts = {
            feedCount: Number(petRow.feed_count ?? 0),
            named: typeof petRow.name === 'string' && petRow.name.length > 0,
            sustainedSatisfied: feedingCfg
                ? sustainedSatisfied(petRow, feedingCfg, sustainedHours)
                : false,
        };
        // No place: this endpoint reads, and a hand-over only ever happens on the page
        // load that visits the character's home.
        const facts = buildFacts(factsRows[0] as unknown as EncounterFactsRow, petFacts, null);
        const grantsByKey = new Map(facts.encounters.map((e) => [e.key, e.grants]));

        const views: PlayView[] = facts.plays.map((p) => {
            const def = PLAY_BY_KEY[p.key];
            const completedAt = iso(p.completedAt);
            // What a completed Play took: the frozen item list, whether the delivery was
            // the whole objective or one part of a compound beat. The hand-over is
            // all-or-nothing for exactly these counts, so the list is a faithful record.
            const gave = (deliveryOf(p)?.items ?? []).map((i) => ({
                catalogKey: i.catalogKey, count: i.count, name: i.name, art: i.art ?? null,
            }));
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
