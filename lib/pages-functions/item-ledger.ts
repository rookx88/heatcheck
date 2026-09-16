// The item journal's vocabulary and key convention - the items counterpart to ledger.ts's
// Ember doctrine. See create_item_ledger_tables.sql for the schema and the reasoning.
//
// WHY THIS FILE IS NOT "the one write path" THE WAY ledger.ts IS. ledger.ts can insist
// that nothing outside it writes ember_ledger, because every Ember movement is its own
// statement. Items cannot: discovery and encounters write inventory_items inside large
// statements whose OTHER legs are the race guards (the pets claim UPDATE, the encounters
// ON CONFLICT insert), and the Neon tagged-template driver cannot compose SQL fragments,
// so the write cannot be lifted into a shared function without losing atomicity.
//
// So the rule is enforced from the outside instead, and it is not optional:
//   EVERY statement that INSERTs, decrements or DELETEs inventory_items must write its
//   item_ledger row IN THE SAME STATEMENT, keyed off a token that is already durable at
//   that site.
// scripts/acceptance/suites/ledger-trace.ts reads this repo's source and fails if any
// inventory write is missing its journal leg, and separately sweeps the database for a
// user/SKU whose SUM(delta) disagrees with what they hold. A write path that evades the
// source read still shows up in the sweep.

/**
 * Every reason a journal row can carry, and its sign. Mirrors ledger.ts's
 * LIFETIME_EARNED_RULE_KEYS in spirit: exported so the acceptance suite can cross-check
 * the code's vocabulary against the item_reasons table and catch a seed row that was
 * never added (which would be an FK violation on the hot path, not a silent skip).
 *
 * 'opening_balance' and 'acceptance_seed' exist in the table but NOT here: neither is
 * ever written by product code.
 */
export const ITEM_REASONS = {
    purchase: 'source',
    discovery_find: 'source',
    encounter_grant: 'source',
    hatch: 'sink',
    feed: 'sink',
} as const;

export type ItemReason = keyof typeof ITEM_REASONS;

/**
 * The idempotency key convention, identical in shape to ledger.buildIdempotencyKey so the
 * two journals read the same. `scope` must be a token that ALREADY exists durably at the
 * call site - the consumed roll window, the encounter key, the egg row's id, the feed
 * token - never one invented for the journal, or the key stops meaning anything.
 */
export function itemIdempotencyKey(reason: ItemReason, userId: string, scope: string): string {
    return `${reason}:${userId}:${scope}`;
}
