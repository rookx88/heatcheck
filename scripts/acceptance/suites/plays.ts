// Acceptance suite for Plays - delivery hand-overs (encounters/deliver.ts), the find
// guarantee (plays.ts forcedFind + discovery.ts), and My Playbook (GET /api/plays),
// driven through the real endpoints against the dev server.
//
// Every fixture account parks the registry's encounters as already seen, so a scene
// firing mid-test can never hand over something this suite then counts. The one
// exception is the Charles football arc, which the first section drives for real so the
// registry path - fire, freeze, enrich, hand over, reward - is covered end to end.

import crypto from 'crypto';
import { pool, api, check, warn, section, type Suite } from '../harness';
import { fireParallel, tally, countStatus } from '../concurrency';
import {
    createSessionUser, cleanupUsersByEmailPrefix, flipConfig, restoreConfig,
    seedMemorabilia, memorabiliaHeld, memorabiliaSkus, startPlayDirect, itemTotals, seedFood,
} from '../fixtures';
import { ENCOUNTERS, PLAY_BY_KEY } from '../../../lib/pages-functions/encounters';

const EMAIL_PREFIX = 'acceptance-plays-';
const FOOTBALL = 'memorabilia_worn_football';
// A found-only concession food: droppable, never sold, so a delivery of it is the
// found-food path rather than the buy-it path.
const FOUND_FOOD = 'food_loaded_nachos';

async function foodHeld(userId: string, catalogKey: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COALESCE(SUM(quantity), 0)::int AS n FROM inventory_items
         WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'food'`,
        [userId, catalogKey],
    );
    return Number(rows[0].n);
}

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userId]);
    return rows[0].id as string;
}

// Every registry encounter parked as seen, minus `except`.
async function parkEncounters(userId: string, except: string[] = []): Promise<void> {
    for (const e of ENCOUNTERS) {
        if (except.includes(e.key)) continue;
        await pool.query(
            `INSERT INTO encounters (user_id, encounter_key, character_key, status, seen_at)
             VALUES ($1, $2, $3, 'seen', NOW())
             ON CONFLICT (user_id, encounter_key) DO NOTHING`,
            [userId, e.key, e.character],
        );
    }
}

async function playRow(userId: string, playKey: string) {
    const { rows } = await pool.query(
        `SELECT id, objective, baseline, completed_at FROM plays WHERE user_id = $1 AND play_key = $2`,
        [userId, playKey],
    );
    return rows[0] as { id: string; objective: any; baseline: any; completed_at: string | null } | undefined;
}

async function deliveryRows(userId: string) {
    const { rows } = await pool.query(
        `SELECT catalog_key, delta, metadata FROM item_ledger WHERE user_id = $1 AND reason = 'play_delivery' ORDER BY id`,
        [userId],
    );
    return rows as Array<{ catalog_key: string; delta: number; metadata: any }>;
}

async function assertItemsConsistent(userId: string, label: string): Promise<void> {
    const { mismatches } = await itemTotals(userId);
    check(`${label}: SUM(item_ledger) == inventory held, per SKU`, mismatches.length === 0, JSON.stringify(mismatches));
}

const at = (path: string) => `/api/toolbar-state?place=${encodeURIComponent(path)}`;

// Due, explored, with a known find counter: the discovery suite's rearm, plus find_count.
async function makeDue(petId: string): Promise<void> {
    const { rows } = await pool.query(`SELECT config->>'min_new_places' AS n FROM game_config WHERE key = 'discovery' AND active`);
    const stamped = Array.from({ length: Number(rows[0]?.n ?? 0) }, (_, i) => `stamp:${i}`);
    await pool.query(
        `UPDATE pets SET next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`,
        [petId, stamped],
    );
}

async function run() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    const [skuA, skuB] = await memorabiliaSkus();

    // =================================================================================
    section("Charles's football - the registry path: fire, freeze, hand over at home, reward");
    // =================================================================================
    const charles = await createSessionUser(`${EMAIL_PREFIX}charles@example.com`);
    await insertPet(charles.userId);
    await parkEncounters(charles.userId, ['charles_football', 'charles_football_done']);

    const fire = await api('GET', '/api/toolbar-state', { cookie: charles.cookie });
    check('the errand scene fires once Vic has been seen', fire.json?.encounter?.key === 'charles_football', JSON.stringify(fire.json?.encounter?.key));
    const started = await playRow(charles.userId, 'charles_football');
    check('the Play row exists and is open', Boolean(started) && started!.completed_at === null);
    check('stored objective is frozen with title, home and enriched items', started?.objective?.kind === 'deliver_items'
        && started?.objective?.title === PLAY_BY_KEY.charles_football.title
        && started?.objective?.home === 'the-tank'
        && started?.objective?.items?.[0]?.catalogKey === FOOTBALL
        && started?.objective?.items?.[0]?.count === 1
        && started?.objective?.items?.[0]?.name === 'Worn Football'
        && started?.objective?.items?.[0]?.art === 'memorabilia/worn_football.png', JSON.stringify(started?.objective));
    check('baseline records the find counter', Number(started?.baseline?.finds) === 0, JSON.stringify(started?.baseline));

    const book0 = await api('GET', '/api/plays', { cookie: charles.cookie });
    const cur0 = book0.json?.current?.find((p: any) => p.key === 'charles_football');
    check('Playbook lists it under current with 0/1 and where to go', book0.status === 200
        && cur0?.character === 'charles' && cur0?.kind === 'deliver_items'
        && cur0?.progress?.done === 0 && cur0?.progress?.target === 1 && cur0?.progress?.home === 'the-tank'
        && cur0?.progress?.items?.[0]?.held === 0 && cur0?.receipt === null, JSON.stringify(cur0));
    check('nothing under completed yet', Array.isArray(book0.json?.completed) && book0.json.completed.length === 0);

    // Watch the scene, so the thank-you (which waits on it) can fire.
    await api('POST', '/api/encounters/seen', { cookie: charles.cookie, body: { id: fire.json?.encounter?.id } });

    await api('GET', at('/the-tank/'), { cookie: charles.cookie });
    check('at home holding nothing: Play stays open', (await playRow(charles.userId, 'charles_football'))?.completed_at === null);

    await seedMemorabilia(charles.userId, FOOTBALL, 1);
    const wrong = await api('GET', at('/the-tank-hq/'), { cookie: charles.cookie });
    check('holding it at the WRONG place: nothing taken, Play open',
        wrong.status === 200 && (await memorabiliaHeld(charles.userId, FOOTBALL)) === 1
        && (await playRow(charles.userId, 'charles_football'))?.completed_at === null);
    const book1 = await api('GET', '/api/plays', { cookie: charles.cookie });
    const cur1 = book1.json?.current?.find((p: any) => p.key === 'charles_football');
    check('Playbook shows 1/1 held', cur1?.progress?.done === 1 && cur1?.progress?.items?.[0]?.held === 1, JSON.stringify(cur1?.progress));

    const home = await api('GET', at('/the-tank/'), { cookie: charles.cookie });
    const done = await playRow(charles.userId, 'charles_football');
    check('at home with the item: Play completed', done?.completed_at !== null && done?.completed_at !== undefined);
    check('the football was taken (held 0)', (await memorabiliaHeld(charles.userId, FOOTBALL)) === 0);
    const d1 = await deliveryRows(charles.userId);
    check("exactly one 'play_delivery' journal row, -1, naming the Play",
        d1.length === 1 && d1[0].catalog_key === FOOTBALL && d1[0].delta === -1 && d1[0].metadata?.playId === done?.id, JSON.stringify(d1));
    check('the thank-you scene arrives in the same response', home.json?.encounter?.key === 'charles_football_done', JSON.stringify(home.json?.encounter?.key));
    const { rows: rewardRows } = await pool.query(
        `SELECT grants FROM encounters WHERE user_id = $1 AND encounter_key = 'charles_football_done'`, [charles.userId]);
    check('the reward carries the large Ember gift', Number(rewardRows[0]?.grants?.ember?.amount) === 100, JSON.stringify(rewardRows));
    await assertItemsConsistent(charles.userId, 'after hand-over');

    await seedMemorabilia(charles.userId, FOOTBALL, 1);
    await api('GET', at('/the-tank/'), { cookie: charles.cookie });
    check('replay at home with a new football: nothing taken again',
        (await memorabiliaHeld(charles.userId, FOOTBALL)) === 1 && (await deliveryRows(charles.userId)).length === 1);

    const book2 = await api('GET', '/api/plays', { cookie: charles.cookie });
    const fin = book2.json?.completed?.find((p: any) => p.key === 'charles_football');
    check('Playbook moves it to completed', Boolean(fin) && !book2.json?.current?.some((p: any) => p.key === 'charles_football'));
    check('receipt: gave exactly one Worn Football, with its art',
        fin?.receipt?.gave?.length === 1 && fin.receipt.gave[0].catalogKey === FOOTBALL && fin.receipt.gave[0].count === 1
        && fin.receipt.gave[0].name === 'Worn Football' && fin.receipt.gave[0].art === 'memorabilia/worn_football.png', JSON.stringify(fin?.receipt));
    check('receipt: got the 100 Ember gift, with a completion date',
        Number(fin?.receipt?.got?.ember?.amount) === 100 && typeof fin?.receipt?.completedAt === 'string', JSON.stringify(fin?.receipt));
    const counting = book2.json?.completed?.find((p: any) => p.kind !== 'deliver_items') ?? null;
    check('no counting Play is on this account (all parked)', counting === null);

    // Frozen snapshot: the endpoint reports what is stored, not what the registry says.
    await pool.query(`UPDATE plays SET objective = objective || '{"title": "Mutated title"}'::jsonb WHERE id = $1`, [done!.id]);
    const book3 = await api('GET', '/api/plays', { cookie: charles.cookie });
    check('the endpoint renders the stored objective, not the registry',
        book3.json?.completed?.find((p: any) => p.key === 'charles_football')?.title === 'Mutated title');

    // Reward missing: the given half still renders and "got" is null. No toolbar-state
    // call after this, or the thank-you would fire again.
    await pool.query(`DELETE FROM encounters WHERE user_id = $1 AND encounter_key = 'charles_football_done'`, [charles.userId]);
    const book4 = await api('GET', '/api/plays', { cookie: charles.cookie });
    const orphan = book4.json?.completed?.find((p: any) => p.key === 'charles_football');
    check('reward not fired: receipt keeps the given half and got is null',
        book4.status === 200 && orphan?.receipt?.gave?.length === 1 && orphan?.receipt?.got === null, JSON.stringify(orphan?.receipt));

    // =================================================================================
    section('Multi-item deliveries are all or nothing');
    // =================================================================================
    const multi = await createSessionUser(`${EMAIL_PREFIX}multi@example.com`);
    await insertPet(multi.userId);
    await parkEncounters(multi.userId);
    const multiId = await startPlayDirect({
        userId: multi.userId,
        playKey: 'acceptance_multi',
        objective: { kind: 'deliver_items', title: 'Two things', home: 'the-tank-hq', items: [{ catalogKey: skuA.key, count: 1 }, { catalogKey: skuB.key, count: 2 }] },
    });
    await seedMemorabilia(multi.userId, skuA.key, 1);
    await seedMemorabilia(multi.userId, skuB.key, 1);
    await api('GET', at('/the-tank-hq/'), { cookie: multi.cookie });
    check('short on the second item: neither is taken',
        (await memorabiliaHeld(multi.userId, skuA.key)) === 1 && (await memorabiliaHeld(multi.userId, skuB.key)) === 1
        && (await deliveryRows(multi.userId)).length === 0);
    const { rows: stillOpen } = await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [multiId]);
    check('and the Play stays open', stillOpen[0].completed_at === null);
    await seedMemorabilia(multi.userId, skuB.key, 2);
    await api('GET', at('/the-tank-hq/'), { cookie: multi.cookie });
    check('fully stocked: exactly the requested counts are taken (A 1->0, B 3->1)',
        (await memorabiliaHeld(multi.userId, skuA.key)) === 0 && (await memorabiliaHeld(multi.userId, skuB.key)) === 1);
    const dm = await deliveryRows(multi.userId);
    check('one journal row per SKU with the exact delta',
        dm.length === 2 && dm.some((r) => r.catalog_key === skuA.key && r.delta === -1) && dm.some((r) => r.catalog_key === skuB.key && r.delta === -2),
        JSON.stringify(dm));
    await assertItemsConsistent(multi.userId, 'multi-item');

    // =================================================================================
    section('Concurrency - eight simultaneous loads at home take the stack once');
    // =================================================================================
    const racer = await createSessionUser(`${EMAIL_PREFIX}racer@example.com`);
    await insertPet(racer.userId);
    await parkEncounters(racer.userId);
    const raceId = await startPlayDirect({
        userId: racer.userId,
        playKey: 'acceptance_race',
        objective: { kind: 'deliver_items', title: 'Race', home: 'the-tank', items: [{ catalogKey: skuA.key, count: 2 }] },
    });
    await seedMemorabilia(racer.userId, skuA.key, 2);
    const results = await fireParallel({
        method: 'GET',
        path: at('/the-tank/'),
        build: () => ({ headers: { Cookie: racer.cookie } }),
        n: 8,
    });
    check('all eight answer 200', countStatus(results, 200) === 8, JSON.stringify(tally(results)));
    const { rows: raced } = await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [raceId]);
    check('the Play completed', raced[0].completed_at !== null);
    const { rows: rq } = await pool.query(
        `SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'memorabilia'`,
        [racer.userId, skuA.key]);
    check('quantity is exactly zero, never negative', rq.length === 1 && rq[0].quantity === 0, JSON.stringify(rq));
    const dr = await deliveryRows(racer.userId);
    check('exactly one journal row of -2', dr.length === 1 && dr[0].delta === -2, JSON.stringify(dr));
    await assertItemsConsistent(racer.userId, 'concurrent hand-over');

    // =================================================================================
    section('Two open deliveries wanting the same item: one unit completes one Play');
    // =================================================================================
    const twin = await createSessionUser(`${EMAIL_PREFIX}twin@example.com`);
    await insertPet(twin.userId);
    await parkEncounters(twin.userId);
    for (const k of ['acceptance_twin_1', 'acceptance_twin_2']) {
        await startPlayDirect({
            userId: twin.userId,
            playKey: k,
            objective: { kind: 'deliver_items', title: k, home: 'the-tank', items: [{ catalogKey: skuA.key, count: 1 }] },
        });
    }
    await seedMemorabilia(twin.userId, skuA.key, 1);
    await api('GET', at('/the-tank/'), { cookie: twin.cookie });
    const { rows: twins } = await pool.query(
        `SELECT COUNT(*) FILTER (WHERE completed_at IS NOT NULL)::int AS done FROM plays WHERE user_id = $1`, [twin.userId]);
    check('exactly one of the two completed', twins[0].done === 1, JSON.stringify(twins));
    check('the single unit was taken once', (await memorabiliaHeld(twin.userId, skuA.key)) === 0 && (await deliveryRows(twin.userId)).length === 1);
    await assertItemsConsistent(twin.userId, 'twin deliveries');

    // =================================================================================
    section('Find guarantee - every Nth find while short is the requested item');
    // =================================================================================
    const finder = await createSessionUser(`${EMAIL_PREFIX}finder@example.com`);
    const finderPet = await insertPet(finder.userId);
    await parkEncounters(finder.userId);
    await startPlayDirect({
        userId: finder.userId,
        playKey: 'acceptance_forced',
        objective: { kind: 'deliver_items', title: 'Forced', home: 'the-tank', items: [{ catalogKey: skuB.key, count: 1 }] },
    });
    try {
        // Memorabilia weight zero: the ONLY way skuB can arrive is the forced path.
        await flipConfig('discovery', { weight_ember: 100, weight_food: 0, weight_memorabilia: 0, weight_collectible: 0, forced_find_every_nth: 3 });
        const heldAfter: number[] = [];
        for (let i = 1; i <= 6; i++) {
            await makeDue(finderPet);
            // No ?place=, so no hand-over happens mid-test.
            await api('GET', '/api/toolbar-state', { cookie: finder.cookie });
            heldAfter.push(await memorabiliaHeld(finder.userId, skuB.key));
        }
        check('finds 1-2 are ordinary (nothing forced yet)', heldAfter[0] === 0 && heldAfter[1] === 0, JSON.stringify(heldAfter));
        check('find 3 is forced to the requested item', heldAfter[2] === 1, JSON.stringify(heldAfter));
        check('find 6 is NOT forced: the Play is no longer short', heldAfter[5] === 1, JSON.stringify(heldAfter));
        const { rows: fc } = await pool.query(`SELECT find_count FROM pets WHERE id = $1`, [finderPet]);
        check('find_count counted all six won windows', fc[0].find_count === 6, JSON.stringify(fc));
        const { rows: note } = await pool.query(
            `SELECT message, art FROM notifications WHERE user_id = $1 AND art = $2`, [finder.userId, skuB.image]);
        check('the forced find reads like any memorabilia find', note.length === 1 && note[0].message.includes(skuB.name), JSON.stringify(note));
        await assertItemsConsistent(finder.userId, 'forced find');
    } finally {
        await restoreConfig('discovery');
    }

    // =================================================================================
    section('Food deliveries - a character can be handed a meal');
    // =================================================================================
    // Puffington's arc hands over food, which feeding also consumes. The objective
    // carries the frozen itemType, exactly as freezeObjective would have written it.
    const eater = await createSessionUser(`${EMAIL_PREFIX}food@example.com`);
    await insertPet(eater.userId);
    await parkEncounters(eater.userId);
    const foodPlayId = await startPlayDirect({
        userId: eater.userId,
        playKey: 'acceptance_food',
        objective: {
            kind: 'deliver_items',
            title: 'Bring him a plate',
            home: 'champions-terrace',
            items: [{ catalogKey: FOUND_FOOD, count: 2, itemType: 'food', forceable: true }],
        },
    });
    await seedFood(eater.userId, FOUND_FOOD, 1);
    await api('GET', at('/champions-terrace/'), { cookie: eater.cookie });
    check('short on food: nothing taken', (await foodHeld(eater.userId, FOUND_FOOD)) === 1
        && (await deliveryRows(eater.userId)).length === 0);
    await seedFood(eater.userId, FOUND_FOOD, 1);
    await api('GET', at('/the-tank/'), { cookie: eater.cookie });
    check('stocked but at the wrong place: nothing taken', (await foodHeld(eater.userId, FOUND_FOOD)) === 2);
    await api('GET', at('/champions-terrace/'), { cookie: eater.cookie });
    const { rows: foodDone } = await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [foodPlayId]);
    check('at his home with both: the Play completes', foodDone[0].completed_at !== null);
    check('both units left the pantry', (await foodHeld(eater.userId, FOUND_FOOD)) === 0);
    const df = await deliveryRows(eater.userId);
    check("the journal row is a food sink of -2", df.length === 1 && df[0].delta === -2, JSON.stringify(df));
    const { rows: dfType } = await pool.query(
        `SELECT item_type FROM item_ledger WHERE user_id = $1 AND reason = 'play_delivery'`, [eater.userId]);
    check("it is journaled as 'food', not memorabilia", dfType[0]?.item_type === 'food', JSON.stringify(dfType));
    await assertItemsConsistent(eater.userId, 'food hand-over');

    // =================================================================================
    section('A feed and a hand-over cannot spend the same unit');
    // =================================================================================
    // The one genuinely new race in this change: feeding and delivering both decrement
    // food. deliver.ts takes the feeding lock as well as its own for exactly this.
    const racer2 = await createSessionUser(`${EMAIL_PREFIX}foodrace@example.com`);
    const racer2Pet = await insertPet(racer2.userId);
    await parkEncounters(racer2.userId);
    const racePlayId = await startPlayDirect({
        userId: racer2.userId,
        playKey: 'acceptance_food_race',
        objective: {
            kind: 'deliver_items',
            title: 'One unit, two claimants',
            home: 'champions-terrace',
            items: [{ catalogKey: FOUND_FOOD, count: 1, itemType: 'food', forceable: true }],
        },
    });
    await seedFood(racer2.userId, FOUND_FOOD, 1);
    // Hungry, so the feed is not rejected before it reaches the lock.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 20, last_fed_at = NOW() WHERE id = $1`, [racer2Pet]);
    const [feedRes, loadRes] = await Promise.all([
        api('POST', '/api/pets/feed', { cookie: racer2.cookie, body: { foodCatalogKey: FOUND_FOOD, feedToken: crypto.randomUUID() } }),
        api('GET', at('/champions-terrace/'), { cookie: racer2.cookie }),
    ]);
    const heldAfterRace = await foodHeld(racer2.userId, FOUND_FOOD);
    const { rows: raceRows } = await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [racePlayId]);
    const { rows: raceSinks } = await pool.query(
        `SELECT reason, delta FROM item_ledger WHERE user_id = $1 AND catalog_key = $2 AND delta < 0`,
        [racer2.userId, FOUND_FOOD]);
    check('exactly one of the two spent it', raceSinks.length === 1, JSON.stringify(raceSinks));
    check('the unit is gone and never negative', heldAfterRace === 0, `held=${heldAfterRace}`);
    // Whichever won, the other must have declined rather than double-spent: a fed pet
    // leaves the Play open, a completed Play leaves the feed with nothing to eat.
    const fedWon = raceSinks[0]?.reason === 'feed';
    check('the loser did nothing',
        fedWon ? raceRows[0].completed_at === null : raceRows[0].completed_at !== null,
        `feed=${feedRes.status} load=${loadRes.status} winner=${raceSinks[0]?.reason}`);
    await assertItemsConsistent(racer2.userId, 'feed versus delivery');

    // =================================================================================
    section('Compound beats - every part at the same moment');
    // =================================================================================
    const both = await createSessionUser(`${EMAIL_PREFIX}compound@example.com`);
    const bothPet = await insertPet(both.userId);
    await parkEncounters(both.userId);
    const compoundId = await startPlayDirect({
        userId: both.userId,
        playKey: 'acceptance_compound',
        objective: {
            kind: 'all_of',
            title: 'A plate, and a pet that eats properly',
            home: 'champions-terrace',
            parts: [
                { kind: 'deliver_items', items: [{ catalogKey: FOUND_FOOD, count: 1, itemType: 'food', forceable: true }] },
                { kind: 'pet_sustained_satisfied' },
            ],
        },
    });
    await seedFood(both.userId, FOUND_FOOD, 1);
    // Hungry: the item part holds, the care part does not.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 10, last_fed_at = NOW() - INTERVAL '3 hours' WHERE id = $1`, [bothPet]);
    await api('GET', at('/champions-terrace/'), { cookie: both.cookie });
    check('one part short: nothing is taken and the Play stays open',
        (await foodHeld(both.userId, FOUND_FOOD)) === 1
        && (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [compoundId])).rows[0].completed_at === null);
    const bookCompound = await api('GET', '/api/plays', { cookie: both.cookie });
    const compoundView = bookCompound.json?.current?.find((p: any) => p.key === 'acceptance_compound');
    check('the Playbook lists both parts with their own numbers',
        compoundView?.progress?.parts?.length === 2
        && compoundView.progress.parts[0].done === 1 && compoundView.progress.parts[0].target === 1
        && compoundView.progress.parts[1].done === 0 && compoundView.progress.parts[1].target === 1,
        JSON.stringify(compoundView?.progress?.parts));
    // Satisfied, and fed long enough ago to count as sustained.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW() - INTERVAL '4 hours' WHERE id = $1`, [bothPet]);
    await api('GET', at('/champions-terrace/'), { cookie: both.cookie });
    check('both parts true at once: it completes and burns',
        (await foodHeld(both.userId, FOUND_FOOD)) === 0
        && (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [compoundId])).rows[0].completed_at !== null);
    await assertItemsConsistent(both.userId, 'compound beat');

    // =================================================================================
    section('The rest of the new objective kinds, through the endpoints');
    // =================================================================================
    const misc = await createSessionUser(`${EMAIL_PREFIX}kinds@example.com`);
    const miscPet = await insertPet(misc.userId);
    await parkEncounters(misc.userId);

    // name_pet: open while the pet is nameless, done the moment it has a name.
    const namePlay = await startPlayDirect({
        userId: misc.userId, playKey: 'acceptance_name',
        objective: { kind: 'name_pet', title: 'Name it' },
    });
    await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
    check('name_pet: open while the pet is nameless',
        (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [namePlay])).rows[0].completed_at === null);
    await pool.query(`UPDATE pets SET name = $2 WHERE id = $1`, [miscPet, `Acceptance ${Date.now()}`]);
    await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
    check('name_pet: completes once it has one',
        (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [namePlay])).rows[0].completed_at !== null);

    // hold_shares: the holdings row is the fact. Written directly - buying goes through
    // ledger.buyShares and the Ember economy, which is not what this check is about.
    const tickerKey = (await pool.query(`SELECT key FROM tickers WHERE active ORDER BY key LIMIT 1`)).rows[0]?.key as string;
    const holdPlay = await startPlayDirect({
        userId: misc.userId, playKey: 'acceptance_hold',
        objective: { kind: 'hold_shares', title: 'Own a share', shares: 2 },
    });
    await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
    check('hold_shares: open with no position',
        (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [holdPlay])).rows[0].completed_at === null);
    await pool.query(
        `INSERT INTO share_holdings (user_id, ticker_key, shares, avg_buy_price, held_since)
         VALUES ($1, $2, 2, 100, NOW() - INTERVAL '2 days')`,
        [misc.userId, tickerKey]);
    await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
    check('hold_shares: completes once the position exists',
        (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [holdPlay])).rows[0].completed_at !== null);

    // hold_through_close: false until a close lands after the position was opened. The
    // position is re-opened NOW first: the one above is two days old, and real daily
    // closes have genuinely landed since, so it has in fact held through one already.
    // The seeded close carries delta 0 and a timestamp just ahead of the position, so
    // it never moves a real index price and is removed in the finally.
    const closeDate = '1999-01-04';
    await pool.query(`UPDATE share_holdings SET held_since = NOW() WHERE user_id = $1 AND ticker_key = $2`, [misc.userId, tickerKey]);
    try {
        const closePlay = await startPlayDirect({
            userId: misc.userId, playKey: 'acceptance_close',
            objective: { kind: 'hold_through_close', title: 'Hold it overnight' },
        });
        await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
        check('hold_through_close: open before any close',
            (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [closePlay])).rows[0].completed_at === null);
        await pool.query(
            `INSERT INTO ticker_events (ticker_key, event_type, delta, source, close_date, occurred_at, metadata)
             VALUES ($1, 'close', 0, 'slate', $2::date, NOW() + INTERVAL '1 minute', '{"acceptance": true}'::jsonb)`,
            [tickerKey, closeDate]);
        await api('GET', '/api/toolbar-state', { cookie: misc.cookie });
        check('hold_through_close: completes once a close lands on a position older than it',
            (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [closePlay])).rows[0].completed_at !== null);
    } finally {
        await pool.query(`DELETE FROM ticker_events WHERE ticker_key = $1 AND close_date = $2::date`, [tickerKey, closeDate]);
    }

    // read_articles: any published Tank article the pet visits counts, once each.
    const { rows: articles } = await pool.query(
        `SELECT slug FROM tank_pages WHERE status = 'published' AND visibility = 'app' ORDER BY published_at DESC LIMIT 2`);
    if (articles.length < 2) {
        warn('read_articles: fewer than two published app-visible Tanks exist - skipping the visit walk');
    } else {
        const readPlay = await startPlayDirect({
            userId: misc.userId, playKey: 'acceptance_read',
            objective: { kind: 'read_articles', title: 'Read two Tanks', count: 2 },
        });
        await api('GET', at(`/the-tank/articles/${articles[0].slug}/`), { cookie: misc.cookie });
        // The same article twice must not count twice.
        await api('GET', at(`/the-tank/articles/${articles[0].slug}/`), { cookie: misc.cookie });
        const { rows: midRead } = await pool.query(`SELECT visited, completed_at FROM plays WHERE id = $1`, [readPlay]);
        check('read_articles: one article recorded once, Play still open',
            midRead[0].visited.length === 1 && midRead[0].completed_at === null, JSON.stringify(midRead[0]));
        await api('GET', at('/the-tank/articles/not-a-real-slug/'), { cookie: misc.cookie });
        check('read_articles: an invented slug records nothing',
            (await pool.query(`SELECT visited FROM plays WHERE id = $1`, [readPlay])).rows[0].visited.length === 1);
        await api('GET', at(`/the-tank/articles/${articles[1].slug}/`), { cookie: misc.cookie });
        check('read_articles: the second one completes it',
            (await pool.query(`SELECT completed_at FROM plays WHERE id = $1`, [readPlay])).rows[0].completed_at !== null);
    }

    // =================================================================================
    section("A whole arc, end to end - Puffington's diet, six scenes in order");
    // =================================================================================
    // The arcs are only as good as their chaining: each beat is its own scene, gated on
    // the Play before it AND on the previous scene having been watched. This walks every
    // beat through the real endpoints. Counters (feed_count) are set directly - the
    // feeding path has its own suite, and fifty real feeds would prove nothing new.
    const puff = await createSessionUser(`${EMAIL_PREFIX}puffington@example.com`);
    const puffPet = await insertPet(puff.userId);
    const puffKeys = ENCOUNTERS.filter((e) => e.character === 'puffington').map((e) => e.key);
    await parkEncounters(puff.userId, puffKeys);
    const watch = async (key: string) => {
        const { rows } = await pool.query(`SELECT id FROM encounters WHERE user_id = $1 AND encounter_key = $2`, [puff.userId, key]);
        if (rows[0]) await api('POST', '/api/encounters/seen', { cookie: puff.cookie, body: { id: rows[0].id } });
        return Boolean(rows[0]);
    };
    const bumpFeeds = (n: number) => pool.query(`UPDATE pets SET feed_count = feed_count + $2 WHERE id = $1`, [puffPet, n]);
    const load = (path?: string) => api('GET', path ? at(path) : '/api/toolbar-state', { cookie: puff.cookie });
    const fired: string[] = [];
    const expectScene = async (res: any, key: string, label: string) => {
        const got = res.json?.encounter?.key;
        check(`arc: ${label} -> '${key}' plays`, got === key, String(got));
        if (got === key) fired.push(key);
        await watch(key);
    };

    await bumpFeeds(3);
    await expectScene(await load(), 'puffington_intro', 'three feeds');
    await load('/champions-terrace/');
    await expectScene(await load('/quickboost-delicacies/'), 'puffington_quest_done', 'both counters visited');
    await expectScene(await load(), 'puffington_your_bowl', 'the next beat opens on its own');
    await bumpFeeds(3);
    await expectScene(await load(), 'puffington_fed_done', 'three more feeds');
    await seedFood(puff.userId, 'food_loaded_nachos', 1);
    await seedFood(puff.userId, 'food_chicken_wings', 1);
    await expectScene(await load('/champions-terrace/'), 'puffington_last_plate_done', 'nachos and wings handed over');
    await seedFood(puff.userId, 'food_sampler_platter', 1);
    await seedFood(puff.userId, 'food_mint_julep', 1);
    await seedFood(puff.userId, 'food_craft_beer', 1);
    // The spread alone is not enough: the ten feeds are the other half of the beat.
    const shortSpread = await load('/champions-terrace/');
    check('arc: the farewell spread waits for its feeds', shortSpread.json?.encounter === null
        && (await foodHeld(puff.userId, 'food_sampler_platter')) === 1, String(shortSpread.json?.encounter?.key));
    await bumpFeeds(10);
    await expectScene(await load('/champions-terrace/'), 'puffington_farewell_done', 'spread handed over with ten feeds');
    await seedFood(puff.userId, 'food_fresh_salad', 1);
    await seedFood(puff.userId, 'food_protein_shake', 1);
    await seedFood(puff.userId, 'food_banana_shake', 1);
    await bumpFeeds(25);
    // Hungry: the diet beat's care part holds it back even with every item in hand.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 10, last_fed_at = NOW() - INTERVAL '4 hours' WHERE id = $1`, [puffPet]);
    const hungryDiet = await load('/champions-terrace/');
    check('arc: the diet beat waits for a well-kept pet', hungryDiet.json?.encounter === null
        && (await foodHeld(puff.userId, 'food_fresh_salad')) === 1, String(hungryDiet.json?.encounter?.key));
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW() - INTERVAL '4 hours' WHERE id = $1`, [puffPet]);
    const ribeyeBefore = await foodHeld(puff.userId, 'food_ribeye');
    await expectScene(await load('/champions-terrace/'), 'puffington_diet_done', 'the diet order with a well-kept pet');
    check('arc: the finale hands over his saved ribeye', (await foodHeld(puff.userId, 'food_ribeye')) === ribeyeBefore + 1);
    check('arc: every scene fired, once, in order', JSON.stringify(fired) === JSON.stringify(puffKeys), JSON.stringify(fired));
    const puffBook = await api('GET', '/api/plays', { cookie: puff.cookie });
    check('arc: the Playbook shows all five Plays completed, none current',
        puffBook.json?.completed?.length === 5 && puffBook.json?.current?.length === 0,
        `current=${puffBook.json?.current?.length} completed=${puffBook.json?.completed?.length}`);
    const dietReceipt = puffBook.json?.completed?.find((p: any) => p.key === 'puffington_diet')?.receipt;
    check('arc: the diet receipt lists all three bought items and the ribeye that came back',
        dietReceipt?.gave?.length === 3 && dietReceipt?.got?.item?.catalogKey === 'food_ribeye', JSON.stringify(dietReceipt));
    await assertItemsConsistent(puff.userId, 'the whole Puffington arc');

    // =================================================================================
    section('Endpoint gates');
    // =================================================================================
    const petless = await createSessionUser(`${EMAIL_PREFIX}petless@example.com`);
    const pl = await api('GET', '/api/plays', { cookie: petless.cookie });
    check('petless account -> 200 with two empty lists',
        pl.status === 200 && pl.json?.current?.length === 0 && pl.json?.completed?.length === 0, JSON.stringify(pl.json));
    const anon = await api('GET', '/api/plays', {});
    check('logged out -> 401', anon.status === 401, `status=${anon.status}`);
    const fresh = await createSessionUser(`${EMAIL_PREFIX}fresh@example.com`, { onboarded: false });
    const gated = await api('GET', '/api/plays', { cookie: fresh.cookie });
    check('not onboarded -> 403', gated.status === 403, `status=${gated.status}`);
    const other = await api('GET', '/api/plays', { cookie: multi.cookie });
    check("an account only ever sees its own Plays",
        other.status === 200 && ![...(other.json?.current ?? []), ...(other.json?.completed ?? [])].some((p: any) => p.key === 'charles_football'));

    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
}

export const suite: Suite = {
    name: 'plays',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
