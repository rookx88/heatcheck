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
// (ledger.ts is the one sanctioned Ember write path). The food and collectible
// branches write inventory_items directly, precedent pets.ts feed(); the collectible
// branch also allocates serials via collectible_pools (add_genesis_collectibles.sql).

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
    | { kind: 'found_food'; catalogKey: string; name: string }
    | { kind: 'found_collectible'; catalogKey: string; name: string; serial: number; mintSize: number }
    // Last-copy race: the pool sold out between the pre-roll eligibility check and the
    // grant statement. The window is consumed and nothing is granted - by design (see
    // the collectible branch); needs two collectible rolls landing on the final serial
    // within one statement window, so at most once per SKU ever.
    | { kind: 'collectible_pool_exhausted' };

function uniformMinutes(min: number, max: number): number {
    return min + Math.random() * (max - min);
}

interface FoodSkuRow {
    key: string;
    name: string;
    price: number;
}

interface CollectibleSkuRow {
    key: string;
    name: string;
    mint_size: number;
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
    // the pet SELECT the endpoint already does. Always `new Date(x).getTime()`, never
    // Date.parse(x): the Neon driver hands timestamptz back as a Date at runtime, and
    // Date.parse coerces via toString(), which truncates to whole seconds - that
    // truncation made windowScope collide across rapid test rolls and silently
    // ON CONFLICT-dropped their ledger rows. new Date(x) keeps millisecond precision
    // for both the Date and ISO-string cases (same idiom as computeSatisfaction).
    if (pet.next_eligible_roll_at !== null && new Date(pet.next_eligible_roll_at).getTime() > Date.now()) {
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
        Date.now() - new Date(pet.last_fed_at).getTime() >= cfg.sustained_hours * 3_600_000;
    const cooldownMinutes = sustained
        ? uniformMinutes(cfg.short_cooldown_minutes_min, cfg.short_cooldown_minutes_max)
        : uniformMinutes(cfg.long_cooldown_minutes_min, cfg.long_cooldown_minutes_max);

    // The identity of the window being consumed - makes the grant's idempotency keys
    // deterministic per roll, so a replay of the same window is a no-op everywhere.
    // Millisecond precision matters here (see the new Date note above): at second
    // precision, distinct windows can collide into one idempotency key and the
    // conflict silently swallows the grant.
    const windowScope = String(new Date(pet.next_eligible_roll_at).getTime());

    // Droppable collectible SKUs with supply remaining. Sold-out (minted_count >=
    // mint_size) and non-droppable SKUs fall out of this list BEFORE the roll, so the
    // no-eligible-SKU case renormalizes over ember+food exactly like the pre-launch
    // no-SKU case always has (70/95, 25/95) - the roll never fails over the missing
    // category. discovery_droppable is a catalog-config gate independent of `active`:
    // a held-back edition activated later for some other channel (shop, airdrop) must
    // not silently start dropping here.
    const collectibleSkus = (await sql`
        SELECT c.key, c.name, p.mint_size
        FROM items_catalog c
        JOIN collectible_pools p ON p.catalog_key = c.key
        WHERE c.item_type = 'collectible' AND c.active = true
          AND (c.config->>'discovery_droppable')::boolean IS TRUE
          AND (c.available_from IS NULL OR c.available_from <= NOW())
          AND (c.available_until IS NULL OR c.available_until > NOW())
          AND p.minted_count < p.mint_size
    `) as unknown as CollectibleSkuRow[];

    const weightEmber = cfg.weight_ember;
    const weightFood = cfg.weight_food;
    const weightCollectible = collectibleSkus.length > 0 ? cfg.weight_collectible : 0;
    const roll = Math.random() * (weightEmber + weightFood + weightCollectible);

    let category: 'ember' | 'food' = roll < weightEmber ? 'ember' : 'food';
    if (roll >= weightEmber + weightFood) {
        // Collectible rolled: mint one serialized copy. Uniform over eligible SKUs
        // (one today - Genesis Neon - but nothing here assumes that).
        const picked = collectibleSkus[Math.floor(Math.random() * collectibleSkus.length)];
        const notificationKey = `discovery:${pet.id}:${windowScope}`;
        // The serial is only known inside the statement (RETURNING minted_count), so
        // the pet-voice message is assembled in SQL around it from two halves.
        const msgPre = `WHOA. I dug up something SHINY while you were away — a ${picked.name} card, serial #`;
        const msgPost = ` of ${picked.mint_size}! Tucked it into our Collectibles. Do NOT let me eat it.`;
        // Same one-statement shape as the food branch (claimed = the window race
        // guard), plus `minted`: the discovery-pool check-and-decrement in spend()'s
        // guarded-UPDATE idiom. The collectible_pools row lock serializes all mints of
        // this SKU globally; a loser re-evaluates minted_count < mint_size against the
        // winner's committed version, so the cap can't be exceeded, and RETURNING
        // minted_count IS the freshly allocated 1-based serial - allocation and cap
        // enforcement are one atomic write. minted_count is monotone (never decrement:
        // a freed serial would be re-issued and collide on
        // idx_inventory_collectible_serial). The consumed window is the idempotency
        // for the mint, the notification key the deduped backstop - food-branch
        // doctrine. No Ember moves, so ledger.ts stays untouched.
        const rows = await sql`
            WITH claimed AS (
                UPDATE pets SET next_eligible_roll_at = NOW() + (${cooldownMinutes}::float8 * INTERVAL '1 minute')
                WHERE id = ${pet.id} AND user_id = ${userId}
                  AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
                RETURNING id
            ), minted AS (
                UPDATE collectible_pools
                SET minted_count = minted_count + 1
                WHERE catalog_key = ${picked.key} AND minted_count < mint_size
                  AND EXISTS (SELECT 1 FROM claimed)
                RETURNING minted_count AS serial
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity, serial_number)
                SELECT ${userId}, ${picked.key}, 'collectible', 1, m.serial
                FROM minted m
                RETURNING id
            ), note AS (
                INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
                SELECT ${userId}, 'claimable', ${msgPre} || m.serial::text || ${msgPost}, 'pet', ${pet.id}::text, ${notificationKey}
                FROM minted m
                ON CONFLICT (idempotency_key) DO NOTHING
            )
            SELECT EXISTS (SELECT 1 FROM claimed) AS claimed,
                   (SELECT serial FROM minted) AS serial
        `;
        const outcome = rows[0] as unknown as { claimed: boolean; serial: number | null };
        if (!outcome.claimed) return { kind: 'lost_race' };
        if (outcome.serial === null) return { kind: 'collectible_pool_exhausted' };
        return {
            kind: 'found_collectible',
            catalogKey: picked.key,
            name: picked.name,
            serial: outcome.serial,
            mintSize: picked.mint_size,
        };
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
