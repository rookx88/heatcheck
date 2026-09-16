// Pet Random Event Discovery - the "luck channel" (see add_pet_discovery.sql for the
// product shape). Runs as a cheap side effect of GET /api/toolbar-state, which fires
// during normal ambient app use - deliberately NOT tied to any one player action, so
// there is no client-observable moment that "is the check". The server owns the clock:
// pets.next_eligible_roll_at is the only scheduling fact, and no client input can move
// it. Spamming the endpoint hits the zero-query not_due fast path; truly-simultaneous
// due requests serialize on the pets row (the claim UPDATE in each grant statement),
// so exactly one wins and the loser writes nothing.
//
// Two gates, both quals on that same claim UPDATE (add_pet_footprints.sql):
//   time       - next_eligible_roll_at <= NOW(), the cooldown.
//   footprints - cardinality(places_since_find) >= min_new_places: the pet must have
//                visited that many DISTINCT places since its last find. The chrome
//                sends the page path with every toolbar-state call; placeFromPath()
//                below turns it into a place key (an allowlist - unknown paths are
//                ignored, never an error), and a NEW place costs one UPDATE that
//                appends it. A known place costs nothing. Footprints accumulate whether
//                or not the clock is due, and the claim resets them to '{}'. Without
//                this, polling one URL until the clock came due farmed forever; with
//                it, the reward follows the owner actually moving around the site.
//
// No Ember is written here - the ember branch delegates to ledger.discoveryFindEmber()
// (ledger.ts is the one sanctioned Ember write path). The food and collectible
// branches write inventory_items directly, precedent pets.ts feed(); the collectible
// branch also allocates serials via collectible_pools (add_genesis_collectibles.sql).

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { computeSatisfaction, getGameConfig, petState, type FeedingConfig, type PetRow } from './pets';
import { itemIdempotencyKey } from './item-ledger';
import { discoveryFindEmber } from './ledger';

// game_config['discovery'] - flat numeric keys, matching getGameConfig's shape.
export interface DiscoveryConfig {
    weight_ember: number;
    weight_food: number;
    // OPTIONAL on purpose, and always read as `?? 0`. The memorabilia category arrives
    // in config v3 (add_discovery_config_v3.sql), which is flipped active AFTER this
    // code deploys - so during the deploy window the running code reads a v2 config
    // that has no such key. The coalesce is what makes that window inert: weight 0 ->
    // category never selected -> discovery behaves exactly as it did before. Without
    // it the roll's arithmetic sums an undefined, every band comparison against NaN is
    // false, and the whole feature collapses into one arbitrary category.
    weight_memorabilia?: number;
    weight_collectible: number;
    short_cooldown_minutes_min: number;
    short_cooldown_minutes_max: number;
    long_cooldown_minutes_min: number;
    long_cooldown_minutes_max: number;
    sustained_hours: number;
    food_weight_price_exponent: number;
    min_new_places: number;
}

// The pet row as toolbar-state reads it: the feed/hatch shape plus the discovery clock
// and the footprints since the last find.
export interface DiscoveryPetRow extends PetRow {
    next_eligible_roll_at: string | null;
    places_since_find: string[];
}

// Hard ceiling on places_since_find so a pet row can't grow without bound between
// finds (a tour of every article would otherwise keep appending). Enforced in the
// write's WHERE, mirrored in JS to skip the round-trip.
const MAX_FOOTPRINTS = 64;

// A place the pet can be taken to. `check` names the existence predicate the footprint
// write must pass before the key counts: article slugs and ticker keys come from the
// URL, so they're verified against tank_pages / tickers inside the UPDATE (no extra
// round-trip, and only when the place is new) - a made-up slug never satisfies the gate.
export interface Place {
    key: string;
    check: 'none' | 'article' | 'tankdaq';
    ref: string;
}

const STATIC_PLACES = new Set([
    'the-tank', 'the-tank-hq', 'the-hatchery', 'champions-terrace',
    'quickboost-delicacies', 'tankdaq', 'account', 'my-portfolio',
]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const TICKER_RE = /^[a-z0-9-]{1,40}$/;

// Pure: a raw pathname (the client sends location.pathname verbatim) to a Place, or null
// for anything outside the allowlist. Never throws. Trailing slash is stripped once (the
// static site serves /the-tank/ and /the-tank/articles/<slug>/ as directories), case is
// folded, and everything else - extra segments, dot segments, legacy routes, login pages
// - is simply not a place.
export function placeFromPath(raw: string | null): Place | null {
    if (!raw || raw.length > 200 || raw[0] !== '/') return null;
    let p = raw.toLowerCase();
    if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
    if (p === '/') return { key: 'home', check: 'none', ref: '' };
    const segs = p.slice(1).split('/');
    if (segs.length === 1 && STATIC_PLACES.has(segs[0])) return { key: segs[0], check: 'none', ref: '' };
    if (segs.length === 3 && segs[0] === 'the-tank' && segs[1] === 'articles' && SLUG_RE.test(segs[2])) {
        return { key: `article:${segs[2]}`, check: 'article', ref: segs[2] };
    }
    if (segs.length === 2 && segs[0] === 'tankdaq') {
        if (segs[1] === 'indexes') return { key: 'tankdaq:indexes', check: 'none', ref: '' };
        if (TICKER_RE.test(segs[1])) return { key: `tankdaq:${segs[1]}`, check: 'tankdaq', ref: segs[1] };
    }
    return null;
}

export type DiscoveryOutcome =
    | { kind: 'no_pet' }
    | { kind: 'not_due' }
    | { kind: 'initialized' }
    // Due, but the pet hasn't been taken to enough new places since its last find.
    | { kind: 'not_explored'; places: number; needed: number }
    | { kind: 'lost_race' }
    | { kind: 'found_ember'; amount: number }
    | { kind: 'found_food'; catalogKey: string; name: string }
    | { kind: 'found_memorabilia'; catalogKey: string; name: string }
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

interface MemorabiliaSkuRow {
    key: string;
    name: string;
    // Relative pick weight WITHIN the category. Explicit (not derived from a price)
    // because memorabilia is never sold - there's no amount to invert.
    weight: number;
    // Subpath under /assets/images/, straight from the catalog - same contract as a
    // collectible's cover_image, so the notification carries a ready-to-render path
    // and no renderer has to know how memorabilia art is named.
    image: string | null;
}

interface CollectibleSkuRow {
    key: string;
    name: string;
    cover_image: string | null;
    mint_size: number;
}

// The whole side effect, including its own preconditions - callers just pass whatever
// pet row they have (or null) and never need to know the feature's rules.
export async function maybeDiscover(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string; pet: DiscoveryPetRow | null; feedingCfg: FeedingConfig; placePath: string | null }
): Promise<DiscoveryOutcome> {
    const { userId, pet, feedingCfg, placePath } = input;

    // Hard precondition: a petless account triggers NOTHING in this system - no
    // cooldown read, no reward logic, no error. Checked first, before any query.
    if (!pet) return { kind: 'no_pet' };

    // Footprint: record the place this call came from, if it's new for the pet. Runs
    // before the due check on purpose - footprints have to accumulate WHILE the clock
    // runs, or nobody could ever satisfy the gate. The WHERE re-checks membership and
    // the cap against the committed row, so two simultaneous loads of the same new
    // place append it once (the loser matches zero rows), and the CASE folds the
    // article/ticker existence check into the same statement. Zero rows back means
    // either an invalid ref or a lost same-place race; both keep the array we already
    // have (at worst one page-load stale - the claim UPDATE's own cardinality qual is
    // what's authoritative). Explicit ::text casts throughout: the Neon HTTP driver
    // binds params untyped, and array_append / = ANY are ambiguous without them.
    let places = pet.places_since_find;
    const place = placeFromPath(placePath);
    if (place && !places.includes(place.key) && places.length < MAX_FOOTPRINTS) {
        const rows = await sql`
            UPDATE pets
            SET places_since_find = array_append(places_since_find, ${place.key}::text)
            WHERE id = ${pet.id} AND user_id = ${userId}
              AND NOT (${place.key}::text = ANY(places_since_find))
              AND cardinality(places_since_find) < ${MAX_FOOTPRINTS}::int
              AND CASE ${place.check}::text
                    WHEN 'article' THEN EXISTS (
                        SELECT 1 FROM tank_pages
                        WHERE slug = ${place.ref}::text AND status = 'published' AND visibility = 'app')
                    WHEN 'tankdaq' THEN EXISTS (
                        SELECT 1 FROM tickers WHERE key = ${place.ref}::text AND active)
                    ELSE true END
            RETURNING places_since_find
        `;
        if (rows.length) places = (rows[0] as unknown as { places_since_find: string[] }).places_since_find;
    }

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

    // Due, but not explored: the footprints gate. Read after the config (the threshold
    // lives there) and before any roll, so an unexplored pet costs nothing past the
    // config read. The claim UPDATE below re-checks the same qual atomically.
    const minPlaces = cfg.min_new_places;
    if (places.length < minPlaces) return { kind: 'not_explored', places: places.length, needed: minPlaces };

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
        SELECT c.key, c.name, c.config->>'cover_image' AS cover_image, p.mint_size
        FROM items_catalog c
        JOIN collectible_pools p ON p.catalog_key = c.key
        WHERE c.item_type = 'collectible' AND c.active = true
          AND (c.config->>'discovery_droppable')::boolean IS TRUE
          AND (c.available_from IS NULL OR c.available_from <= NOW())
          AND (c.available_until IS NULL OR c.available_until > NOW())
          AND p.minted_count < p.mint_size
    `) as unknown as CollectibleSkuRow[];

    // Droppable memorabilia (add_memorabilia_items.sql). Same droppable gate and the
    // same zero-if-empty treatment as collectibles - no pool to check, because these
    // stack and have no mint cap, so the only way the category empties is an operator
    // deactivating every SKU.
    //
    // discovery_weight > 0 is excluded HERE, in the query, and that placement is the
    // point: weight 0 means "catalogued, art shipped, not obtainable yet" (the
    // whitelist passes), and it has to be an exact off, not a very small chance. The
    // weighted walk below falls back to its last row when the accumulator doesn't go
    // negative - which floating-point summation permits - so a 0-weight SKU left in
    // the list could be picked, rarely and unrepeatably. Filtering first makes that
    // unreachable instead of unlikely. Turning one on is a weight change, no deploy.
    const memorabiliaSkus = (await sql`
        SELECT c.key, c.name,
               COALESCE((c.config->>'discovery_weight')::int, 1) AS weight,
               c.config->>'image' AS image
        FROM items_catalog c
        WHERE c.item_type = 'memorabilia' AND c.active = true
          AND (c.config->>'discovery_droppable')::boolean IS TRUE
          AND COALESCE((c.config->>'discovery_weight')::int, 1) > 0
          AND (c.available_from IS NULL OR c.available_from <= NOW())
          AND (c.available_until IS NULL OR c.available_until > NOW())
    `) as unknown as MemorabiliaSkuRow[];

    // The category bands, in order. Written as a cumulative walk rather than chained
    // comparisons because there are four of them now: a zero weight (no eligible SKU,
    // or a config version that predates the category) simply owns no interval and can
    // never be selected, and the remaining weights renormalize on their own - which is
    // what has always kept a missing category from failing the roll.
    const weightEmber = cfg.weight_ember;
    const weightFood = cfg.weight_food;
    const weightMemorabilia = memorabiliaSkus.length > 0 ? (cfg.weight_memorabilia ?? 0) : 0;
    const weightCollectible = collectibleSkus.length > 0 ? cfg.weight_collectible : 0;
    const bands: Array<['ember' | 'food' | 'memorabilia' | 'collectible', number]> = [
        ['ember', weightEmber],
        ['food', weightFood],
        ['memorabilia', weightMemorabilia],
        ['collectible', weightCollectible],
    ];
    const totalWeight = bands.reduce((sum, [, w]) => sum + w, 0);
    let bandRoll = Math.random() * totalWeight;
    // Ember is the fallback if every weight is 0 (a misconfigured catalog) - it's the
    // one branch that needs no SKU to exist.
    let category: 'ember' | 'food' | 'memorabilia' | 'collectible' = 'ember';
    for (const [name, weight] of bands) {
        if (weight <= 0) continue;
        bandRoll -= weight;
        if (bandRoll < 0) {
            category = name;
            break;
        }
    }

    if (category === 'collectible') {
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
                UPDATE pets
                SET next_eligible_roll_at = NOW() + (${cooldownMinutes}::float8 * INTERVAL '1 minute'),
                    places_since_find = '{}'
                WHERE id = ${pet.id} AND user_id = ${userId}
                  AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
                  AND cardinality(places_since_find) >= ${minPlaces}::int
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
                RETURNING id, serial_number
            ), itm AS (
                -- The item journal (create_item_ledger_tables.sql). The item type is in the
                -- key's scope, not the reason: all three branches share one roll window, so
                -- without it a future two-item window would silently drop one of them. The
                -- pool-exhausted path needs no special case: an empty minted means an empty
                -- granted means this writes nothing, which is correct - the window is
                -- consumed and nothing was granted.
                -- (No backticks in these comments: they terminate the enclosing template.)
                INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                         inventory_item_id, serial_number, idempotency_key, metadata)
                SELECT ${userId}::uuid, ${picked.key}::text, 'collectible', 1, 'discovery_find', 'source',
                       g.id, g.serial_number,
                       ${itemIdempotencyKey('discovery_find', userId, `${pet.id}:${windowScope}:collectible`)}::text,
                       ${JSON.stringify({ petId: pet.id, window: windowScope })}::jsonb
                FROM granted g
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            ), note AS (
                INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood, art)
                SELECT ${userId}, 'claimable', ${msgPre} || m.serial::text || ${msgPost}, 'pet', ${pet.id}::text, ${notificationKey}, 'happy', ${picked.cover_image}
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

    if (category === 'memorabilia') {
        // Weighted pick within the category, same cumulative walk the food branch uses
        // below - just reading an explicit config weight instead of inverting a price,
        // because memorabilia is never sold and has no price to invert.
        const weights = memorabiliaSkus.map((r) => r.weight);
        let pickRoll = Math.random() * weights.reduce((a, b) => a + b, 0);
        let picked = memorabiliaSkus[memorabiliaSkus.length - 1];
        for (let i = 0; i < memorabiliaSkus.length; i++) {
            pickRoll -= weights[i];
            if (pickRoll < 0) {
                picked = memorabiliaSkus[i];
                break;
            }
        }
        const message = `Look what I dragged back — a ${picked.name}! No idea whose it was. It's ours now.`;
        const notificationKey = `discovery:${pet.id}:${windowScope}`;
        // The food branch's statement shape exactly, NOT the collectible one: these
        // stack, so there's no pool to decrement and no serial to allocate. The claim
        // UPDATE is still the race guard and still resets the footprints, and the
        // consumed window is still the idempotency for the quantity bump.
        //
        // The `WHERE item_type = 'memorabilia'` on the conflict target is MANDATORY,
        // not decorative: inventory_items now carries two partial unique indexes over
        // (user_id, catalog_key) - one for food, one for memorabilia - and a bare
        // ON CONFLICT (user_id, catalog_key) cannot pick an arbiter between them.
        const rows = await sql`
            WITH claimed AS (
                UPDATE pets
                SET next_eligible_roll_at = NOW() + (${cooldownMinutes}::float8 * INTERVAL '1 minute'),
                    places_since_find = '{}'
                WHERE id = ${pet.id} AND user_id = ${userId}
                  AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
                  AND cardinality(places_since_find) >= ${minPlaces}::int
                RETURNING id
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                SELECT ${userId}, ${picked.key}, 'memorabilia', 1
                FROM claimed
                ON CONFLICT (user_id, catalog_key) WHERE item_type = 'memorabilia'
                    DO UPDATE SET quantity = inventory_items.quantity + 1
                RETURNING id
            ), itm AS (
                -- The item journal - see the collectible branch for why the item type is in
                -- the key's scope. The upsert's DO UPDATE branch returns the row id (a
                -- DO NOTHING would not), so g.id is always present when this leg fires.
                INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                         inventory_item_id, idempotency_key, metadata)
                SELECT ${userId}::uuid, ${picked.key}::text, 'memorabilia', 1, 'discovery_find', 'source',
                       g.id,
                       ${itemIdempotencyKey('discovery_find', userId, `${pet.id}:${windowScope}:memorabilia`)}::text,
                       ${JSON.stringify({ petId: pet.id, window: windowScope })}::jsonb
                FROM granted g
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            ), note AS (
                INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood, art)
                SELECT ${userId}, 'claimable', ${message}, 'pet', ${pet.id}::text, ${notificationKey}, 'happy', ${picked.image}
                FROM claimed
                ON CONFLICT (idempotency_key) DO NOTHING
            )
            SELECT EXISTS (SELECT 1 FROM claimed) AS claimed
        `;
        const claimed = Boolean((rows[0] as unknown as { claimed: boolean }).claimed);
        return claimed ? { kind: 'found_memorabilia', catalogKey: picked.key, name: picked.name } : { kind: 'lost_race' };
    }

    if (category === 'food') {
        // The DROPPABLE food SKUs, weighted toward cheap: weight = (1/price)^exponent,
        // so the pool re-weights itself as SKUs come, go, or get repriced - no per-SKU
        // map to maintain.
        //
        // discovery_droppable is what splits the drop pool from the shop menu
        // (add_discovery_foods.sql). The shop foods are flagged false, so a find never
        // hands you something you could have bought two clicks away; the seven
        // vendorless concession foods are flagged true and are the whole pool. For
        // those, `price` is not a shelf price at all - nothing sells them - it is
        // purely the rarity dial this weighting reads.
        const foodRows = (await sql`
            SELECT c.key, c.name, (r.config->>'amount')::int AS price
            FROM items_catalog c
            JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
            WHERE c.active = true AND c.item_type = 'food'
              AND (c.config->>'discovery_droppable')::boolean IS TRUE
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
            // the notification key is the deduped backstop. The footprints qual and
            // reset ride in the same UPDATE, so time and exploration are one gate.
            const rows = await sql`
                WITH claimed AS (
                    UPDATE pets
                    SET next_eligible_roll_at = NOW() + (${cooldownMinutes}::float8 * INTERVAL '1 minute'),
                        places_since_find = '{}'
                    WHERE id = ${pet.id} AND user_id = ${userId}
                      AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
                      AND cardinality(places_since_find) >= ${minPlaces}::int
                    RETURNING id
                ), granted AS (
                    INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                    SELECT ${userId}, ${picked.key}, 'food', 1
                    FROM claimed
                    ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                        DO UPDATE SET quantity = inventory_items.quantity + 1
                    RETURNING id
                ), itm AS (
                    -- The item journal - see the collectible branch for why the item type
                    -- is in the key's scope rather than the reason.
                    INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                             inventory_item_id, idempotency_key, metadata)
                    SELECT ${userId}::uuid, ${picked.key}::text, 'food', 1, 'discovery_find', 'source',
                           g.id,
                           ${itemIdempotencyKey('discovery_find', userId, `${pet.id}:${windowScope}:food`)}::text,
                           ${JSON.stringify({ petId: pet.id, window: windowScope })}::jsonb
                    FROM granted g
                    ON CONFLICT (idempotency_key) DO NOTHING
                    RETURNING 1
                ), note AS (
                    INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood, art)
                    SELECT ${userId}, 'claimable', ${message}, 'pet', ${pet.id}::text, ${notificationKey}, 'happy', ${`food/${picked.key}.png`}
                    FROM claimed
                    ON CONFLICT (idempotency_key) DO NOTHING
                )
                SELECT EXISTS (SELECT 1 FROM claimed) AS claimed
            `;
            const claimed = Boolean((rows[0] as unknown as { claimed: boolean }).claimed);
            return claimed ? { kind: 'found_food', catalogKey: picked.key, name: picked.name } : { kind: 'lost_race' };
        }
        // No droppable food exists at all (every SKU deactivated or un-flagged) -
        // fall through to ember rather than fail the roll.
    }

    const result = await discoveryFindEmber(sql, {
        userId,
        petId: pet.id,
        cooldownMinutes,
        minPlaces,
        windowScope,
        buildMessage: (amount) =>
            `I was poking around while you were gone and dug up ${amount} Ember! Snuck it straight into the stash.`,
        // The one sentinel value of notifications.art: there is no Ember image, so the
        // widget answers it with the $$$ flourish over the pet's head instead of an
        // <img> in the bubble. Passed from here rather than baked into
        // discoveryFindEmber() - that function is a generic ledger primitive, and the
        // presentation choice belongs to the caller that knows this was a pet find.
        art: 'ember',
    });
    return result.claimed ? { kind: 'found_ember', amount: result.amount } : { kind: 'lost_race' };
}
