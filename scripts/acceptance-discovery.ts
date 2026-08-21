// Acceptance suite for Pet Random Event Discovery + the consolidated toolbar-state
// endpoint. No test framework in this repo - this script IS the acceptance suite for
// lib/pages-functions/discovery.ts, ledger.discoveryFindEmber, and
// functions/api/toolbar-state.ts. Run it after any change to those.
//
//   npx tsx scripts/acceptance-discovery.ts
//
// Requirements (env / .env):
//   DATABASE_URL         - a DEV/BRANCH database, NEVER prod: this script inserts and
//                          deletes fixture rows (emails 'acceptance-discovery-*') and
//                          force-rewinds their pets' next_eligible_roll_at.
//   ACCEPTANCE_CONFIRM   - must be "1" (explicit acknowledgement of the line above).
//   SESSION_TOKEN_SECRET - must match the dev server's binding (.dev.vars): the script
//                          mints real session cookies for its fixture users.
//   BASE_URL             - where the Pages Functions are serving (default
//                          http://localhost:8788 - `npm run dev:functions`; the dev
//                          server must be pointed at the SAME DATABASE_URL).
//
// Environment gotchas (Windows): kill stale wrangler dev servers before running -
// orphaned workerd children keep serving old code on 8788 (kill the node parents too).
// All HTTP is driven from in-script fetch, never curl (PS5.1 curl quoting mangles
// JSON bodies).

import { Pool } from 'pg';
import dotenv from 'dotenv';
import { signAuthToken } from '../lib/pages-functions/auth-tokens';
import type { SessionTokenPayload } from '../lib/auth-token-payloads';

dotenv.config();

const BASE_URL = process.env.BASE_URL || 'http://localhost:8788';
const SESSION_TOKEN_SECRET = process.env.SESSION_TOKEN_SECRET || '';
const EMAIL_PREFIX = 'acceptance-discovery-';

if (process.env.ACCEPTANCE_CONFIRM !== '1') {
    console.error('Refusing to run: set ACCEPTANCE_CONFIRM=1 to confirm DATABASE_URL is a dev/branch DB (this script writes and deletes rows).');
    process.exit(2);
}
if (!process.env.DATABASE_URL || !SESSION_TOKEN_SECRET) {
    console.error('DATABASE_URL and SESSION_TOKEN_SECRET are both required.');
    process.exit(2);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

let passCount = 0;
let failCount = 0;
function check(name: string, ok: boolean, detail?: string) {
    if (ok) {
        passCount++;
        console.log(`  PASS  ${name}`);
    } else {
        failCount++;
        console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    }
}

async function api(method: string, path: string, cookie: string | null, body?: unknown) {
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            ...(cookie ? { Cookie: cookie } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json: any = null;
    try {
        json = await res.json();
    } catch {
        /* non-JSON response surfaces as json === null */
    }
    return { status: res.status, json, headers: res.headers };
}

// ---------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------

async function createUser(tag: string): Promise<{ userId: string; cookie: string }> {
    const email = `${EMAIL_PREFIX}${tag}@example.com`;
    const { rows } = await pool.query(
        `INSERT INTO waitlist (email, email_verified, username, onboarded_at)
         VALUES ($1, true, $2, NOW())
         ON CONFLICT (LOWER(email)) DO UPDATE SET email_verified = true, onboarded_at = NOW()
         RETURNING id`,
        [email, `${EMAIL_PREFIX}${tag}`],
    );
    const userId = rows[0].id as string;
    const { rows: sessionRows } = await pool.query(
        `INSERT INTO sessions (user_id, expires_at) VALUES ($1, NOW() + INTERVAL '30 days') RETURNING session_id`,
        [userId],
    );
    const sessionId = sessionRows[0].session_id as string;
    const token = await signAuthToken<SessionTokenPayload>(
        { userId, purpose: 'session', sessionId },
        SESSION_TOKEN_SECRET,
        30 * 24 * 3600,
    );
    // Dev server is plain http, so the un-prefixed cookie name is the trusted one.
    return { userId, cookie: `hc_session=${token}` };
}

async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(
        `INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`,
        [userId],
    );
    return rows[0].id as string;
}

// Every way this feature can have granted anything to a user, as one number.
async function grantTotals(userId: string): Promise<{ ledgerRows: number; ledgerSum: number; foodUnits: number; total: number }> {
    const { rows } = await pool.query(
        `SELECT
            (SELECT COUNT(*)::int FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find') AS ledger_rows,
            (SELECT COALESCE(SUM(amount), 0)::int FROM ember_ledger WHERE user_id = $1 AND rule_key = 'discovery_find') AS ledger_sum,
            (SELECT COALESCE(SUM(quantity), 0)::int FROM inventory_items WHERE user_id = $1 AND item_type = 'food') AS food_units`,
        [userId],
    );
    const r = rows[0];
    return {
        ledgerRows: r.ledger_rows,
        ledgerSum: r.ledger_sum,
        foodUnits: r.food_units,
        total: r.ledger_rows + r.food_units,
    };
}

async function rearm(petId: string): Promise<void> {
    await pool.query(`UPDATE pets SET next_eligible_roll_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [petId]);
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
    const { rows: users } = await pool.query(`SELECT id FROM waitlist WHERE email LIKE $1`, [`${EMAIL_PREFIX}%@example.com`]);
    for (const u of users) {
        await pool.query(`DELETE FROM notifications WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_ledger WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM ember_balances WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM inventory_items WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM pets WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM sessions WHERE user_id = $1`, [u.id]);
        await pool.query(`DELETE FROM waitlist WHERE id = $1`, [u.id]);
    }
}

// ---------------------------------------------------------------------------------
// The suite
// ---------------------------------------------------------------------------------

async function main() {
    console.log(`Acceptance run against ${BASE_URL}\n`);
    await cleanup();

    // --- Petless: the hard precondition ---
    console.log('Petless account - complete no-op');
    const petless = await createUser('petless');
    const p1 = await api('GET', '/api/toolbar-state', petless.cookie);
    const p2 = await api('GET', '/api/toolbar-state', petless.cookie);
    check('toolbar-state -> 200 with pet: null, twice', p1.status === 200 && p2.status === 200 && p1.json?.pet === null && p2.json?.pet === null);
    check('consolidated shape present (session + balance + notifications)',
        p1.json?.session?.userId === petless.userId && p1.json?.balance === 0 && Array.isArray(p1.json?.notifications));
    const petlessGrants = await grantTotals(petless.userId);
    const { rows: petlessNotes } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1`, [petless.userId]);
    check('zero grants, zero notifications, no error', petlessGrants.total === 0 && petlessNotes[0].n === 0);

    // --- Initialization: NULL schedules, never grants ---
    console.log('\nInitialization - NULL next_eligible_roll_at schedules without granting');
    const roller = await createUser('roller');
    const petId = await insertPet(roller.userId);
    await api('GET', '/api/toolbar-state', roller.cookie);
    const initMins = await windowMinutes(petId);
    check('first check schedules into the long range (90-120m)', initMins > 88 && initMins <= 120.5, `got ${initMins.toFixed(1)}m`);
    const initGrants = await grantTotals(roller.userId);
    check('initialization granted nothing', initGrants.total === 0);

    // --- A due roll always finds, in the same response ---
    console.log('\nDue roll - always grants, atomically, visible in the same response');
    await rearm(petId);
    const rollRes = await api('GET', '/api/toolbar-state', roller.cookie);
    const afterFirst = await grantTotals(roller.userId);
    check('exactly one grant (ember row or food unit)', afterFirst.total === 1, JSON.stringify(afterFirst));
    const { rows: noteRows } = await pool.query(
        `SELECT id, type, ref_type, read_at, claimed_at FROM notifications WHERE user_id = $1`, [roller.userId]);
    check("exactly one 'claimable' notification, ref_type 'pet'",
        noteRows.length === 1 && noteRows[0].type === 'claimable' && noteRows[0].ref_type === 'pet');
    check('the find is already in this response (notification + non-null balance)',
        (rollRes.json?.notifications ?? []).some((n: any) => n.id === noteRows[0]?.id) && typeof rollRes.json?.balance === 'number');
    if (afterFirst.ledgerRows === 1) {
        check('ember amount within configured 1-5', afterFirst.ledgerSum >= 1 && afterFirst.ledgerSum <= 5, `got ${afterFirst.ledgerSum}`);
    }

    // --- Spam gating ---
    console.log('\nSpam gating - concurrent due requests grant exactly once');
    await rearm(petId);
    await Promise.all(Array.from({ length: 10 }, () => api('GET', '/api/toolbar-state', roller.cookie)));
    const afterSpam = await grantTotals(roller.userId);
    check('10 concurrent GETs -> grants +1 exactly', afterSpam.total === afterFirst.total + 1, `total ${afterSpam.total}, was ${afterFirst.total}`);
    const gateMins = await windowMinutes(petId);
    check('next_eligible_roll_at pushed out past now', gateMins > 0, `got ${gateMins.toFixed(1)}m`);

    // --- Cooldown classes ---
    console.log('\nCooldown - sustained-Satisfied gets short, everyone else long');
    // Just fed: satisfied NOW but fed seconds ago - must NOT get the short window.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW(), next_eligible_roll_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [petId]);
    await api('GET', '/api/toolbar-state', roller.cookie);
    const justFedMins = await windowMinutes(petId);
    check('just-fed pet -> long window (90-120m)', justFedMins > 88 && justFedMins <= 120.5, `got ${justFedMins.toFixed(1)}m`);
    // Sustained: fed 3h ago at 100 -> current ~91, satisfied the whole window.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 100, last_fed_at = NOW() - INTERVAL '3 hours', next_eligible_roll_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [petId]);
    await api('GET', '/api/toolbar-state', roller.cookie);
    const sustainedMins = await windowMinutes(petId);
    check('sustained-satisfied pet -> short window (45-60m)', sustainedMins > 43 && sustainedMins <= 60.5, `got ${sustainedMins.toFixed(1)}m`);
    // Hungry: fed 3h ago at 45 -> current ~36 < threshold 40.
    await pool.query(`UPDATE pets SET satisfaction_at_last_feed = 45, last_fed_at = NOW() - INTERVAL '3 hours', next_eligible_roll_at = NOW() - INTERVAL '1 minute' WHERE id = $1`, [petId]);
    await api('GET', '/api/toolbar-state', roller.cookie);
    const hungryMins = await windowMinutes(petId);
    check('hungry pet -> long window (90-120m)', hungryMins > 88 && hungryMins <= 120.5, `got ${hungryMins.toFixed(1)}m`);

    // --- Distribution over many rolls ---
    console.log('\nDistribution - category weights, food price skew, collectible redistribution (150 rolls, ~a minute)');
    const distBase = await grantTotals(roller.userId);
    const ROLLS = 150;
    for (let i = 0; i < ROLLS; i++) {
        await rearm(petId);
        await api('GET', '/api/toolbar-state', roller.cookie);
    }
    const distEnd = await grantTotals(roller.userId);
    const emberRolls = distEnd.ledgerRows - distBase.ledgerRows;
    const foodRolls = distEnd.foodUnits - distBase.foodUnits;
    check(`every roll granted (${ROLLS} rolls -> ${emberRolls} ember + ${foodRolls} food)`, emberRolls + foodRolls === ROLLS);
    // Collectible weight (5) redistributes into ember/food: expected ember share is
    // 70/95 ~ 73.7%. Band is ~4 standard deviations at n=150.
    const emberShare = emberRolls / ROLLS;
    check(`ember share near 70/95 (73.7%), got ${(emberShare * 100).toFixed(1)}%`, emberShare > 0.59 && emberShare < 0.88);
    const { rows: collectibles } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM inventory_items WHERE user_id = $1 AND item_type = 'collectible'`, [roller.userId]);
    check('zero collectible grants (no backend yet - weight redistributed, rolls never failed)', collectibles[0].n === 0);
    // Food skew: cheap half of the catalog (price <= 20) carries ~70% of the food
    // weight at exponent 1 - it must out-draw the expensive half.
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
    console.log('\nIdempotency - a consumed window can never grant twice');
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
    console.log('\nClaim - reveals only, never re-grants, never implies read');
    const preClaim = await grantTotals(roller.userId);
    const { rows: claimTarget } = await pool.query(
        `SELECT id FROM notifications WHERE user_id = $1 AND type = 'claimable' AND ref_type = 'pet' LIMIT 1`, [roller.userId]);
    const claim1 = await api('POST', '/api/notifications/claim', roller.cookie, { id: claimTarget[0].id });
    const claim2 = await api('POST', '/api/notifications/claim', roller.cookie, { id: claimTarget[0].id });
    const postClaim = await grantTotals(roller.userId);
    const { rows: claimedRow } = await pool.query(`SELECT read_at, claimed_at FROM notifications WHERE id = $1`, [claimTarget[0].id]);
    check('claim -> 200 and claimed_at stamped', claim1.status === 200 && claimedRow[0].claimed_at !== null);
    check('claim did not re-grant (twice)', claim2.status === 200 && postClaim.total === preClaim.total && postClaim.ledgerSum === preClaim.ledgerSum);
    check('claim did not touch read_at (independent facts)', claimedRow[0].read_at === null);

    // --- Sliding-expiry cookie propagation ---
    console.log('\nSession - toolbar-state propagates the sliding-expiry Set-Cookie');
    await pool.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '20 days' WHERE user_id = $1`, [roller.userId]);
    const refreshed = await api('GET', '/api/toolbar-state', roller.cookie);
    check('drifted session gets Set-Cookie back', refreshed.status === 200 && (refreshed.headers.get('set-cookie') ?? '').includes('hc_session='));

    await cleanup();
    console.log(`\n${passCount} passed, ${failCount} failed.`);
    process.exit(failCount > 0 ? 1 : 0);
}

main()
    .catch(async (err) => {
        console.error('\nSuite aborted:', err);
        process.exit(1);
    })
    .finally(async () => {
        await pool.end();
    });
