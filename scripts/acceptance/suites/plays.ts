// Acceptance suite for Plays - delivery hand-overs (encounters/deliver.ts), the find
// guarantee (plays.ts forcedFind + discovery.ts), and My Playbook (GET /api/plays),
// driven through the real endpoints against the dev server.
//
// Every fixture account parks the registry's encounters as already seen, so a scene
// firing mid-test can never hand over something this suite then counts. The one
// exception is the Charles football arc, which the first section drives for real so the
// registry path - fire, freeze, enrich, hand over, reward - is covered end to end.

import { pool, api, check, section, type Suite } from '../harness';
import { fireParallel, tally, countStatus } from '../concurrency';
import {
    createSessionUser, cleanupUsersByEmailPrefix, flipConfig, restoreConfig,
    seedMemorabilia, memorabiliaHeld, memorabiliaSkus, startPlayDirect, itemTotals,
} from '../fixtures';
import { ENCOUNTERS, PLAY_BY_KEY } from '../../../lib/pages-functions/encounters';

const EMAIL_PREFIX = 'acceptance-plays-';
const FOOTBALL = 'memorabilia_worn_football';

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
