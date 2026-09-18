// Delivery Plays - the hand-over. The one place in the encounter system that CONSUMES
// inventory, which is why it is its own module with its own lock rather than a leg in
// fireEncounter's statement: every other write there only ever adds.
//
// Called from evaluateEncounters once playComplete() says a delivery is ready (stocked,
// and the page is the character's home), whether the delivery is the whole objective or
// one part of a compound beat. The completion and the burn are one statement, inside one
// transaction behind the per-user advisory locks:
//
//   claimed - UPDATE plays SET completed_at, only while it is still open AND every
//             requested item is held in full (a set-level gate: a two-item errand that is
//             short on the second item burns neither). This is the race guard: a replay
//             or a concurrent loser matches nothing, and every leg below selects FROM it.
//   burned  - decrements each requested row, with its own quantity >= count check, so a
//             negative quantity is impossible whatever the snapshot said (and
//             inventory_items carries a quantity >= 0 CHECK as the last backstop).
//   itm     - one item_ledger sink row per SKU ('play_delivery'), in the same statement,
//             per the item-journal doctrine (lib/pages-functions/item-ledger.ts).
//   guard   - if the Play was claimed but fewer rows were burned or journaled than
//             requested, the statement raises (division by zero, deliberately) and the
//             whole transaction rolls back - the Play stays open and nothing is taken.
//             Under both locks this cannot happen (nothing else decrements memorabilia,
//             and feeding holds the same feed lock), so it is an assertion, not a path.
//
// TWO LOCKS, ALWAYS IN THIS ORDER: 'play_deliver' first, then 'pet_feed'. Deliveries
// were memorabilia-only when this module was written, and memorabilia has exactly one
// consumer, so one lock was enough. A delivery can now ask for FOOD, which feeding also
// decrements (pets.ts feed), so the two paths have to serialize against each other or a
// feed and a hand-over could each see the last unit and both spend it. Feeding takes
// only 'pet_feed'; this takes both, and the fixed order is what makes that safe - two
// callers that take the same locks in the same order cannot deadlock. Anything else that
// ever consumes food must take 'pet_feed' too, and must not take it before a lock this
// module takes first.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { itemIdempotencyKey } from '../item-ledger';
import { deliveryOf, type PlayRow } from './plays';

function deliverLock(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`SELECT pg_advisory_xact_lock(hashtext('play_deliver'), hashtext(${userId}))`;
}

// The same namespace pets.ts feed() uses - deliberately, not coincidentally.
function feedLock(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`SELECT pg_advisory_xact_lock(hashtext('pet_feed'), hashtext(${userId}))`;
}

export interface DeliverResult {
    // The Play's completed_at when THIS call completed it; null when nothing happened
    // (already completed, or not stocked by the time the lock was held).
    completedAt: string | null;
}

export async function deliverPlay(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string; play: PlayRow },
): Promise<DeliverResult> {
    const { userId, play } = input;
    // Covers a delivery that is one part of a compound beat as well as one that is the
    // whole objective (plays.ts deliveryOf).
    const handover = deliveryOf(play);
    if (!handover) return { completedAt: null };
    const items = handover.items;
    if (items.length === 0) return { completedAt: null };

    const keys = items.map((i) => i.catalogKey);
    const counts = items.map((i) => Math.max(1, Math.floor(Number(i.count))));
    // The type each item was frozen with. Food deliveries exist so a character can be
    // handed a meal; anything not explicitly food is memorabilia, which is what every
    // row written before food deliveries carried.
    const types = items.map((i) => (i.itemType === 'food' ? 'food' : 'memorabilia'));
    // One key per Play per SKU. The catalog key is appended in SQL.
    const keyPrefix = itemIdempotencyKey('play_delivery', userId, `${play.id}:`);
    const metadata = JSON.stringify({ playId: play.id, playKey: play.key });

    const [, , rows] = await sql.transaction([
        deliverLock(sql, userId),
        feedLock(sql, userId),
        sql`
        WITH want AS (
            SELECT w.catalog_key, w.cnt, w.item_type
            FROM unnest(${keys}::text[], ${counts}::int[], ${types}::text[]) AS w(catalog_key, cnt, item_type)
        ), claimed AS (
            UPDATE plays SET completed_at = NOW()
            WHERE id = ${play.id}::uuid AND user_id = ${userId}::uuid AND completed_at IS NULL
              AND NOT EXISTS (
                  SELECT 1 FROM want w
                  LEFT JOIN inventory_items i
                    ON i.user_id = ${userId}::uuid AND i.catalog_key = w.catalog_key
                   AND i.item_type = w.item_type
                  WHERE COALESCE(i.quantity, 0) < w.cnt
              )
            RETURNING id, completed_at
        ), burned AS (
            UPDATE inventory_items i SET quantity = i.quantity - w.cnt
            FROM want w, claimed c
            WHERE i.user_id = ${userId}::uuid AND i.catalog_key = w.catalog_key
              AND i.item_type = w.item_type AND i.quantity >= w.cnt
            RETURNING i.id, i.catalog_key, i.item_type, w.cnt
        ), itm AS (
            INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                     inventory_item_id, idempotency_key, metadata)
            SELECT ${userId}::uuid, b.catalog_key, b.item_type, -b.cnt, 'play_delivery', 'sink',
                   b.id, ${keyPrefix}::text || b.catalog_key, ${metadata}::jsonb
            FROM burned b
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING 1
        ), tally AS (
            SELECT (SELECT completed_at FROM claimed) AS completed_at,
                   (SELECT COUNT(*) FROM burned)::int AS burned,
                   (SELECT COUNT(*) FROM itm)::int AS journaled
        )
        SELECT completed_at,
               -- The assertion described in the header: claimed but short raises. The
               -- divisor is a column expression on purpose: a literal 1 / 0 can be
               -- constant-folded by the planner and raise even when the branch is not taken.
               CASE WHEN completed_at IS NOT NULL
                         AND (burned <> ${items.length}::int OR journaled <> ${items.length}::int)
                    THEN 1 / (burned - burned) ELSE 0 END AS guard
        FROM tally
        `,
    ]);
    const row = rows[0] as unknown as { completed_at: string | Date | null } | undefined;
    const at = row?.completed_at ?? null;
    return { completedAt: at === null ? null : new Date(at).toISOString() };
}
