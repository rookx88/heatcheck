// Acceptance suite for Pet Random Event Discovery + the consolidated toolbar-state
// endpoint. This IS the acceptance suite for lib/pages-functions/discovery.ts,
// ledger.discoveryFindEmber, and functions/api/toolbar-state.ts. Lifted verbatim
// (behavior-preserving) from the original standalone scripts/acceptance-discovery.ts
// into the consolidated runner.

import { pool, api, check, section, type Suite } from '../harness';
import { createSessionUser, cleanupUsersByEmailPrefix, activeConfig, insertTank, cleanupTanksBySlugPrefix } from '../fixtures';
import { placeFromPath } from '../../../lib/pages-functions/discovery';

const EMAIL_PREFIX = 'acceptance-discovery-';
const TANK_SLUG_PREFIX = 'acceptance-discovery-';

// The footprints gate (add_pet_footprints.sql): a due roll also needs this many distinct
// places since the last find. Read from the active config once per run, never hardcoded.
let need = 0;

// Synthetic footprints for tests that are about the roll, not the walk - the gate only
// counts entries, so any distinct strings satisfy it.
function stampPlaces(n: number): string[] {
    return Array.from({ length: n }, (_, i) => `stamp:${i}`);
}
async function stamp(petId: string, places: string[]): Promise<void> {
    await pool.query(`UPDATE pets SET places_since_find = $2::text[] WHERE id = $1`, [petId, places]);
}
async function placesOf(petId: string): Promise<string[]> {
    const { rows } = await pool.query(`SELECT places_since_find FROM pets WHERE id = $1`, [petId]);
    return rows[0].places_since_find as string[];
}

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`,
        [userId],
    );
    return rows[0].id as string;
}

// Every way this feature can have granted anything to a user, as one number.
async function grantTotals(userId: string): Promise<{ ledgerRows: number; ledgerSum: number; foodUnits: number; cardRows: number; total: number }> {
    const { rows } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find') AS ledger_rows,
            (SELECT COALESCE(SUM(amount), 0)::int FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find') AS ledger_sum,
            (SELECT COALESCE(SUM(quantity), 0)::int FROM inventory_items WHERE user_id = $1 AND item_type = 'food') AS food_units,
            (SELECT COUNT(*)::int FROM inventory_items WHERE user_id = $1 AND item_type = 'collectible') AS card_rows`,
        [userId],
    );
    const r = rows[0];
    return {
        ledgerRows: r.ledger_rows,
        ledgerSum: r.ledger_sum,
        foodUnits: r.food_units,
        cardRows: r.card_rows,
        total: r.ledger_rows + r.food_units + r.card_rows,
    };
}

// Makes the pet due AND explored (both gates open) unless `places` says otherwise.
async function rearm(petId: string, places: string[] = stampPlaces(need)): Promise<void> {
    await pool.query(
        `UPDATE pets SET next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`,
        [petId, places],
    );
}

// Minutes from NOW() to the pet's next window - measured AFTER a roll, so it reads
// slightly under the rolled value (request latency); bounds get a small tolerance.
async function windowMinutes(petId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT EXTRACT(EPOCH FROM (next_eligible_roll_at - NOW())) / 60 AS mins FROM pets WHERE id = $1`,
        [petId],
    );
    return Number(rows[0].mins);
}

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(TANK_SLUG_PREFIX);
}

async function run() {
    await cleanup();
    need = Number((await activeConfig('discovery')).min_new_places);
    console.log(`  [discovery] Active discovery.min_new_places = ${need}`);

    // --- Petless: the hard precondition ---
    section('Petless account - complete no-op');
    const petless = await createSessionUser(`${EMAIL_PREFIX}petless@example.com`);
    const p1 = await api('GET', '/api/toolbar-state', { cookie: petless.cookie });
    const p2 = await api('GET', '/api/toolbar-state', { cookie: petless.cookie });
    check('toolbar-state -> 200 with pet: null, twice', p1.status === 200 && p2.status === 200 && p1.json?.pet === null && p2.json?.pet === null);
    check('consolidated shape present (session + balance + notifications)',
        p1.json?.session?.userId === petless.userId && p1.json?.balance === 0 && Array.isArray(p1.json?.notifications));
    const petlessGrants = await grantTotals(petless.userId);
    const { rows: petlessNotes } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1`, [petless.userId]);
    check('zero grants, zero notifications, no error', petlessGrants.total === 0 && petlessNotes[0].n === 0);

    // --- Initialization: NULL schedules, never grants ---
    section('Initialization - NULL next_eligible_roll_at schedules without granting');
    const roller = await createSessionUser(`${EMAIL_PREFIX}roller@example.com`);
    const petId = await insertPet(roller.userId);
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const initMins = await windowMinutes(petId);
    check('first check schedules into the long range (90-120m)', initMins > 88 && initMins <= 120.5, `got ${initMins.toFixed(1)}m`);
    const initGrants = await grantTotals(roller.userId);
    check('initialization granted nothing', initGrants.total === 0);

    // --- A due roll always finds, in the same response ---
    section('Due roll - always grants, atomically, visible in the same response');
    await rearm(petId);
    const rollRes = await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const afterFirst = await grantTotals(roller.userId);
    check('exactly one grant (ember row or food unit)', afterFirst.total === 1, JSON.stringify(afterFirst));
    const { rows: noteRows } = await pool.query(
        `SELECT id, type, ref_type, read_at, claimed_at, mood FROM notifications WHERE user_id = $1`, [roller.userId]);
    check("exactly one 'claimable' notification, ref_type 'pet'",
        noteRows.length === 1 && noteRows[0].type === 'claimable' && noteRows[0].ref_type === 'pet');
    // Every find is good news: the widget pulls the happy face while it speaks it
    // (add_mood_to_notifications.sql), and the wire shape carries the mood through.
    check("find notification is mood 'happy' in the DB", noteRows[0]?.mood === 'happy', `got ${noteRows[0]?.mood}`);
    const wireNote = (rollRes.json?.notifications ?? []).find((n: any) => n.id === noteRows[0]?.id);
    check('the find is already in this response (notification + non-null balance)',
        Boolean(wireNote) && typeof rollRes.json?.balance === 'number');
    check("toolbar-state serialises mood: 'happy' on the find", wireNote?.mood === 'happy', `got ${wireNote?.mood}`);
    if (afterFirst.ledgerRows === 1) {
        check('ember amount within configured 1-5', afterFirst.ledgerSum >= 1 && afterFirst.ledgerSum <= 5, `got ${afterFirst.ledgerSum}`);
    }

    // --- Spam gating ---
    section('Spam gating - concurrent due requests grant exactly once');
    await rearm(petId);
    await Promise.all(Array.from({ length: 10 }, () => api('GET', '/api/toolbar-state', { cookie: roller.cookie })));
    const afterSpam = await grantTotals(roller.userId);
    check('10 concurrent GETs -> grants +1 exactly', afterSpam.total === afterFirst.total + 1, `total ${afterSpam.total}, was ${afterFirst.total}`);
    const gateMins = await windowMinutes(petId);
    check('next_eligible_roll_at pushed out past now', gateMins > 0, `got ${gateMins.toFixed(1)}m`);

    // --- Footprints gate: placeFromPath is the allowlist ---
    section('Footprints - placeFromPath allowlist (pure, table-driven)');
    const placeTable: Array<[string | null, string | null]> = [
        ['/', 'home'],
        ['/the-tank', 'the-tank'],
        ['/the-tank/', 'the-tank'],
        ['/THE-TANK/', 'the-tank'],
        ['/the-tank-hq/', 'the-tank-hq'],
        ['/the-hatchery/', 'the-hatchery'],
        ['/champions-terrace/', 'champions-terrace'],
        ['/quickboost-delicacies/', 'quickboost-delicacies'],
        ['/account/', 'account'],
        ['/my-portfolio/', 'my-portfolio'],
        ['/tankdaq/', 'tankdaq'],
        ['/tankdaq/indexes/', 'tankdaq:indexes'],
        ['/tankdaq/dogs/', 'tankdaq:dogs'],
        ['/the-tank/articles/some-slug-42/', 'article:some-slug-42'],
        ['/the-tank/articles/', null],
        ['/the-tank/articles/a/b', null],
        ['/the-tank/articles/../x', null],
        ['/tankdaq/dogs/extra', null],
        ['/login/', null],
        ['/welcome/', null],
        ['/nfl/', null],
        ['the-tank', null],
        ['', null],
        [null, null],
        ['/' + 'a'.repeat(300), null],
    ];
    for (const [input, expected] of placeTable) {
        const got = placeFromPath(input)?.key ?? null;
        check(`placeFromPath(${JSON.stringify(input)}) -> ${JSON.stringify(expected)}`, got === expected, `got ${JSON.stringify(got)}`);
    }
    check('article place carries the slug check', placeFromPath('/the-tank/articles/x-1/')?.check === 'article');
    check('ticker place carries the tankdaq check', placeFromPath('/tankdaq/dogs/')?.check === 'tankdaq');

    // --- Footprints gate: due but unexplored never grants ---
    section('Footprints - due + zero places -> nothing, clock untouched');
    await rearm(petId, []);
    const preUnexplored = await grantTotals(roller.userId);
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const postUnexplored = await grantTotals(roller.userId);
    check('two GETs on a due, unexplored pet grant nothing', postUnexplored.total === preUnexplored.total, `total ${postUnexplored.total}, was ${preUnexplored.total}`);
    const unexploredMins = await windowMinutes(petId);
    check('clock still due (not consumed, not pushed out)', unexploredMins < 0, `got ${unexploredMins.toFixed(1)}m`);
    check('places_since_find still empty (no ?place= sent)', (await placesOf(petId)).length === 0);

    // --- Footprints gate: accumulation is distinct, normalized, and independent of due-ness ---
    section('Footprints - ?place= accumulates distinct normalized places while the clock runs');
    await pool.query(`UPDATE pets SET next_eligible_roll_at = NOW() + INTERVAL '1 day', places_since_find = '{}' WHERE id = $1`, [petId]);
    for (const p of ['/the-tank/', '/THE-TANK', '/the-tank']) {
        await api('GET', `/api/toolbar-state?place=${encodeURIComponent(p)}`, { cookie: roller.cookie });
    }
    check("three spellings of /the-tank -> exactly ['the-tank']", JSON.stringify(await placesOf(petId)) === JSON.stringify(['the-tank']), JSON.stringify(await placesOf(petId)));
    for (const p of ['/nope/', '/the-tank/articles/../x', '/login/']) {
        await api('GET', `/api/toolbar-state?place=${encodeURIComponent(p)}`, { cookie: roller.cookie });
    }
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    check('unknown paths, dot segments, and a missing param add nothing', (await placesOf(petId)).length === 1, JSON.stringify(await placesOf(petId)));
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/the-hatchery/')}`, { cookie: roller.cookie });
    check("a second venue -> ['the-tank','the-hatchery']", JSON.stringify(await placesOf(petId)) === JSON.stringify(['the-tank', 'the-hatchery']), JSON.stringify(await placesOf(petId)));
    const notDueGrants = await grantTotals(roller.userId);
    check('accumulating with a future clock granted nothing', notDueGrants.total === postUnexplored.total);
    const fresh = await createSessionUser(`${EMAIL_PREFIX}fresh@example.com`);
    const freshPetId = await insertPet(fresh.userId);
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/account/')}`, { cookie: fresh.cookie });
    const freshMins = await windowMinutes(freshPetId);
    check('NULL-clock pet: first call initializes the clock AND records the footprint',
        freshMins > 88 && freshMins <= 120.5 && JSON.stringify(await placesOf(freshPetId)) === JSON.stringify(['account']),
        `mins ${freshMins.toFixed(1)}, places ${JSON.stringify(await placesOf(freshPetId))}`);

    // --- Footprints gate: the Nth place grants on that same request, then resets ---
    section(`Footprints - new place #${need} grants on that request; footprints reset`);
    await rearm(petId, stampPlaces(need - 1));
    const preNth = await grantTotals(roller.userId);
    const nthRes = await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/my-portfolio/')}`, { cookie: roller.cookie });
    const postNth = await grantTotals(roller.userId);
    check(`walking into place #${need} grants exactly once`, postNth.total === preNth.total + 1, `total ${postNth.total}, was ${preNth.total}`);
    // Wire shape is camelCase (toolbar-state.ts mapNotifications), unlike the DB rows.
    const nthNote = (nthRes.json?.notifications ?? []).find((n: any) => n.type === 'claimable' && n.refType === 'pet' && n.claimedAt === null);
    check('the find is in that same response', Boolean(nthNote) && nthRes.status === 200, `status ${nthRes.status}, notes ${JSON.stringify((nthRes.json?.notifications ?? []).slice(0, 2))}`);
    check('clock pushed out past now', (await windowMinutes(petId)) > 0);
    check("places_since_find reset to '{}' by the claim", (await placesOf(petId)).length === 0, JSON.stringify(await placesOf(petId)));
    await rearm(petId, [...stampPlaces(need - 2), 'my-portfolio']);
    const preDup = await grantTotals(roller.userId);
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/my-portfolio/')}`, { cookie: roller.cookie });
    const postDup = await grantTotals(roller.userId);
    check('revisiting an already-counted place does not complete the gate', postDup.total === preDup.total && (await placesOf(petId)).length === need - 1);

    // --- Footprints gate: articles and tickers are validated against the DB ---
    section('Footprints - article slugs and ticker keys must exist (fake ones never count)');
    await stamp(petId, []);
    await pool.query(`UPDATE pets SET next_eligible_roll_at = NOW() + INTERVAL '1 day' WHERE id = $1`, [petId]);
    const slugA = `${TANK_SLUG_PREFIX}art-a`;
    const slugB = `${TANK_SLUG_PREFIX}art-b`;
    await insertTank({ slug: slugA, marketId: 'acceptance-discovery-a', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
    await insertTank({ slug: slugB, marketId: 'acceptance-discovery-b', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/the-tank/articles/${slugA}/`)}`, { cookie: roller.cookie });
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/the-tank/articles/${slugB}/`)}`, { cookie: roller.cookie });
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/the-tank/articles/${slugA}/`)}`, { cookie: roller.cookie });
    check('two published articles -> two distinct article places (revisit is a no-op)',
        JSON.stringify(await placesOf(petId)) === JSON.stringify([`article:${slugA}`, `article:${slugB}`]), JSON.stringify(await placesOf(petId)));
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/the-tank/articles/${TANK_SLUG_PREFIX}not-real/`)}`, { cookie: roller.cookie });
    check('a non-existent article slug adds nothing', (await placesOf(petId)).length === 2, JSON.stringify(await placesOf(petId)));
    await pool.query(`UPDATE tank_pages SET visibility = 'draft' WHERE slug = $1`, [`${TANK_SLUG_PREFIX}art-a`]);
    await stamp(petId, []);
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/the-tank/articles/${slugA}/`)}`, { cookie: roller.cookie });
    check('an article that is not visibility=app adds nothing', (await placesOf(petId)).length === 0, JSON.stringify(await placesOf(petId)));
    const { rows: liveTicker } = await pool.query(`SELECT key FROM tickers WHERE active ORDER BY key LIMIT 1`);
    if (liveTicker.length) {
        await api('GET', `/api/toolbar-state?place=${encodeURIComponent(`/tankdaq/${liveTicker[0].key}/`)}`, { cookie: roller.cookie });
        check(`an active ticker floor counts (tankdaq:${liveTicker[0].key})`, JSON.stringify(await placesOf(petId)) === JSON.stringify([`tankdaq:${liveTicker[0].key}`]), JSON.stringify(await placesOf(petId)));
    } else {
        check('an active ticker floor counts', false, 'no active tickers in the DB to test against');
    }
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/tankdaq/not-a-ticker/')}`, { cookie: roller.cookie });
    check('a non-existent ticker key adds nothing', (await placesOf(petId)).length === (liveTicker.length ? 1 : 0), JSON.stringify(await placesOf(petId)));

    // --- Footprints gate: cap ---
    section('Footprints - capped at 64 entries');
    await stamp(petId, stampPlaces(64));
    await api('GET', `/api/toolbar-state?place=${encodeURIComponent('/the-hatchery/')}`, { cookie: roller.cookie });
    const capped = await placesOf(petId);
    check('a 65th place is not appended', capped.length === 64 && !capped.includes('the-hatchery'), `len ${capped.length}`);

    // --- Cooldown classes ---
    section('Cooldown - sustained-Satisfied gets short, everyone else long');
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW(), next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`, [petId, stampPlaces(need)]);
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const justFedMins = await windowMinutes(petId);
    check('just-fed pet -> long window (90-120m)', justFedMins > 88 && justFedMins <= 120.5, `got ${justFedMins.toFixed(1)}m`);
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW() - INTERVAL '3 hours', next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`, [petId, stampPlaces(need)]);
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const sustainedMins = await windowMinutes(petId);
    check('sustained-satisfied pet -> short window (45-60m)', sustainedMins > 43 && sustainedMins <= 60.5, `got ${sustainedMins.toFixed(1)}m`);
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 45, last_fed_at = NOW() - INTERVAL '3 hours', next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`, [petId, stampPlaces(need)]);
    await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    const hungryMins = await windowMinutes(petId);
    check('hungry pet -> long window (90-120m)', hungryMins > 88 && hungryMins <= 120.5, `got ${hungryMins.toFixed(1)}m`);

    // --- Distribution over many rolls ---
    section('Distribution - category weights, food price skew, collectible redistribution (150 rolls, ~a minute)');
    const distBase = await grantTotals(roller.userId);
    const ROLLS = 150;
    for (let i = 0; i < ROLLS; i++) {
        await rearm(petId);
        await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    }
    const distEnd = await grantTotals(roller.userId);
    const emberRolls = distEnd.ledgerRows - distBase.ledgerRows;
    const foodRolls = distEnd.foodUnits - distBase.foodUnits;
    const cardRolls = distEnd.cardRows - distBase.cardRows;
    check(`every roll granted (${ROLLS} rolls -> ${emberRolls} ember + ${foodRolls} food + ${cardRolls} cards)`, emberRolls + foodRolls + cardRolls === ROLLS);
    const { rows: eligibleSkus } = await pool.query(
        `SELECT c.key FROM items_catalog c
         JOIN collectible_pools p ON p.catalog_key = c.key
         WHERE c.item_type = 'collectible' AND c.active = true
           AND (c.config->>'discovery_droppable')::boolean IS TRUE
           AND (c.available_from IS NULL OR c.available_from <= NOW())
           AND (c.available_until IS NULL OR c.available_until > NOW())
           AND p.minted_count < p.mint_size`,
    );
    const collectiblesLive = eligibleSkus.length > 0;
    const emberShare = emberRolls / ROLLS;
    const expected = collectiblesLive ? '70/100 (70.0%)' : '70/95 (73.7%)';
    check(`ember share near ${expected}, got ${(emberShare * 100).toFixed(1)}%`,
        collectiblesLive ? emberShare > 0.55 && emberShare < 0.85 : emberShare > 0.59 && emberShare < 0.88);
    if (cardRolls > 0) {
        const { rows: serialRows } = await pool.query(
            `SELECT i.catalog_key,
                    COUNT(*)::int AS n, COUNT(DISTINCT i.serial_number)::int AS distinct_n,
                    MIN(i.serial_number)::int AS lo, MAX(i.serial_number)::int AS hi,
                    p.mint_size, p.minted_count
             FROM inventory_items i
             JOIN collectible_pools p ON p.catalog_key = i.catalog_key
             WHERE i.user_id = $1 AND i.item_type = 'collectible'
             GROUP BY i.catalog_key, p.mint_size, p.minted_count`,
            [roller.userId],
        );
        for (const s of serialRows) {
            check(`${s.catalog_key}: serials distinct and within 1..${s.mint_size}`,
                s.n === s.distinct_n && s.lo >= 1 && s.hi <= s.mint_size, JSON.stringify(s));
            check(`${s.catalog_key}: pool counter >= highest issued serial`, s.minted_count >= s.hi, JSON.stringify(s));
        }
    } else if (collectiblesLive) {
        check('collectible SKU live but zero cards in 150 rolls (p~0.0005 - rerun to confirm)', false);
    }
    await pool.query(
        `INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, active)
         VALUES ('collectible_acceptance_test', 'collectible', 'Acceptance Test Card', 'collectible_not_for_sale',
                 '{"discovery_droppable": true}', false)
         ON CONFLICT (key) DO NOTHING`,
    );
    await pool.query(
        `INSERT INTO collectible_pools (catalog_key, mint_size, minted_count)
         VALUES ('collectible_acceptance_test', 0, 0) ON CONFLICT (catalog_key) DO NOTHING`,
    );
    const { rows: exhausted } = await pool.query(
        `SELECT 1 FROM items_catalog c
         JOIN collectible_pools p ON p.catalog_key = c.key
         WHERE c.key = 'collectible_acceptance_test' AND p.minted_count < p.mint_size`,
    );
    check('zero-mint pool is excluded from the eligible set', exhausted.length === 0);
    await pool.query(`DELETE FROM collectible_pools WHERE catalog_key = 'collectible_acceptance_test'`);
    await pool.query(`DELETE FROM items_catalog WHERE key = 'collectible_acceptance_test'`);
    const { rows: foodDist } = await pool.query(
        `SELECT (r.config->>'amount')::int <= 20 AS cheap, SUM(i.quantity)::int AS units
         FROM inventory_items i
         JOIN items_catalog c ON c.key = i.catalog_key
         JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
         WHERE i.user_id = $1 AND i.item_type = 'food'
         GROUP BY 1`,
        [roller.userId],
    );
    const cheapUnits = foodDist.find((r) => r.cheap === true)?.units ?? 0;
    const expensiveUnits = foodDist.find((r) => r.cheap === false)?.units ?? 0;
    check(`food skews cheap (price<=20: ${cheapUnits} vs >20: ${expensiveUnits})`, cheapUnits > expensiveUnits);
    const { rows: amountBounds } = await pool.query(
        `SELECT MIN(amount)::int AS lo, MAX(amount)::int AS hi FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find'`, [roller.userId]);
    check('all ember finds within configured 1-5', amountBounds[0].lo >= 1 && amountBounds[0].hi <= 5, JSON.stringify(amountBounds[0]));

    // --- Idempotency backstop ---
    section('Idempotency - a consumed window can never grant twice');
    const { rows: keyRows } = await pool.query(
        `SELECT idempotency_key FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find' LIMIT 1`, [roller.userId]);
    if (keyRows.length) {
        const { rows: replay } = await pool.query(
            `INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
             VALUES ($1, 3, 'earn', 'discovery_find', 1, $2, '{}')
             ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
            [roller.userId, keyRows[0].idempotency_key],
        );
        check('replaying a consumed window key inserts nothing', replay.length === 0);
    } else {
        check('replaying a consumed window key inserts nothing', false, 'no ember find landed in the whole run (astronomically unlikely)');
    }

    // --- Claim is presentational ---
    section('Claim - reveals only, never re-grants, never implies read');
    const preClaim = await grantTotals(roller.userId);
    const { rows: claimTarget } = await pool.query(
        `SELECT id FROM notifications WHERE user_id = $1 AND type = 'claimable' AND ref_type = 'pet' LIMIT 1`, [roller.userId]);
    const claim1 = await api('POST', '/api/notifications/claim', { cookie: roller.cookie, body: { id: claimTarget[0].id } });
    const claim2 = await api('POST', '/api/notifications/claim', { cookie: roller.cookie, body: { id: claimTarget[0].id } });
    const postClaim = await grantTotals(roller.userId);
    const { rows: claimedRow } = await pool.query(`SELECT read_at, claimed_at FROM notifications WHERE id = $1`, [claimTarget[0].id]);
    check('claim -> 200 and claimed_at stamped', claim1.status === 200 && claimedRow[0].claimed_at !== null);
    check('claim did not re-grant (twice)', claim2.status === 200 && postClaim.total === preClaim.total && postClaim.ledgerSum === preClaim.ledgerSum);
    check('claim did not touch read_at (independent facts)', claimedRow[0].read_at === null);

    // --- Sliding-expiry cookie propagation ---
    section('Session - toolbar-state propagates the sliding-expiry Set-Cookie');
    await pool.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '20 days' WHERE user_id = $1`, [roller.userId]);
    const refreshed = await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
    check('drifted session gets Set-Cookie back', refreshed.status === 200 && (refreshed.headers.get('set-cookie') ?? '').includes('hc_session='));

    await cleanup();
}

export const suite: Suite = {
    name: 'discovery',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
