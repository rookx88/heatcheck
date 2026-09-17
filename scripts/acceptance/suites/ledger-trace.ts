// Acceptance suite: walks ONE fixture account through the entire product loop -
// signup -> onboarding -> pick -> settlement -> shop -> hatch -> feed -> discovery ->
// ticker isolation - asserting after EVERY state-changing step that the Ember ledger
// (ember_ledger, append-only) and the cached balance (ember_balances, a derived cache
// per lib/pages-functions/ledger.ts's header comment) never drift apart. A second
// account (acceptance-trace-loss) exists only to prove the LOSS payout path
// (participation) independently, without disturbing the win account's trace.
//
// Items ride the same trace. Every point that asserts the Ember invariant also asserts
// the item one - SUM(item_ledger.delta) per SKU equals what the account holds - because
// Ember and items move inside the SAME statement at four of these steps, and a leg that
// lands on one side of a CTE but not the other is exactly what that pairing catches.
//
// This is a cross-system regression net, not a per-endpoint spec test (those live in
// suites/tickers.ts and suites/discovery.ts already) - its whole reason to exist is to
// catch drift that only shows up when features compose in sequence on one account.

import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'node:url';
import { pool, api, check, warn, section, type Suite } from '../harness';
import {
    createUser, mintSessionCookie, ledgerTotals, itemTotals, seedFood,
    insertTank, findMarkets, insertTagDirect, settleEventDelta,
    flipConfig, restoreConfig, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix,
} from '../fixtures';
import { ITEM_REASONS } from '../../../lib/pages-functions/item-ledger';

const EMAIL_PREFIX = 'acceptance-trace-';
const SLUG_PREFIX = 'acceptance-trace-';
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
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
    const { balanceCache, ledgerSum, lifetimeCache, lifetimeRecomputed } = await ledgerTotals(userId);

    // The second cached column (Hall of Fame's lifetime_earned) holds to the same rule:
    // every step must leave it equal to its independent recompute, with null only
    // legitimate while no ember_balances row exists yet.
    const lifetimeOk = lifetimeCache === lifetimeRecomputed || (lifetimeCache === null && lifetimeRecomputed === 0);
    check(`${label}: cached lifetime_earned == recompute`, lifetimeOk, `cached=${lifetimeCache} recomputed=${lifetimeRecomputed}`);

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

    // Items ride along at every single trace point, for free. Ember and items move in
    // the same statements at four of this trace's steps (both purchases, discovery, the
    // encounter grant), so checking them together is what catches a leg that lands on
    // one side of a CTE and not the other.
    await assertItemsConsistent(userId, label);
}

// The item-ledger invariant (create_item_ledger_tables.sql): for every SKU this account
// has ever touched, SUM(item_ledger.delta) equals SUM(inventory_items.quantity). Unlike
// Ember there is no cache to compare against - the journal IS the second opinion, and
// inventory_items is the thing it has to agree with.
//
// A zero-row result is legitimate only before the account has touched an item at all;
// it is not special-cased because a SKU that exists on neither side simply does not
// appear in the full outer join, so there is nothing to mistake for agreement.
async function assertItemsConsistent(userId: string, label: string): Promise<void> {
    const { rows, mismatches, ledgerRows } = await itemTotals(userId);
    check(
        `${label}: SUM(item_ledger) == inventory held, per SKU`,
        mismatches.length === 0,
        mismatches.map((m) => `${m.itemType}/${m.catalogKey}: ledger=${m.ledgerSum} held=${m.held}`).join('; '),
    );
    if (rows.length > 0) {
        const summary = rows.map((r) => `${r.catalogKey}=${r.ledgerSum}`).join(' ');
        console.log(`  ITEMS  ${label.padEnd(46)} rows=${ledgerRows}  ${summary}`);
    }
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
           -- Buyable, not merely active: the discovery-only concession foods
           -- (add_discovery_foods.sql) have no config.vendor, price below every shop
           -- food, and are rejected by /api/shop/buy. Mirrors the server's predicate;
           -- same qual as scripts/acceptance/fixtures.ts.
           AND (c.item_type <> 'food' OR c.config ? 'vendor')
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

// Opens both discovery gates: the clock (due) and the footprints (add_pet_footprints.sql
// - stamped with synthetic places up to the active min_new_places).
async function rewindPetForRoll(petId: string): Promise<void> {
    const { rows } = await pool.query(`SELECT config->>'min_new_places' AS n FROM game_config WHERE key = 'discovery' AND active`);
    const stamped = Array.from({ length: Number(rows[0]?.n ?? 0) }, (_, i) => `stamp:${i}`);
    await pool.query(
        `UPDATE pets SET next_eligible_roll_at = NOW() - INTERVAL '1 minute', places_since_find = $2::text[] WHERE id = $1`,
        [petId, stamped],
    );
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

// ---------------------------------------------------------------------------------
// Static enforcement of the item-journal doctrine
//
// Ember's doctrine is enforced by a comment: nothing outside ledger.ts may write
// ember_ledger. Items cannot be held to that. Discovery and encounters write inventory
// inside large statements whose OTHER legs are their race guards, and the Neon driver
// cannot compose SQL fragments, so lifting the write into a shared function would cost
// the atomicity that makes it correct in the first place. Two static checks stand in.
// ---------------------------------------------------------------------------------

// Statements, not inserts: the encounter grant's single statement holds three mutually
// exclusive inventory inserts behind one journal leg, while pets.ts contributes two
// separate statements (hatch and feed). Pinned to a count so a ninth write path has to
// be converted consciously rather than silently breaking the invariant for whoever runs
// this next. Two purchase legs + three discovery branches + the encounter grant + hatch
// + feed + the delivery Play hand-over (encounters/deliver.ts).
const EXPECTED_INVENTORY_WRITE_SITES = 9;

// Walks the source tree rather than a list of known files, so a brand-new module that
// writes inventory is caught too - a hardcoded file list would quietly exempt it.
function tsFilesUnder(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) tsFilesUnder(full, out);
        else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
    }
    return out;
}

function assertEveryInventoryWriteJournals(): void {
    section('Doctrine: every inventory write sits in a statement that also writes the journal');
    const files = [
        ...tsFilesUnder(path.join(REPO_ROOT, 'lib')),
        ...tsFilesUnder(path.join(REPO_ROOT, 'functions')),
    ];
    let sites = 0;
    for (const full of files) {
        const rel = path.relative(REPO_ROOT, full).replace(/\\/g, '/');
        const src = fs.readFileSync(full, 'utf8');
        // Split on the tagged-template boundary so each chunk is at most one statement. A
        // write and a journal leg that agree across two DIFFERENT statements are not
        // atomic and must not pass this.
        for (const stmt of src.split(/\bsql`/).slice(1)) {
            const body = stmt.split('`')[0];
            if (!/(INSERT INTO|UPDATE|DELETE FROM) inventory_items/.test(body)) continue;
            sites += 1;
            check(
                `${rel}: an inventory-writing statement also writes item_ledger`,
                /INSERT INTO item_ledger/.test(body),
                body.slice(0, 160).replace(/\s+/g, ' '),
            );
        }
    }
    check(`exactly ${EXPECTED_INVENTORY_WRITE_SITES} inventory-writing statements in production code`,
        sites === EXPECTED_INVENTORY_WRITE_SITES,
        `found ${sites} - if this is a legitimate new site, convert it and bump the constant`);
}

// Every reason string the code uses must exist in item_reasons with the kind it pairs
// with. The FK is (reason, reason_kind) together, so a missing seed row or a mispaired
// kind is a foreign key violation on a hot path - during an ordinary page load, for the
// discovery reasons - rather than anything a user could see and report.
async function assertReasonVocabulary(): Promise<void> {
    section('Doctrine: every reason used in code is seeded in item_reasons');
    const { rows } = await pool.query(`SELECT key, kind FROM item_reasons`);
    const seeded = new Set(rows.map((r) => `${r.key}:${r.kind}`));
    for (const [key, kind] of Object.entries(ITEM_REASONS)) {
        check(`item_reasons has '${key}' as a ${kind}`, seeded.has(`${key}:${kind}`), `${key}:${kind}`);
    }
    // The reverse direction, minus the reasons ITEM_REASONS deliberately omits because
    // no product code ever writes them: the migration's backfill, the acceptance seeds,
    // and reconcile_item_ledger_deploy_gap.sql's one-shot correction. Anything else in
    // the table that the code cannot produce is a vocabulary row nobody owns.
    const nonProduct = new Set(['opening_balance', 'acceptance_seed', 'deploy_gap']);
    const unowned = rows.map((r) => r.key as string).filter((k) => !(k in ITEM_REASONS) && !nonProduct.has(k));
    check('every seeded reason is either in ITEM_REASONS or a known non-product one',
        unowned.length === 0, unowned.join(', '));
}

async function run(): Promise<void> {
    await cleanup();

    assertEveryInventoryWriteJournals();
    await assertReasonVocabulary();

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
    section('3c: /api/picks/mine reports the ledger\'s own numbers (per-pick award + all-time record)');
    // =================================================================================
    // The portfolio endpoint reads each settled pick's Ember from ember_ledger
    // (metadata.pickId) in one grouped pass joined to the picks - it must agree exactly
    // with an independent per-pick SUM straight from the table, for a win and a loss,
    // and the record's emberTotal must equal the sum of those awards.
    for (const [label, u, pickId, expected] of [
        ['win', win, winPickId, expectedWinPayout],
        ['loss', loss, lossPickId, participationAmount],
    ] as const) {
        const mine = await api('GET', '/api/picks/mine', { cookie: u.cookie });
        check(`3c (${label}): GET /api/picks/mine -> 200 with settled + record`, mine.status === 200 && Array.isArray(mine.json?.settled) && mine.json?.record, JSON.stringify(mine.json)?.slice(0, 200));
        const { rows: direct } = await pool.query(
            `SELECT COALESCE(SUM(amount), 0)::int AS ember FROM ember_ledger WHERE user_id = $1 AND metadata->>'pickId' = $2`, [u.userId, pickId]);
        const settledRow = (mine.json?.settled ?? []).find((s: any) => s.slug === tankSlug);
        check(`3c (${label}): the settled pick's emberAwarded == direct ledger SUM for that pickId (${direct[0].ember}) == the settle payout (${expected})`,
            settledRow?.emberAwarded === direct[0].ember && direct[0].ember === expected, JSON.stringify({ settledRow, direct: direct[0] }));
        check(`3c (${label}): pending is empty, settled has exactly this one pick`,
            (mine.json?.pending ?? []).length === 0 && (mine.json?.settled ?? []).length === 1, JSON.stringify({ pending: mine.json?.pending?.length, settled: mine.json?.settled?.length }));
        const { rows: recordDirect } = await pool.query(
            `SELECT COUNT(*) FILTER (WHERE result = 'correct')::int AS correct, COUNT(*) FILTER (WHERE result = 'incorrect')::int AS incorrect FROM picks WHERE waitlist_id = $1 AND result IS NOT NULL`, [u.userId]);
        check(`3c (${label}): record {correct, incorrect, emberTotal} == direct counts + the same award sum`,
            mine.json?.record?.correct === recordDirect[0].correct
            && mine.json?.record?.incorrect === recordDirect[0].incorrect
            && mine.json?.record?.emberTotal === direct[0].ember,
            JSON.stringify({ record: mine.json?.record, recordDirect: recordDirect[0], award: direct[0].ember }));
    }

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
    // The purchase's item row must exist AND be stitched to the Ember row that paid for
    // it - purchases share one idempotency key across both journals, so a non-null
    // ledger_id is what proves the two legs came out of the same statement rather than
    // two independent writes that happen to agree.
    const { rows: eggItemRows } = await pool.query(
        `SELECT delta, ledger_id, inventory_item_id FROM item_ledger
         WHERE user_id = $1 AND catalog_key = $2 AND reason = 'purchase'`,
        [win.userId, egg.catalogKey],
    );
    check('5: exactly one purchase item row, +1, linked to its ember row',
        eggItemRows.length === 1 && eggItemRows[0].delta === 1 && eggItemRows[0].ledger_id !== null
        && eggItemRows[0].inventory_item_id === eggInventoryId,
        JSON.stringify(eggItemRows));
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
    // The zero-Ember check above only ever proved a negative. Paired with the journal it
    // becomes a positive one: hatching moved zero Ember and exactly one egg. The burn row
    // still names the inventory row it consumed even though that row no longer exists,
    // which is precisely why inventory_item_id carries no foreign key.
    const { rows: hatchBurnRows } = await pool.query(
        `SELECT delta, inventory_item_id FROM item_ledger WHERE user_id = $1 AND reason = 'hatch'`,
        [win.userId],
    );
    check('6: exactly one hatch burn row, -1, naming the deleted egg row',
        hatchBurnRows.length === 1 && hatchBurnRows[0].delta === -1 && hatchBurnRows[0].inventory_item_id === eggInventoryId,
        JSON.stringify(hatchBurnRows));
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
    // Same upgrade as the hatch check: feeding moved zero Ember AND exactly one food.
    const { rows: feedBurnRows } = await pool.query(
        `SELECT delta FROM item_ledger WHERE user_id = $1 AND reason = 'feed'`,
        [win.userId],
    );
    check('7: exactly one feed burn row, -1', feedBurnRows.length === 1 && feedBurnRows[0].delta === -1, JSON.stringify(feedBurnRows));
    await assertLedgerConsistent(win.userId, win.cookie, '7: fed');

    // =================================================================================
    section('7b: Replaying an OLD feed token consumes nothing (the bug the journal fixed)');
    // =================================================================================
    // Feeding used to guard on pets.last_feed_token, a single column holding only the most
    // recent token. Feed with A, feed with B, replay A: the pet no longer remembered A, so
    // the replay consumed a THIRD unit. A unique key on a journal row remembers every
    // token ever used, so the replay now answers 200 with the pet unchanged and no stock
    // moves. This exact sequence fails against the pre-journal code.
    await seedFood(win.userId, food.catalogKey, 3);
    await assertLedgerConsistent(win.userId, win.cookie, '7b: food seeded for replay test');

    const tokenA = crypto.randomUUID();
    const tokenB = crypto.randomUUID();
    const feedOnce = async (token: string) => {
        // Reset below the ceiling first, or the second feed is rejected 409 before the
        // idempotency path is ever reached and the test proves nothing.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 20, last_fed_at = NOW() WHERE id = $1`, [petId]);
        return api('POST', '/api/pets/feed', { cookie: win.cookie, body: { foodCatalogKey: food.catalogKey, feedToken: token } });
    };
    const feedA = await feedOnce(tokenA);
    check('7b: feed with token A -> 200', feedA.status === 200, JSON.stringify(feedA.json));
    const feedB = await feedOnce(tokenB);
    check('7b: feed with token B -> 200', feedB.status === 200, JSON.stringify(feedB.json));
    const replayA = await feedOnce(tokenA);
    check('7b: REPLAY of token A -> 200 (idempotent, not a 404)', replayA.status === 200, JSON.stringify(replayA.json));

    const { rows: afterReplayQty } = await pool.query(
        `SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2 AND item_type = 'food'`,
        [win.userId, food.catalogKey],
    );
    check('7b: exactly two units consumed from three, NOT three',
        afterReplayQty.length === 1 && afterReplayQty[0].quantity === 1,
        `quantity=${JSON.stringify(afterReplayQty)} (0 means the replay over-consumed)`);
    const { rows: feedRowCount } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM item_ledger WHERE user_id = $1 AND reason = 'feed'`,
        [win.userId],
    );
    check('7b: three feed burn rows total (step 7 + A + B), the replay wrote none', feedRowCount[0].n === 3, JSON.stringify(feedRowCount[0]));
    await assertLedgerConsistent(win.userId, win.cookie, '7b: old feed token replayed');

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
    section('9: Ticker isolation - a settle run over a tagged Tank must never touch the Ember ledger');
    // =================================================================================
    // Tag settlement itself is retired (settle.ts SETTLE_TANK_TAGS = false), so the tag
    // must come out of this run untouched too - the isolation claim below is then
    // proven against a run that had every chance to write and wrote nothing.
    const tagId = await insertTagDirect(tankId, 'dogs', L, 1.5);
    const { rows: phaseStartRows } = await pool.query(`SELECT NOW() AS ts`);
    const phaseStart = phaseStartRows[0].ts;
    const settle4 = await settlePost();
    check('9: settle (tag present) -> 200', settle4.status === 200, JSON.stringify(settle4.json)?.slice(0, 300));
    const tagDelta = await settleEventDelta(tagId);
    check('9: ticker_events gained NO settle row for the tag (tag settlement retired)', tagDelta === null, `delta=${tagDelta}`);
    const { rows: ledgerSinceRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND created_at > $2`, [win.userId, phaseStart]);
    check('9: zero new ember_ledger rows for this user from ticker settlement', ledgerSinceRows[0].n === 0, JSON.stringify(ledgerSinceRows[0]));
    await assertLedgerConsistent(win.userId, win.cookie, '9: ticker tag settled (isolation)');

    // System-wide isolation proof, not just this one account: no ember_ledger row
    // anywhere should carry a ticker-shaped rule_key or a tickerKey metadata field
    // EXCEPT the two TANKDAQ trade rules - ledger.ts's buyShares/sellShares stamp
    // {tickerKey, shares, price, ...} on 'shares_buy'/'shares_sell' rows by design (a
    // trade consumes an index's price; it is the one sanctioned Ember<->ticker touch
    // point, and it never writes ticker_events). Everything else in the ticker layer
    // (tags, settle, slate closes) stays structurally disjoint from the ledger.
    const { rows: tickerLeakRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_ledger
         WHERE (rule_key ILIKE '%ticker%' OR metadata ? 'tickerKey')
           AND rule_key NOT IN ('shares_buy', 'shares_sell')`);
    check('9: (system-wide) no non-trade ember_ledger row anywhere is ticker-tainted', tickerLeakRows[0].n === 0, JSON.stringify(tickerLeakRows[0]));

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
