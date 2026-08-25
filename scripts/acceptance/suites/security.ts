// Acceptance suite for cross-cutting security guarantees added since commit f4cc3dc
// ("Harden magic-link auth: CSRF, brute-force, host-header, cookie fixation") - the
// only security audit this repo has. That commit's HIGH/MED/LOW list is the template
// this suite re-proves, extended to every state-changing endpoint shipped since (pets,
// shop, ticker-tags, notifications, discovery/toolbar-state), not just the auth surface
// it originally covered. suites/auth.ts already re-proves f4cc3dc's own login/consume/
// verify-email checks sequentially; this suite adds real concurrency (fireParallel) for
// the brute-force guard, cross-account IDOR coverage, client-value-injection coverage
// per mutating endpoint, and a from-scratch, non-vacuous re-proof of the settlement
// outcome-order-mismatch hardening (lib/pages-functions/gamma.ts's outcomeOrderMismatch).
//
// Uses real Polymarket data on purpose (same rationale as suites/tickers.ts /
// suites/settlement.ts): the outcome-order-mismatch hazard only exists against a real
// resolved market's real outcome-name array, so it's constructed for real here, never
// stubbed.

import { fileURLToPath } from 'node:url';
import * as path from 'node:path';
import * as fs from 'node:fs';

import { pool, api, check, warn, near, section, type Suite } from '../harness';
import {
    createUser,
    createSessionUser,
    mintVerificationCode,
    insertTank,
    insertTagDirect,
    insertUserWithPick,
    findMarkets,
    deactivateConfig,
    restoreConfig,
    cleanupUsersByEmailPrefix,
    cleanupTanksBySlugPrefix,
    cheapestActiveSku,
} from '../fixtures';
import { fireParallel } from '../concurrency';
import { outcomeOrderMismatch } from '../../../lib/pages-functions/gamma';
import { resolveMarket as kalshiResolveMarket } from '../../../lib/pages-functions/kalshi';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.join(__dirname, '../../../');

const PREFIX = 'acceptance-sec-';
const TICKER_SECRET = process.env.TICKER_SECRET || '';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const CURATE_SECRET = process.env.CURATE_SECRET || '';

const settlePost = () => api('POST', '/api/settle', { headers: { 'X-Settle-Secret': SETTLE_SECRET } });

async function cleanup() {
    await cleanupUsersByEmailPrefix(PREFIX);
    await cleanupTanksBySlugPrefix(PREFIX);
}

// ---------------------------------------------------------------------------------
// 1. CSRF - every session/cookie-authenticated state-changing POST must reject a
// cross-origin caller before touching the session or the body (per requireSameOrigin,
// lib/pages-functions/session.ts). Shared-secret endpoints (ticker-tags, settle, the
// sweep endpoints) are machine-to-machine and deliberately excluded here - there is no
// ambient browser credential for a CSRF attack to ride, so requireSameOrigin doesn't
// apply to them; their auth gate is proven separately in section 3.
// ---------------------------------------------------------------------------------
const CSRF_PROTECTED_ENDPOINTS = [
    '/api/pets/hatch',
    '/api/pets/feed',
    '/api/pets/name',
    '/api/shop/buy',
    '/api/notifications/claim',
    '/api/notifications/read',
    '/api/onboarding/complete',
    '/api/verify-email',
    '/api/login/consume',
];

async function runCsrfSection() {
    section('CSRF - cross-origin POSTs rejected before session/body are ever touched');
    for (const endpoint of CSRF_PROTECTED_ENDPOINTS) {
        const originRes = await api('POST', endpoint, { body: {}, headers: { Origin: 'https://evil.example' } });
        check(`POST ${endpoint} with hostile Origin -> 403`, originRes.status === 403, JSON.stringify(originRes.json));

        const sfsRes = await api('POST', endpoint, { body: {}, headers: { 'Sec-Fetch-Site': 'cross-site' } });
        check(`POST ${endpoint} with Sec-Fetch-Site: cross-site -> 403`, sfsRes.status === 403, JSON.stringify(sfsRes.json));
    }

    // toolbar-state.ts: confirmed by source read to have NO requireSameOrigin() call at
    // all, despite GET /api/toolbar-state triggering the Pet Discovery write side-effect
    // (maybeDiscover) as a side effect of an ordinary ambient read. Confirm dynamically
    // (a hostile Origin does NOT get rejected) and by source inspection, then note it as
    // an accepted-risk observation for the report rather than fail the suite over it -
    // GET-based CSRF is a materially weaker vector than the state-changing POST class
    // this endpoint's siblings guard against (any cross-site <img>/fetch can already
    // force a victim's browser to issue an authenticated cross-site GET; the browser
    // itself does nothing to stop that), and the side effect is independently
    // rate/idempotency-guarded server-side (at most one grant per due cooldown window,
    // regardless of the caller's origin) - but a hostile page COULD still silently force
    // a logged-in victim's browser to consume their pet's due discovery roll on the
    // attacker's timing, which is a minor griefing vector worth flagging even though it
    // cannot grant anything to the attacker or exfiltrate anything a normal page load
    // wouldn't already see.
    const probe = await createSessionUser(`${PREFIX}csrf-toolbar-probe@example.com`);
    const hostileGet = await api('GET', '/api/toolbar-state', {
        cookie: probe.cookie,
        headers: { Origin: 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' },
    });
    check(
        'GET /api/toolbar-state with hostile Origin + Sec-Fetch-Site is NOT 403 (confirms dynamically: no CSRF guard on this endpoint)',
        hostileGet.status !== 403,
        JSON.stringify(hostileGet.json),
    );
    const toolbarSrc = fs.readFileSync(path.join(REPO_ROOT, 'functions/api/toolbar-state.ts'), 'utf8');
    const toolbarHasGuard = /requireSameOrigin/.test(toolbarSrc);
    if (!toolbarHasGuard) {
        warn(
            'ACCEPTED-RISK OBSERVATION: functions/api/toolbar-state.ts has no requireSameOrigin() CSRF guard, ' +
            'confirmed by source read AND the dynamic probe above, despite triggering the Pet Discovery write ' +
            'side-effect on every call. Not failed as a bug per task scope - see the comment above this check ' +
            'for the risk analysis (GET-based griefing of the discovery cooldown window at worst, no grant to ' +
            'the attacker, no data exposed beyond a normal page load).',
        );
    } else {
        check(
            'functions/api/toolbar-state.ts now HAS a requireSameOrigin guard - this suite\'s accepted-risk warn() above is stale and should be revisited',
            false,
            'toolbar-state.ts gained CSRF protection since this suite was written',
        );
    }
}

// ---------------------------------------------------------------------------------
// 2. AuthZ / IDOR - account B must never be able to read or mutate account A's rows via
// a guessed/observed id. A gets a full resource set (pet + egg + notification); B is
// deliberately left PETLESS so its cross-account hatch attempt actually reaches the
// egg-ownership check instead of short-circuiting on B's own existing-pet branch
// (functions/api/pets/hatch.ts's "already has a pet" fast path would return 200, not
// 404, if B already owned a pet - that would test nothing).
// ---------------------------------------------------------------------------------
async function runIdorSection() {
    section('AuthZ / IDOR - cross-account access is rejected, victim rows untouched');

    const userA = await createSessionUser(`${PREFIX}idor-a@example.com`);
    const userB = await createSessionUser(`${PREFIX}idor-b@example.com`);

    const { rows: petRowsA } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userA.userId]);
    const aPetId = petRowsA[0].id as string;
    const { rows: eggRowsA } = await pool.query(
        `INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity) VALUES ($1, 'egg_moss', 'egg', 1) RETURNING id`,
        [userA.userId],
    );
    const aEggId = eggRowsA[0].id as string;
    const { rows: noteRowsA } = await pool.query(
        `INSERT INTO notifications (user_id, type, message, ref_type, ref_id) VALUES ($1, 'claimable', 'Acceptance fixture notification', 'pick', 'fixture') RETURNING id`,
        [userA.userId],
    );
    const aNoteId = noteRowsA[0].id as string;

    // B also owns resources of its own (an egg + a notification) - just no pet, per the
    // note above.
    await pool.query(`INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity) VALUES ($1, 'egg_berry', 'egg', 1)`, [userB.userId]);
    await pool.query(
        `INSERT INTO notifications (user_id, type, message, ref_type, ref_id) VALUES ($1, 'claimable', 'B own fixture notification', 'pick', 'fixture')`,
        [userB.userId],
    );

    const eggSnapshotBefore = (await pool.query(`SELECT * FROM inventory_items WHERE id = $1`, [aEggId])).rows[0];
    const noteSnapshotBefore = (await pool.query(`SELECT * FROM notifications WHERE id = $1`, [aNoteId])).rows[0];

    // --- pets/hatch: B tries to hatch A's egg ---
    const hatchAttempt = await api('POST', '/api/pets/hatch', { cookie: userB.cookie, body: { inventoryItemId: aEggId } });
    check("B hatching A's egg by id -> 404", hatchAttempt.status === 404, JSON.stringify(hatchAttempt.json));
    const { rows: bPetCount } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1`, [userB.userId]);
    check('B still has zero pets after the failed cross-account hatch attempt', bPetCount[0].n === 0);
    const { rows: aPetStill } = await pool.query(`SELECT id FROM pets WHERE id = $1`, [aPetId]);
    check("A's own pet is untouched (still exists, unchanged id)", aPetStill.length === 1 && aPetStill[0].id === aPetId);

    // --- notifications/claim: B tries to claim A's notification ---
    const claimAttempt = await api('POST', '/api/notifications/claim', { cookie: userB.cookie, body: { id: aNoteId } });
    check("B claiming A's notification -> 404", claimAttempt.status === 404, JSON.stringify(claimAttempt.json));

    // --- notifications/read: B tries to mark A's notification read ---
    const readAttempt = await api('POST', '/api/notifications/read', { cookie: userB.cookie, body: { id: aNoteId } });
    check("B marking A's notification read -> 404", readAttempt.status === 404, JSON.stringify(readAttempt.json));

    const eggSnapshotAfter = (await pool.query(`SELECT * FROM inventory_items WHERE id = $1`, [aEggId])).rows[0];
    const noteSnapshotAfter = (await pool.query(`SELECT * FROM notifications WHERE id = $1`, [aNoteId])).rows[0];
    check("A's egg row is byte-identical before/after B's failed hatch attempt", JSON.stringify(eggSnapshotBefore) === JSON.stringify(eggSnapshotAfter));
    check(
        "A's notification row is byte-identical before/after B's failed claim+read attempts (claimed_at and read_at both still NULL)",
        JSON.stringify(noteSnapshotBefore) === JSON.stringify(noteSnapshotAfter)
            && noteSnapshotAfter.claimed_at === null
            && noteSnapshotAfter.read_at === null,
    );
}

// ---------------------------------------------------------------------------------
// 3. Client-value injection - every mutating endpoint must compute its own
// price/points/color/delta server-side and ignore whatever the client asserts, plus the
// shared-secret endpoints' auth gate (401 on missing/wrong secret; the happy path for
// the two safe-to-call-for-real ones, ticker-tags and settle, is exercised by their own
// dedicated checks elsewhere in this suite so it isn't duplicated here).
// ---------------------------------------------------------------------------------
async function runInjectionSection(markets: { live: { id: string; outcomes: string[] } }) {
    section('Client-value injection - server computes every value itself, hostile fields are ignored');

    // Looked up live rather than hardcoded ('egg_slate'/'food_basic' are both
    // active=false in the current catalog) - the expected color/hue/render_mode/points
    // below are read from this SKU's real config, not assumed.
    const eggSku = await cheapestActiveSku('egg');
    const foodSku = await cheapestActiveSku('food');
    const eggColor = String(eggSku.config?.color ?? '');
    const eggRenderMode = String(eggSku.config?.render_mode ?? 'filter');
    const eggHue = eggSku.config?.hue;
    const foodPoints = Number(foodSku.config?.satisfaction_points ?? NaN);
    console.log(`  [security] Live SKUs for injection tests: egg=${eggSku.catalogKey}(${eggColor}), food=${foodSku.catalogKey}(+${foodPoints}pts)`);

    // --- shop/buy: hostile price/amount/quantity/userId ---
    const buyer = await createSessionUser(`${PREFIX}inject-buyer@example.com`);
    const otherUser = await createSessionUser(`${PREFIX}inject-other@example.com`);
    await pool.query(`INSERT INTO ember_balances (user_id, balance) VALUES ($1, 500) ON CONFLICT (user_id) DO UPDATE SET balance = 500`, [buyer.userId]);

    const buyRes = await api('POST', '/api/shop/buy', {
        cookie: buyer.cookie,
        body: { catalogKey: eggSku.catalogKey, purchaseToken: crypto.randomUUID(), price: 1, amount: 0, quantity: 99, userId: otherUser.userId },
    });
    check('shop/buy with hostile price/amount/quantity/userId fields -> 200 ok', buyRes.status === 200 && buyRes.json?.ok === true, JSON.stringify(buyRes.json));
    const eggInvId = buyRes.json?.item?.inventoryItemId as string | undefined;

    const { rows: buyerBalAfter } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [buyer.userId]);
    check(
        `buyer debited exactly the server price for ${eggSku.catalogKey} (${eggSku.price}), never client's price:1 (balance=${buyerBalAfter[0].balance})`,
        Number(buyerBalAfter[0].balance) === 500 - eggSku.price,
    );
    const { rows: otherInv } = await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`, [otherUser.userId, eggSku.catalogKey]);
    check(`grant never lands on the client's userId field - other user has zero ${eggSku.catalogKey} rows`, otherInv[0].n === 0);
    const { rows: buyerInv } = await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`, [buyer.userId, eggSku.catalogKey]);
    check('grant actually landed on the SESSION\'s user (the real buyer)', buyerInv[0].n === 1);

    // SQL-injection-shaped catalogKey - parameterized queries mean this is just a
    // string that matches no row, not a query-structure attack.
    const injectRes = await api('POST', '/api/shop/buy', {
        cookie: buyer.cookie,
        body: { catalogKey: `${eggSku.catalogKey}' OR '1'='1`, purchaseToken: crypto.randomUUID() },
    });
    check('SQL-injection-shaped catalogKey -> 404, no SKU match (parameterized query, not string concatenation)', injectRes.status === 404, JSON.stringify(injectRes.json));
    const { rows: buyerBalAfterInject } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [buyer.userId]);
    check('SQL-injection-shaped attempt caused zero writes (balance unchanged)', Number(buyerBalAfterInject[0].balance) === Number(buyerBalAfter[0].balance));

    // --- pets/hatch: hostile color/render_mode/startSatisfaction/is_captain ---
    check('setup: egg purchase for the hatch injection test returned an inventoryItemId', typeof eggInvId === 'string' && eggInvId.length > 0, JSON.stringify(buyRes.json));
    const hatchInjectRes = await api('POST', '/api/pets/hatch', {
        cookie: buyer.cookie,
        body: { inventoryItemId: eggInvId, color: 'gold', render_mode: 'custom_asset', startSatisfaction: 100000, is_captain: true },
    });
    check('pets/hatch with hostile color/render_mode/startSatisfaction/is_captain -> 201', hatchInjectRes.status === 201, JSON.stringify(hatchInjectRes.json));
    check(`hatched pet color comes from the egg SKU config ("${eggColor}"), never client's "gold"`, hatchInjectRes.json?.pet?.color === eggColor, JSON.stringify(hatchInjectRes.json?.pet));
    check(`hatched pet render_mode comes from the SKU ("${eggRenderMode}"), never client's "custom_asset"`, hatchInjectRes.json?.pet?.render_mode === eggRenderMode);
    const { rows: hatchedPetRows } = await pool.query(
        `SELECT render_config, satisfaction_at_last_feed, is_captain FROM pets WHERE user_id = $1`,
        [buyer.userId],
    );
    check(`render_config.hue comes from the SKU (${eggHue}), never a client-asserted asset_key`, hatchedPetRows[0].render_config?.hue === eggHue, JSON.stringify(hatchedPetRows[0].render_config));
    check(
        'satisfaction_at_last_feed is the server\'s hatch_start_satisfaction (100) - the route never even reads startSatisfaction from the body',
        Number(hatchedPetRows[0].satisfaction_at_last_feed) === 100,
        String(hatchedPetRows[0].satisfaction_at_last_feed),
    );
    check('is_captain is the schema default (true), unaffected either way by the client-asserted is_captain field', hatchedPetRows[0].is_captain === true);

    // --- pets/feed: hostile points/currentSatisfaction/satisfaction ---
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 50, last_fed_at = NOW() WHERE user_id = $1`, [buyer.userId]);
    const foodBuy = await api('POST', '/api/shop/buy', { cookie: buyer.cookie, body: { catalogKey: foodSku.catalogKey, purchaseToken: crypto.randomUUID() } });
    check(`setup: buyer purchased ${foodSku.catalogKey} for the feed injection test -> 200`, foodBuy.status === 200 && foodBuy.json?.ok === true, JSON.stringify(foodBuy.json));

    const feedInjectRes = await api('POST', '/api/pets/feed', {
        cookie: buyer.cookie,
        body: { foodCatalogKey: foodSku.catalogKey, feedToken: crypto.randomUUID(), points: 99999, currentSatisfaction: 0, satisfaction: 100 },
    });
    check('pets/feed with hostile points/currentSatisfaction/satisfaction -> 200', feedInjectRes.status === 200, JSON.stringify(feedInjectRes.json));
    const { rows: fedPetRows } = await pool.query(`SELECT satisfaction_at_last_feed FROM pets WHERE user_id = $1`, [buyer.userId]);
    const fedSatisfaction = Number(fedPetRows[0].satisfaction_at_last_feed);
    const expectedFed = 50 + foodPoints;
    check(
        `satisfaction rose by exactly ${foodSku.catalogKey}'s configured ${foodPoints} points (50 -> ~${expectedFed}), never client's points:99999 or satisfaction:100 (got ${fedSatisfaction})`,
        Math.abs(fedSatisfaction - expectedFed) < 2,
    );

    // --- ticker-tags: hostile delta/capped/retroactive ---
    const ttSlug = `${PREFIX}tt-inject`;
    await insertTank({ slug: ttSlug, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });
    const ttRes = await api('POST', '/api/ticker-tags', {
        body: { slug: ttSlug, tickerKey: 'dogs', relevantSide: 1, delta: 9999, capped: false, retroactive: true },
        headers: { 'X-Ticker-Secret': TICKER_SECRET },
    });
    check('ticker-tags eligible tag with hostile delta/capped/retroactive fields -> 201', ttRes.status === 201, JSON.stringify(ttRes.json));
    check(
        "response delta is server-computed (within the +/-10 cap), never the client's delta:9999",
        typeof ttRes.json?.delta === 'number' && Math.abs(ttRes.json.delta) <= 10.0005 && ttRes.json.delta !== 9999,
        JSON.stringify(ttRes.json),
    );
    const { rows: ttEventRows } = await pool.query(`SELECT delta::float8 AS delta FROM ticker_events WHERE ticker_tag_id = $1`, [ttRes.json?.tagId]);
    check(
        "ticker_events.delta stored in the DB matches the response's server-computed delta, not the client's 9999",
        ttEventRows.length === 1 && near(ttEventRows[0].delta, ttRes.json?.delta) && ttEventRows[0].delta !== 9999,
        JSON.stringify(ttEventRows[0]),
    );
    const { rows: ttTagRows } = await pool.query(`SELECT retroactive FROM ticker_tags WHERE id = $1`, [ttRes.json?.tagId]);
    check("ticker_tags.retroactive is false for a normal API-created tag, ignoring the client's retroactive:true", ttTagRows[0]?.retroactive === false);

    // --- shared-secret endpoints: auth gate ---
    section('Shared-secret endpoints - auth gate (401 on missing/wrong secret)');
    const noSecretTag = await api('POST', '/api/ticker-tags', { body: {} });
    check('POST /api/ticker-tags with no secret header -> 401', noSecretTag.status === 401);
    const wrongSecretTag = await api('POST', '/api/ticker-tags', { body: {}, headers: { 'X-Ticker-Secret': 'not-the-real-secret' } });
    check('POST /api/ticker-tags with wrong secret -> 401', wrongSecretTag.status === 401);

    const noSecretSettle = await api('POST', '/api/settle');
    check('POST /api/settle with no secret header -> 401', noSecretSettle.status === 401);
    const wrongSecretSettle = await api('POST', '/api/settle', { headers: { 'X-Settle-Secret': 'not-the-real-secret' } });
    check('POST /api/settle with wrong secret -> 401', wrongSecretSettle.status === 401);
    // The happy path for both ticker-tags (above) and settle (section 4, outcome-order-
    // mismatch) is already exercised for real elsewhere in this suite - not duplicated.

    const noSecretTS = await api('POST', '/api/ticker-sweep');
    check('POST /api/ticker-sweep with no secret header -> 401', noSecretTS.status === 401);
    const wrongSecretTS = await api('POST', '/api/ticker-sweep', { headers: { 'X-Curate-Secret': 'not-the-real-secret' } });
    check('POST /api/ticker-sweep with wrong secret -> 401', wrongSecretTS.status === 401);
    const noSecretNS = await api('POST', '/api/notify-sweep');
    check('POST /api/notify-sweep with no secret header -> 401', noSecretNS.status === 401);
    const wrongSecretNS = await api('POST', '/api/notify-sweep', { headers: { 'X-Curate-Secret': 'not-the-real-secret' } });
    check('POST /api/notify-sweep with wrong secret -> 401', wrongSecretNS.status === 401);
    warn(
        'ticker-sweep / notify-sweep "correct header -> normal behavior" happy path intentionally NOT exercised here: ' +
        'both run an unscoped sweep over every app-visible Tank / onboarded account in the database, not just ' +
        `${PREFIX} fixtures, so firing them for real would have side effects well outside this suite's blast ` +
        'radius. Only the auth-gate (401) paths are proven for these two; CURATE_SECRET correctness is otherwise ' +
        'implicitly covered by production cron runs.',
    );
}

// ---------------------------------------------------------------------------------
// 4. Outcome-order-mismatch - the settlement hardening hazard. Constructed for real
// against a real resolved Polymarket market (no stub/mock injection point exists for
// Polymarket in this codebase): the tank's snapshot outcome order is the LIVE order
// reversed, so a naive index-only comparison (pick.outcome_index === winningIndex,
// ignoring outcome NAMES - explicitly the pre-hardening behavior per gamma.ts's own
// comment) disagrees with the real name-based truth. See the non-vacuity check below,
// which is the one check in this whole file that verifies the fixture itself means
// something before trusting anything downstream of it.
// ---------------------------------------------------------------------------------
async function runOutcomeOrderMismatchSection(markets: { resolved: { id: string; outcomes: string[]; winningIndex: number } }) {
    section('Outcome-order-mismatch - settlement hardening hazard (real resolved market, no stubs)');

    const W = markets.resolved.winningIndex;
    const ro = markets.resolved.outcomes;
    const roRev = [...ro].reverse();
    const rid = markets.resolved.id;

    check(
        'lib/pages-functions/gamma.ts outcomeOrderMismatch(liveOutcomes, snapshotOutcomes) returns true for this reversed fixture (unit-level confirmation the fixture actually triggers the real guard, matching its real (liveOutcomes, snapshotOutcomes) signature)',
        outcomeOrderMismatch(ro, roRev) === true,
        `ro=${JSON.stringify(ro)} roRev=${JSON.stringify(roRev)}`,
    );

    const mismatchSlug = `${PREFIX}mismatch`;
    const mismatchTankId = await insertTank({ slug: mismatchSlug, marketId: rid, outcomes: roRev, outcomePrices: [0.5, 0.5] });
    const mismatchTagId = await insertTagDirect(mismatchTankId, 'locks', W, 1.5);
    const { pickId: mismatchPickId } = await insertUserWithPick(`${PREFIX}mismatch@example.com`, mismatchTankId, mismatchSlug, W, 0.5);

    // --- Non-vacuity: prove the fixture actually matters ---
    // pick.outcome_index is literally W, so a NAIVE index-only comparison (the
    // pre-hardening behavior) scores this "correct". But the snapshot's outcome order is
    // reversed relative to the live/real order, so BY NAME the position the user picked
    // (roRev[W], which is ro[1-W] - the LOSING outcome's real name) actually lost. If
    // naive and name-based scoring agreed here, a passing outcome_order_mismatch
    // assertion below would prove nothing about this hardening actually mattering.
    const naiveResult: 'correct' | 'incorrect' = W === W ? 'correct' : 'incorrect';
    const nameBasedTruth: 'correct' | 'incorrect' =
        roRev[W]?.trim().toLowerCase() === ro[W]?.trim().toLowerCase() ? 'correct' : 'incorrect';
    check(
        'fixture is non-vacuous: naive index comparison would score this differently than the name-based truth',
        naiveResult !== nameBasedTruth,
        `naive=${naiveResult} nameBased=${nameBasedTruth} snapshotOutcomes(roRev)=${JSON.stringify(roRev)} liveOutcomes(ro)=${JSON.stringify(ro)} pick.outcome_index=W=${W}`,
    );

    const settle1 = await settlePost();
    check('POST /api/settle -> 200', settle1.status === 200, JSON.stringify(settle1.json)?.slice(0, 500));
    const pr1 = settle1.json?.results?.find((r: any) => r.pickId === mismatchPickId);
    const tr1 = settle1.json?.tickerResults?.find((r: any) => r.tagId === mismatchTagId);
    check("pick result status is 'outcome_order_mismatch'", pr1?.status === 'outcome_order_mismatch', JSON.stringify(pr1));
    check("tag result status is 'outcome_order_mismatch'", tr1?.status === 'outcome_order_mismatch', JSON.stringify(tr1));

    const { rows: pickRow1 } = await pool.query(`SELECT result, settled_at FROM picks WHERE id = $1`, [mismatchPickId]);
    check(
        'picks.result IS NULL - not settled as a loss, not paid participation as a "safe default" (a naive fix would still be wrong here)',
        pickRow1[0].result === null,
    );
    check('picks.settled_at IS NULL', pickRow1[0].settled_at === null);

    const { rows: ledgerRows1 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE metadata->>'pickId' = $1`, [mismatchPickId]);
    check('ZERO ember_ledger rows exist for this pick', ledgerRows1[0].n === 0);

    const { rows: noteRows1 } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE idempotency_key = $1`, [`settle:call:${mismatchPickId}`]);
    check(`no 'settle:call:${mismatchPickId}' notification exists`, noteRows1[0].n === 0);

    const { rows: tagRow1 } = await pool.query(`SELECT calculated_at FROM ticker_tags WHERE id = $1`, [mismatchTagId]);
    check('ticker_tags.calculated_at IS NULL (non-terminal, still pending)', tagRow1[0].calculated_at === null);

    // --- Stability: a second run must skip it again, not settle it the second time ---
    const settle2 = await settlePost();
    const pr2 = settle2.json?.results?.find((r: any) => r.pickId === mismatchPickId);
    const tr2 = settle2.json?.tickerResults?.find((r: any) => r.tagId === mismatchTagId);
    check("second settle run: pick still 'outcome_order_mismatch' (the skip is stable)", pr2?.status === 'outcome_order_mismatch', JSON.stringify(pr2));
    check("second settle run: tag still 'outcome_order_mismatch'", tr2?.status === 'outcome_order_mismatch', JSON.stringify(tr2));
    const { rows: ledgerRows2 } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE metadata->>'pickId' = $1`, [mismatchPickId]);
    check('second run: still ZERO ember_ledger rows for this pick', ledgerRows2[0].n === 0);
}

// ---------------------------------------------------------------------------------
// 4b. Kalshi has no outcome-order-mismatch equivalent - documented, not just assumed.
// Polymarket's hazard exists because Gamma's `outcomes` array is reorderable and
// winningIndex is derived from array POSITION, which a frozen snapshot's own order
// could silently disagree with by the time settlement re-fetches it live. Kalshi's
// resolveMarket (lib/pages-functions/kalshi.ts) reads a fixed `result: 'yes'|'no'`
// STRING field directly and maps it to a hardcoded 0/1 convention - there is no live
// array whose order could ever drift out from under a snapshot. This is a structural
// proof (the resolved variant has no `outcomes` field to reorder at all, confirmed
// below), not a runtime behavioral test like section 4 above - there'd be nothing for
// a runtime check to compare against.
// ---------------------------------------------------------------------------------
async function runKalshiNoOutcomeOrderHazardSection() {
    section('Kalshi - no outcome-order-mismatch equivalent (structural, not behavioral)');

    const yesResolution = kalshiResolveMarket({ status: 'finalized', result: 'yes' });
    const noResolution = kalshiResolveMarket({ status: 'finalized', result: 'no' });
    check(
        "resolved variant carries only winningIndex (0 for 'yes', 1 for 'no') - no outcomes array exists to reorder",
        yesResolution.status === 'resolved' && yesResolution.winningIndex === 0
        && noResolution.status === 'resolved' && noResolution.winningIndex === 1
        && !('outcomes' in yesResolution) && !('outcomes' in noResolution),
        JSON.stringify({ yesResolution, noResolution }),
    );
    const scalarResolution = kalshiResolveMarket({ status: 'finalized', result: 'scalar' });
    check(
        "a market that settles to a fair-value price (result:'scalar') resolves to 'voided', never a guessed winningIndex",
        scalarResolution.status === 'voided',
        JSON.stringify(scalarResolution),
    );
}

// ---------------------------------------------------------------------------------
// 5. "No pet, no roll" precondition (lib/pages-functions/discovery.ts).
// ---------------------------------------------------------------------------------
async function runNoPetNoRollSection() {
    section('"No pet, no roll" precondition - static + dynamic proof');

    // Static: the `if (!pet) return { kind: 'no_pet' }` guard must run BEFORE any
    // `await sql` call in maybeDiscover, so a petless account touches the database for
    // nothing. Read dynamically at test time (not hardcoded) so a future refactor that
    // moves the guard trips this check instead of silently going stale.
    const discoverySrc = fs.readFileSync(path.join(REPO_ROOT, 'lib/pages-functions/discovery.ts'), 'utf8');
    const guardMatch = discoverySrc.match(/if\s*\(!pet\)\s*return\s*\{\s*kind:\s*'no_pet'\s*\}/);
    const firstAwaitSqlIdx = discoverySrc.search(/await\s+sql/);
    const guardLine = guardMatch ? discoverySrc.slice(0, guardMatch.index).split('\n').length : -1;
    check(
        `no-pet guard ("if (!pet) return { kind: 'no_pet' }") is present and runs before any "await sql" call (lib/pages-functions/discovery.ts:${guardLine})`,
        !!guardMatch && (firstAwaitSqlIdx === -1 || (guardMatch.index as number) < firstAwaitSqlIdx),
        `guardIndex=${guardMatch?.index} firstAwaitSqlIndex=${firstAwaitSqlIdx}`,
    );

    // Dynamic: deactivate game_config['discovery'] entirely (getGameConfig('discovery')
    // now throws if it's ever reached). A petless account's toolbar-state must still be
    // 200 with pet: null - proof the discovery-config read was never reached. A
    // pet-HAVING account with a genuinely due roll on the SAME deactivated config must
    // fail/error - proof the code path really does need that config, so the petless
    // 200 above wasn't a coincidence or an unrelated pass-through.
    try {
        await deactivateConfig('discovery');

        const petless = await createSessionUser(`${PREFIX}nopet-petless@example.com`);
        const petlessRes = await api('GET', '/api/toolbar-state', { cookie: petless.cookie });
        check(
            'petless account, discovery config deactivated -> still 200 with pet: null (discovery-config read never reached)',
            petlessRes.status === 200 && petlessRes.json?.pet === null,
            JSON.stringify(petlessRes.json),
        );

        const haver = await createSessionUser(`${PREFIX}nopet-haver@example.com`);
        await pool.query(
            `INSERT INTO pets (user_id, color, next_eligible_roll_at) VALUES ($1, 'slate', NOW() - INTERVAL '1 minute')`,
            [haver.userId],
        );
        const haverRes = await api('GET', '/api/toolbar-state', { cookie: haver.cookie });
        check(
            'pet-having account with a DUE roll on the same deactivated discovery config -> fails/errors (proves the code path genuinely needs it, and the petless case above genuinely never reached it)',
            haverRes.status !== 200,
            `status=${haverRes.status} body=${JSON.stringify(haverRes.json)}`,
        );
    } finally {
        await restoreConfig('discovery');
    }

    // A petless account also gets clean 404s (never a crash, never a grant) from every
    // other pet-scoped mutating endpoint.
    const petless2 = await createSessionUser(`${PREFIX}nopet-endpoints@example.com`);
    const feedAttempt = await api('POST', '/api/pets/feed', { cookie: petless2.cookie, body: { foodCatalogKey: 'food_basic', feedToken: crypto.randomUUID() } });
    check('petless account: POST /api/pets/feed -> 404', feedAttempt.status === 404, JSON.stringify(feedAttempt.json));
    const nameAttempt = await api('POST', '/api/pets/name', { cookie: petless2.cookie, body: { name: 'Sparky' } });
    check('petless account: POST /api/pets/name -> 404', nameAttempt.status === 404, JSON.stringify(nameAttempt.json));
    const claimAttempt = await api('POST', '/api/notifications/claim', { cookie: petless2.cookie, body: { id: crypto.randomUUID() } });
    check('petless account: POST /api/notifications/claim (no such notification) -> 404', claimAttempt.status === 404, JSON.stringify(claimAttempt.json));

    const { rows: petless2Totals } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM ember_ledger WHERE user_id = $1) AS ledger_rows,
            (SELECT COUNT(*)::int FROM inventory_items WHERE user_id = $1) AS inventory_rows,
            (SELECT COUNT(*)::int FROM notifications WHERE user_id = $1) AS notification_rows,
            (SELECT COUNT(*)::int FROM pets WHERE user_id = $1) AS pet_rows`,
        [petless2.userId],
    );
    const t = petless2Totals[0];
    check(
        'petless account: zero grants/notifications/pets ever created across all three failed attempts',
        t.ledger_rows === 0 && t.inventory_rows === 0 && t.notification_rows === 0 && t.pet_rows === 0,
        JSON.stringify(t),
    );
}

// ---------------------------------------------------------------------------------
// 6. Brute-force re-proof under REAL parallelism. suites/auth.ts already re-proves
// f4cc3dc's brute-force fix sequentially; this is the actual account-takeover
// assertion, under genuine concurrency (fireParallel), with the critical follow-up the
// sequential version can't exercise cleanly: the CORRECT code, tried after the cap is
// already exhausted by the concurrent wrong guesses, must still be rejected. This is
// the single highest-value check in this file.
// ---------------------------------------------------------------------------------
async function runBruteForceSection() {
    section('Brute-force re-proof under real parallelism (highest-value check in this suite)');

    const email = `${PREFIX}bruteforce@example.com`;
    const { userId } = await createUser(email); // no session pre-minted - sessions created must be exactly 0 by the end
    await mintVerificationCode(userId, '654321');

    const wrongCodes = Array.from({ length: 10 }, (_, i) => `00000${i}`); // none of these equal '654321'
    const results = await fireParallel({
        method: 'POST',
        path: '/api/verify-email',
        n: 10,
        build: (i) => ({ body: { email, code: wrongCodes[i] } }),
    });
    check('all 10 concurrent wrong-code requests completed (no transport errors)', results.every((r) => r.status !== -1), JSON.stringify(results.map((r) => r.status)));
    check('none of the 10 concurrent wrong-code guesses were accepted as verified', results.every((r) => r.json?.verified !== true));

    const { rows: attemptRows } = await pool.query(`SELECT verification_attempts FROM waitlist WHERE id = $1`, [userId]);
    const attempts = attemptRows[0].verification_attempts as number;
    check(
        `waitlist.verification_attempts <= 5 after 10 concurrent wrong-code POSTs (never more than MAX_ATTEMPTS evaluated guesses despite 10-way concurrency) - got ${attempts}`,
        attempts <= 5,
    );

    // [CRITICAL] The correct code, tried AFTER the cap is exhausted, must still be
    // rejected - this is the actual account-takeover assertion.
    const correctAfterCap = await api('POST', '/api/verify-email', { body: { email, code: '654321' } });
    check(
        '[CRITICAL] correct code AFTER cap exhaustion -> still rejected (429), NOT verified',
        correctAfterCap.status === 429 && correctAfterCap.json?.verified !== true,
        JSON.stringify(correctAfterCap.json),
    );
    const { rows: sessionCountRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM sessions WHERE user_id = $1`, [userId]);
    check(
        '[CRITICAL] zero sessions were ever created for this account during the whole brute-force test (no account takeover)',
        sessionCountRows[0].n === 0,
        `sessions created = ${sessionCountRows[0].n}`,
    );
}

async function run() {
    await cleanup();

    await runCsrfSection();
    await runIdorSection();

    const markets = await findMarkets();
    await runInjectionSection(markets);
    await runOutcomeOrderMismatchSection(markets);
    await runKalshiNoOutcomeOrderHazardSection();

    await runNoPetNoRollSection();
    await runBruteForceSection();

    await cleanup();
}

export const suite: Suite = {
    name: 'security',
    requiredEnv: ['SETTLE_SECRET', 'TICKER_SECRET', 'SESSION_TOKEN_SECRET', 'CURATE_SECRET'],
    run,
};
