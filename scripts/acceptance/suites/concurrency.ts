// Acceptance suite for genuine-parallelism races across every endpoint with a
// concurrency-sensitive write path. Each check fires N truly-simultaneous requests via
// concurrency.ts's fireParallel() (NOT Promise.all of sequential closures - see that
// file's header for why the distinction matters for actually exercising a race) and
// then asserts against the DATABASE, not just the HTTP status distribution: a status
// code only proves what one response said, the DB row(s) prove what actually got
// written. Read the real endpoint source before trusting any status-code assumption
// here - several of these endpoints are idempotent-replay (all 200) rather than
// winner-take-401/409, which only becomes obvious by reading the code.
//
// Two items carry an explicit "this would be a critical bug" callout in their comments
// (hatch on different egg rows, and login-token double-consume) - if a run of this
// suite ever fails those specific checks, do not treat it as a flaky test; it means the
// underlying atomicity guarantee documented in the production code's own comments does
// not actually hold.

import { pool, check, section, type Suite } from '../harness';
import { fireParallel, tally, countStatus } from '../concurrency';
import {
    createUser,
    createSessionUser,
    mintLoginToken,
    insertTank,
    findMarkets,
    insertTagDirect,
    insertUserWithPick,
    ledgerTotals,
    cleanupUsersByEmailPrefix,
    cleanupTanksBySlugPrefix,
    cheapestActiveSku,
} from '../fixtures';

const EMAIL_PREFIX = 'acceptance-conc-';
const SLUG_PREFIX = 'acceptance-conc-';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const TICKER_SECRET = process.env.TICKER_SECRET || '';

// ---------------------------------------------------------------------------------
// Local fixture helpers - mirror the direct-pool-insert style suites/discovery.ts
// already uses for a bare pet row; extended here for eggs/food/balance/notifications
// since this suite needs to seed preconditions no shared fixture currently covers.
// ---------------------------------------------------------------------------------

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userId]);
    return rows[0].id as string;
}

// Eggs are one row each (never stacked) - matches lib/pages-functions/pets.ts's hatch().
async function insertEgg(userId: string, catalogKey: string): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity) VALUES ($1, $2, 'egg', 1) RETURNING id`,
        [userId, catalogKey],
    );
    return rows[0].id as string;
}

async function insertFood(userId: string, catalogKey: string, quantity: number): Promise<void> {
    await pool.query(
        `INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity) VALUES ($1, $2, 'food', $3)`,
        [userId, catalogKey, quantity],
    );
}

async function setBalance(userId: string, amount: number): Promise<void> {
    await pool.query(
        `INSERT INTO ember_balances (user_id, balance, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (user_id) DO UPDATE SET balance = $2, updated_at = NOW()`,
        [userId, amount],
    );
}

async function insertClaimableNotification(userId: string, message: string): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO notifications (user_id, type, message, ref_type) VALUES ($1, 'claimable', $2, 'acceptance') RETURNING id`,
        [userId, message],
    );
    return rows[0].id as string;
}

async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

async function run(): Promise<void> {
    await cleanup();

    // Looked up live rather than hardcoded ('egg_slate'/'food_basic' are both
    // active=false in the current catalog - hardcoding them made every buy in this
    // suite 404 "not available" the first time this ran).
    const eggSku = await cheapestActiveSku('egg');
    const foodSku = await cheapestActiveSku('food');
    console.log(`  [concurrency] Live SKUs: egg=${eggSku.catalogKey}(${eggSku.price}, rule=${eggSku.priceRuleKey}), food=${foodSku.catalogKey}(${foodSku.price})`);

    const markets = await findMarkets();
    console.log(`Live market: ${markets.live.id}; resolved market: ${markets.resolved.id} (winner index ${markets.resolved.winningIndex})`);

    // =================================================================================
    // 1. Pick submit - one session, one Tank, N=8 identical submissions.
    //    functions/api/picks.ts's idempotency guard is the DB unique index
    //    idx_picks_waitlist_tank (waitlist_id, tank_page_id): a 23505 there maps to a
    //    409 "You already made this call." The daily-cap check is documented in the
    //    source itself as a count-then-insert race (not closed by a lock) - so under
    //    real simultaneity a loser can plausibly land on the cap's 429 instead of the
    //    unique-index's 409 depending on exactly when its count read lands relative to
    //    the winner's commit. Either way, the DB is unambiguous: at most one row.
    // =================================================================================
    section('1. Pick submit - N=8 identical submissions, exactly one row survives');
    const u1 = await createSessionUser(`${EMAIL_PREFIX}picks@example.com`);
    const tankSlug1 = `${SLUG_PREFIX}picks`;
    const tankId1 = await insertTank({ slug: tankSlug1, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.6, 0.4] });
    const results1 = await fireParallel({
        method: 'POST',
        path: '/api/picks',
        build: () => ({ body: { slug: tankSlug1, side: markets.live.outcomes[0], sideIndex: 0 }, headers: { Cookie: u1.cookie } }),
        n: 8,
    });
    check('exactly one 201', countStatus(results1, 201) === 1, JSON.stringify(tally(results1)));
    check(
        'the other 7 are conflict statuses (409 duplicate-index, or 429 cap-race per the documented race window)',
        results1.filter((r) => r.status !== 201).every((r) => r.status === 409 || r.status === 429),
        JSON.stringify(results1.map((r) => r.status)),
    );
    const { rows: pickRows1 } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1 AND tank_page_id = $2`,
        [u1.userId, tankId1],
    );
    check('exactly one row in picks for (waitlist_id, tank_page_id)', pickRows1[0].n === 1, JSON.stringify(pickRows1[0]));

    // =================================================================================
    // 2. Feed at ceiling - pet already at satisfaction 100, N=8 requests with DISTINCT
    //    feedTokens. The ceiling check in functions/api/pets/feed.ts runs BEFORE any
    //    write (current >= cfg.max_satisfaction -> 409), so every one of the 8 should
    //    be rejected before touching inventory - proven by the food quantity staying
    //    at exactly 1, not just by the response bodies.
    // =================================================================================
    section('2. Feed at ceiling - N=8 distinct feedTokens, all rejected, inventory untouched');
    const u2 = await createSessionUser(`${EMAIL_PREFIX}feed@example.com`);
    const petId2 = await insertPet(u2.userId);
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW() WHERE id = $1`, [petId2]);
    await insertFood(u2.userId, foodSku.catalogKey, 1);
    const results2 = await fireParallel({
        method: 'POST',
        path: '/api/pets/feed',
        build: () => ({ body: { foodCatalogKey: foodSku.catalogKey, feedToken: crypto.randomUUID() }, headers: { Cookie: u2.cookie } }),
        n: 8,
    });
    check(
        'all 8 rejected at the ceiling (409, full:true)',
        results2.every((r) => r.status === 409 && r.json?.full === true),
        JSON.stringify(tally(results2)),
    );
    const { rows: foodRows2 } = await pool.query(
        `SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`,
        [u2.userId, foodSku.catalogKey],
    );
    check('food quantity unchanged at 1', foodRows2[0]?.quantity === 1, JSON.stringify(foodRows2[0]));

    // =================================================================================
    // 2b. Feed, SAME feedToken, hungry pet - N=8 truly-simultaneous requests all
    //     carrying the IDENTICAL feedToken. lib/pages-functions/pets.ts's feed() now
    //     takes feedLock() (a pg_advisory_xact_lock, mirroring ledger.ts's spendLock())
    //     as its transaction's first statement specifically to close this race: without
    //     it, N simultaneous same-token requests could all take their snapshot before
    //     any commits, all see the OLD last_feed_token, and all pass the idempotency
    //     check - consuming N food units for what should have been one feed plus (N-1)
    //     no-op retries. With the lock, exactly one unit is ever consumed, no matter how
    //     many of the 8 identical requests raced in.
    // =================================================================================
    section('2b. Feed, SAME feedToken - N=8 simultaneous identical-token feeds, exactly one consumed');
    const u2b = await createSessionUser(`${EMAIL_PREFIX}feed-same-token@example.com`);
    const petId2b = await insertPet(u2b.userId);
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 20, last_fed_at = NOW() WHERE id = $1`, [petId2b]);
    await insertFood(u2b.userId, foodSku.catalogKey, 8); // enough stock that an unfixed race would visibly over-consume
    const sharedFeedToken = crypto.randomUUID();
    const results2b = await fireParallel({
        method: 'POST',
        path: '/api/pets/feed',
        build: () => ({ body: { foodCatalogKey: foodSku.catalogKey, feedToken: sharedFeedToken }, headers: { Cookie: u2b.cookie } }),
        n: 8,
    });
    check('exactly one 200 (the fresh feed)', countStatus(results2b, 200) === 1, JSON.stringify(tally(results2b)));
    const { rows: foodRows2b } = await pool.query(
        `SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`,
        [u2b.userId, foodSku.catalogKey],
    );
    check(
        'exactly one food unit consumed (8 -> 7), not one per racing request - feedLock() closes the same-token double-consume',
        foodRows2b[0]?.quantity === 7,
        `got ${foodRows2b[0]?.quantity}`,
    );
    const { rows: satRows2b } = await pool.query(`SELECT satisfaction_at_last_feed::float8 AS s FROM pets WHERE id = $1`, [petId2b]);
    check(
        'satisfaction rose by exactly one food unit\'s points, not stacked N times',
        Math.abs(satRows2b[0].s - (20 + Number(foodSku.config.satisfaction_points))) < 0.5,
        `got ${satRows2b[0].s}`,
    );

    // =================================================================================
    // 3. Egg buy, SAME purchaseToken - lib/pages-functions/ledger.ts's purchaseConsumable
    //    is idempotent-replay, not winner/loser: SpendResult.ok is true for BOTH a fresh
    //    spend AND a retried-but-already-recorded call (already_recorded || newly_spent),
    //    so functions/api/shop/buy.ts returns 200 for every one of the 8, not 402. The
    //    real proof is the ledger: exactly one spend row for the idempotency key
    //    `spend_egg_standard:<uid>:<token>` (buildIdempotencyKey's format), and exactly
    //    one granted egg row, regardless of how many of the 8 report success.
    // =================================================================================
    section('3. Egg buy, SAME purchaseToken - idempotent replay, single spend + single grant');
    const u3 = await createSessionUser(`${EMAIL_PREFIX}buy-same@example.com`);
    await setBalance(u3.userId, eggSku.price); // exactly the live egg SKU's price
    const token3 = crypto.randomUUID();
    const results3 = await fireParallel({
        method: 'POST',
        path: '/api/shop/buy',
        build: () => ({ body: { catalogKey: eggSku.catalogKey, purchaseToken: token3 }, headers: { Cookie: u3.cookie } }),
        n: 8,
    });
    check('all 8 return 200 (idempotent replay of the same token, not 402)', results3.every((r) => r.status === 200), JSON.stringify(tally(results3)));
    const grantedCount3 = results3.filter((r) => r.json?.item?.inventoryItemId).length;
    check(
        'exactly one response carries a fresh (non-null) inventoryItemId - the rest are null (replay)',
        grantedCount3 === 1,
        JSON.stringify(results3.map((r) => r.json?.item?.inventoryItemId)),
    );
    const idemKey3 = `${eggSku.priceRuleKey}:${u3.userId}:${token3}`;
    const { rows: ledger3 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE idempotency_key = $1`, [idemKey3]);
    check('exactly one spend row in ember_ledger for that idempotency key', ledger3[0].n === 1, JSON.stringify(ledger3[0]));
    const { rows: eggs3 } = await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND item_type = 'egg'`, [u3.userId]);
    check('exactly one egg row granted', eggs3[0].n === 1, JSON.stringify(eggs3[0]));
    const { rows: bal3 } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [u3.userId]);
    check('balance is exactly 0, never negative', bal3[0]?.balance === 0, `balance=${bal3[0]?.balance}`);

    // =================================================================================
    // 4. Egg buy, DISTINCT purchaseTokens, balance enough for exactly one - this
    //    re-proves ledger.ts's spendLock() advisory-xact-lock guard: without it, two
    //    truly-simultaneous spends can both pass the `balance >= amount` precheck under
    //    READ COMMITTED before either commits (spendLock's own comment documents this
    //    exact double-debit failure mode as previously observed live). With the lock,
    //    the balance must land at exactly 0, never negative, and exactly one spend row
    //    exists no matter how many of the 8 distinct tokens raced in.
    // =================================================================================
    section('4. Egg buy, DISTINCT purchaseTokens, balance for exactly one - spendLock re-proof');
    const u4 = await createSessionUser(`${EMAIL_PREFIX}buy-distinct@example.com`);
    await setBalance(u4.userId, eggSku.price);
    const results4 = await fireParallel({
        method: 'POST',
        path: '/api/shop/buy',
        build: () => ({ body: { catalogKey: eggSku.catalogKey, purchaseToken: crypto.randomUUID() }, headers: { Cookie: u4.cookie } }),
        n: 8,
    });
    check('exactly one 200', countStatus(results4, 200) === 1, JSON.stringify(tally(results4)));
    check('the other 7 are 402 (insufficient balance)', results4.filter((r) => r.status !== 200).every((r) => r.status === 402), JSON.stringify(tally(results4)));
    const { rows: ledger4 } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = $2`,
        [u4.userId, eggSku.priceRuleKey],
    );
    check('exactly one spend row (spendLock serialized the 8 distinct-token attempts)', ledger4[0].n === 1, JSON.stringify(ledger4[0]));
    const { rows: bal4 } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [u4.userId]);
    check('balance never went negative (lands at exactly 0)', bal4[0]?.balance === 0, `balance=${bal4[0]?.balance}`);
    const { rows: eggs4 } = await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND item_type = 'egg'`, [u4.userId]);
    check('exactly one egg granted', eggs4[0].n === 1, JSON.stringify(eggs4[0]));

    // =================================================================================
    // 5. Egg hatch, SAME egg row - lib/pages-functions/pets.ts's hatch() DELETEs the
    //    named inventory row and INSERTs the pet in one CTE-chained statement; the
    //    DELETE's row lock is the race guard (concurrent DELETEs on the same id
    //    serialize, and the loser's `consumed` CTE is empty once the winner's atomic
    //    delete+insert has committed). Egg B is a second, untouched row belonging to
    //    the same account - proving the guard is scoped to the named row, not the
    //    whole account's egg supply.
    // =================================================================================
    section('5. Egg hatch, SAME egg row - N=8, exactly one pet, the untargeted egg survives');
    const u5 = await createSessionUser(`${EMAIL_PREFIX}hatch-same@example.com`);
    const eggA5 = await insertEgg(u5.userId, 'egg_slate');
    const eggB5 = await insertEgg(u5.userId, 'egg_moss');
    const results5 = await fireParallel({
        method: 'POST',
        path: '/api/pets/hatch',
        build: () => ({ body: { inventoryItemId: eggA5 }, headers: { Cookie: u5.cookie } }),
        n: 8,
    });
    check('exactly one 201 (created:true)', countStatus(results5, 201) === 1, JSON.stringify(tally(results5)));
    // hatch.ts's own comment documents both loser shapes as correct: a loser whose DELETE
    // raced after the row was already gone re-checks for an existing pet and reports it
    // (200/created:false) - but if that re-check runs before the winner's own transaction
    // has committed, it legitimately sees no pet yet either and returns 404 ("You don't
    // have that egg to hatch."). Both are accepted per hatch.ts:73-81; only a SECOND 201,
    // or a 200/created:true for a pet that doesn't match the winner's, would be a bug.
    check(
        'the other 7 are 200 created:false, or (accepted per hatch.ts\'s documented race) 404',
        results5.filter((r) => r.status !== 201).every((r) => (r.status === 200 && r.json?.created === false) || r.status === 404),
        JSON.stringify(results5.map((r) => [r.status, r.json?.created])),
    );
    const { rows: petCount5 } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1`, [u5.userId]);
    check('exactly one pet row (COUNT(*) FROM pets)', petCount5[0].n === 1, JSON.stringify(petCount5[0]));
    const { rows: eggARow5 } = await pool.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [eggA5]);
    check('egg A\'s row is gone (consumed)', eggARow5.length === 0);
    const { rows: eggBRow5 } = await pool.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [eggB5]);
    check('egg B\'s row is UNTOUCHED (still present)', eggBRow5.length === 1);

    // =================================================================================
    // 6. Egg hatch, DIFFERENT egg rows (N=4 on A, N=4 on B, fired together) - the
    //    hardest of the two hatch races. hatch.ts's own comment claims a losing
    //    attempt's captain-uniqueness violation (idx_pets_one_captain, 23505) rolls
    //    back the WHOLE statement, so a losing group's DELETE is undone along with its
    //    failed pets INSERT - meaning the losing egg is never actually consumed even
    //    though a DELETE for it was issued and (temporarily) succeeded. If that claim
    //    is wrong, BOTH eggs would vanish while only one pet exists - flagged loudly
    //    below, not silently passed, per the task brief.
    // =================================================================================
    section('6. Egg hatch, DIFFERENT egg rows - N=4/N=4 together, exactly one pet, one egg must survive');
    const u6 = await createSessionUser(`${EMAIL_PREFIX}hatch-diff@example.com`);
    const eggA6 = await insertEgg(u6.userId, 'egg_slate');
    const eggB6 = await insertEgg(u6.userId, 'egg_moss');
    const results6 = await fireParallel({
        method: 'POST',
        path: '/api/pets/hatch',
        build: (i) => ({ body: { inventoryItemId: i < 4 ? eggA6 : eggB6 }, headers: { Cookie: u6.cookie } }),
        n: 8,
    });
    // Same accepted-race shape as test 5: a loser whose re-check for an existing pet
    // runs before the winner's transaction commits legitimately sees no pet yet either
    // and gets 404, per hatch.ts:73-81.
    check(
        'exactly one 201 across both groups, rest 200 created:false or (accepted race) 404',
        countStatus(results6, 201) === 1 && results6.filter((r) => r.status !== 201).every((r) => (r.status === 200 && r.json?.created === false) || r.status === 404),
        JSON.stringify(results6.map((r) => [r.status, r.json?.created])),
    );
    const { rows: petCount6 } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1`, [u6.userId]);
    check('exactly one pet total, no matter which egg won', petCount6[0].n === 1, JSON.stringify(petCount6[0]));
    const { rows: survivors6 } = await pool.query(`SELECT id FROM inventory_items WHERE id = ANY($1)`, [[eggA6, eggB6]]);
    if (survivors6.length === 0) {
        check(
            'CRITICAL BUG: both eggs were consumed while only one pet exists - hatch.ts\'s "losing attempt rolls back the whole statement" claim does NOT hold under real parallelism',
            false,
            `eggA=${eggA6} eggB=${eggB6} pets=${petCount6[0].n}`,
        );
    } else {
        check(
            'exactly one egg survives (the losing group\'s DELETE was rolled back together with its failed pets INSERT, as hatch.ts claims)',
            survivors6.length === 1,
            JSON.stringify(survivors6),
        );
    }

    // =================================================================================
    // 7. Settlement - one pending fixture pick (real resolved market) plus one pending
    //    hand-inserted tag, N=3 (not 8 - politeness to the live Gamma/CLOB API this
    //    endpoint calls per pick/tag it processes). settleCall()'s picks UPDATE is
    //    guarded by `result IS NULL`, its ledger insert by an independent idempotency
    //    key, and its notification insert by the same key again - three independently
    //    idempotent legs in one transaction, so however the 3 concurrent runs interleave,
    //    exactly one of each should land.
    // =================================================================================
    section('7. Settlement - N=3 simultaneous /api/settle, one pending pick + one pending tag');
    const W = markets.resolved.winningIndex;
    const settlePrices: [number, number] = W === 0 ? [0.9, 0.1] : [0.1, 0.9];
    const tankSlug7a = `${SLUG_PREFIX}settle-pick`;
    const tankId7a = await insertTank({ slug: tankSlug7a, marketId: markets.resolved.id, outcomes: markets.resolved.outcomes, outcomePrices: settlePrices });
    const { userId: u7Id, pickId: pick7Id } = await insertUserWithPick(`${EMAIL_PREFIX}settle@example.com`, tankId7a, tankSlug7a, W, 0.5);
    const tankSlug7b = `${SLUG_PREFIX}settle-tag`;
    const tankId7b = await insertTank({ slug: tankSlug7b, marketId: markets.resolved.id, outcomes: markets.resolved.outcomes, outcomePrices: settlePrices });
    const tag7Id = await insertTagDirect(tankId7b, 'dogs', W, 1.5);

    const results7 = await fireParallel({
        method: 'POST',
        path: '/api/settle',
        build: () => ({ headers: { 'X-Settle-Secret': SETTLE_SECRET } }),
        n: 3,
    });
    check('all 3 settle calls -> 200', results7.every((r) => r.status === 200), JSON.stringify(tally(results7)));

    const idemKey7 = `correct_call:${u7Id}:call:${pick7Id}`;
    const { rows: ledger7 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE idempotency_key = $1`, [idemKey7]);
    check('exactly one settlement ledger row for this pick\'s idempotency key', ledger7[0].n === 1, JSON.stringify(ledger7[0]));
    const { rows: pickRow7 } = await pool.query(`SELECT result FROM picks WHERE id = $1`, [pick7Id]);
    check('picks.result settled to a single consistent value (correct - outcome_index was set to the real winner)', pickRow7[0]?.result === 'correct', `got ${pickRow7[0]?.result}`);
    const { rows: notes7 } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE idempotency_key = $1`, [`settle:call:${pick7Id}`]);
    check('exactly one settle:call:<pickId> notification', notes7[0].n === 1, JSON.stringify(notes7[0]));

    // Belt-and-suspenders on the pending tag riding along in the same concurrent runs.
    const { rows: tagRow7 } = await pool.query(`SELECT calculated_at FROM ticker_tags WHERE id = $1`, [tag7Id]);
    check('the pending tag also settled exactly once (calculated_at stamped)', tagRow7[0]?.calculated_at != null);
    const { rows: tagEvents7 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ticker_events WHERE ticker_tag_id = $1 AND event_type = 'settle'`, [tag7Id]);
    check('exactly one settle event for the tag', tagEvents7[0].n === 1, JSON.stringify(tagEvents7[0]));

    // =================================================================================
    // 8. Ticker tag - one Tank, N=4 simultaneous tag requests for the same
    //    (tank, ticker_key). functions/api/ticker-tags.ts has a friendly pre-check SELECT
    //    (racy by its own comment) backed by the real guarantee: the UNIQUE
    //    (tank_id, ticker_key) index, whose 23505 also maps to 409 already_tagged. This
    //    is suites/tickers.ts's existing single-attempt duplicate check, re-proven here
    //    under genuine simultaneity rather than sequential repetition.
    // =================================================================================
    section('8. Ticker tag - N=4 simultaneous for the same (tank, tickerKey)');
    const tankSlug8 = `${SLUG_PREFIX}tag`;
    const tankId8 = await insertTank({ slug: tankSlug8, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });
    const results8 = await fireParallel({
        method: 'POST',
        path: '/api/ticker-tags',
        build: () => ({ body: { slug: tankSlug8, tickerKey: 'dogs', relevantSide: 1 }, headers: { 'X-Ticker-Secret': TICKER_SECRET } }),
        n: 4,
    });
    check('exactly one 201', countStatus(results8, 201) === 1, JSON.stringify(tally(results8)));
    check(
        'the other 3 are 409 already_tagged',
        results8.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.json?.code === 'already_tagged'),
        JSON.stringify(results8.map((r) => [r.status, r.json?.code])),
    );
    const { rows: tagRows8 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ticker_tags WHERE tank_id = $1 AND ticker_key = 'dogs'`, [tankId8]);
    check('exactly one row in ticker_tags for the pair', tagRows8[0].n === 1, JSON.stringify(tagRows8[0]));

    // =================================================================================
    // 9. Notification claim - one claimable notification, N=8 simultaneous claims for
    //    the same id. functions/api/notifications/claim.ts's UPDATE uses
    //    `claimed_at = COALESCE(claimed_at, NOW())`, which is write-once by
    //    construction: whichever request's UPDATE actually lands first stamps the real
    //    timestamp, and every other request's UPDATE (concurrent or not) can only ever
    //    read that same already-set value back via RETURNING - so all 8 responses
    //    should report the identical claimedAt, not each other's local NOW().
    // =================================================================================
    section('9. Notification claim - N=8 simultaneous, single consistent claimed_at, no Ember change');
    const u9 = await createSessionUser(`${EMAIL_PREFIX}claim@example.com`);
    const noteId9 = await insertClaimableNotification(u9.userId, 'Acceptance concurrency claim test.');
    const before9 = await ledgerTotals(u9.userId);
    const results9 = await fireParallel({
        method: 'POST',
        path: '/api/notifications/claim',
        build: () => ({ body: { id: noteId9 }, headers: { Cookie: u9.cookie } }),
        n: 8,
    });
    check('all 8 return 200 (claim is idempotent/presentational)', results9.every((r) => r.status === 200), JSON.stringify(tally(results9)));
    const distinctClaimedAt9 = new Set(results9.map((r) => r.json?.claimedAt));
    check(
        'all 8 responses report the SAME claimedAt (not silently overwritten by a later concurrent writer)',
        distinctClaimedAt9.size === 1,
        JSON.stringify([...distinctClaimedAt9]),
    );
    const { rows: claimedRow9 } = await pool.query(`SELECT claimed_at FROM notifications WHERE id = $1`, [noteId9]);
    check('the stored claimed_at is non-null (write-once, per COALESCE)', claimedRow9[0]?.claimed_at != null, JSON.stringify(claimedRow9[0]));
    const after9 = await ledgerTotals(u9.userId);
    check(
        'no Ember/grant totals changed from claiming (claim moves no Ember)',
        after9.balanceCache === before9.balanceCache && after9.ledgerSum === before9.ledgerSum && after9.ledgerRows === before9.ledgerRows,
        JSON.stringify({ before: before9, after: after9 }),
    );

    // =================================================================================
    // 10. Login token double-consume - one minted login token, N=8 simultaneous
    //     /api/login/consume calls with the SAME token. consume.ts's single-use guard is
    //     the UPDATE's WHERE clause (login_nonce = <token's nonce> AND not-expired),
    //     which NULLs the nonce as part of the same statement - a second concurrent
    //     match against the same pre-NULL nonce is only possible if the guard is not
    //     atomic. fireParallel's ParallelResult doesn't carry response headers (only
    //     status/json), so the winner's Set-Cookie itself isn't observable here; the
    //     DB is the real ground truth anyway - sessions actually created for this user
    //     is what would show a fixation/double-session bug, not the header count.
    // =================================================================================
    section('10. Login token double-consume - N=8 simultaneous consumes of ONE token');
    const { userId: u10Id } = await createUser(`${EMAIL_PREFIX}login@example.com`);
    const token10 = await mintLoginToken(u10Id);
    const results10 = await fireParallel({
        method: 'POST',
        path: '/api/login/consume',
        build: () => ({ body: { token: token10 } }),
        n: 8,
    });
    check('exactly one 200', countStatus(results10, 200) === 1, JSON.stringify(tally(results10)));
    check('the other 7 are 400 ("already used or replaced")', results10.filter((r) => r.status !== 200).every((r) => r.status === 400), JSON.stringify(tally(results10)));
    check(
        'the single winner\'s body carries userId/verified (a real success, not an empty 200)',
        results10.find((r) => r.status === 200)?.json?.userId === u10Id && results10.find((r) => r.status === 200)?.json?.verified === true,
    );
    const { rows: sessions10 } = await pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1`, [u10Id]);
    if (sessions10[0].n > 1) {
        check(
            `CRITICAL BUG: ${sessions10[0].n} sessions were created from ONE login token under concurrency - the single-use nonce guard in login/consume.ts did not hold`,
            false,
            JSON.stringify(sessions10[0]),
        );
    } else {
        check('exactly one session row created for this user (COUNT(*) FROM sessions)', sessions10[0].n === 1, JSON.stringify(sessions10[0]));
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'concurrency',
    requiredEnv: ['SETTLE_SECRET', 'TICKER_SECRET', 'SESSION_TOKEN_SECRET'],
    run,
};
