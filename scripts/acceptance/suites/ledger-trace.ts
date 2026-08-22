// Acceptance suite: walks ONE fixture account through the entire product loop -
// signup -> onboarding -> pick -> settlement -> shop -> hatch -> feed -> discovery ->
// ticker isolation - asserting after EVERY state-changing step that the Ember ledger
// (ember_ledger, append-only) and the cached balance (ember_balances, a derived cache
// per lib/pages-functions/ledger.ts's header comment) never drift apart. A second
// account (acceptance-trace-loss) exists only to prove the LOSS payout path
// (participation) independently, without disturbing the win account's trace.
//
// This is a cross-system regression net, not a per-endpoint spec test (those live in
// suites/tickers.ts and suites/discovery.ts already) - its whole reason to exist is to
// catch drift that only shows up when features compose in sequence on one account.

import { pool, api, check, warn, section, type Suite } from '../harness';
import {
    createUser, mintSessionCookie, ledgerTotals,
    insertTank, findMarkets, insertTagDirect, settleEventDelta,
    flipConfig, restoreConfig, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix,
} from '../fixtures';

const EMAIL_PREFIX = 'acceptance-trace-';
const SLUG_PREFIX = 'acceptance-trace-';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';

const settlePost = () => api('POST', '/api/settle', { headers: { 'X-Settle-Secret': SETTLE_SECRET } });

async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

// ---------------------------------------------------------------------------------
// The core invariant, checked after every single state-changing step: the ledger's
// SUM(amount) for this user must always equal both the ember_balances cache and what
// GET /api/balance reports. Printed as a running trace line so the phase's deliverable
// (the printed trace) is visible even when every check passes.
// ---------------------------------------------------------------------------------

// Per-user running total, so the printed trace shows the delta each step actually
// moved rather than just the cumulative sum every time.
const lastSeenSum = new Map<string, number>();

async function assertLedgerConsistent(userId: string, cookie: string, label: string): Promise<void> {
    const { balanceCache, ledgerSum } = await ledgerTotals(userId);

    // cached === ledgerSum covers the normal case (a row exists and agrees). The only
    // legitimate way for balanceCache to be null is "no ember_balances row was ever
    // written for this user" - which can only be consistent when the ledger truly has
    // nothing in it either. Coercing null to 0 here would silently paper over a real
    // bug (a ledger row landing without its balance-cache fold ever happening).
    const consistent = balanceCache === ledgerSum || (balanceCache === null && ledgerSum === 0);
    check(`${label}: cached balance == SUM(ledger)`, consistent, `cached=${balanceCache} sum=${ledgerSum}`);

    const balRes = await api('GET', '/api/balance', { cookie });
    if (balRes.status === 200) {
        check(`${label}: GET /api/balance matches ledger sum`, balRes.json?.balance === ledgerSum, `api=${balRes.json?.balance} sum=${ledgerSum}`);
    } else {
        // functions/api/balance.ts gates on requireOnboarded - a pre-onboarding account
        // (the very first step of this trace) gets 403 here, not a balance. That's
        // expected behavior, not a ledger inconsistency, as long as the ledger is
        // genuinely still empty at that point.
        check(`${label}: GET /api/balance gated pre-onboarding (status ${balRes.status}), ledger still empty`, ledgerSum === 0, `status=${balRes.status} sum=${ledgerSum}`);
    }

    check(`${label}: ledger sum never negative`, ledgerSum >= 0, `sum=${ledgerSum}`);

    const prev = lastSeenSum.get(userId) ?? 0;
    const delta = ledgerSum - prev;
    lastSeenSum.set(userId, ledgerSum);
    console.log(`  TRACE  ${label.padEnd(46)} delta=${delta >= 0 ? '+' : ''}${delta}  ledgerSum=${ledgerSum}  cached=${balanceCache}`);
}

// ---------------------------------------------------------------------------------
// Fixture-local helpers
// ---------------------------------------------------------------------------------

interface TraceUser { userId: string; cookie: string }

async function signUp(email: string): Promise<TraceUser> {
    const { userId } = await createUser(email, { onboarded: false });
    const cookie = await mintSessionCookie(userId);
    return { userId, cookie };
}

async function onboard(user: TraceUser, username: string): Promise<void> {
    const res = await api('POST', '/api/onboarding/complete', { cookie: user.cookie, body: { username } });
    check(`onboarding/complete -> 200 for ${username}`, res.status === 200 && res.json?.username === username, JSON.stringify(res.json));
}

async function emberBalancesRowExists(userId: string): Promise<boolean> {
    const { rows } = await pool.query(`SELECT 1 FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length > 0;
}

async function pickIdFor(userId: string, tankId: string): Promise<string> {
    const { rows } = await pool.query(`SELECT id FROM picks WHERE waitlist_id = $1 AND tank_page_id = $2 LIMIT 1`, [userId, tankId]);
    if (rows.length === 0) throw new Error('Expected pick row not found.');
    return rows[0].id as string;
}

// The live active price for a sink rule (spend_egg_standard, spend_food_basic, ...),
// read from the DB rather than hardcoded - per the task's instruction not to assume a
// price that could be retuned by a future ember_rules version-flip.
interface SkuInfo { catalogKey: string; priceRuleKey: string; price: number }
async function cheapestActiveSku(itemType: 'egg' | 'food'): Promise<SkuInfo> {
    const { rows } = await pool.query(
        `SELECT c.key AS catalog_key, c.price_rule_key, (r.config->>'amount')::int AS price
         FROM items_catalog c
         JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
         WHERE c.item_type = $1 AND c.active = true
           AND (c.available_from IS NULL OR c.available_from <= NOW())
           AND (c.available_until IS NULL OR c.available_until > NOW())
         ORDER BY (r.config->>'amount')::int ASC
         LIMIT 1`,
        [itemType],
    );
    if (rows.length === 0) throw new Error(`No active ${itemType} SKU found - seed the catalog first.`);
    return { catalogKey: rows[0].catalog_key as string, priceRuleKey: rows[0].price_rule_key as string, price: Number(rows[0].price) };
}

async function activeRuleAmount(ruleKey: string): Promise<number> {
    const { rows } = await pool.query(`SELECT config FROM ember_rules WHERE key = $1 AND active = true LIMIT 1`, [ruleKey]);
    if (rows.length === 0) throw new Error(`No active ember_rules row for "${ruleKey}"`);
    return Number((rows[0].config as Record<string, number>).amount);
}

async function activeCorrectCallConfig(): Promise<{ base: number; cap: number }> {
    const { rows } = await pool.query(`SELECT config FROM ember_rules WHERE key = 'correct_call' AND active = true LIMIT 1`);
    if (rows.length === 0) throw new Error('No active ember_rules row for "correct_call"');
    const cfg = rows[0].config as Record<string, number>;
    return { base: Number(cfg.base), cap: Number(cfg.cap) };
}

// Mirrors ledger.ts's private correctCallPayout() exactly: round(base * min(1/p, cap)).
function correctCallPayout(base: number, cap: number, impliedProb: number): number {
    return Math.round(base * Math.min(1 / impliedProb, cap));
}

async function rewindPetForRoll(petId: string): Promise<void> {
    await pool.query(`UPDATE pets SET next_eligible_roll_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [petId]);
}

async function latestClaimableNotificationId(userId: string): Promise<string | null> {
    const { rows } = await pool.query(
        `SELECT id FROM notifications WHERE user_id = $1 AND type = 'claimable' ORDER BY created_at DESC LIMIT 1`,
        [userId],
    );
    return rows.length ? (rows[0].id as string) : null;
}

// ---------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------

async function run(): Promise<void> {
    await cleanup();

    const markets = await findMarkets();
    const W = markets.resolved.winningIndex;
    const L = 1 - W;
    const winSide = markets.resolved.outcomes[W];
    const lossSide = markets.resolved.outcomes[L];
    console.log(`Resolved market: ${markets.resolved.id} (winner index ${W}: "${winSide}")`);

    // One shared Tank for both accounts - "same market, opposite side" per the plan.
    // Both accounts picking the same tank_page_id is fine: the uniqueness constraint is
    // (waitlist_id, tank_page_id), not per-tank-per-account-in-isolation.
    const tankSlug = `${SLUG_PREFIX}market`;
    const tankId = await insertTank({
        slug: tankSlug,
        marketId: markets.resolved.id,
        outcomes: markets.resolved.outcomes,
        outcomePrices: [0.5, 0.5],
    });

    // =================================================================================
    section('0-1: Sign up + onboard (win + loss accounts)');
    // =================================================================================
    const win = await signUp(`${EMAIL_PREFIX}win@example.com`);
    const loss = await signUp(`${EMAIL_PREFIX}loss@example.com`);

    for (const [label, u] of [['win', win], ['loss', loss]] as const) {
        const totals = await ledgerTotals(u.userId);
        check(`0 (${label}): zero ledger rows at signup`, totals.ledgerRows === 0 && totals.ledgerSum === 0, JSON.stringify(totals));
        // Explicit raw query, not just ledgerTotals's null coercion - proves the
        // ember_balances row is genuinely ABSENT, not present-with-balance-0.
        const rowExists = await emberBalancesRowExists(u.userId);
        check(`0 (${label}): ember_balances row absent (not present-with-0)`, rowExists === false);
        await assertLedgerConsistent(u.userId, u.cookie, `0 (${label}): signed up`);
    }

    await onboard(win, 'acceptancetracewin');
    await onboard(loss, 'acceptancetraceloss');
    for (const [label, u] of [['win', win], ['loss', loss]] as const) {
        // functions/api/onboarding/complete.ts's header comment: "no pet, no starter
        // item, no bonus Ember is provisioned here or anywhere else on first login" -
        // verified directly against the actual route above, so this asserts that claim
        // against real behavior rather than trusting the comment.
        const totals = await ledgerTotals(u.userId);
        check(`1 (${label}): onboarding grants zero Ember`, totals.ledgerRows === 0 && totals.ledgerSum === 0, JSON.stringify(totals));
        await assertLedgerConsistent(u.userId, u.cookie, `1 (${label}): onboarded`);
    }

    // =================================================================================
    section('2: Make a pick (win account) - picks pay nothing at submission');
    // =================================================================================
    const winPickRes = await api('POST', '/api/picks', { cookie: win.cookie, body: { slug: tankSlug, side: winSide, sideIndex: W } });
    check('2: pick submitted -> 201', winPickRes.status === 201, JSON.stringify(winPickRes.json));
    const winPickId = await pickIdFor(win.userId, tankId);
    await assertLedgerConsistent(win.userId, win.cookie, '2: win pick submitted (unsettled)');

    // =================================================================================
    section('3: Settle a WIN, then re-settle for idempotency');
    // =================================================================================
    const { base, cap } = await activeCorrectCallConfig();
    const expectedWinPayout = correctCallPayout(base, cap, 0.5);

    const settle1 = await settlePost();
    check('3: POST /api/settle -> 200', settle1.status === 200, JSON.stringify(settle1.json)?.slice(0, 300));
    const winResult1 = settle1.json?.results?.find((r: any) => r.pickId === winPickId);
    check(`3: win pick settled_correct, payout ${expectedWinPayout} (base=${base} cap=${cap})`,
        winResult1?.status === 'settled_correct' && winResult1?.payoutAmount === expectedWinPayout, JSON.stringify(winResult1));
    const { rows: winPickRow } = await pool.query(`SELECT result FROM picks WHERE id = $1`, [winPickId]);
    check("3: picks.result == 'correct'", winPickRow[0]?.result === 'correct', JSON.stringify(winPickRow[0]));
    const { rows: winLedgerRow } = await pool.query(
        `SELECT amount, entry_type, rule_key FROM ember_ledger WHERE user_id = $1 AND rule_key = 'correct_call'`, [win.userId]);
    check(`3: exactly one correct_call ledger row, amount=+${expectedWinPayout}, entry_type='earn'`,
        winLedgerRow.length === 1 && winLedgerRow[0].amount === expectedWinPayout && winLedgerRow[0].entry_type === 'earn', JSON.stringify(winLedgerRow));
    await assertLedgerConsistent(win.userId, win.cookie, '3: win settled');

    const totalsBeforeReplay = await ledgerTotals(win.userId);
    const settle2 = await settlePost();
    const winResult2 = settle2.json?.results?.find((r: any) => r.pickId === winPickId);
    check('3: re-settle no longer sees the win pick as pending (idempotent)', winResult2 === undefined, JSON.stringify(winResult2));
    const totalsAfterReplay = await ledgerTotals(win.userId);
    check('3: re-settle - ledger byte-identical (rows, sum, cache all unchanged)',
        totalsAfterReplay.ledgerRows === totalsBeforeReplay.ledgerRows
        && totalsAfterReplay.ledgerSum === totalsBeforeReplay.ledgerSum
        && totalsAfterReplay.balanceCache === totalsBeforeReplay.balanceCache,
        `before=${JSON.stringify(totalsBeforeReplay)} after=${JSON.stringify(totalsAfterReplay)}`);
    await assertLedgerConsistent(win.userId, win.cookie, '3: win settled (idempotent replay)');

    // =================================================================================
    section('3b: Settle a LOSS (separate account, same market, opposite side)');
    // =================================================================================
    const lossPickRes = await api('POST', '/api/picks', { cookie: loss.cookie, body: { slug: tankSlug, side: lossSide, sideIndex: L } });
    check('3b: loss pick submitted -> 201', lossPickRes.status === 201, JSON.stringify(lossPickRes.json));
    const lossPickId = await pickIdFor(loss.userId, tankId);
    await assertLedgerConsistent(loss.userId, loss.cookie, '3b: loss pick submitted (unsettled)');

    const participationAmount = await activeRuleAmount('participation');
    const settle3 = await settlePost();
    const lossResult = settle3.json?.results?.find((r: any) => r.pickId === lossPickId);
    check(`3b: loss pick settled_incorrect, payout == live participation.amount (${participationAmount})`,
        lossResult?.status === 'settled_incorrect' && lossResult?.payoutAmount === participationAmount, JSON.stringify(lossResult));
    const { rows: lossPickRow } = await pool.query(`SELECT result FROM picks WHERE id = $1`, [lossPickId]);
    check("3b: picks.result == 'incorrect'", lossPickRow[0]?.result === 'incorrect', JSON.stringify(lossPickRow[0]));
    const { rows: lossLedgerRow } = await pool.query(
        `SELECT amount, entry_type, rule_key FROM ember_ledger WHERE user_id = $1 AND rule_key = 'participation'`, [loss.userId]);
    check(`3b: exactly one participation ledger row, amount=+${participationAmount} (losses still pay), entry_type='earn'`,
        lossLedgerRow.length === 1 && lossLedgerRow[0].amount === participationAmount && lossLedgerRow[0].entry_type === 'earn', JSON.stringify(lossLedgerRow));
    await assertLedgerConsistent(loss.userId, loss.cookie, '3b: loss settled');

    // =================================================================================
    section('4: Top-up (test-only adjustment) - bridge win balance up to afford the shop');
    // =================================================================================
    const egg = await cheapestActiveSku('egg');
    const food = await cheapestActiveSku('food');
    const preTopup = await ledgerTotals(win.userId);
    const buffer = 10; // leaves a comfortable positive remainder after buying both SKUs below
    const needed = egg.price + food.price + buffer - preTopup.ledgerSum;
    if (needed > 0) {
        const idempotencyKey = `acceptance-topup:${win.userId}`;
        // Hand-inserted, but replicating post()'s exact CTE shape (lib/pages-functions/
        // ledger.ts) so the ledger row and the ember_balances fold are one atomic
        // statement, never two - never write ember_balances without a matching
        // ember_ledger row landing in the SAME statement. rule_key='participation'
        // version=1 is an existing (inactive) ember_rules row, referenced purely to
        // satisfy the ember_ledger -> ember_rules FK; entry_type is what actually marks
        // this as a test-only adjustment, not the rule it's FK'd to.
        await pool.query(
            `WITH ins AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                VALUES ($1, $2, 'adjustment', 'participation', 1, $3, '{"acceptance":"ledger-trace test-only topup to afford shop purchases"}')
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING amount
            )
            INSERT INTO ember_balances (user_id, balance, updated_at)
            SELECT $1, amount, NOW() FROM ins
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
            [win.userId, needed, idempotencyKey],
        );
    } else {
        warn(`4: win balance (${preTopup.ledgerSum}) already covers egg+food - skipping topup adjustment`);
    }
    const postTopup = await ledgerTotals(win.userId);
    check('4: topup landed exactly the needed adjustment', postTopup.ledgerSum === preTopup.ledgerSum + Math.max(needed, 0), `pre=${preTopup.ledgerSum} post=${postTopup.ledgerSum} needed=${needed}`);
    await assertLedgerConsistent(win.userId, win.cookie, '4: test-only topup adjustment');

    // =================================================================================
    section(`5: Buy an egg (${egg.catalogKey}, price ${egg.price})`);
    // =================================================================================
    const preEgg = await ledgerTotals(win.userId);
    const buyEggRes = await api('POST', '/api/shop/buy', { cookie: win.cookie, body: { catalogKey: egg.catalogKey, purchaseToken: crypto.randomUUID() } });
    check('5: egg purchase -> 200', buyEggRes.status === 200 && typeof buyEggRes.json?.item?.inventoryItemId === 'string', JSON.stringify(buyEggRes.json));
    const eggInventoryId = buyEggRes.json.item.inventoryItemId as string;
    const postEgg = await ledgerTotals(win.userId);
    check('5: exact debit == egg price', postEgg.ledgerSum === preEgg.ledgerSum - egg.price, `pre=${preEgg.ledgerSum} post=${postEgg.ledgerSum} price=${egg.price}`);
    const { rows: eggLedgerRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = $2`, [win.userId, egg.priceRuleKey]);
    check('5: exactly one egg-purchase ledger row', eggLedgerRows[0].n === 1, JSON.stringify(eggLedgerRows[0]));
    await assertLedgerConsistent(win.userId, win.cookie, '5: egg purchased');

    // =================================================================================
    section('6: Hatch - free, zero Ember movement');
    // =================================================================================
    const preHatch = await ledgerTotals(win.userId);
    const hatchRes = await api('POST', '/api/pets/hatch', { cookie: win.cookie, body: { inventoryItemId: eggInventoryId } });
    check('6: hatch -> 201 created', hatchRes.status === 201 && hatchRes.json?.created === true, JSON.stringify(hatchRes.json));
    const petId = hatchRes.json?.pet?.id as string;
    const postHatch = await ledgerTotals(win.userId);
    check('6: hatching moved zero Ember', postHatch.ledgerSum === preHatch.ledgerSum, `pre=${preHatch.ledgerSum} post=${postHatch.ledgerSum}`);
    const { rows: petRows } = await pool.query(`SELECT id FROM pets WHERE user_id = $1`, [win.userId]);
    check('6: pet exists', petRows.length === 1 && petRows[0].id === petId);
    const { rows: eggGoneRows } = await pool.query(`SELECT 1 FROM inventory_items WHERE id = $1`, [eggInventoryId]);
    check('6: consumed egg row is gone', eggGoneRows.length === 0);
    await assertLedgerConsistent(win.userId, win.cookie, '6: hatched');

    // =================================================================================
    section(`7: Buy food (${food.catalogKey}, price ${food.price}), then feed - the cross-system check`);
    // =================================================================================
    const preFood = await ledgerTotals(win.userId);
    const buyFoodRes = await api('POST', '/api/shop/buy', { cookie: win.cookie, body: { catalogKey: food.catalogKey, purchaseToken: crypto.randomUUID() } });
    check('7: food purchase -> 200, quantity 1', buyFoodRes.status === 200 && buyFoodRes.json?.item?.quantity === 1, JSON.stringify(buyFoodRes.json));
    const postFood = await ledgerTotals(win.userId);
    check('7: exact debit == food price', postFood.ledgerSum === preFood.ledgerSum - food.price, `pre=${preFood.ledgerSum} post=${postFood.ledgerSum} price=${food.price}`);
    await assertLedgerConsistent(win.userId, win.cookie, '7: food purchased');

    // ROUTE/SHAPE NOTE: game_config['feeding'].hatch_start_satisfaction == max_satisfaction
    // (both 100, per create_game_config_table.sql) - a freshly hatched pet is ALREADY at
    // the feed ceiling, so an immediate feed would be rejected 409 before ever touching
    // the ledger. Force a known sub-max satisfaction directly first (same fixture idiom
    // suites/pets.ts and suites/discovery.ts already use for this), purely to reach the
    // feed code path - this does not touch ember_ledger.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 50, last_fed_at = NOW() WHERE id = $1`, [petId]);
    const preFeed = await ledgerTotals(win.userId);
    const feedRes = await api('POST', '/api/pets/feed', { cookie: win.cookie, body: { foodCatalogKey: food.catalogKey, feedToken: crypto.randomUUID() } });
    check('7: feed -> 200', feedRes.status === 200, JSON.stringify(feedRes.json));
    const postFeed = await ledgerTotals(win.userId);
    check('7: feeding moved zero Ember (spends inventory, not the ledger)', postFeed.ledgerSum === preFeed.ledgerSum, `pre=${preFeed.ledgerSum} post=${postFeed.ledgerSum}`);
    const { rows: foodQtyRows } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'food'`, [win.userId, food.catalogKey]);
    check('7: food quantity decremented to 0 (item consumed, not Ember)', foodQtyRows.length === 1 && foodQtyRows[0].quantity === 0, JSON.stringify(foodQtyRows));
    await assertLedgerConsistent(win.userId, win.cookie, '7: fed');

    // =================================================================================
    section('8: Discovery claim - ember find grants, food find does not, claim is presentational');
    // =================================================================================
    try {
        await rewindPetForRoll(petId);
        await flipConfig('discovery', { weight_ember: 1000, weight_food: 0, weight_collectible: 0 });
        const preEmberFind = await ledgerTotals(win.userId);
        const emberFindRes = await api('GET', '/api/toolbar-state', { cookie: win.cookie });
        check('8: toolbar-state (forced ember weighting) -> 200', emberFindRes.status === 200, JSON.stringify(emberFindRes.json)?.slice(0, 300));
        const postEmberFind = await ledgerTotals(win.userId);
        const emberDelta = postEmberFind.ledgerSum - preEmberFind.ledgerSum;
        check('8: discovery ember find landed a ledger row within configured 1-5', emberDelta >= 1 && emberDelta <= 5, `delta=${emberDelta}`);
        const { rows: discoveryRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find'`, [win.userId]);
        check('8: exactly one discovery_find ledger row so far', discoveryRows[0].n === 1, JSON.stringify(discoveryRows[0]));
        await assertLedgerConsistent(win.userId, win.cookie, '8: discovery ember find');
    } finally {
        await restoreConfig('discovery');
    }

    try {
        await rewindPetForRoll(petId);
        await flipConfig('discovery', { weight_ember: 0, weight_food: 1000, weight_collectible: 0 });
        const preFoodFind = await ledgerTotals(win.userId);
        const foodFindRes = await api('GET', '/api/toolbar-state', { cookie: win.cookie });
        check('8: toolbar-state (forced food weighting) -> 200', foodFindRes.status === 200, JSON.stringify(foodFindRes.json)?.slice(0, 300));
        const postFoodFind = await ledgerTotals(win.userId);
        check('8: discovery food find moved zero Ember', postFoodFind.ledgerSum === preFoodFind.ledgerSum, `pre=${preFoodFind.ledgerSum} post=${postFoodFind.ledgerSum}`);
        await assertLedgerConsistent(win.userId, win.cookie, '8: discovery food find (no ember)');
    } finally {
        await restoreConfig('discovery');
    }

    const claimTargetId = await latestClaimableNotificationId(win.userId);
    check('8: a claimable notification exists to claim', typeof claimTargetId === 'string');
    if (claimTargetId) {
        const preClaim = await ledgerTotals(win.userId);
        const claimRes = await api('POST', '/api/notifications/claim', { cookie: win.cookie, body: { id: claimTargetId } });
        check('8: claim -> 200', claimRes.status === 200, JSON.stringify(claimRes.json));
        const postClaim = await ledgerTotals(win.userId);
        check('8: claim is presentational - SUM(ember_ledger) unchanged by the claim itself', postClaim.ledgerSum === preClaim.ledgerSum, `pre=${preClaim.ledgerSum} post=${postClaim.ledgerSum}`);
        await assertLedgerConsistent(win.userId, win.cookie, '8: notification claimed');
    }

    // =================================================================================
    section('9: Ticker isolation - settlement of a tagged Tank must never touch the Ember ledger');
    // =================================================================================
    const tagId = await insertTagDirect(tankId, 'dogs', L, 1.5);
    const { rows: phaseStartRows } = await pool.query(`SELECT NOW() AS ts`);
    const phaseStart = phaseStartRows[0].ts;
    const settle4 = await settlePost();
    check('9: settle (tag pass) -> 200', settle4.status === 200, JSON.stringify(settle4.json)?.slice(0, 300));
    const tagDelta = await settleEventDelta(tagId);
    check('9: ticker_events gained a row for the tag', tagDelta !== null, `delta=${tagDelta}`);
    const { rows: ledgerSinceRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND created_at > $2`, [win.userId, phaseStart]);
    check('9: zero new ember_ledger rows for this user from ticker settlement', ledgerSinceRows[0].n === 0, JSON.stringify(ledgerSinceRows[0]));
    await assertLedgerConsistent(win.userId, win.cookie, '9: ticker tag settled (isolation)');

    // System-wide isolation proof, not just this one account: no ember_ledger row
    // anywhere should ever carry a ticker-shaped rule_key or a tickerKey metadata field -
    // the ticker layer and the Ember ledger are structurally disjoint write paths.
    const { rows: tickerLeakRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_ledger WHERE rule_key ILIKE '%ticker%' OR metadata ? 'tickerKey'`);
    check('9: (system-wide) no ember_ledger row anywhere is ticker-tainted', tickerLeakRows[0].n === 0, JSON.stringify(tickerLeakRows[0]));

    // =================================================================================
    section('Final: full ember_ledger trace for the win account, cache vs. independent recompute');
    // =================================================================================
    const { rows: ledgerDump } = await pool.query(
        `SELECT id, amount, entry_type, rule_key, created_at FROM ember_ledger WHERE user_id = $1 ORDER BY created_at ASC`,
        [win.userId],
    );
    console.log('\n  Full ember_ledger trace - acceptance-trace-win:');
    console.log(`  ${'id'.padEnd(8)}${'amount'.padEnd(8)}${'entry_type'.padEnd(12)}${'rule_key'.padEnd(16)}${'running'.padEnd(9)}created_at`);
    let running = 0;
    for (const row of ledgerDump) {
        running += Number(row.amount);
        console.log(`  ${String(row.id).padEnd(8)}${String(row.amount).padEnd(8)}${String(row.entry_type).padEnd(12)}${String(row.rule_key).padEnd(16)}${String(running).padEnd(9)}${new Date(row.created_at).toISOString()}`);
    }

    const finalTotals = await ledgerTotals(win.userId);
    check('final: SUM(ember_ledger) == cached ember_balances', finalTotals.ledgerSum === finalTotals.balanceCache, JSON.stringify(finalTotals));
    check('final: printed running trace matches SUM(ember_ledger)', running === finalTotals.ledgerSum, `running=${running} sum=${finalTotals.ledgerSum}`);

    // Independent recompute using rebuildBalance()'s exact read (lib/pages-functions/
    // ledger.ts) - the SELECT half only, deliberately not the write half, so this suite
    // proves the cache never drifted without also being the thing that fixes it.
    const { rows: recomputeRows } = await pool.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM ember_ledger WHERE user_id = $1`, [win.userId]);
    const recomputedTotal = Number(recomputeRows[0].total);
    check("final: rebuildBalance()-shaped independent recompute matches the cache", recomputedTotal === finalTotals.balanceCache, `recomputed=${recomputedTotal} cached=${finalTotals.balanceCache}`);

    await cleanup();
}

export const suite: Suite = {
    name: 'ledger-trace',
    requiredEnv: ['SETTLE_SECRET', 'SESSION_TOKEN_SECRET'],
    run,
};
