// Acceptance suite for the gaps the pre-launch security audit (Audit 3, 2026-09-18) found in
// the existing suites' coverage. Each section is a category the other suites never exercised
// for these endpoints:
//
//   1. Enumeration - does a response tell a stranger whether an email has an account?
//   2. CSRF WITH a valid session - security.ts sends its hostile-origin requests with no
//      cookie, which proves the guard fires but not that it fires before an authenticated
//      write. Here every state-changing POST gets a real fixture session and a VALID body,
//      so a guard that failed open would show up as a real write.
//   3. Session invalidation - logout, revoke-others, account delete, and tokens minted for
//      another purpose presented as a session cookie.
//   4. Genuine concurrency on the limited resources nobody raced yet: the last unit of a
//      finite egg run between many buyers, an oversell race on TANKDAQ sells, buys and sells
//      interleaved, and onboarding (the welcome gift must pay exactly once).
//   5. Tampered pick and trade fields - client-sent odds/prices must be ignored, and a pick's
//      side label must agree with the side it will be scored on.
//   6. Behaviours the audit flagged as design decisions (not bugs) are asserted as WARN so
//      they stay visible in every run without failing it: GET /api/toolbar-state's writes,
//      the client-reported ?place=, and the two "is this email a claimed account" signals.
//
// Fixtures are 'acceptance-secgaps-' accounts and Tanks, cleaned before and after.

import { pool, api, check, section, warn, registerTeardown, BASE_URL, type Suite } from '../harness';
import {
    createUser, createSessionUser, mintSessionCookie, mintLoginToken, mintUnsubscribeToken,
    seedBalance, seedEgg, parkAllEncounters, insertTank, ledgerTotals, cleanupUsersByEmailPrefix,
    cleanupUsersByIds, cleanupTanksBySlugPrefix, cheapestActiveSku,
} from '../fixtures';
import { fireParallel, countStatus, tally } from '../concurrency';
import { signToken } from '../../../lib/pages-functions/tokens';
import type { NewsletterPickTokenPayload } from '../../../lib/newsletter-pick-token';

const PREFIX = 'acceptance-secgaps-';
const NEWSLETTER_TOKEN_SECRET = process.env.NEWSLETTER_TOKEN_SECRET || '';
const LAST_EGG_KEY = 'acceptance-secgaps-last-egg';
const TICKER = 'dogs';

// Soft-deleted fixtures lose their email (delete.ts rewrites it), so the prefix sweep can't
// find them - remember their ids.
const deletedIds: string[] = [];

function email(tag: string): string {
    return `${PREFIX}${tag}@example.com`;
}

async function cleanup(): Promise<void> {
    await cleanupUsersByIds(deletedIds.splice(0));
    await cleanupUsersByEmailPrefix(PREFIX);
    await cleanupTanksBySlugPrefix(PREFIX);
    await pool.query(`DELETE FROM item_ledger WHERE catalog_key = $1`, [LAST_EGG_KEY]);
    await pool.query(`DELETE FROM inventory_items WHERE catalog_key = $1`, [LAST_EGG_KEY]);
    await pool.query(`DELETE FROM sku_supply WHERE catalog_key = $1`, [LAST_EGG_KEY]);
    await pool.query(`DELETE FROM items_catalog WHERE key = $1`, [LAST_EGG_KEY]);
}

async function balanceOf(userId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT balance FROM ember_balances WHERE user_id = $1`, [userId]);
    return rows.length ? Number(rows[0].balance) : 0;
}

async function sharesHeld(userId: string): Promise<number> {
    const { rows } = await pool.query(`SELECT shares FROM share_holdings WHERE user_id = $1 AND ticker_key = $2`, [userId, TICKER]);
    return rows.length ? Number(rows[0].shares) : 0;
}

async function ledgerConsistent(label: string, userId: string): Promise<void> {
    const t = await ledgerTotals(userId);
    check(`${label}: cached balance == SUM(ledger)`, t.balanceCache === null ? t.ledgerSum === 0 : t.balanceCache === t.ledgerSum, JSON.stringify(t));
}

// A two-sided pickable fixture Tank (no kickoff in the snapshot, like every other suite's).
async function pickableTank(tag: string): Promise<{ id: string; slug: string }> {
    const slug = `${PREFIX}${tag}`;
    const id = await insertTank({ slug, marketId: `${PREFIX}${tag}-market`, outcomes: ['Yes', 'No'], outcomePrices: [0.4, 0.6] });
    return { id, slug };
}

// The four ways a browser marks a request as not same-origin. requireSameOrigin
// (lib/pages-functions/session.ts) must reject every one.
const HOSTILE: Array<{ label: string; headers: Record<string, string> }> = [
    { label: 'hostile Origin', headers: { Origin: 'https://evil.example' } },
    { label: 'Sec-Fetch-Site: cross-site', headers: { 'Sec-Fetch-Site': 'cross-site' } },
    { label: 'Sec-Fetch-Site: same-site', headers: { 'Sec-Fetch-Site': 'same-site' } },
    { label: 'Origin: null', headers: { Origin: 'null' } },
];

async function run(): Promise<void> {
    await cleanup();
    registerTeardown(cleanup);

    // =================================================================================
    section('1. Enumeration - existing vs unknown email');
    // =================================================================================
    {
        const known = email('enum-verified');
        await createUser(known);
        const unknown = email(`enum-unknown-${crypto.randomUUID().slice(0, 8)}`);

        const rvKnown = await api('POST', '/api/resend-verification', { body: { email: known } });
        const rvUnknown = await api('POST', '/api/resend-verification', { body: { email: unknown } });
        check('resend-verification: verified vs unknown email answer identically',
            rvKnown.status === rvUnknown.status && JSON.stringify(rvKnown.json) === JSON.stringify(rvUnknown.json),
            `${rvKnown.status} ${JSON.stringify(rvKnown.json)} vs ${rvUnknown.status} ${JSON.stringify(rvUnknown.json)}`);

        const loginKnown = await api('POST', '/api/login', { body: { email: known } });
        const loginUnknown = await api('POST', '/api/login', { body: { email: email(`enum-login-${crypto.randomUUID().slice(0, 8)}`) } });
        check('login: verified vs unknown email answer identically',
            loginKnown.status === loginUnknown.status && JSON.stringify(loginKnown.json) === JSON.stringify(loginUnknown.json),
            `${loginKnown.status} ${JSON.stringify(loginKnown.json)} vs ${loginUnknown.status} ${JSON.stringify(loginUnknown.json)}`);

        // Known design trade-offs (flagged in the audit, not bugs): both reveal that an
        // address belongs to a claimed account.
        const veKnown = await api('POST', '/api/verify-email', { body: { email: known, code: '000000' } });
        const veUnknown = await api('POST', '/api/verify-email', { body: { email: unknown, code: '000000' } });
        if (veKnown.status !== veUnknown.status) {
            warn(`verify-email distinguishes a verified account (${veKnown.status} ${JSON.stringify(veKnown.json)}) from an unknown email (${veUnknown.status}) - audit decision item`);
        } else {
            check('verify-email: verified vs unknown email answer identically', JSON.stringify(veKnown.json) === JSON.stringify(veUnknown.json));
        }
        const tank = await pickableTank('enum');
        const pkKnown = await api('POST', '/api/picks', { body: { email: known, slug: tank.slug, side: 'Yes', sideIndex: 0 } });
        const pkUnknown = await api('POST', '/api/picks', { body: { email: email(`enum-pick-${crypto.randomUUID().slice(0, 8)}`), slug: tank.slug, side: 'Yes', sideIndex: 0 } });
        if (pkKnown.status !== pkUnknown.status) {
            warn(`anonymous /api/picks distinguishes a claimed account (${pkKnown.status}) from an unknown email (${pkUnknown.status}) - deliberate anti-hijack (H2), audit decision item`);
        }

        // Someone else's resource must look exactly like a missing one.
        const owner = await createSessionUser(email('enum-owner'));
        const other = await createSessionUser(email('enum-other'));
        const { rows: n } = await pool.query(
            `INSERT INTO notifications (user_id, type, message, idempotency_key) VALUES ($1, 'informational', 'secgaps', $2) RETURNING id`,
            [owner.userId, `${PREFIX}notif:${crypto.randomUUID()}`],
        );
        for (const path of ['/api/notifications/claim', '/api/notifications/read', '/api/encounters/seen']) {
            const foreign = await api('POST', path, { cookie: other.cookie, body: { id: n[0].id } });
            const missing = await api('POST', path, { cookie: other.cookie, body: { id: crypto.randomUUID() } });
            check(`${path}: someone else's id and a nonexistent id answer identically`,
                foreign.status === missing.status && JSON.stringify(foreign.json) === JSON.stringify(missing.json),
                `${foreign.status} ${JSON.stringify(foreign.json)} vs ${missing.status} ${JSON.stringify(missing.json)}`);
        }
    }

    // =================================================================================
    section('2. CSRF with a valid session - every state-changing POST, valid bodies');
    // =================================================================================
    {
        const tank = await pickableTank('csrf');
        const u = await createSessionUser(email('csrf'));
        await seedBalance(u.userId, 1000);
        const sku = await cheapestActiveSku('food');
        const fresh = await createSessionUser(email('csrf-fresh'), { onboarded: false });

        const targets: Array<{ path: string; cookie: string; body: () => unknown }> = [
            { path: '/api/picks', cookie: u.cookie, body: () => ({ slug: tank.slug, side: 'Yes', sideIndex: 0 }) },
            { path: '/api/shop/buy', cookie: u.cookie, body: () => ({ catalogKey: sku.catalogKey, purchaseToken: crypto.randomUUID() }) },
            { path: '/api/tankdaq/buy', cookie: u.cookie, body: () => ({ tickerKey: TICKER, shares: 1, tradeToken: crypto.randomUUID() }) },
            { path: '/api/tankdaq/sell', cookie: u.cookie, body: () => ({ tickerKey: TICKER, shares: 1, tradeToken: crypto.randomUUID() }) },
            { path: '/api/pets/name', cookie: u.cookie, body: () => ({ name: 'Secgaps' }) },
            { path: '/api/encounters/seen', cookie: u.cookie, body: () => ({ id: crypto.randomUUID() }) },
            { path: '/api/notifications/read', cookie: u.cookie, body: () => ({ id: crypto.randomUUID() }) },
            { path: '/api/newsletter-optin', cookie: u.cookie, body: () => ({}) },
            { path: '/api/account/prefs', cookie: u.cookie, body: () => ({ newsletterOptIn: true }) },
            { path: '/api/account/sessions/revoke-others', cookie: u.cookie, body: () => ({}) },
            { path: '/api/discord/unlink', cookie: u.cookie, body: () => ({}) },
            { path: '/api/onboarding/complete', cookie: fresh.cookie, body: () => ({ username: `secgaps${Date.now() % 100000}`, acceptTerms: true }) },
            { path: '/api/account/delete', cookie: u.cookie, body: () => ({ confirm: 'DELETE' }) },
            { path: '/api/logout', cookie: u.cookie, body: () => ({}) },
        ];

        const balanceBefore = await balanceOf(u.userId);
        for (const t of targets) {
            const statuses: number[] = [];
            for (const h of HOSTILE) {
                const res = await api('POST', t.path, { cookie: t.cookie, body: t.body(), headers: h.headers });
                statuses.push(res.status);
            }
            check(`${t.path}: all four cross-origin markers -> 403`, statuses.every((s) => s === 403), statuses.join(','));
        }

        // Nothing any of those requests would have done happened.
        check('CSRF: balance untouched (no buy, no trade)', (await balanceOf(u.userId)) === balanceBefore, `${balanceBefore} -> ${await balanceOf(u.userId)}`);
        const { rows: picks } = await pool.query(`SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1`, [u.userId]);
        check('CSRF: no pick written', picks[0].n === 0, `picks=${picks[0].n}`);
        const { rows: acct } = await pool.query(`SELECT deleted_at, onboarded_at FROM waitlist WHERE id = ANY($1::uuid[])`, [[u.userId]]);
        check('CSRF: account not deleted', acct[0]?.deleted_at === null);
        const { rows: fr } = await pool.query(`SELECT onboarded_at FROM waitlist WHERE id = $1`, [fresh.userId]);
        check('CSRF: fresh account still not onboarded (no welcome gift)', fr[0]?.onboarded_at === null);
        const still = await api('GET', '/api/account', { cookie: u.cookie });
        check('CSRF: session still valid after the hostile logout/revoke attempts', still.status === 200, `status ${still.status}`);

        // Documented allowances of requireSameOrigin, surfaced so they are decided on, not forgotten.
        const noHeaders = await api('POST', '/api/notifications/read', { cookie: u.cookie, body: { id: crypto.randomUUID() } });
        if (noHeaders.status !== 403) warn(`requireSameOrigin allows a cookie-bearing POST with neither Origin nor Sec-Fetch-Site (got ${noHeaders.status}) - by design for non-browser clients, audit decision item`);
        const localhostPort = await api('POST', '/api/notifications/read', { cookie: u.cookie, body: { id: crypto.randomUUID() }, headers: { Origin: 'http://localhost:9999' } });
        if (localhostPort.status !== 403) warn(`Origin http://localhost:<any port> is trusted (got ${localhostPort.status}) - isTrustedHost ignores the port, audit decision item`);
        const crossGet = await api('GET', '/api/toolbar-state', { cookie: u.cookie, headers: { 'Sec-Fetch-Site': 'cross-site' } });
        if (crossGet.status === 200) warn('GET /api/toolbar-state (which can roll discovery, fire encounters and consume items) runs on a cross-site request - audit decision item');
    }

    // =================================================================================
    section('3. Session invalidation and token-purpose confusion');
    // =================================================================================
    {
        const u = await createSessionUser(email('sess'));
        const second = await mintSessionCookie(u.userId);

        const revoke = await api('POST', '/api/account/sessions/revoke-others', { cookie: u.cookie, body: {} });
        check('revoke-others -> 200', revoke.status === 200, `status ${revoke.status}`);
        check('revoke-others: the other session is dead', (await api('GET', '/api/account', { cookie: second })).status === 401);
        check('revoke-others: the calling session still works', (await api('GET', '/api/account', { cookie: u.cookie })).status === 200);

        const out = await api('POST', '/api/logout', { cookie: u.cookie, body: {} });
        check('logout -> 200', out.status === 200, `status ${out.status}`);
        check('logout: the cookie is dead afterwards', (await api('GET', '/api/account', { cookie: u.cookie })).status === 401);

        const unsub = await mintUnsubscribeToken(u.userId, 'newsletter');
        check('an unsubscribe token presented as the session cookie -> 401', (await api('GET', '/api/account', { cookie: `hc_session=${unsub}` })).status === 401);
        const login = await mintLoginToken(u.userId);
        check('a login token presented as the session cookie -> 401', (await api('GET', '/api/account', { cookie: `hc_session=${login}` })).status === 401);

        const doomed = await createSessionUser(email('sess-delete'), { username: `secgapsdel${Date.now() % 100000}` });
        deletedIds.push(doomed.userId);
        const del = await api('POST', '/api/account/delete', { cookie: doomed.cookie, body: { confirm: 'DELETE' } });
        check('account delete -> 200', del.status === 200, `status ${del.status} ${JSON.stringify(del.json)}`);
        check('delete: the old cookie is dead', (await api('GET', '/api/account', { cookie: doomed.cookie })).status === 401);
        const minted = await mintSessionCookie(doomed.userId);
        check('delete: even a freshly minted session for the deleted account -> 401', (await api('GET', '/api/account', { cookie: minted })).status === 401);

        // A newsletter pick link outlives the account (30-day TTL) - it must stop working
        // at deletion. The account check precedes any issue/Tank lookup, so a random issue
        // id is enough to prove it.
        if (NEWSLETTER_TOKEN_SECRET) {
            const issueId = crypto.randomUUID();
            const token = await signToken<NewsletterPickTokenPayload>({ userId: doomed.userId, newsletterIssueId: issueId }, NEWSLETTER_TOKEN_SECRET, 3600);
            const nl = await api('POST', '/api/newsletter/pick', { body: { token, issue: issueId, side: 'Yes', sideIndex: 0 } });
            check('delete: a still-valid newsletter pick link for the deleted account -> 400 invalid link',
                nl.status === 400 && /invalid or has expired/.test(nl.json?.message ?? ''), `${nl.status} ${JSON.stringify(nl.json)}`);
        } else {
            warn('NEWSLETTER_TOKEN_SECRET unset - deleted-account newsletter link not exercised');
        }
    }

    // =================================================================================
    section('4. Concurrency on limited resources');
    // =================================================================================
    {
        // 4a. The last unit of a finite egg run, raced by 8 funded buyers at once.
        const price = (await cheapestActiveSku('egg')).price;
        await pool.query(
            `INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, active)
             VALUES ($1, 'egg', 'Acceptance Secgaps Last Egg', 'spend_egg_standard', '{"color":"red","render_mode":"filter","hue":0}', true)
             ON CONFLICT (key) DO NOTHING`,
            [LAST_EGG_KEY],
        );
        await pool.query(
            `INSERT INTO sku_supply (catalog_key, supply, sold_count) VALUES ($1, 1, 0)
             ON CONFLICT (catalog_key) DO UPDATE SET supply = 1, sold_count = 0`,
            [LAST_EGG_KEY],
        );
        const buyers = [];
        for (let i = 0; i < 8; i++) {
            const b = await createSessionUser(email(`race-egg-${i}`));
            await seedBalance(b.userId, Math.max(price, 200));
            buyers.push(b);
        }
        const eggRace = await fireParallel({
            method: 'POST', path: '/api/shop/buy', n: 8,
            build: (i) => ({ headers: { Cookie: buyers[i].cookie }, body: { catalogKey: LAST_EGG_KEY, purchaseToken: crypto.randomUUID() } }),
        });
        check('last egg, 8 buyers at once: exactly one 200', countStatus(eggRace, 200) === 1, JSON.stringify(tally(eggRace)));
        check('last egg: every loser gets 409 sold out', countStatus(eggRace, 409) === 7, JSON.stringify(tally(eggRace)));
        const { rows: sold } = await pool.query(`SELECT sold_count FROM sku_supply WHERE catalog_key = $1`, [LAST_EGG_KEY]);
        check('last egg: the run sold exactly its supply', Number(sold[0].sold_count) === 1, `sold=${sold[0].sold_count}`);
        const { rows: held } = await pool.query(`SELECT COUNT(*)::int AS n FROM inventory_items WHERE catalog_key = $1`, [LAST_EGG_KEY]);
        check('last egg: exactly one egg exists', held[0].n === 1, `eggs=${held[0].n}`);
        for (const b of buyers) await ledgerConsistent(`last egg buyer ${b.userId.slice(0, 8)}`, b.userId);

        // 4b. Oversell: hold 10 shares, fire 8 simultaneous "sell 10".
        const trader = await createSessionUser(email('race-sell'));
        await seedBalance(trader.userId, 20000);
        const bought = await api('POST', '/api/tankdaq/buy', { cookie: trader.cookie, body: { tickerKey: TICKER, shares: 10, tradeToken: crypto.randomUUID() } });
        check('setup: bought 10 shares', bought.status === 200 && (await sharesHeld(trader.userId)) === 10, JSON.stringify(bought.json));
        const sellRace = await fireParallel({
            method: 'POST', path: '/api/tankdaq/sell', n: 8,
            build: () => ({ headers: { Cookie: trader.cookie }, body: { tickerKey: TICKER, shares: 10, tradeToken: crypto.randomUUID() } }),
        });
        check('oversell race: exactly one sell of 10 succeeds', countStatus(sellRace, 200) === 1, JSON.stringify(tally(sellRace)));
        check('oversell race: holdings end at 0, never negative', (await sharesHeld(trader.userId)) === 0);
        const { rows: sells } = await pool.query(`SELECT COUNT(*)::int AS n FROM share_trades WHERE user_id = $1 AND side = 'sell'`, [trader.userId]);
        check('oversell race: exactly one sell trade recorded', sells[0].n === 1, `sells=${sells[0].n}`);
        await ledgerConsistent('oversell race', trader.userId);

        // 4c. Buys and sells interleaved: hold 4, then 4 buys of 1 and 4 sells of 1 at once.
        const mixer = await createSessionUser(email('race-mix'));
        await seedBalance(mixer.userId, 20000);
        await api('POST', '/api/tankdaq/buy', { cookie: mixer.cookie, body: { tickerKey: TICKER, shares: 4, tradeToken: crypto.randomUUID() } });
        // fireParallel targets a single path, so the interleave uses the same gate pattern
        // inline: every request is built first, then all eight are released together.
        await fetch(`${BASE_URL}/`).catch(() => {});
        let release!: () => void;
        const gate = new Promise<void>((r) => { release = r; });
        const fire = (path: string) => (async () => {
            await gate;
            const res = await fetch(`${BASE_URL}${path}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: mixer.cookie },
                body: JSON.stringify({ tickerKey: TICKER, shares: 1, tradeToken: crypto.randomUUID() }),
            });
            return { path, status: res.status };
        })();
        const waves = [...Array(4)].flatMap(() => [fire('/api/tankdaq/buy'), fire('/api/tankdaq/sell')]);
        release();
        const mixed = await Promise.all(waves);
        const okBuys = mixed.filter((r) => r.path.endsWith('/buy') && r.status === 200).length;
        const okSells = mixed.filter((r) => r.path.endsWith('/sell') && r.status === 200).length;
        check('interleaved buy/sell: final shares == 4 + successful buys - successful sells', (await sharesHeld(mixer.userId)) === 4 + okBuys - okSells,
            `held=${await sharesHeld(mixer.userId)} buys=${okBuys} sells=${okSells}`);
        const { rows: tr } = await pool.query(
            `SELECT COALESCE(SUM(CASE WHEN side = 'buy' THEN shares ELSE -shares END), 0)::int AS net FROM share_trades WHERE user_id = $1 AND ticker_key = $2`,
            [mixer.userId, TICKER],
        );
        check('interleaved buy/sell: the trade journal nets to the holding', tr[0].net === (await sharesHeld(mixer.userId)), `journal=${tr[0].net}`);
        await ledgerConsistent('interleaved buy/sell', mixer.userId);

        // 4d. Onboarding raced 8 ways - one account, one username, one welcome gift.
        const newbie = await createSessionUser(email('race-onboard'), { onboarded: false });
        const stamp = Date.now() % 100000;
        const onboard = await fireParallel({
            method: 'POST', path: '/api/onboarding/complete', n: 8,
            build: (i) => ({ headers: { Cookie: newbie.cookie }, body: { username: `secgapsob${stamp}${i}`, acceptTerms: true } }),
        });
        // Losers get 200 { alreadyOnboarded, username: <the winner's> } by design (complete.ts:69-77).
        const winners = onboard.filter((r) => r.status === 200 && r.json?.ok === true && r.json?.alreadyOnboarded !== true);
        check('onboarding x8 at once: exactly one request wins the signature', winners.length === 1, JSON.stringify(onboard.map((r) => [r.status, r.json?.alreadyOnboarded ?? false])));
        const { rows: nm } = await pool.query(`SELECT username FROM waitlist WHERE id = $1`, [newbie.userId]);
        check('onboarding race: every loser was told the name that actually won',
            onboard.every((r) => r.status !== 200 || r.json?.username === nm[0].username), `stored=${nm[0].username}`);
        const { rows: gifts } = await pool.query(`SELECT COUNT(*)::int AS n FROM ember_ledger WHERE user_id = $1 AND rule_key = 'welcome_gift'`, [newbie.userId]);
        check('onboarding race: exactly one welcome gift row', gifts[0].n === 1, `gifts=${gifts[0].n}`);
        await ledgerConsistent('onboarding race', newbie.userId);
    }

    // =================================================================================
    section('5. Tampered pick and trade fields');
    // =================================================================================
    {
        const tank = await pickableTank('tamper');
        const u = await createSessionUser(email('tamper'));

        const res = await api('POST', '/api/picks', {
            cookie: u.cookie,
            body: { slug: tank.slug, side: 'Yes', sideIndex: 0, impliedProb: 0.01, implied_prob_at_lock: 0.01, outcome_index: 1, outcomeIndex: 1 },
        });
        check('pick with client odds/index fields -> 201 (extra fields ignored)', res.status === 201, `${res.status} ${JSON.stringify(res.json)}`);
        const { rows: p } = await pool.query(`SELECT outcome_index, implied_prob_at_lock::float8 AS p, side FROM picks WHERE waitlist_id = $1 AND tank_page_id = $2`, [u.userId, tank.id]);
        check('pick: stored odds are the snapshot price (0.4), not the client value', p.length === 1 && Math.abs(p[0].p - 0.4) < 1e-9, JSON.stringify(p[0]));
        check('pick: stored outcome_index is sideIndex (0), not the client outcome_index', p[0]?.outcome_index === 0, JSON.stringify(p[0]));

        const tank2 = await pickableTank('tamper-mismatch');
        const mismatch = await api('POST', '/api/picks', { cookie: u.cookie, body: { slug: tank2.slug, side: 'No', sideIndex: 0 } });
        check("pick: a side label that doesn't match sideIndex -> 400", mismatch.status === 400, `${mismatch.status} ${JSON.stringify(mismatch.json)}`);

        const trader = await createSessionUser(email('tamper-trade'));
        await seedBalance(trader.userId, 20000);
        const detail = await api('GET', `/api/tickers/detail?key=${TICKER}`);
        const livePrice = Number(detail.json?.ticker?.price);
        const before = await balanceOf(trader.userId);
        const tampered = await api('POST', '/api/tankdaq/buy', {
            cookie: trader.cookie, body: { tickerKey: TICKER, shares: 2, tradeToken: crypto.randomUUID(), price: 0.0001, expectedPrice: 0.0001, emberAmount: 1 },
        });
        const paid = before - (await balanceOf(trader.userId));
        check('buy with client price/emberAmount -> charged the server price', tampered.status === 200 && paid === Math.ceil(2 * livePrice - 1e-9),
            `status=${tampered.status} paid=${paid} live=${livePrice}`);

        const rawBuy = (raw: string) => fetch(`${BASE_URL}/api/tankdaq/buy`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: trader.cookie }, body: raw }).then((r) => r.status);
        const tok = () => crypto.randomUUID();
        const shapes: Array<[string, string]> = [
            ['shares as a string', `{"tickerKey":"${TICKER}","shares":"5","tradeToken":"${tok()}"}`],
            ['shares as an array', `{"tickerKey":"${TICKER}","shares":[5],"tradeToken":"${tok()}"}`],
            ['shares = 1e309 (Infinity)', `{"tickerKey":"${TICKER}","shares":1e309,"tradeToken":"${tok()}"}`],
            ['shares negative', `{"tickerKey":"${TICKER}","shares":-3,"tradeToken":"${tok()}"}`],
            ['body not JSON', `shares=5`],
        ];
        const beforeShapes = await balanceOf(trader.userId);
        for (const [label, raw] of shapes) {
            const s = await rawBuy(raw);
            check(`buy with ${label} -> 400`, s === 400, `status ${s}`);
        }
        check('malformed buys moved no Ember', (await balanceOf(trader.userId)) === beforeShapes);
        const neverHeld = await api('POST', '/api/tankdaq/sell', { cookie: (await createSessionUser(email('tamper-empty'))).cookie, body: { tickerKey: TICKER, shares: 1, tradeToken: crypto.randomUUID() } });
        check('selling shares never held -> 409', neverHeld.status === 409, `status ${neverHeld.status}`);
        await ledgerConsistent('tampered trades', trader.userId);
    }

    // =================================================================================
    section('6. Client-reported place (design item)');
    // =================================================================================
    {
        const petless = await createSessionUser(email('place-petless'));
        const noPet = await api('GET', '/api/toolbar-state?place=/tankdaq', { cookie: petless.cookie });
        check('petless account: toolbar-state with a place -> 200', noPet.status === 200, `status ${noPet.status}`);
        const { rows: petlessRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM pets WHERE user_id = $1`, [petless.userId]);
        check('petless account: no pet row appears', petlessRows[0].n === 0);

        // A pet whose footprints are reported by direct API calls, with no page ever loaded.
        const u = await createSessionUser(email('place'));
        const eggKey = (await cheapestActiveSku('egg')).catalogKey;
        const eggId = await seedEgg(u.userId, eggKey);
        const hatched = await api('POST', '/api/pets/hatch', { cookie: u.cookie, body: { inventoryItemId: eggId } });
        check('setup: pet hatched', hatched.status === 201, `${hatched.status} ${JSON.stringify(hatched.json)}`);
        await parkAllEncounters(u.userId);
        const places = ['/the-hatchery', '/champions-terrace', '/quickboost-delicacies', '/my-portfolio'];
        for (const place of places) {
            await api('GET', `/api/toolbar-state?place=${encodeURIComponent(place)}`, { cookie: u.cookie });
        }
        const { rows: fp } = await pool.query(`SELECT places_since_find FROM pets WHERE user_id = $1`, [u.userId]);
        const recorded: string[] = fp[0]?.places_since_find ?? [];
        const spoofed = places.filter((p) => recorded.includes(p.slice(1))).length;
        if (spoofed > 0) {
            warn(`?place= is taken as reported: ${spoofed}/${places.length} footprints recorded from API calls alone (${recorded.join(',')}) - by design for a static site, audit decision item`);
        }
        check('footprints only ever hold allowlisted places', recorded.every((k) => /^[a-z0-9:-]+$/.test(k)), recorded.join(','));
    }
}

export const suite: Suite = {
    name: 'security-gaps',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
