// Acceptance suite for the Pets economy: buying eggs/food (functions/api/shop/buy.ts,
// lib/pages-functions/ledger.ts's purchaseConsumable()), hatching (functions/api/pets/
// hatch.ts, lib/pages-functions/pets.ts's hatch()), feeding (functions/api/pets/feed.ts,
// pets.ts's feed()), and naming (functions/api/pets/name.ts).
//
// Real catalog SKUs are looked up live (cheapestActiveSku/secondActiveSku in
// fixtures.ts) rather than hardcoded, so prices/points always come from whatever the
// active catalog actually is. An earlier version of this suite hardcoded 'egg_slate'/
// 'food_basic'/'food_premium' - those are all `active=false` in the current catalog,
// which made every check in this file fail with "That item is not available." The
// catalog is retuned independently of this harness, so hardcoding a key is exactly the
// kind of thing that silently breaks the moment someone deactivates a SKU.
// Two throwaway items_catalog rows (inactive / expired-window) are hand-inserted only
// for the 404-unavailable-SKU cases and deleted immediately after, mirroring
// suites/discovery.ts's "Exhaustion" section.

import { pool, api, check, section, type Suite } from '../harness';
import { createSessionUser, cleanupUsersByEmailPrefix, cheapestActiveSku, secondActiveSku } from '../fixtures';

const EMAIL_PREFIX = 'acceptance-pets-';

let EGG_KEY: string;
let EGG_PRICE: number;
let FOOD_BASIC_KEY: string;
let FOOD_BASIC_PRICE: number;
let FOOD_BASIC_POINTS: number;
let FOOD_PREMIUM_KEY: string;
let FOOD_PREMIUM_PRICE: number;
let FOOD_PREMIUM_POINTS: number;

async function resolveLiveSkus(): Promise<void> {
    const egg = await cheapestActiveSku('egg');
    EGG_KEY = egg.catalogKey;
    EGG_PRICE = egg.price;

    const foodA = await cheapestActiveSku('food');
    FOOD_BASIC_KEY = foodA.catalogKey;
    FOOD_BASIC_PRICE = foodA.price;
    FOOD_BASIC_POINTS = Number(foodA.config?.satisfaction_points ?? NaN);

    const foodB = await secondActiveSku('food', FOOD_BASIC_KEY);
    FOOD_PREMIUM_KEY = foodB.catalogKey;
    FOOD_PREMIUM_PRICE = foodB.price;
    FOOD_PREMIUM_POINTS = Number(foodB.config?.satisfaction_points ?? NaN);

    console.log(`  [pets] Live SKUs: egg=${EGG_KEY}(${EGG_PRICE}), food1=${FOOD_BASIC_KEY}(${FOOD_BASIC_PRICE}, +${FOOD_BASIC_POINTS}pts), food2=${FOOD_PREMIUM_KEY}(${FOOD_PREMIUM_PRICE}, +${FOOD_PREMIUM_POINTS}pts)`);
}

// ---------------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------------

function user(tag: string): string {
    return `${EMAIL_PREFIX}${tag}@example.com`;
}

// Hand-grants Ember exactly the way lib/pages-functions/ledger.ts's post() does: one
// ember_ledger row (FK'd to an already-active, already-seeded ember_rules row so we
// don't need to insert our own rule) whose amount folds into ember_balances in the same
// statement. Never writes ember_balances without a corresponding ember_ledger row.
async function seedBalance(userId: string, amount: number): Promise<void> {
    const idempotencyKey = `acceptance-pets-seed:${userId}:${crypto.randomUUID()}`;
    await pool.query(
        `WITH ins AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            VALUES ($1, $2, 'adjustment', 'participation', 1, $3, '{"acceptance":"pets fixture seed"}')
            RETURNING amount
        )
        INSERT INTO ember_balances (user_id, balance, updated_at)
        SELECT $1, amount, NOW() FROM ins
        ON CONFLICT (user_id) DO UPDATE SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
        [userId, amount, idempotencyKey],
    );
}

async function currentBalance(userId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length ? Number(rows[0].balance) : 0;
}

function buy(cookie: string, catalogKey: string) {
    return api('POST', '/api/shop/buy', { cookie, body: { catalogKey, purchaseToken: crypto.randomUUID() } });
}

function hatchReq(cookie: string, inventoryItemId: string) {
    return api('POST', '/api/pets/hatch', { cookie, body: { inventoryItemId } });
}

function feedReq(cookie: string, foodCatalogKey: string) {
    return api('POST', '/api/pets/feed', { cookie, body: { foodCatalogKey, feedToken: crypto.randomUUID() } });
}

function nameReq(cookie: string, name: string) {
    return api('POST', '/api/pets/name', { cookie, body: { name } });
}

async function eggInventoryCount(userId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND item_type = 'egg'`,
        [userId],
    );
    return rows[0].n;
}

async function foodQuantity(userId: string, catalogKey: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'food'`,
        [userId, catalogKey],
    );
    return rows.length ? Number(rows[0].quantity) : 0;
}

async function foodRowCount(userId: string, catalogKey: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'food'`,
        [userId, catalogKey],
    );
    return rows[0].n;
}

// Full buy-egg -> hatch round trip for suite sections that just need a pet to exist.
async function hatchPetForUser(cookie: string, userId: string): Promise<string> {
    await seedBalance(userId, EGG_PRICE);
    const bought = await buy(cookie, EGG_KEY);
    const inventoryItemId = bought.json?.item?.inventoryItemId as string;
    const hatched = await hatchReq(cookie, inventoryItemId);
    return hatched.json?.pet?.id as string;
}

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
}

async function run() {
    await cleanup();
    await resolveLiveSkus();

    // ===============================================================================
    section('Buy egg - price debit, exactly one row, insufficient balance, unavailable SKU');
    // ===============================================================================
    {
        const buyer = await createSessionUser(user('buy-egg-ok'));
        await seedBalance(buyer.userId, EGG_PRICE);
        const res = await buy(buyer.cookie, EGG_KEY);
        check('buy egg -> 200', res.status === 200, JSON.stringify(res.json));
        check('response carries a granted inventoryItemId', typeof res.json?.item?.inventoryItemId === 'string');
        const balanceAfter = await currentBalance(buyer.userId);
        check('balance debited by exactly the egg price', balanceAfter === 0, `got ${balanceAfter}`);
        const eggRows = await eggInventoryCount(buyer.userId);
        check('exactly one egg row in inventory_items', eggRows === 1, `got ${eggRows}`);

        const poor = await createSessionUser(user('buy-egg-poor'));
        await seedBalance(poor.userId, EGG_PRICE - 1);
        const poorRes = await buy(poor.cookie, EGG_KEY);
        check('insufficient balance -> 402', poorRes.status === 402, JSON.stringify(poorRes.json));
        const poorBalanceAfter = await currentBalance(poor.userId);
        check('402 debited nothing', poorBalanceAfter === EGG_PRICE - 1, `got ${poorBalanceAfter}`);
        const poorEggRows = await eggInventoryCount(poor.userId);
        check('402 granted nothing', poorEggRows === 0);

        const shopper = await createSessionUser(user('buy-egg-unavailable'));
        await seedBalance(shopper.userId, 500);

        await pool.query(
            `INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, active)
             VALUES ('acceptance_pets_inactive_egg', 'egg', 'Acceptance Inactive Egg', 'spend_egg_standard', '{}', false)
             ON CONFLICT (key) DO NOTHING`,
        );
        const inactiveRes = await buy(shopper.cookie, 'acceptance_pets_inactive_egg');
        check('inactive SKU -> 404', inactiveRes.status === 404, JSON.stringify(inactiveRes.json));
        await pool.query(`DELETE FROM items_catalog WHERE key = 'acceptance_pets_inactive_egg'`);

        await pool.query(
            `INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, active, available_until)
             VALUES ('acceptance_pets_expired_egg', 'egg', 'Acceptance Expired Egg', 'spend_egg_standard', '{}', true, NOW() - INTERVAL '1 day')
             ON CONFLICT (key) DO NOTHING`,
        );
        const expiredRes = await buy(shopper.cookie, 'acceptance_pets_expired_egg');
        check('expired available_until window -> 404', expiredRes.status === 404, JSON.stringify(expiredRes.json));
        await pool.query(`DELETE FROM items_catalog WHERE key = 'acceptance_pets_expired_egg'`);

        const shopperBalanceAfter = await currentBalance(shopper.userId);
        check('unavailable-SKU attempts charged nothing', shopperBalanceAfter === 500, `got ${shopperBalanceAfter}`);
    }

    // ===============================================================================
    section('Buy food - quantity upsert on repeat purchase (idx_inventory_user_food)');
    // ===============================================================================
    {
        const buyer = await createSessionUser(user('buy-food'));
        await seedBalance(buyer.userId, 100);
        const first = await buy(buyer.cookie, FOOD_BASIC_KEY);
        check('first food purchase -> 200, quantity 1', first.status === 200 && first.json?.item?.quantity === 1, JSON.stringify(first.json));
        const second = await buy(buyer.cookie, FOOD_BASIC_KEY);
        check('second food purchase -> 200, quantity 2 (upsert, not a new row)', second.status === 200 && second.json?.item?.quantity === 2, JSON.stringify(second.json));
        const rowCount = await foodRowCount(buyer.userId, FOOD_BASIC_KEY);
        check('still exactly one inventory row for that food SKU', rowCount === 1, `got ${rowCount}`);
        const balanceAfter = await currentBalance(buyer.userId);
        check('balance debited by exactly two unit prices', balanceAfter === 100 - 2 * FOOD_BASIC_PRICE, `got ${balanceAfter}`);
    }

    // ===============================================================================
    section('Hatch - one pet per account ever (idx_pets_one_captain), egg ownership');
    // ===============================================================================
    {
        const hatcher = await createSessionUser(user('hatch-main'));
        await seedBalance(hatcher.userId, 2 * EGG_PRICE);

        const egg1 = await buy(hatcher.cookie, EGG_KEY);
        const eggId1 = egg1.json?.item?.inventoryItemId as string;
        const hatch1 = await hatchReq(hatcher.cookie, eggId1);
        check('first hatch -> 201, created:true', hatch1.status === 201 && hatch1.json?.created === true, JSON.stringify(hatch1.json));
        check('hatched pet has an id and no numeric satisfaction field', typeof hatch1.json?.pet?.id === 'string' && !('satisfaction' in (hatch1.json?.pet ?? {})) && !('satisfaction_at_last_feed' in (hatch1.json?.pet ?? {})));
        const { rows: eggGoneRows } = await pool.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [eggId1]);
        check('consumed egg row is gone', eggGoneRows.length === 0);
        const { rows: petRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1 AND is_captain = true`, [hatcher.userId]);
        check('exactly one captain pet exists', petRows[0].n === 1, `got ${petRows[0].n}`);

        // Second owned egg, same account that already has a pet: one-pet-per-account
        // (idx_pets_one_captain) - hatch.ts's early-return path, NOT an error status.
        const egg2 = await buy(hatcher.cookie, EGG_KEY);
        const eggId2 = egg2.json?.item?.inventoryItemId as string;
        const hatch2 = await hatchReq(hatcher.cookie, eggId2);
        check('second hatch with a different owned egg -> 200, created:false (existing pet returned, not an error)',
            hatch2.status === 200 && hatch2.json?.created === false, JSON.stringify(hatch2.json));
        check('the returned pet is the same pet as the first hatch', hatch2.json?.pet?.id === hatch1.json?.pet?.id);
        const { rows: egg2Rows } = await pool.query(`SELECT 1 FROM inventory_items WHERE id = $1 AND item_type = 'egg'`, [eggId2]);
        check('the second egg was left untouched (not consumed)', egg2Rows.length === 1);

        // Nonexistent egg id, and someone else's egg id, both against an account with no pet.
        const eggOwner = await createSessionUser(user('hatch-egg-owner'));
        await seedBalance(eggOwner.userId, EGG_PRICE);
        const ownerEgg = await buy(eggOwner.cookie, EGG_KEY);
        const ownerEggId = ownerEgg.json?.item?.inventoryItemId as string;

        const petless = await createSessionUser(user('hatch-petless'));
        const bogusRes = await hatchReq(petless.cookie, crypto.randomUUID());
        check('hatch with a nonexistent egg id -> 404', bogusRes.status === 404, JSON.stringify(bogusRes.json));
        const othersRes = await hatchReq(petless.cookie, ownerEggId);
        check("hatch with someone else's egg id -> 404", othersRes.status === 404, JSON.stringify(othersRes.json));
        const { rows: petlessPetRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1`, [petless.userId]);
        check('the petless account still has no pet', petlessPetRows[0].n === 0);
    }

    // ===============================================================================
    section('Feed - satisfaction rise, clamp to max, reject at max, never a numeric leak');
    // ===============================================================================
    {
        const feeder = await createSessionUser(user('feed-main'));
        const petId = await hatchPetForUser(feeder.cookie, feeder.userId);
        check('feeder has a hatched pet', typeof petId === 'string' && petId.length > 0);

        await seedBalance(feeder.userId, FOOD_BASIC_PRICE + FOOD_PREMIUM_PRICE + FOOD_BASIC_PRICE);
        await buy(feeder.cookie, FOOD_BASIC_KEY);
        await buy(feeder.cookie, FOOD_PREMIUM_KEY);

        // Force a known low (hungry) satisfaction directly, bypassing decay math.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 20, last_fed_at = NOW() WHERE id = $1`, [petId]);
        const feed1 = await feedReq(feeder.cookie, FOOD_BASIC_KEY);
        check('feed hungry pet with basic food -> 200', feed1.status === 200, JSON.stringify(feed1.json));
        check("response never carries a numeric satisfaction field, only 'state'",
            typeof feed1.json?.pet?.state === 'string' && !('satisfaction' in (feed1.json?.pet ?? {})) && !JSON.stringify(feed1.json?.pet ?? {}).toLowerCase().includes('satisfaction'));
        check(`20 + food_basic's ${FOOD_BASIC_POINTS} points >= hungry_threshold -> state 'satisfied'`, feed1.json?.pet?.state === 'satisfied', JSON.stringify(feed1.json?.pet));
        const { rows: afterFeed1 } = await pool.query(`SELECT satisfaction_at_last_feed::float8 AS s, last_feed_token FROM pets WHERE id = $1`, [petId]);
        const expectedAfterFeed1 = 20 + FOOD_BASIC_POINTS;
        check(`satisfaction rose by exactly the food SKU's satisfaction_points (20 -> ${expectedAfterFeed1})`, Math.abs(afterFeed1[0].s - expectedAfterFeed1) < 0.5, `got ${afterFeed1[0].s}`);
        check('last_feed_token stamped with this request\'s feedToken', typeof afterFeed1[0].last_feed_token === 'string' && afterFeed1[0].last_feed_token.length > 0);
        const basicQtyAfter = await foodQuantity(feeder.userId, FOOD_BASIC_KEY);
        check('basic food quantity decremented by 1 (1 -> 0)', basicQtyAfter === 0, `got ${basicQtyAfter}`);

        // Second feed with the premium food must clamp to max_satisfaction (100). Force
        // satisfaction to just below max first (rather than relying on the two live
        // foods' organic point totals to overshoot 100, which isn't guaranteed - the
        // catalog's "second cheapest" food may not carry enough points on its own) so
        // ANY positive-point food SKU reliably exercises the clamp path.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 95, last_fed_at = NOW() WHERE id = $1`, [petId]);
        const feed2 = await feedReq(feeder.cookie, FOOD_PREMIUM_KEY);
        check('feed with premium food -> 200', feed2.status === 200, JSON.stringify(feed2.json));
        const { rows: afterFeed2 } = await pool.query(`SELECT satisfaction_at_last_feed::float8 AS s FROM pets WHERE id = $1`, [petId]);
        const uncappedTotal = 95 + FOOD_PREMIUM_POINTS;
        check(`satisfaction clamped to max_satisfaction (100), not ${uncappedTotal}`, Math.abs(afterFeed2[0].s - 100) < 0.5, `got ${afterFeed2[0].s}`);
        const premiumQtyAfter = await foodQuantity(feeder.userId, FOOD_PREMIUM_KEY);
        check('premium food quantity decremented by 1 (1 -> 0)', premiumQtyAfter === 0, `got ${premiumQtyAfter}`);

        // Third feed: pet is now at (rounded) max - must be rejected before any write.
        await buy(feeder.cookie, FOOD_BASIC_KEY); // own a spare unit so we can prove it's untouched
        const spareQtyBefore = await foodQuantity(feeder.userId, FOOD_BASIC_KEY);
        const feed3 = await feedReq(feeder.cookie, FOOD_BASIC_KEY);
        check('feed at satisfaction already at max -> rejected (409, full:true)', feed3.status === 409 && feed3.json?.full === true, JSON.stringify(feed3.json));
        const spareQtyAfter = await foodQuantity(feeder.userId, FOOD_BASIC_KEY);
        check('rejected feed consumed no food', spareQtyAfter === spareQtyBefore, `before ${spareQtyBefore}, after ${spareQtyAfter}`);
        const { rows: afterFeed3 } = await pool.query(`SELECT satisfaction_at_last_feed::float8 AS s FROM pets WHERE id = $1`, [petId]);
        check('rejected feed did not change satisfaction', Math.abs(afterFeed3[0].s - 100) < 0.5, `got ${afterFeed3[0].s}`);
    }

    // ===============================================================================
    section('Name - one-time naming, global case-insensitive uniqueness, charset validation');
    // ===============================================================================
    {
        const namer1 = await createSessionUser(user('name-1'));
        await hatchPetForUser(namer1.cookie, namer1.userId);
        const nameOk = await nameReq(namer1.cookie, 'Zephyrus');
        check('valid name -> 200', nameOk.status === 200 && nameOk.json?.pet?.name === 'Zephyrus', JSON.stringify(nameOk.json));

        const namer2 = await createSessionUser(user('name-2'));
        await hatchPetForUser(namer2.cookie, namer2.userId);
        const nameTaken = await nameReq(namer2.cookie, 'zephyrus'); // case-insensitive collision
        check('name already taken by another pet -> 409', nameTaken.status === 409 && nameTaken.json?.taken === true, JSON.stringify(nameTaken.json));

        // Collides with an account USERNAME, not another pet's name.
        await createSessionUser(user('name-username-owner'), { username: 'Sparkletail' });
        const namer3 = await createSessionUser(user('name-3'));
        await hatchPetForUser(namer3.cookie, namer3.userId);
        const usernameCollision = await nameReq(namer3.cookie, 'sparkletail');
        check('name colliding with another account\'s username -> 409', usernameCollision.status === 409 && usernameCollision.json?.taken === true, JSON.stringify(usernameCollision.json));

        const namer4 = await createSessionUser(user('name-invalid'));
        await hatchPetForUser(namer4.cookie, namer4.userId);
        const scriptRes = await nameReq(namer4.cookie, '<script>');
        check('name with disallowed charset (<script>) -> 400', scriptRes.status === 400, JSON.stringify(scriptRes.json));
        const emojiRes = await nameReq(namer4.cookie, '😀pet');
        check('name with emoji -> 400', emojiRes.status === 400, JSON.stringify(emojiRes.json));
        const emptyRes = await nameReq(namer4.cookie, '');
        check('empty name -> 400', emptyRes.status === 400, JSON.stringify(emptyRes.json));
        const { rows: stillUnnamed } = await pool.query(`SELECT name FROM pets WHERE user_id = $1`, [namer4.userId]);
        check('invalid attempts never consumed the one-time naming', stillUnnamed[0]?.name === null);
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'pets',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
