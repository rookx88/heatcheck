// Plays - the pure rules. No imports beyond types, so the Worker, the acceptance suite
// and (for the wire types) the client bundle all read the same definitions.
//
// A Play is an errand a character hands the pet (an encounter's start_play effect). The
// plays row freezes the objective at the moment it starts - together with a title and,
// for a delivery, the character's home - so retuning the registry never changes an
// errand someone is halfway through, and the Playbook renders from that frozen copy.
//
// Two shapes:
//   counting  - feeds, picks, earn_ember, visit_places. Progress is the current fact
//               minus the baseline snapshotted when the Play started.
//   delivery  - deliver_items. Hold every item in full, then be AT the home. Completing
//               it consumes the items (deliver.ts), so the completion rule here only says
//               a delivery is READY; the burn is what actually completes it.
//
// playProgress is the single source of both the Playbook's numbers and the completion
// rule, so the list a player reads and the moment a Play completes can never disagree.

import type { DeliverItem, EncounterGrants, Objective } from './types';

// The objective as stored on the plays row.
export type StoredObjective = Objective & { title?: string; home?: string | null };

export interface PlayBaseline {
    feeds: number;
    picks: number;
    lifetime_earned: number;
    // Absent on rows written before rename_quests_to_plays.sql. forcedFind treats a
    // missing baseline as "never force", which is correct: none of those rows is a
    // delivery.
    finds?: number;
}

export interface PlayRow {
    id: string;
    key: string;
    objective: StoredObjective;
    baseline: PlayBaseline;
    visited: string[];
    completedAt: string | null;
    rewardEncounterKey: string;
    startedAt?: string;
}

// Only what a Play can ask about.
export interface PlayFacts {
    lifetimeEarned: number;
    picks: number;
    feeds: number;
    place: string | null;
    // Memorabilia held, catalog key -> quantity. A key that is absent is held zero.
    holdings: Record<string, number>;
}

// 'tankdaq' matches 'tankdaq' and 'tankdaq:chalk'; 'article:x' only matches itself.
export function placeMatches(actual: string | null, wanted: string): boolean {
    if (!actual) return false;
    return actual === wanted || actual.startsWith(`${wanted}:`);
}

export interface DeliveryLine extends DeliverItem {
    held: number;
}

export interface PlayProgress {
    // Units done and units wanted, in whatever unit the objective counts. Clamped, so a
    // Play never reads "5 of 3".
    done: number;
    target: number;
    // deliver_items only: one line per requested item.
    items?: DeliveryLine[];
    // deliver_items only: where to hand it over.
    home?: string | null;
}

function clamp(n: number, hi: number): number {
    return Math.max(0, Math.min(hi, n));
}

export function playProgress(p: PlayRow, facts: PlayFacts): PlayProgress {
    const o = p.objective;
    switch (o.kind) {
        case 'feeds':
            return { done: clamp(facts.feeds - Number(p.baseline.feeds), o.count), target: o.count };
        case 'picks':
            return { done: clamp(facts.picks - Number(p.baseline.picks), o.count), target: o.count };
        case 'earn_ember':
            return { done: clamp(facts.lifetimeEarned - Number(p.baseline.lifetime_earned), o.amount), target: o.amount };
        case 'visit_places': {
            const done = o.places.filter((want) => p.visited.some((v) => placeMatches(v, want))).length;
            return { done, target: o.places.length };
        }
        case 'deliver_items': {
            const items = o.items.map((i) => ({ ...i, held: Math.max(0, Number(facts.holdings[i.catalogKey] ?? 0)) }));
            return {
                done: items.reduce((sum, i) => sum + Math.min(i.held, i.count), 0),
                target: items.reduce((sum, i) => sum + i.count, 0),
                items,
                home: o.home ?? null,
            };
        }
    }
}

// Is every requested item held in full? Place is not considered.
export function deliveryStocked(p: PlayRow, facts: PlayFacts): boolean {
    if (p.objective.kind !== 'deliver_items') return false;
    const pr = playProgress(p, facts);
    return pr.target > 0 && pr.done >= pr.target;
}

// Should this Play complete on this request? For a delivery that means "ready to hand
// over": stocked AND standing at the home. A delivery with no home can never be ready,
// which is why the encounters suite refuses one.
export function playComplete(p: PlayRow, facts: PlayFacts): boolean {
    if (p.completedAt) return false;
    if (p.objective.kind === 'deliver_items') {
        const home = p.objective.home;
        return Boolean(home) && placeMatches(facts.place, home as string) && deliveryStocked(p, facts);
    }
    const pr = playProgress(p, facts);
    return pr.done >= pr.target;
}

// The find guarantee. While a delivery Play is open and short, the Nth, 2Nth, ... find
// since that Play started must be its first missing item. `findCount` is the pet's
// find_count BEFORE this find, so `findCount - baseline + 1` is this find's ordinal
// within the Play. Oldest open Play first, so two errands take turns rather than race.
//
// This makes a find predictable from the player's own Play state. That is acceptable:
// nothing a request carries moves either number, so it cannot be farmed.
export function forcedFind(plays: PlayRow[], facts: PlayFacts, findCount: number, everyNth: number): string | null {
    if (!(everyNth >= 1)) return null;
    for (const p of plays) {
        if (p.completedAt || p.objective.kind !== 'deliver_items') continue;
        if (typeof p.baseline.finds !== 'number') continue;
        const ordinal = Number(findCount) - Number(p.baseline.finds) + 1;
        if (ordinal < 1 || ordinal % everyNth !== 0) continue;
        const short = p.objective.items.find((i) => Number(facts.holdings[i.catalogKey] ?? 0) < i.count);
        if (short) return short.catalogKey;
    }
    return null;
}

// Wire shape: GET /api/plays. The character comes down as a key; the client resolves the
// portrait from the bundled registry, so the asset literal stays in the bundle.
export interface PlayView {
    id: string;
    key: string;
    character: string;
    title: string;
    kind: Objective['kind'];
    objective: StoredObjective;
    progress: PlayProgress;
    startedAt: string | null;
    completedAt: string | null;
    // Completed Plays only.
    receipt: PlayReceipt | null;
}

export interface PlayReceipt {
    // Exactly what the delivery took: the stored objective's items. The burn is
    // all-or-nothing for exactly those counts, so this is a faithful record. Empty for a
    // counting Play, which takes nothing.
    gave: DeliverItem[];
    // The reward encounter's grants, or null when that scene has not fired yet.
    got: EncounterGrants | null;
    completedAt: string;
}
