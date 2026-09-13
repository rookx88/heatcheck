// NPC encounters - server-side evaluation. Runs as a side effect of GET
// /api/toolbar-state right after discovery's roll, on the same doctrine: the server
// owns every fact, the client only ever sees the result, and everything that grants
// is one atomic statement whose race guard is an INSERT ... ON CONFLICT DO NOTHING
// that every grant leg selects FROM (see create_encounters.sql).
//
// Cost model: the facts arrive in the endpoint's existing batch (encounterFactsStatement
// rides the same HTTP round trip as the pet SELECT), so the common case - nothing new
// fireable, no open quest touched by this page - costs zero extra queries. Reading
// game_config['encounters'] is skipped whenever no unfired encounter needs a threshold.
// At most ONE encounter fires per request, in registry order, so two characters never
// arrive on the same page load.
//
// Pure functions (triggerSatisfied, questComplete, fireableEncounters) carry the rules
// and are imported directly by the acceptance suite. Adding a trigger/objective kind is
// one case here; adding an effect kind is one leg in fireEncounter's statement.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { getGameConfig } from '../pets';
import { placeFromPath } from '../discovery';
import { encounterGiftEmber } from '../ledger';
import { CHARACTERS, ENCOUNTERS, ENCOUNTER_BY_KEY } from './index';
import type { Encounter, EncounterGrants, EncounterView, Objective, Trigger } from './types';

export interface EncounterRow {
    id: string;
    key: string;
    status: 'offered' | 'seen';
    grants: EncounterGrants;
}

export interface QuestRow {
    id: string;
    key: string;
    objective: Objective;
    baseline: { feeds: number; picks: number; lifetime_earned: number };
    visited: string[];
    completedAt: string | null;
    rewardEncounterKey: string;
}

// The row encounterFactsStatement returns (json columns arrive parsed).
export interface EncounterFactsRow {
    lifetime_earned: number;
    picks: number;
    collectibles: number;
    encounters: EncounterRow[];
    quests: QuestRow[];
}

// Everything a trigger or objective can ask about, in one object.
export interface Facts {
    lifetimeEarned: number;
    picks: number;
    collectibles: number;
    feeds: number;
    place: string | null;
    encounters: EncounterRow[];
    quests: QuestRow[];
}

// One statement for the toolbar-state batch. Petless users get zero rows (the EXISTS
// guard is an index probe), so evaluateEncounters no-ops for them without a query of
// its own. Every subquery is index-backed: ember_balances PK, idx_picks_waitlist_created,
// idx_inventory_user_id, idx_encounters_user_key, idx_quests_user_key.
export function encounterFactsStatement(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`
        SELECT
            COALESCE((SELECT lifetime_earned FROM ember_balances WHERE user_id = ${userId}), 0)::int AS lifetime_earned,
            (SELECT COUNT(*) FROM picks WHERE waitlist_id = ${userId})::int AS picks,
            (SELECT COUNT(*) FROM inventory_items WHERE user_id = ${userId} AND item_type = 'collectible')::int AS collectibles,
            COALESCE((SELECT json_agg(json_build_object('id', e.id, 'key', e.encounter_key, 'status', e.status, 'grants', e.grants)
                                      ORDER BY e.created_at)
                      FROM encounters e WHERE e.user_id = ${userId}), '[]'::json) AS encounters,
            COALESCE((SELECT json_agg(json_build_object('id', q.id, 'key', q.quest_key, 'objective', q.objective,
                                                        'baseline', q.baseline, 'visited', q.visited,
                                                        'completedAt', q.completed_at,
                                                        'rewardEncounterKey', q.reward_encounter_key)
                                      ORDER BY q.started_at)
                      FROM quests q WHERE q.user_id = ${userId}), '[]'::json) AS quests
        WHERE EXISTS (SELECT 1 FROM pets WHERE user_id = ${userId})
    `;
}

// 'tankdaq' matches 'tankdaq' and 'tankdaq:chalk'; 'article:x' only matches itself.
export function placeMatches(actual: string | null, wanted: string): boolean {
    if (!actual) return false;
    return actual === wanted || actual.startsWith(`${wanted}:`);
}

export function triggerSatisfied(t: Trigger, facts: Facts, cfg: Record<string, number>): boolean {
    switch (t.kind) {
        case 'lifetime_earned_at_least': {
            const amount = Number(cfg[t.configKey]);
            // A missing threshold never fires (the registry sanity check in the
            // acceptance suite is what catches the misconfiguration loudly).
            return Number.isFinite(amount) && facts.lifetimeEarned >= amount;
        }
        case 'collectibles_at_least': return facts.collectibles >= t.count;
        case 'picks_at_least': return facts.picks >= t.count;
        case 'feeds_at_least': return facts.feeds >= t.count;
        case 'at_place': return placeMatches(facts.place, t.place);
        case 'after_encounter': return facts.encounters.some((e) => e.key === t.key && e.status === 'seen');
        case 'quest_completed': return facts.quests.some((q) => q.key === t.key && q.completedAt !== null);
    }
}

// Progress is current fact minus the baseline snapshotted when the quest started.
export function questComplete(q: QuestRow, facts: Facts): boolean {
    const o = q.objective;
    switch (o.kind) {
        case 'feeds': return facts.feeds - Number(q.baseline.feeds) >= o.count;
        case 'picks': return facts.picks - Number(q.baseline.picks) >= o.count;
        case 'earn_ember': return facts.lifetimeEarned - Number(q.baseline.lifetime_earned) >= o.amount;
        case 'visit_places': return o.places.every((p) => q.visited.some((v) => placeMatches(v, p)));
    }
}

// Registry order, minus anything this user already has - the first element is what
// fires this request.
export function fireableEncounters(facts: Facts, cfg: Record<string, number>): Encounter[] {
    return ENCOUNTERS.filter(
        (e) => !facts.encounters.some((r) => r.key === e.key) && e.trigger.every((t) => triggerSatisfied(t, facts, cfg)),
    );
}

export function toEncounterView(row: EncounterRow): EncounterView | null {
    const def = ENCOUNTER_BY_KEY[row.key];
    const character = def ? CHARACTERS[def.character] : undefined;
    // A row whose definition was removed from the registry can't be played; it just
    // stays 'offered' and invisible.
    if (!def || !character) return null;
    return {
        id: row.id,
        key: row.key,
        character: { key: character.key, name: character.name, title: character.title },
        dialogue: def.dialogue,
        grants: row.grants ?? {},
    };
}

// Claim-and-grant in ONE statement. `ins` is the race guard (unique (user_id,
// encounter_key)); every other leg selects FROM it, so a concurrent loser writes
// nothing. Item legs are gated by the itemType param so one statement covers every
// effect shape; the quest leg snapshots its baseline with subqueries so the numbers
// are the DB's at insert time, not the request's. `grants` is written in the INSERT
// itself (a CTE cannot UPDATE a row a sibling CTE inserted) and only names the item -
// the Ember gift is a separate statement (ledger.encounterGiftEmber) that patches it.
async function fireEncounter(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string; petId: string; encounter: Encounter }
): Promise<EncounterRow | null> {
    const { userId, petId, encounter } = input;
    const item = encounter.effects.find((e) => e.kind === 'grant_item');
    const quest = encounter.effects.find((e) => e.kind === 'start_quest');
    const gift = encounter.effects.find((e) => e.kind === 'grant_ember');

    const itemType = item?.kind === 'grant_item' ? item.itemType : 'none';
    const catalogKey = item?.kind === 'grant_item' ? item.catalogKey : '';
    const hasQuest = quest?.kind === 'start_quest';
    const questKey = hasQuest ? quest.quest.key : '';
    const objective = hasQuest ? JSON.stringify(quest.quest.objective) : '{}';
    const rewardKey = hasQuest ? quest.quest.rewardEncounter : '';
    const grants: EncounterGrants = item?.kind === 'grant_item' ? { item: { catalogKey, itemType } } : {};
    const notificationKey = `encounter:${encounter.key}:${userId}`;

    const rows = await sql`
        WITH ins AS (
            INSERT INTO encounters (user_id, encounter_key, character_key, status, grants)
            VALUES (${userId}, ${encounter.key}::text, ${encounter.character}::text, 'offered', ${JSON.stringify(grants)}::jsonb)
            ON CONFLICT (user_id, encounter_key) DO NOTHING
            RETURNING id
        ), quest AS (
            INSERT INTO quests (user_id, quest_key, encounter_id, objective, baseline, reward_encounter_key)
            SELECT ${userId}, ${questKey}::text, ins.id, ${objective}::jsonb,
                   jsonb_build_object(
                       'feeds', COALESCE((SELECT feed_count FROM pets WHERE id = ${petId}), 0),
                       'picks', (SELECT COUNT(*) FROM picks WHERE waitlist_id = ${userId}),
                       'lifetime_earned', COALESCE((SELECT lifetime_earned FROM ember_balances WHERE user_id = ${userId}), 0)),
                   ${rewardKey}::text
            FROM ins WHERE ${hasQuest}::boolean
            ON CONFLICT (user_id, quest_key) DO NOTHING
        ), egg AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
            SELECT ${userId}, ${catalogKey}::text, 'egg', 1 FROM ins WHERE ${itemType}::text = 'egg'
        ), food AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
            SELECT ${userId}, ${catalogKey}::text, 'food', 1 FROM ins WHERE ${itemType}::text = 'food'
            ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                DO UPDATE SET quantity = inventory_items.quantity + 1
        ), minted AS (
            UPDATE collectible_pools SET minted_count = minted_count + 1
            WHERE catalog_key = ${catalogKey}::text AND minted_count < mint_size
              AND ${itemType}::text = 'collectible' AND EXISTS (SELECT 1 FROM ins)
            RETURNING minted_count AS serial
        ), card AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity, serial_number)
            SELECT ${userId}, ${catalogKey}::text, 'collectible', 1, m.serial FROM minted m
        ), note AS (
            INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood)
            SELECT ${userId}, 'informational', ${encounter.inboxLine}::text, 'encounter', ${encounter.key}::text,
                   ${notificationKey}::text, 'happy'
            FROM ins
            ON CONFLICT (idempotency_key) DO NOTHING
        )
        SELECT (SELECT id FROM ins) AS id, (SELECT serial FROM minted) AS serial
    `;
    const out = rows[0] as unknown as { id: string | null; serial: number | null };
    if (!out.id) return null; // lost the race - the winner's row is already in facts next load

    const row: EncounterRow = { id: out.id, key: encounter.key, status: 'offered', grants };
    if (itemType === 'collectible' && out.serial === null) {
        // Pool sold out between the registry and the mint: the visit still happens,
        // the card just isn't in it.
        await sql`UPDATE encounters SET grants = grants - 'item' WHERE id = ${out.id} AND user_id = ${userId}`;
        row.grants = {};
    }
    if (gift?.kind === 'grant_ember') {
        const credited = await encounterGiftEmber(sql, {
            userId, encounterId: out.id, encounterKey: encounter.key, ruleKey: gift.ruleKey,
        });
        if (credited.credited) row.grants = { ...row.grants, ember: { amount: credited.amount } };
    }
    return row;
}

export interface EvaluateInput {
    userId: string;
    // null = petless: nothing in this system runs (a character talks TO the pet).
    pet: { id: string; feedCount: number } | null;
    // Raw ?place= from the request; normalized here via placeFromPath.
    placePath: string | null;
    // The batch row from encounterFactsStatement, or null when it returned no row.
    facts: EncounterFactsRow | null;
}

export interface EvaluateOutcome {
    fired: boolean;
    // The oldest encounter this user has not finished watching (fired now or earlier).
    pending: EncounterView | null;
}

export async function evaluateEncounters(
    sql: NeonQueryFunction<false, false>,
    input: EvaluateInput
): Promise<EvaluateOutcome> {
    const { userId, pet, placePath } = input;
    // Petless / no facts row: before any query.
    if (!pet || !input.facts) return { fired: false, pending: null };

    const facts: Facts = {
        lifetimeEarned: Number(input.facts.lifetime_earned),
        picks: Number(input.facts.picks),
        collectibles: Number(input.facts.collectibles),
        feeds: Number(pet.feedCount),
        place: placeFromPath(placePath)?.key ?? null,
        encounters: (input.facts.encounters ?? []).map((e) => ({ ...e, grants: e.grants ?? {} })),
        quests: (input.facts.quests ?? []).map((q) => ({ ...q, visited: q.visited ?? [] })),
    };

    // Thresholds only when something unfired actually needs one.
    const unfired = ENCOUNTERS.filter((e) => !facts.encounters.some((r) => r.key === e.key));
    const needsCfg = unfired.some((e) => e.trigger.some((t) => t.kind === 'lifetime_earned_at_least'));
    const cfg = needsCfg ? await getGameConfig(sql, 'encounters') : {};

    // Heal: an encounter whose Ember gift never landed (crash between the fire and
    // the gift) gets it now. Idempotent on both the grants flag and the ledger key.
    for (const row of facts.encounters) {
        const def = ENCOUNTER_BY_KEY[row.key];
        const gift = def?.effects.find((e) => e.kind === 'grant_ember');
        if (!def || gift?.kind !== 'grant_ember' || row.grants.ember) continue;
        const credited = await encounterGiftEmber(sql, {
            userId, encounterId: row.id, encounterKey: row.key, ruleKey: gift.ruleKey,
        });
        if (credited.credited) row.grants = { ...row.grants, ember: { amount: credited.amount } };
    }

    // visit_places progress: one small UPDATE only when this page is a wanted place
    // the quest hasn't recorded yet.
    if (facts.place) {
        for (const q of facts.quests) {
            if (q.completedAt || q.objective.kind !== 'visit_places') continue;
            if (!q.objective.places.some((p) => placeMatches(facts.place, p))) continue;
            if (q.visited.includes(facts.place)) continue;
            const rows = await sql`
                UPDATE quests SET visited = array_append(visited, ${facts.place}::text)
                WHERE id = ${q.id} AND user_id = ${userId} AND NOT (${facts.place}::text = ANY(visited))
                RETURNING visited
            `;
            if (rows.length) q.visited = (rows[0] as unknown as { visited: string[] }).visited;
        }
    }

    // Quest completion. A quest completed by an earlier request whose reward never
    // fired simply shows completedAt in facts and fires below - that's the heal.
    for (const q of facts.quests) {
        if (q.completedAt || !questComplete(q, facts)) continue;
        const rows = await sql`
            UPDATE quests SET completed_at = NOW()
            WHERE id = ${q.id} AND user_id = ${userId} AND completed_at IS NULL
            RETURNING completed_at
        `;
        q.completedAt = rows.length
            ? String((rows[0] as unknown as { completed_at: string }).completed_at)
            : new Date().toISOString();
    }

    // Fire at most one.
    let fired = false;
    const candidate = fireableEncounters(facts, cfg)[0];
    if (candidate) {
        const row = await fireEncounter(sql, { userId, petId: pet.id, encounter: candidate });
        if (row) {
            fired = true;
            facts.encounters.push(row);
        }
    }

    // facts.encounters is created_at-ordered with any fresh fire appended, so the
    // first 'offered' row with a live definition is the oldest unwatched one.
    let pending: EncounterView | null = null;
    for (const row of facts.encounters) {
        if (row.status !== 'offered') continue;
        pending = toEncounterView(row);
        if (pending) break;
    }
    return { fired, pending };
}
