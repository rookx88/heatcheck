// Pet Random Event Discovery - the "luck channel" (see add_pet_discovery.sql for the
// product shape). Runs as a cheap side effect of GET /api/toolbar-state, which fires
// during normal ambient app use - deliberately NOT tied to any one player action, so
// there is no client-observable moment that "is the check". The server owns the clock:
// pets.next_eligible_roll_at is the only scheduling fact, and no client input can move
// it. Spamming the endpoint hits the zero-query not_due fast path; truly-simultaneous
// due requests serialize on the pets row (the claim UPDATE in each grant statement),
// so exactly one wins and the loser writes nothing.
//
// No Ember is written here - the ember branch delegates to ledger.discoveryFindEmber()
// (ledger.ts is the one sanctioned Ember write path). The food branch writes
// inventory_items directly, precedent pets.ts feed().

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { computeSatisfaction, getGameConfig, petState, type FeedingConfig, type PetRow } from './pets';
import { discoveryFindEmber } from './ledger';

// game_config['discovery'] - flat numeric keys, matching getGameConfig's shape.
export interface DiscoveryConfig {
    weight_ember: number;
    weight_food: number;
    weight_collectible: number;
    short_cooldown_minutes_min: number;
    short_cooldown_minutes_max: number;
    long_cooldown_minutes_min: number;
    long_cooldown_minutes_max: number;
    sustained_hours: number;
    food_weight_price_exponent: number;
}

// The pet row as toolbar-state reads it: the feed/hatch shape plus the discovery clock.
export interface DiscoveryPetRow extends PetRow {
    next_eligible_roll_at: string | null;
}

export type DiscoveryOutcome =
    | { kind: 'no_pet' }
    | { kind: 'not_due' }
    | { kind: 'initialized' }
    | { kind: 'lost_race' }
    | { kind: 'found_ember'; amount: number }
    | { kind: 'found_food'; catalogKey: string; name: string };

function uniformMinutes(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

interface FoodSkuRow {
    key: string;
    name: string;
    price: number;
}

// The whole side effect, including its own preconditions - callers just pass whatever
// pet row they have (or null) and never need to know the feature's rules.
export async function maybeDiscover(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string; pet: DiscoveryPetRow | null; feedingCfg: FeedingConfig }
): Promise<DiscoveryOutcome> {
    const { userId, pet, feedingCfg } = input;

    // Hard precondition: a petless account triggers NOTHING in this system - no
    // cooldown read, no reward logic, no error. Checked first, before any query.
    if (!pet) return { kind: 'no_pet' };

    // The ~100% path: not due yet. Zero extra queries - the timestamp rides along in
    // the pet SELECT the endpoint already does.
    if (pet.next_eligible_roll_at !== null && Date.parse(pet.next_eligible_roll_at) > Date.now()) {
        return { kind: 'not_due' };
    }

    const cfg = (await getGameConfig(sql, 'discovery')) as unknown as DiscoveryConfig;

    // NULL = never scheduled (pre-feature pets, fresh hatches). Start the clock with a
    // long-range window and grant nothing - so a deploy never produces an instant-find
    // burst, and a hatch's first find takes real elapsed time. The IS NULL qual is the
    // race guard: a concurrent initializer matches zero rows and is a harmless no-op.
    if (pet.next_eligible_roll_at === null) {
        const minutes = uniformMinutes(cfg.long_cooldown_minutes_min, cfg.long_cooldown_minutes_max);
        await sql`
            UPDATE pets SET next_eligible_roll_at = NOW() + (${minutes}::float8 * INTERVAL '1 minute')
            WHERE id = ${pet.id} AND user_id = ${userId} AND next_eligible_roll_at IS NULL
        `;
        return { kind: 'initialized' };
    }

    // Due. Roll everything in JS first, then claim-and-grant in one atomic statement.
    //
    // Sustained-Satisfied gates the short cooldown: satisfied NOW and fed at least
    // sustained_hours ago. Satisfaction decays monotonically from the value stored at
    // last_fed_at (pets.ts computeSatisfaction), so satisfied-now implies satisfied at
    // every instant since the last feed - the two checks together mean "continuously
    // Satisfied for the whole window". A pet topped off moments before the check is
    // satisfied-now but fails the time gate, so last-second feeding never buys the
    // short window. (Conservative: a feed always restarts the sustained clock, because
    // pre-feed history is unrecoverable from the stored facts. Accepted.)
    const sustained =
        petState(computeSatisfaction(pet, feedingCfg), feedingCfg) === 'satisfied' &&
        Date.now() - Date.parse(pet.last_fed_at) >= cfg.sustained_hours * 3_600_000;
    const cooldownMinutes = sustained
        ? uniformMinutes(cfg.short_cooldown_minutes_min, cfg.short_cooldown_minutes_max)
        : uniformMinutes(cfg.long_cooldown_minutes_min, cfg.long_cooldown_minutes_max);

    // The identity of the window being consumed - makes the grant's idempotency keys
    // deterministic per roll, so a replay of the same window is a no-op everywhere.
    const windowScope = String(Date.parse(pet.next_eligible_roll_at));

    // Collectibles are in the configured weights from day one, but have no backend yet.
    // When no active collectible SKU exists, renormalizing over ember+food IS the
    // proportional redistribution of the collectible mass (70/95, 25/95) - the roll
    // never fails or errors over the missing category.
    const collectibleRows = await sql`
        SELECT EXISTS (
            SELECT 1 FROM items_catalog
            WHERE item_type = 'collectible' AND active = true
              AND (available_from IS NULL OR available_from <= NOW())
              AND (available_until IS NULL OR available_until > NOW())
        ) AS supported
    `;
    const collectiblesSupported = Boolean((collectibleRows[0] as unknown as { supported: boolean }).supported);

    const weightEmber = cfg.weight_ember;
    const weightFood = cfg.weight_food;
    const weightCollectible = collectiblesSupported ? cfg.weight_collectible : 0;
    const roll = Math.random() * (weightEmber + weightFood + weightCollectible);

    let category: 'ember' | 'food' = roll < weightEmber ? 'ember' : 'food';
    if (roll >= weightEmber + weightFood) {
        // Collectible rolled (only reachable once collectible SKUs exist). There is no
        // collectible grant path yet - no discovery-pool table to decrement - so fall
        // back to ember rather than over-issue or fail. Build the real branch (atomic
        // discovery-pool check-and-decrement, spend()'s guarded-UPDATE idiom) before
        // activating collectible SKUs.
        category = 'ember';
    }

    if (category === 'food') {
        // Active food SKUs with live prices (shop.ts's join), weighted toward cheap:
        // weight = (1/price)^exponent, so the catalog re-weights itself as SKUs come,
        // go, or get repriced - no per-SKU map to maintain, and free finds skew away
        // from undercutting the shop's expensive tier.
        const foodRows = (await sql`
            SELECT c.key, c.name, (r.config->>'amount')::int AS price
            FROM items_catalog c
            JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
            WHERE c.active = true AND c.item_type = 'food'
              AND (c.available_from IS NULL OR c.available_from <= NOW())
              AND (c.available_until IS NULL OR c.available_until > NOW())
        `) as unknown as FoodSkuRow[];
        if (foodRows.length > 0) {
            const weights = foodRows.map((r) => (1 / r.price) ** cfg.food_weight_price_exponent);
            let pickRoll = Math.random() * weights.reduce((a, b) => a + b, 0);
            let picked = foodRows[foodRows.length - 1];
            for (let i = 0; i < foodRows.length; i++) {
                pickRoll -= weights[i];
                if (pickRoll < 0) {
                    picked = foodRows[i];
                    break;
                }
            }
            const message = `Psst — I sniffed out a ${picked.name} while exploring! Tucked it into our inventory for later.`;
            const notificationKey = `discovery:${pet.id}:${windowScope}`;
            // Claim the window and grant in ONE statement: the pets UPDATE is the race
            // guard (a losing concurrent request re-evaluates against the winner's
            // pushed-out timestamp and matches zero rows), and both grant legs select
            // FROM it, so a lost race writes nothing. The consumed window IS the
            // idempotency for the stack upsert (no natural key on a quantity bump);
            // the notification key is the deduped backstop.
            const rows = await sql`
                WITH claimed AS (
                    UPDATE pets SET next_eligible_roll_at = NOW() + (${cooldownMinutes}::float8 * INTERVAL '1 minute')
                    WHERE id = ${pet.id} AND user_id = ${userId}
                      AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
                    RETURNING id
                ), granted AS (
                    INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                    SELECT ${userId}, ${picked.key}, 'food', 1
                    FROM claimed
                    ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                        DO UPDATE SET quantity = inventory_items.quantity + 1
                    RETURNING id
                ), note AS (
                    INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
                    SELECT ${userId}, 'claimable', ${message}, 'pet', ${pet.id}::text, ${notificationKey}
                    FROM claimed
                    ON CONFLICT (idempotency_key) DO NOTHING
                )
                SELECT EXISTS (SELECT 1 FROM claimed) AS claimed
            `;
            const claimed = Boolean((rows[0] as unknown as { claimed: boolean }).claimed);
            return claimed ? { kind: 'found_food', catalogKey: picked.key, name: picked.name } : { kind: 'lost_race' };
        }
        // No purchasable food exists at all (catalog emptied) - degrade to ember
        // rather than fail the roll.
        category = 'ember';
    }

    const result = await discoveryFindEmber(sql, {
        userId,
        petId: pet.id,
        cooldownMinutes,
        windowScope,
        buildMessage: (amount) =>
            `I was poking around while you were gone and dug up ${amount} Ember! Snuck it straight into the stash.`,
    });
    return result.claimed ? { kind: 'found_ember', amount: result.amount } : { kind: 'lost_race' };
}
