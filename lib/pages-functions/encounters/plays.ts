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
    // Absent on rows written before the character arcs. Every counting kind reads its
    // baseline through `base()` below, which treats a missing value as zero - so an old
    // row measures from zero rather than crashing, and no old row uses these kinds.
    wins?: number;
    profit_sells?: number;
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

// Only what a Play can ask about. Everything here is either already in the toolbar-state
// batch or one index-backed subquery in encounterFactsStatement.
export interface PlayFacts {
    lifetimeEarned: number;
    picks: number;
    feeds: number;
    place: string | null;
    // Memorabilia AND food held, catalog key -> quantity. A key that is absent is held
    // zero. Food is in here because deliveries can ask for it.
    holdings: Record<string, number>;
    // Settled picks that came in.
    wins: number;
    // Positions closed above cost.
    profitSells: number;
    // TANKDAQ positions held right now, ticker key -> shares.
    shares: Record<string, number>;
    // Does any held position predate one of its index's daily closes?
    heldThroughClose: boolean;
    // Satisfied now and last fed longer ago than discovery's sustained_hours.
    petSustainedSatisfied: boolean;
    // The pet has a name.
    petNamed: boolean;
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
    // Play never reads "5 of 3". A moment objective is 0/1 or 1/1.
    done: number;
    target: number;
    // deliver_items only: one line per requested item.
    items?: DeliveryLine[];
    // deliver_items only: where to hand it over.
    home?: string | null;
    // all_of only: one entry per part, in the order the author wrote them, so the
    // Playbook can list them instead of showing one meaningless total.
    parts?: Array<PlayProgress & { kind: Objective['kind']; label: string }>;
}

function clamp(n: number, hi: number): number {
    return Math.max(0, Math.min(hi, n));
}

// A missing baseline counts as zero. Only rows written before a kind existed can have
// one, and no such row uses that kind - see PlayBaseline.
function base(baseline: PlayBaseline, key: keyof PlayBaseline): number {
    return Number(baseline[key] ?? 0);
}

function flag(on: boolean): PlayProgress {
    return { done: on ? 1 : 0, target: 1 };
}

// What the Playbook calls each part of a compound Play. Deliberately short: the row
// already says which character asked and the part carries its own numbers.
function partLabel(o: Objective): string {
    switch (o.kind) {
        case 'feeds': return 'Feed your pet';
        case 'picks': return 'Make calls';
        case 'win_picks': return 'Win calls';
        case 'earn_ember': return 'Earn Ember';
        case 'read_articles': return 'Read Tanks';
        case 'visit_places': return 'Visit places';
        case 'deliver_items': return 'Bring the items';
        case 'hold_shares': return o.indexes && o.indexes > 1 ? 'Hold positions in different indexes' : 'Hold shares';
        case 'sell_profit': return 'Close positions in profit';
        case 'hold_through_close': return 'Carry a position through a close';
        case 'pet_sustained_satisfied': return 'Keep your pet fed';
        case 'name_pet': return 'Name your pet';
        case 'all_of': return 'Everything at once';
    }
}

export function playProgress(p: PlayRow, facts: PlayFacts): PlayProgress {
    return progressOf(p.objective, p, facts);
}

// Split from playProgress so a compound part can be measured with the same rules as a
// whole Play: a part shares the Play's row, and therefore its baseline and its visited
// list, which is exactly what makes "items AND wins AND care" one coherent ask.
function progressOf(o: Objective, p: PlayRow, facts: PlayFacts): PlayProgress {
    switch (o.kind) {
        case 'feeds':
            return { done: clamp(facts.feeds - base(p.baseline, 'feeds'), o.count), target: o.count };
        case 'picks':
            return { done: clamp(facts.picks - base(p.baseline, 'picks'), o.count), target: o.count };
        case 'win_picks':
            return { done: clamp(facts.wins - base(p.baseline, 'wins'), o.count), target: o.count };
        case 'earn_ember':
            return { done: clamp(facts.lifetimeEarned - base(p.baseline, 'lifetime_earned'), o.amount), target: o.amount };
        case 'sell_profit':
            return { done: clamp(facts.profitSells - base(p.baseline, 'profit_sells'), o.count), target: o.count };
        case 'visit_places': {
            const done = o.places.filter((want) => p.visited.some((v) => placeMatches(v, want))).length;
            return { done, target: o.places.length };
        }
        case 'read_articles': {
            // Distinct, because `visited` is append-once-per-place anyway; counted here
            // rather than trusted so a future recorder change cannot inflate progress.
            const read = new Set(p.visited.filter((v) => v.startsWith(ARTICLE_PREFIX)));
            return { done: clamp(read.size, o.count), target: o.count };
        }
        case 'deliver_items': {
            const items = o.items.map((i) => ({ ...i, held: Math.max(0, Number(facts.holdings[i.catalogKey] ?? 0)) }));
            return {
                done: items.reduce((sum, i) => sum + Math.min(i.held, i.count), 0),
                target: items.reduce((sum, i) => sum + i.count, 0),
                items,
                // Frozen onto the stored objective; absent on the authored shape.
                home: (o as { home?: string | null }).home ?? null,
            };
        }
        case 'hold_shares': {
            // Two dials, either or both: total shares held, and how many different
            // indexes carry a position. A position is a row with shares above zero.
            const positions = Object.entries(facts.shares).filter(([, n]) => Number(n) > 0);
            if (o.indexes && o.indexes > 0) {
                return { done: clamp(positions.length, o.indexes), target: o.indexes };
            }
            const total = positions.reduce((sum, [, n]) => sum + Number(n), 0);
            const want = o.shares ?? 1;
            return { done: clamp(total, want), target: want };
        }
        case 'hold_through_close':
            return flag(facts.heldThroughClose);
        case 'pet_sustained_satisfied':
            return flag(facts.petSustainedSatisfied);
        case 'name_pet':
            return flag(facts.petNamed);
        case 'all_of': {
            // The home is frozen onto the compound objective itself (one Play, one place),
            // so a delivery part inherits it here; otherwise its "bring it to" line would
            // lose the place the player actually has to go.
            const topHome = (o as { home?: string | null }).home ?? null;
            const parts = o.parts.map((part) => {
                const measured = progressOf(part, p, facts);
                if (part.kind === 'deliver_items' && !measured.home) measured.home = topHome;
                return { ...measured, kind: part.kind, label: partLabel(part) };
            });
            return {
                done: parts.reduce((sum, part) => sum + part.done, 0),
                target: parts.reduce((sum, part) => sum + part.target, 0),
                // A compound delivery's items ride up to the top level too, so the
                // Playbook's item chips and the receipt keep working unchanged.
                items: parts.flatMap((part) => part.items ?? []),
                home: parts.find((part) => part.home)?.home ?? null,
                parts,
            };
        }
    }
}

const ARTICLE_PREFIX = 'article:';

// The delivery inside this Play, whether it IS the Play or one part of a compound one.
// Null when nothing is being handed over, which is what deliver.ts checks first.
export function deliveryOf(p: PlayRow): { items: DeliverItem[]; home: string | null } | null {
    const o = p.objective;
    // `home` is frozen onto the STORED objective, so a part read back out of jsonb may
    // carry it even though the authored type has no such field.
    const homeOf = (x: unknown): string | null => (x as { home?: string | null })?.home ?? null;
    if (o.kind === 'deliver_items') return { items: o.items, home: homeOf(o) };
    if (o.kind === 'all_of') {
        const part = o.parts.find((x) => x.kind === 'deliver_items');
        if (part && part.kind === 'deliver_items') return { items: part.items, home: homeOf(part) ?? homeOf(o) };
    }
    return null;
}

// Is every requested item held in full? Place is not considered.
export function deliveryStocked(p: PlayRow, facts: PlayFacts): boolean {
    const d = deliveryOf(p);
    if (!d || d.items.length === 0) return false;
    return d.items.every((i) => Number(facts.holdings[i.catalogKey] ?? 0) >= i.count);
}

// Should this Play complete on this request?
//
// A Play that hands something over completes AT the character's home and nowhere else,
// whether the delivery is the whole objective or one part of a compound one - so a
// compound beat is "have all of this, and be standing in front of me". A delivery with
// no home can never be ready, which is why the encounters suite refuses one.
//
// Everything else is done when every part is done. For a compound Play that means each
// part measured at this same moment: a sustained-satisfaction part that lapsed while the
// player chased the last item is genuinely not satisfied, and the beat waits.
export function playComplete(p: PlayRow, facts: PlayFacts): boolean {
    if (p.completedAt) return false;
    const d = deliveryOf(p);
    if (d) {
        if (!d.home || !placeMatches(facts.place, d.home)) return false;
        if (!deliveryStocked(p, facts)) return false;
    }
    const pr = playProgress(p, facts);
    if (pr.parts) return pr.parts.every((part) => part.done >= part.target);
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
        if (p.completedAt) continue;
        const d = deliveryOf(p);
        if (!d) continue;
        if (typeof p.baseline.finds !== 'number') continue;
        const ordinal = Number(findCount) - Number(p.baseline.finds) + 1;
        if (ordinal < 1 || ordinal % everyNth !== 0) continue;
        // `forceable` is frozen from the catalog when the Play starts: a shop SKU is
        // never forced, because the ask there is to go and buy it.
        const short = d.items.find((i) => i.forceable !== false && Number(facts.holdings[i.catalogKey] ?? 0) < i.count);
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
