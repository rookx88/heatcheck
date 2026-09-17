// Acceptance suite for the account page's backend (add_account_prefs_to_waitlist.sql):
// GET /api/account, POST /api/account/prefs, POST /api/account/sessions/revoke-others,
// POST /api/account/delete, GET|POST /api/email/unsubscribe, plus the two readers that
// honor the new switches - functions/api/settle.ts (email gate, observable as
// results[].email = 'skipped' since the harness runs with Resend blanked, where a real
// attempt reads 'failed') and functions/api/notify-sweep.ts (both in-app writers).
//
// Deletion is a soft delete that rewrites the fixture's email out of the
// %@example.com shape the prefix sweep matches, so every user this suite creates is
// remembered by id and cleaned up with cleanupUsersByIds - including the SECOND row
// that re-signing-up with the freed address creates.
//
// The settlement section needs a real resolved Gamma market (findMarkets(), like
// suites/settlement.ts) and the notify-sweep section writes one daily-digest row for
// every onboarded account on the DB (idempotent per day - it is what the cron does).

import { pool, api, check, section, warn, BASE_URL, type Suite } from '../harness';
import {
    createUser, createSessionUser, mintSessionCookie, mintLoginToken, mintUnsubscribeToken,
    seedLifetimeEarned, ledgerTotals, insertTank, insertUserWithPick, findMarkets,
    cleanupUsersByEmailPrefix, cleanupUsersByIds, cleanupTanksBySlugPrefix,
} from '../fixtures';

const EMAIL_PREFIX = 'acceptance-account-';
const SLUG_PREFIX = 'acceptance-account-';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const CURATE_SECRET = process.env.CURATE_SECRET || '';
const user = (tag: string) => `${EMAIL_PREFIX}${tag}@example.com`;

// Every id this run creates, for the by-id sweep (see header).
const createdIds: string[] = [];
function remember<T extends { userId: string }>(u: T): T { createdIds.push(u.userId); return u; }

// A run that died mid-suite can leave a soft-deleted fixture behind that the prefix
// sweep can't see. That is harmless: its username and pet name are NULL and its email
// is unique per id, so nothing a later run inserts can collide with it - hence no
// speculative sweep of deleted rows here (which could only ever risk a real account).
async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupUsersByIds(createdIds.splice(0));
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

async function prefsRow(userId: string) {
    const { rows } = await pool.query(
        `SELECT email, username, deleted_at, email_settlement_results, newsletter_opt_in, newsletter_opted_in_at,
                notify_pet_hungry, notify_daily_drop, login_nonce
         FROM waitlist WHERE id = $1`,
        [userId],
    );
    return rows[0];
}

// hall-of-fame.ts's independent rank arithmetic, copied so this suite cross-checks the
// strip's number the same way that suite checks the board's.
async function competitionRank(earned: number): Promise<number> {
    const { rows } = await pool.query(
        `SELECT 1 + COUNT(*)::int AS rank FROM ember_balances b JOIN waitlist w ON w.id = b.user_id
         WHERE b.lifetime_earned > $1 AND w.username IS NOT NULL`,
        [earned],
    );
    return Number(rows[0].rank);
}

async function boardEligibleCount(): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ember_balances b JOIN waitlist w ON w.id = b.user_id
         WHERE b.lifetime_earned > 0 AND w.username IS NOT NULL`,
    );
    return Number(rows[0].n);
}

async function notifCount(userId: string, keyPrefix: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND idempotency_key LIKE $2`,
        [userId, `${keyPrefix}%`],
    );
    return Number(rows[0].n);
}

// The harness's api() follows redirects; the unsubscribe GET must be observed raw.
async function rawGet(path: string, cookie?: string): Promise<Response> {
    return fetch(`${BASE_URL}${path}`, { method: 'GET', redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
}

async function run(): Promise<void> {
    await cleanup();

    // =================================================================================
    section('1. GET /api/account - shape, defaults, standing');
    // =================================================================================
    const anon = await api('GET', '/api/account');
    check('anonymous -> 401', anon.status === 401, `status=${anon.status}`);

    const a = remember(await createSessionUser(user('a'), { username: 'acceptanceaccta' }));
    const accA = await api('GET', '/api/account', { cookie: a.cookie });
    check('session -> 200', accA.status === 200, JSON.stringify(accA.json));
    const keys = Object.keys(accA.json ?? {}).sort();
    check(
        'response carries exactly the documented keys',
        JSON.stringify(keys) === JSON.stringify(['createdAt', 'discord', 'email', 'onboarded', 'prefs', 'sessions', 'standing', 'userId', 'username', 'verified']),
        keys.join(','),
    );
    check('identity matches the fixture', accA.json?.userId === a.userId && accA.json?.email === user('a') && accA.json?.username === 'acceptanceaccta');
    check(
        'prefs default to everything on except the newsletter (opt-in)',
        JSON.stringify(accA.json?.prefs) === JSON.stringify({ emailSettlementResults: true, newsletterOptIn: false, notifyPetHungry: true, notifyDailyDrop: true }),
        JSON.stringify(accA.json?.prefs),
    );
    check('one active session', accA.json?.sessions?.active === 1, JSON.stringify(accA.json?.sessions));
    check('discord unlinked', accA.json?.discord?.linked === false && accA.json?.discord?.username === null);
    check(
        'fresh onboarded account: standing is zeros and unranked',
        accA.json?.standing?.balance === 0 && accA.json?.standing?.lifetimeEarned === 0 && accA.json?.standing?.rank === null
            && accA.json?.standing?.record?.correct === 0 && accA.json?.standing?.record?.incorrect === 0,
        JSON.stringify(accA.json?.standing),
    );
    check('createdAt is a parseable timestamp', !Number.isNaN(Date.parse(accA.json?.createdAt)));

    await seedLifetimeEarned(a.userId, 40);
    const accA2 = await api('GET', '/api/account', { cookie: a.cookie });
    const expectedRank = await competitionRank(40);
    check(
        'after earning: lifetimeEarned=40, balance=40, rank = 1 + accounts above (hall-of-fame arithmetic)',
        accA2.json?.standing?.lifetimeEarned === 40 && accA2.json?.standing?.balance === 40 && accA2.json?.standing?.rank === expectedRank,
        JSON.stringify(accA2.json?.standing) + ` expectedRank=${expectedRank}`,
    );
    const hof = await api('GET', '/api/hall-of-fame', { cookie: a.cookie });
    check('the Hall of Fame `me` half reports the same rank and total (shared standingStatement)',
        hof.json?.me?.rank === expectedRank && hof.json?.me?.earned === 40, JSON.stringify(hof.json?.me));

    const pre = remember(await createSessionUser(user('pre'), { onboarded: false }));
    const accPre = await api('GET', '/api/account', { cookie: pre.cookie });
    check('un-onboarded session -> 200 with standing: null (never a 403)', accPre.status === 200 && accPre.json?.standing === null && accPre.json?.onboarded === false, JSON.stringify(accPre.json));

    // =================================================================================
    section('2. POST /api/account/prefs - partial, strict, CSRF-guarded');
    // =================================================================================
    const p1 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { notifyDailyDrop: false } });
    check('flip one key -> 200 echoing the full prefs row', p1.status === 200 && p1.json?.prefs?.notifyDailyDrop === false && p1.json?.prefs?.notifyPetHungry === true, JSON.stringify(p1.json));
    let row = await prefsRow(a.userId);
    check('DB: notify_daily_drop false, the other three untouched',
        row.notify_daily_drop === false && row.notify_pet_hungry === true && row.email_settlement_results === true && row.newsletter_opt_in === false);

    const bad1 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { notifyDailyDrop: 'no' } });
    check('a string "no" -> 400', bad1.status === 400, `status=${bad1.status}`);
    const bad2 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { bogus: true } });
    check('an unknown key -> 400', bad2.status === 400, `status=${bad2.status}`);
    const bad3 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: {} });
    check('an empty body -> 400', bad3.status === 400, `status=${bad3.status}`);
    const bad4 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { notifyPetHungry: false }, headers: { Origin: 'https://evil.example' } });
    check('hostile Origin -> 403 (requireSameOrigin)', bad4.status === 403, `status=${bad4.status}`);
    const bad5 = await api('POST', '/api/account/prefs', { body: { notifyPetHungry: false } });
    check('no cookie -> 401', bad5.status === 401, `status=${bad5.status}`);
    row = await prefsRow(a.userId);
    check('none of the rejected requests changed anything', row.notify_pet_hungry === true);

    const nl1 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { newsletterOptIn: true } });
    row = await prefsRow(a.userId);
    check('newsletter on -> opt_in true and opted_in_at stamped', nl1.status === 200 && row.newsletter_opt_in === true && row.newsletter_opted_in_at !== null);
    const stamped = String(row.newsletter_opted_in_at);
    const nl2 = await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { newsletterOptIn: false, emailSettlementResults: false } });
    row = await prefsRow(a.userId);
    check('newsletter off + settlement off in one call -> both false, opted_in_at kept as the original consent record',
        nl2.status === 200 && row.newsletter_opt_in === false && row.email_settlement_results === false && String(row.newsletter_opted_in_at) === stamped,
        JSON.stringify({ row: { ...row, email: undefined } }));
    // Restore for later sections.
    await api('POST', '/api/account/prefs', { cookie: a.cookie, body: { emailSettlementResults: true, notifyDailyDrop: true } });

    // =================================================================================
    section('3. Settlement email gate - settle.ts skips Resend when the switch is off');
    // =================================================================================
    try {
        const markets = await findMarkets();
        const W = markets.resolved.winningIndex;
        const rid = markets.resolved.id;
        const ro = markets.resolved.outcomes;
        const onTank = await insertTank({ slug: `${SLUG_PREFIX}email-on`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
        const on = remember(await insertUserWithPick(user('email-on'), onTank, `${SLUG_PREFIX}email-on`, W, 0.5));
        const offTank = await insertTank({ slug: `${SLUG_PREFIX}email-off`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
        const off = remember(await insertUserWithPick(user('email-off'), offTank, `${SLUG_PREFIX}email-off`, W, 0.5));
        await pool.query(`UPDATE waitlist SET email_settlement_results = false WHERE id = $1`, [off.userId]);

        const settle = await api('POST', '/api/settle', { headers: { 'X-Settle-Secret': SETTLE_SECRET } });
        check('POST /api/settle -> 200', settle.status === 200, JSON.stringify(settle.json).slice(0, 300));
        const rOn = settle.json?.results?.find((r: any) => r.pickId === on.pickId);
        const rOff = settle.json?.results?.find((r: any) => r.pickId === off.pickId);
        check('both picks settled', rOn?.status?.startsWith('settled_') && rOff?.status?.startsWith('settled_'), JSON.stringify({ rOn, rOff }));
        check("switch off -> results[].email === 'skipped' (never reached Resend)", rOff?.email === 'skipped', JSON.stringify(rOff));
        check("switch on -> an attempt was made ('sent' or, with Resend blanked, 'failed') - never 'skipped'",
            rOn?.email === 'sent' || rOn?.email === 'failed', JSON.stringify(rOn));
        const offTotals = await ledgerTotals(off.userId);
        check('the opted-out account was still PAID (the gate is on email, not Ember)', offTotals.ledgerRows > 0 && offTotals.ledgerSum > 0, JSON.stringify(offTotals));
    } catch (err) {
        warn(`settlement email gate section skipped - ${err instanceof Error ? err.message : String(err)}`);
    }

    // =================================================================================
    section('4. notify-sweep honors the in-app switches');
    // =================================================================================
    const hungryOn = remember(await createUser(user('hungry-on')));
    const hungryOff = remember(await createUser(user('hungry-off')));
    for (const u of [hungryOn, hungryOff]) {
        await pool.query(
            `INSERT INTO pets (user_id, color, satisfaction_at_last_feed, last_fed_at) VALUES ($1, 'slate', 0, NOW() - INTERVAL '30 days')`,
            [u.userId],
        );
    }
    await pool.query(`UPDATE waitlist SET notify_pet_hungry = false WHERE id = $1`, [hungryOff.userId]);
    const dropOn = remember(await createUser(user('drop-on')));
    const dropOff = remember(await createUser(user('drop-off')));
    await pool.query(`UPDATE waitlist SET notify_daily_drop = false WHERE id = $1`, [dropOff.userId]);
    // A freshly published narrative Tank so the digest writer has something to announce.
    const dropTank = await insertTank({ slug: `${SLUG_PREFIX}drop`, marketId: 'acceptance-drop', outcomes: ['A', 'B'] });
    await pool.query(`UPDATE tank_pages SET published_at = NOW(), kind = 'narrative' WHERE id = $1`, [dropTank]);

    const sweep = await api('POST', '/api/notify-sweep', { headers: { 'X-Curate-Secret': CURATE_SECRET } });
    check('POST /api/notify-sweep -> 200', sweep.status === 200, JSON.stringify(sweep.json));
    check('hungry pet, switch on -> one hungry notification', (await notifCount(hungryOn.userId, 'hungry:')) === 1);
    check('hungry pet, switch off -> zero hungry notifications', (await notifCount(hungryOff.userId, 'hungry:')) === 0);
    check('onboarded, drop switch on -> one daily digest', (await notifCount(dropOn.userId, 'daily:')) === 1, `newTanks=${sweep.json?.newTanksLast24h}`);
    check('onboarded, drop switch off -> zero daily digests', (await notifCount(dropOff.userId, 'daily:')) === 0);

    // =================================================================================
    section('5. Log out of all other devices');
    // =================================================================================
    const multi = remember(await createUser(user('multi'), { username: 'acceptanceacctmulti' }));
    const c1 = await mintSessionCookie(multi.userId);
    const c2 = await mintSessionCookie(multi.userId);
    const c3 = await mintSessionCookie(multi.userId);
    const before = await api('GET', '/api/account', { cookie: c1 });
    check('three cookies -> sessions.active === 3', before.json?.sessions?.active === 3, JSON.stringify(before.json?.sessions));
    const csrf = await api('POST', '/api/account/sessions/revoke-others', { cookie: c1, headers: { Origin: 'https://evil.example' } });
    check('hostile Origin -> 403', csrf.status === 403, `status=${csrf.status}`);
    const rev = await api('POST', '/api/account/sessions/revoke-others', { cookie: c1 });
    check('revoke-others from cookie 1 -> { revoked: 2, active: 1 }', rev.status === 200 && rev.json?.revoked === 2 && rev.json?.active === 1, JSON.stringify(rev.json));
    check('cookie 1 still valid', (await api('GET', '/api/session', { cookie: c1 })).status === 200);
    check('cookie 2 -> 401', (await api('GET', '/api/session', { cookie: c2 })).status === 401);
    check('cookie 3 -> 401', (await api('GET', '/api/session', { cookie: c3 })).status === 401);
    const after = await api('GET', '/api/account', { cookie: c1 });
    check('sessions.active now 1', after.json?.sessions?.active === 1, JSON.stringify(after.json?.sessions));
    const again = await api('POST', '/api/account/sessions/revoke-others', { cookie: c1 });
    check('a second call revokes nothing', again.json?.revoked === 0, JSON.stringify(again.json));

    // =================================================================================
    section('6. One-click unsubscribe - token-authorized, purpose-walled');
    // =================================================================================
    const un = remember(await createSessionUser(user('unsub'), { username: 'acceptanceacctunsub' }));
    await pool.query(`UPDATE waitlist SET newsletter_opt_in = true, email_settlement_results = true WHERE id = $1`, [un.userId]);

    const tSettle = await mintUnsubscribeToken(un.userId, 'settlement');
    const g1 = await rawGet(`/api/email/unsubscribe?token=${encodeURIComponent(tSettle)}`);
    check('settlement token GET -> 302', g1.status === 302, `status=${g1.status}`);
    check('...to /unsubscribed/?kind=settlement', (g1.headers.get('location') ?? '').endsWith('/unsubscribed/?kind=settlement'), g1.headers.get('location') ?? '');
    check('...with Cache-Control: no-store', (g1.headers.get('cache-control') ?? '').includes('no-store'));
    row = await prefsRow(un.userId);
    check('DB: email_settlement_results false, newsletter untouched', row.email_settlement_results === false && row.newsletter_opt_in === true);

    const tNews = await mintUnsubscribeToken(un.userId, 'newsletter');
    // A DIFFERENT account's session cookie rides along: the token, not the cookie, names the row.
    const g2 = await rawGet(`/api/email/unsubscribe?token=${encodeURIComponent(tNews)}`, a.cookie);
    row = await prefsRow(un.userId);
    const rowA = await prefsRow(a.userId);
    check('newsletter token GET (with another user\'s cookie) -> flips the TOKEN\'s account only',
        g2.status === 302 && row.newsletter_opt_in === false && rowA.newsletter_opt_in === false && rowA.email_settlement_results === true,
        JSON.stringify({ un: row.newsletter_opt_in, a: rowA }));

    await pool.query(`UPDATE waitlist SET newsletter_opt_in = true, email_settlement_results = true WHERE id = $1`, [un.userId]);
    const tLogin = await mintLoginToken(un.userId);
    const g3 = await rawGet(`/api/email/unsubscribe?token=${encodeURIComponent(tLogin)}`);
    check('a login-purpose token -> kind=invalid', g3.status === 302 && (g3.headers.get('location') ?? '').endsWith('?kind=invalid'), g3.headers.get('location') ?? '');
    const tExpired = await mintUnsubscribeToken(un.userId, 'settlement', -10);
    const g4 = await rawGet(`/api/email/unsubscribe?token=${encodeURIComponent(tExpired)}`);
    check('an expired token -> kind=invalid', (g4.headers.get('location') ?? '').endsWith('?kind=invalid'), g4.headers.get('location') ?? '');
    const g5 = await rawGet('/api/email/unsubscribe');
    check('no token -> kind=invalid', (g5.headers.get('location') ?? '').endsWith('?kind=invalid'));
    row = await prefsRow(un.userId);
    check('none of the invalid links changed anything', row.newsletter_opt_in === true && row.email_settlement_results === true);

    // RFC 8058 one-click POST, as Gmail sends it.
    const post = await fetch(`${BASE_URL}/api/email/unsubscribe?token=${encodeURIComponent(tSettle)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
    });
    const postJson = await post.json().catch(() => null);
    row = await prefsRow(un.userId);
    check('one-click POST -> 200 { unsubscribed: true, kind: settlement } and flips the flag',
        post.status === 200 && postJson?.unsubscribed === true && postJson?.kind === 'settlement' && row.email_settlement_results === false,
        JSON.stringify(postJson));
    const postBad = await fetch(`${BASE_URL}/api/email/unsubscribe?token=${encodeURIComponent(tLogin)}`, { method: 'POST' });
    check('one-click POST with a non-unsubscribe token -> 400', postBad.status === 400, `status=${postBad.status}`);

    // =================================================================================
    section('7. Delete account - soft delete, everything identifying scrubbed');
    // =================================================================================
    const del = remember(await createSessionUser(user('del'), { username: 'acceptanceacctdel' }));
    const delCookie2 = await mintSessionCookie(del.userId);
    await seedLifetimeEarned(del.userId, 25);
    await pool.query(`INSERT INTO pets (user_id, color, name) VALUES ($1, 'slate', 'AcceptanceDelPet')`, [del.userId]);
    await pool.query(
        `INSERT INTO discord_links (waitlist_id, discord_user_id, discord_username) VALUES ($1, $2, 'acceptance-del')`,
        [del.userId, `acc-del-${Date.now()}`],
    );
    await pool.query(
        `INSERT INTO notifications (user_id, type, message, ref_type, ref_id) VALUES ($1, 'informational', 'fixture', 'pet', 'fixture')`,
        [del.userId],
    );
    const delTank = await insertTank({ slug: `${SLUG_PREFIX}del-pick`, marketId: 'acceptance-del', outcomes: ['A', 'B'] });
    await pool.query(
        `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock) VALUES ($1, $2, $3, 'A', 0, 0.5)`,
        [del.userId, delTank, `${SLUG_PREFIX}del-pick`],
    );
    const totalsBefore = await ledgerTotals(del.userId);
    const eligibleBefore = await boardEligibleCount();

    const wrong = await api('POST', '/api/account/delete', { cookie: del.cookie, body: { confirm: 'nope' } });
    check('wrong confirmation -> 400, nothing happens', wrong.status === 400 && (await prefsRow(del.userId)).deleted_at === null, JSON.stringify(wrong.json));
    const noBody = await api('POST', '/api/account/delete', { cookie: del.cookie });
    check('no body -> 400', noBody.status === 400, `status=${noBody.status}`);

    const done = await api('POST', '/api/account/delete', { cookie: del.cookie, body: { confirm: 'ACCEPTANCEACCTDEL' } });
    check('username (any case) confirmation -> 200 { deleted: true }', done.status === 200 && done.json?.deleted === true, JSON.stringify(done.json));
    check('response clears the session cookie', (done.headers.get('set-cookie') ?? '').includes('Max-Age=0'), done.headers.get('set-cookie') ?? '');

    check('the deleting cookie -> 401 afterwards', (await api('GET', '/api/session', { cookie: del.cookie })).status === 401);
    check('the OTHER cookie for the same account -> 401 too', (await api('GET', '/api/session', { cookie: delCookie2 })).status === 401);

    row = await prefsRow(del.userId);
    check('email scrubbed to deleted+<id>@deleted.heatchecks.invalid', row.email === `deleted+${del.userId}@deleted.heatchecks.invalid`, row.email);
    check('username NULL, deleted_at set, login_nonce NULL', row.username === null && row.deleted_at !== null && row.login_nonce === null);
    check('every switch off', row.email_settlement_results === false && row.newsletter_opt_in === false && row.notify_pet_hungry === false && row.notify_daily_drop === false);
    const { rows: dl } = await pool.query(`SELECT 1 FROM discord_links WHERE waitlist_id = $1`, [del.userId]);
    check('discord_links row gone', dl.length === 0);
    const { rows: petRows } = await pool.query(`SELECT name FROM pets WHERE user_id = $1`, [del.userId]);
    check('pet row kept, name released (NULL)', petRows.length === 1 && petRows[0].name === null, JSON.stringify(petRows));
    const { rows: nRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1`, [del.userId]);
    check('notifications deleted', Number(nRows[0].n) === 0);
    const totalsAfter = await ledgerTotals(del.userId);
    check('Ember ledger + balance cache untouched (append-only journals stay)',
        totalsAfter.ledgerRows === totalsBefore.ledgerRows && totalsAfter.ledgerSum === totalsBefore.ledgerSum && totalsAfter.balanceCache === totalsBefore.balanceCache,
        JSON.stringify({ before: totalsBefore, after: totalsAfter }));
    const { rows: pickRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1`, [del.userId]);
    check('picks kept', Number(pickRows[0].n) === 1);
    check('dropped off the board-eligible set (username NULL)', (await boardEligibleCount()) === eligibleBefore - 1, `before=${eligibleBefore} after=${await boardEligibleCount()}`);

    // The freed address: login.ts's exact upsert must create a NEW row, not revive this one.
    const { rows: relogin } = await pool.query(
        `INSERT INTO waitlist (email) VALUES ($1) ON CONFLICT ((LOWER(email))) DO UPDATE SET email = waitlist.email RETURNING id`,
        [user('del')],
    );
    const newId = relogin[0].id as string;
    createdIds.push(newId);
    check('re-signing-up with the freed email creates a DIFFERENT waitlist row', newId !== del.userId, `old=${del.userId} new=${newId}`);
    check('the new row is clean (not deleted, prefs at defaults)', (await prefsRow(newId)).deleted_at === null && (await prefsRow(newId)).email_settlement_results === true);

    // Prefs on a deleted row must be refused even by a stale cookie (getSession wall).
    const stale = await api('POST', '/api/account/prefs', { cookie: del.cookie, body: { notifyPetHungry: true } });
    check('prefs with the dead cookie -> 401', stale.status === 401, `status=${stale.status}`);

    await cleanup();
}

export const suite: Suite = {
    name: 'account',
    requiredEnv: ['SESSION_TOKEN_SECRET', 'SETTLE_SECRET', 'CURATE_SECRET'],
    run,
};
