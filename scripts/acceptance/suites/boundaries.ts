// Acceptance suite for hard numeric thresholds scattered across the app - the exact
// lines where behavior flips. Each threshold below is tested one unit BELOW, AT, and
// (where meaningful) ABOVE the line, and every check's name states explicitly which
// side is the documented/correct behavior, confirmed against the real source at the
// time this suite was written:
//   1. Satisfaction == 100          - lib/pages-functions/pets.ts + functions/api/pets/feed.ts
//   2. Hungry/Satisfied == 40       - lib/pages-functions/pets.ts's petState()
//   3. Daily pick cap (env-driven)  - functions/api/picks.ts + functions/api/picks/today.ts
//   4. $DOGS/$CHALK pivot == 0.5    - lib/pages-functions/tickers.ts's DOGS_CHALK_PIVOT
//   5. $LOCKS == locks_min_prob     - tickers.ts's checkEligibility('heavy_favorite')
//   6. $MOONSHOT == moonshot_max_prob - tickers.ts's checkEligibility('longshot')
//   7. Ticker tag delta cap         - tickers.ts's fetchTagDelta() clamp + capped flag
//   8. Sustained-satisfaction gate  - lib/pages-functions/discovery.ts's maybeDiscover()
//   9. Login token expiry == 15min  - functions/api/login/consume.ts (two mechanisms)
//  10. Session sliding-refresh == 1h throttle - lib/pages-functions/session.ts's getSession()
//
// Numbers quoted in comments (hungry_threshold=40, locks_min_prob=0.80,
// moonshot_max_prob=0.20, sustained_hours=2, max_satisfaction=100) are read LIVE from
// game_config wherever the code treats them as tunable - never hardcoded - so this
// suite keeps validating the true boundary even if a future migration retunes them.
// Only the DOGS/CHALK 0.5 pivot is a literal source constant (not game_config), per
// tickers.ts's own comment that it is "definitional, not a tunable".

import { pool, api, check, warn, near, section, type Suite } from '../harness';
import {
    createUser, createSessionUser, mintSessionCookie, mintLoginToken,
    insertTank, findMarkets, flipConfig, restoreConfig, activeConfig,
    cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix,
} from '../fixtures';

const EMAIL_PREFIX = 'acceptance-bound-';
const SLUG_PREFIX = 'acceptance-bound-';
const TICKER_SECRET = process.env.TICKER_SECRET || '';

function boundEmail(tag: string): string {
    return `${EMAIL_PREFIX}${tag}@example.com`;
}
function boundSlug(tag: string): string {
    return `${SLUG_PREFIX}${tag}`;
}

const tagPost = (body: unknown) =>
    api('POST', '/api/ticker-tags', { body, headers: { 'X-Ticker-Secret': TICKER_SECRET } });

async function cleanup(): Promise<void> {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

// Mirrors suites/discovery.ts's insertPet - duplicated locally since suite files don't
// import from each other, only from harness.ts/fixtures.ts.
async function insertPet(userId: string): Promise<string> {
    const { rows } = await pool.query(`INSERT INTO pets (user_id, color) VALUES ($1, 'slate') RETURNING id`, [userId]);
    return rows[0].id as string;
}

async function run(): Promise<void> {
    await cleanup();

    // =====================================================================================
    section("1. Satisfaction == 100 - feed rejection (feed.ts: `current >= cfg.max_satisfaction` rejects BEFORE any write)");
    // =====================================================================================
    {
        const feeder = await createSessionUser(boundEmail('feed-100'));
        const petId = await insertPet(feeder.userId);
        const feedingCfg = await activeConfig('feeding');
        const max = Number(feedingCfg.max_satisfaction);
        console.log(`  [boundaries] Active feeding.max_satisfaction = ${max}`);

        const { rows: foodRows } = await pool.query(
            `SELECT key FROM items_catalog WHERE item_type = 'food' AND active = true ORDER BY key LIMIT 1`,
        );
        if (foodRows.length === 0) throw new Error('No active food SKU in items_catalog - cannot build the feed-boundary fixture.');
        const foodKey = foodRows[0].key as string;
        await pool.query(
            `INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity) VALUES ($1, $2, 'food', 3)`,
            [feeder.userId, foodKey],
        );

        // BELOW the line (max - 1): accepted.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW() WHERE id = $1`, [petId, max - 1]);
        const below = await api('POST', '/api/pets/feed', { cookie: feeder.cookie, body: { foodCatalogKey: foodKey, feedToken: crypto.randomUUID() } });
        check(
            `satisfaction BELOW max (${max - 1}) -> feed ACCEPTED (200) - documented side is accept-below-max`,
            below.status === 200 && typeof below.json?.pet?.state === 'string',
            JSON.stringify(below.json),
        );
        const { rows: qtyAfterBelow } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`, [feeder.userId, foodKey]);
        check('accepted feed consumed exactly one food unit (3 -> 2)', qtyAfterBelow[0].quantity === 2, `got ${qtyAfterBelow[0].quantity}`);

        // AT the line (exactly max): rejected, before any write.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW() WHERE id = $1`, [petId, max]);
        const at = await api('POST', '/api/pets/feed', { cookie: feeder.cookie, body: { foodCatalogKey: foodKey, feedToken: crypto.randomUUID() } });
        check(
            `satisfaction AT max (${max}) -> feed REJECTED (409, full:true) - documented side is reject-at-or-above-max`,
            at.status === 409 && at.json?.full === true && typeof at.json?.message === 'string',
            JSON.stringify(at.json),
        );
        const { rows: qtyAfterAt } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`, [feeder.userId, foodKey]);
        check('rejected-at-max feed consumed no food (still 2)', qtyAfterAt[0].quantity === 2, `got ${qtyAfterAt[0].quantity}`);
        const { rows: satAfterAt } = await pool.query(`SELECT satisfaction_at_last_feed::float8 AS s FROM pets WHERE id = $1`, [petId]);
        check('rejected-at-max feed did not change satisfaction', Math.abs(satAfterAt[0].s - max) < 0.5, `got ${satAfterAt[0].s}`);

        // ABOVE the line (max + 5 - only reachable via direct DB write, never through the
        // app, but still exercises the >= comparison past its natural ceiling): rejected.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW() WHERE id = $1`, [petId, max + 5]);
        const above = await api('POST', '/api/pets/feed', { cookie: feeder.cookie, body: { foodCatalogKey: foodKey, feedToken: crypto.randomUUID() } });
        check(`satisfaction ABOVE max (${max + 5}) -> feed REJECTED (409, full:true)`, above.status === 409 && above.json?.full === true, JSON.stringify(above.json));
        const { rows: qtyAfterAbove } = await pool.query(`SELECT quantity FROM inventory_items WHERE user_id = $1 AND catalog_key = $2`, [feeder.userId, foodKey]);
        check('rejected-above-max feed consumed no food (still 2)', qtyAfterAbove[0].quantity === 2, `got ${qtyAfterAbove[0].quantity}`);
    }

    // =====================================================================================
    section("2. Hungry/Satisfied == game_config['feeding'].hungry_threshold (petState: `value >= cfg.hungry_threshold ? satisfied : hungry`)");
    // =====================================================================================
    {
        const feedingCfg = await activeConfig('feeding');
        const threshold = Number(feedingCfg.hungry_threshold);
        console.log(`  [boundaries] Active feeding.hungry_threshold = ${threshold}`);

        const u = await createSessionUser(boundEmail('hungry-threshold'));
        const petId = await insertPet(u.userId);

        // BELOW the line: hungry.
        await pool.query(
            `UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW(), next_eligible_roll_at = NOW() + INTERVAL '1 day' WHERE id = $1`,
            [petId, threshold - 1],
        );
        const below = await api('GET', '/api/toolbar-state', { cookie: u.cookie });
        check(`satisfaction BELOW threshold (${threshold - 1}) -> state 'hungry' - documented side is hungry-strictly-below`, below.json?.pet?.state === 'hungry', JSON.stringify(below.json?.pet));

        // AT the line: satisfied (>= is inclusive).
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW() WHERE id = $1`, [petId, threshold]);
        const at = await api('GET', '/api/toolbar-state', { cookie: u.cookie });
        check(`satisfaction AT threshold (${threshold}) -> state 'satisfied' - documented side is satisfied-at-or-above`, at.json?.pet?.state === 'satisfied', JSON.stringify(at.json?.pet));

        // ABOVE the line: satisfied.
        await pool.query(`UPDATE pets SET satisfaction_at_last_feed = $2, last_fed_at = NOW() WHERE id = $1`, [petId, threshold + 1]);
        const above = await api('GET', '/api/toolbar-state', { cookie: u.cookie });
        check(`satisfaction ABOVE threshold (${threshold + 1}) -> state 'satisfied'`, above.json?.pet?.state === 'satisfied', JSON.stringify(above.json?.pet));
    }

    // =====================================================================================
    section('3. Daily pick cap (CAP-AGNOSTIC by design - functions/api/picks.ts: `numEnv(context.env.DAILY_PICK_CAP, 1)`)');
    // =====================================================================================
    {
        // NOTE on process.env.DAILY_PICK_CAP: NOT attempted here. This script is a Node
        // process talking HTTP to a separately-running `wrangler pages dev` process;
        // Cloudflare Pages Functions read their env from wrangler config/.dev.vars in
        // THAT process, not from process.env of whatever client happens to be calling it
        // over the wire. scripts/acceptance.ts's own printResolvedConfig() comment
        // ("DAILY_PICK_CAP has no DB row - it's an env var read fresh per-request by the
        // dev server process") makes the same distinction. Setting process.env here would
        // affect nothing. So: observe only, log loudly, and test the cap logic itself at
        // whatever value is actually in force.
        const picker = await createSessionUser(boundEmail('pick-cap'));
        const probe = await api('GET', '/api/picks/today', { cookie: picker.cookie });
        check('fresh user, zero picks -> GET /api/picks/today succeeds', probe.status === 200 && probe.json?.picksToday === 0, JSON.stringify(probe.json));
        const cap = Number(probe.json?.remaining);
        console.log(`  [boundaries] Observed DAILY_PICK_CAP (via zero-pick /api/picks/today.remaining) = ${cap}`);
        check('observed cap is a positive integer', Number.isInteger(cap) && cap > 0, `got ${cap}`);

        // cap+1 tank fixtures.
        for (let i = 0; i < cap + 1; i++) {
            await insertTank({ slug: boundSlug(`pick-cap-${i}`), marketId: `acceptance-bound-cap-market-${i}`, outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        }

        // Picks 1..cap all succeed.
        for (let i = 0; i < cap; i++) {
            const res = await api('POST', '/api/picks', { cookie: picker.cookie, body: { slug: boundSlug(`pick-cap-${i}`), side: 'Yes', sideIndex: 0 } });
            check(`pick ${i + 1}/${cap} (WITHIN cap) -> 201`, res.status === 201, JSON.stringify(res.json));
        }

        // The cap+1'th pick -> 429, exact shape.
        const overCap = await api('POST', '/api/picks', { cookie: picker.cookie, body: { slug: boundSlug(`pick-cap-${cap}`), side: 'Yes', sideIndex: 0 } });
        check(
            `pick ${cap + 1}/${cap} (ONE ABOVE cap) -> 429, remaining:0 - documented side is reject-at-or-above cap`,
            overCap.status === 429 && overCap.json?.remaining === 0 && typeof overCap.json?.message === 'string' && typeof overCap.json?.picksToday === 'number',
            JSON.stringify(overCap.json),
        );

        const { rows: countRows } = await pool.query(`SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1`, [picker.userId]);
        check(`exactly ${cap} rows in picks for this user (the rejected cap+1'th pick was never inserted)`, countRows[0].n === cap, `got ${countRows[0].n}`);

        // Newsletter carve-out. Confirmed against add_newsletter_columns_to_picks.sql +
        // functions/api/newsletter/pick.ts: the real source value is 'newsletter_exclusive',
        // NOT 'newsletter' as an earlier summary of this task assumed. picks.ts and
        // picks/today.ts's daily-cap COUNT(*) queries both filter `AND source = 'app'`,
        // so a newsletter_exclusive pick is excluded from the cap count/remaining.
        const nlTankSlug = boundSlug('pick-cap-newsletter');
        const nlTankId = await insertTank({ slug: nlTankSlug, marketId: 'acceptance-bound-cap-market-nl', outcomes: ['Yes', 'No'], outcomePrices: [0.5, 0.5] });
        await pool.query(
            `INSERT INTO picks (waitlist_id, tank_page_id, tank_slug, side, outcome_index, implied_prob_at_lock, source)
             VALUES ($1, $2, $3, 'Yes', 0, 0.5, 'newsletter_exclusive')`,
            [picker.userId, nlTankId, nlTankSlug],
        );
        const afterNl = await api('GET', '/api/picks/today', { cookie: picker.cookie });
        check(
            `newsletter_exclusive pick does NOT count toward the cap - picksToday still ${cap}, remaining still 0`,
            afterNl.json?.picksToday === cap && afterNl.json?.remaining === 0,
            JSON.stringify(afterNl.json),
        );
        const { rows: allSourceCount } = await pool.query(`SELECT COUNT(*)::int AS n FROM picks WHERE waitlist_id = $1`, [picker.userId]);
        check(`total picks rows across ALL sources is ${cap + 1} (the newsletter row exists but is carved out of the app cap)`, allSourceCount[0].n === cap + 1, `got ${allSourceCount[0].n}`);
    }

    const markets = await findMarkets();
    console.log(`  [boundaries] Live market for ticker-eligibility fixtures: ${markets.live.id}`);

    // =====================================================================================
    section("4. $DOGS/$CHALK pivot == 0.5 (tickers.ts DOGS_CHALK_PIVOT - hardcoded constant, NOT a game_config tunable)");
    // =====================================================================================
    {
        let n = 0;
        const tag = async (tickerKey: string, price: number) => {
            const s = boundSlug(`pivot-${tickerKey}-${n++}`);
            await insertTank({ slug: s, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [price, 1 - price] });
            return tagPost({ slug: s, tickerKey, relevantSide: 0 });
        };

        const chalkAt = await tag('chalk', 0.5);
        check("AT 0.5 - chalk/favorite (requires sideProb >= 0.5) -> 201 accepted - documented side is accept-at-or-above", chalkAt.status === 201, JSON.stringify(chalkAt.json));
        const dogsAt = await tag('dogs', 0.5);
        check("AT 0.5 - dogs/underdog (requires sideProb < 0.5) -> 422 ineligible - documented side is reject-at-or-above", dogsAt.status === 422 && dogsAt.json?.code === 'ineligible', JSON.stringify(dogsAt.json));

        const dogsBelow = await tag('dogs', 0.499);
        check('BELOW 0.5 (0.499) - dogs -> 201 accepted', dogsBelow.status === 201, JSON.stringify(dogsBelow.json));
        const chalkBelow = await tag('chalk', 0.499);
        check('BELOW 0.5 (0.499) - chalk -> 422 ineligible', chalkBelow.status === 422 && chalkBelow.json?.code === 'ineligible', JSON.stringify(chalkBelow.json));

        const chalkAbove = await tag('chalk', 0.501);
        check('ABOVE 0.5 (0.501) - chalk -> 201 accepted', chalkAbove.status === 201, JSON.stringify(chalkAbove.json));
        const dogsAbove = await tag('dogs', 0.501);
        check('ABOVE 0.5 (0.501) - dogs -> 422 ineligible', dogsAbove.status === 422 && dogsAbove.json?.code === 'ineligible', JSON.stringify(dogsAbove.json));
    }

    // =====================================================================================
    section("5. $LOCKS == game_config['tickers'].locks_min_prob (heavy_favorite: sideProb >= locks_min_prob)");
    // =====================================================================================
    {
        const tCfg = await activeConfig('tickers');
        const locksMin = Number(tCfg.locks_min_prob);
        console.log(`  [boundaries] Active tickers.locks_min_prob = ${locksMin}`);
        let n = 0;
        const tag = async (price: number) => {
            const s = boundSlug(`locks-${n++}`);
            await insertTank({ slug: s, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [price, 1 - price] });
            return tagPost({ slug: s, tickerKey: 'locks', relevantSide: 0 });
        };

        const below = await tag(locksMin - 0.001);
        check(`BELOW locks_min_prob (${(locksMin - 0.001).toFixed(3)}) -> 422 ineligible - documented side is reject-strictly-below`, below.status === 422 && below.json?.code === 'ineligible', JSON.stringify(below.json));
        const at = await tag(locksMin);
        check(`AT locks_min_prob (${locksMin}) -> 201 accepted - documented side is accept-at-or-above`, at.status === 201, JSON.stringify(at.json));
        const above = await tag(locksMin + 0.001);
        check(`ABOVE locks_min_prob (${(locksMin + 0.001).toFixed(3)}) -> 201 accepted`, above.status === 201, JSON.stringify(above.json));
    }

    // =====================================================================================
    section("6. $MOONSHOT == game_config['tickers'].moonshot_max_prob (longshot: sideProb < moonshot_max_prob)");
    // =====================================================================================
    {
        const tCfg = await activeConfig('tickers');
        const moonMax = Number(tCfg.moonshot_max_prob);
        console.log(`  [boundaries] Active tickers.moonshot_max_prob = ${moonMax}`);
        let n = 0;
        const tag = async (price: number) => {
            const s = boundSlug(`moon-${n++}`);
            await insertTank({ slug: s, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [1 - price, price] });
            return tagPost({ slug: s, tickerKey: 'moonshot', relevantSide: 1 });
        };

        const below = await tag(moonMax - 0.001);
        check(`BELOW moonshot_max_prob (${(moonMax - 0.001).toFixed(3)}) -> 201 accepted - documented side is accept-strictly-below`, below.status === 201, JSON.stringify(below.json));
        const at = await tag(moonMax);
        check(`AT moonshot_max_prob (${moonMax}) -> 422 ineligible - documented side is reject-at-or-above`, at.status === 422 && at.json?.code === 'ineligible', JSON.stringify(at.json));
        const above = await tag(moonMax + 0.001);
        check(`ABOVE moonshot_max_prob (${(moonMax + 0.001).toFixed(3)}) -> 422 ineligible`, above.status === 422 && above.json?.code === 'ineligible', JSON.stringify(above.json));
    }

    // =====================================================================================
    section("7. Ticker tag movement cap (default +/-10%, game_config['tickers'].tag_delta_cap_pct) - strict `>`, not `>=` (fetchTagDelta: `capped = Math.abs(rawDelta) > capPct`)");
    // =====================================================================================
    {
        try {
            await flipConfig('tickers', { tag_delta_cap_pct: 100 });
            const tankRaw = boundSlug('cap-raw');
            await insertTank({ slug: tankRaw, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.3, 0.7] });
            const rawRes = await tagPost({ slug: tankRaw, tickerKey: 'dogs', relevantSide: 0 });
            check('uncapped (cap=100) tag -> 201, raw 3-day movement observed', rawRes.status === 201, JSON.stringify(rawRes.json));
            const rawDelta = Number(rawRes.json?.rawDelta);

            if (!Number.isFinite(rawDelta) || Math.abs(rawDelta) < 0.05) {
                warn(`live market's 3-day movement is ~0 (rawDelta=${rawDelta}) - thin/flat history this run, skipping the exact-cap boundary checks gracefully`);
            } else {
                const capAbs = Math.abs(rawDelta);

                await restoreConfig('tickers');
                await flipConfig('tickers', { tag_delta_cap_pct: capAbs });
                const tankAt = boundSlug('cap-at');
                await insertTank({ slug: tankAt, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.3, 0.7] });
                const atRes = await tagPost({ slug: tankAt, tickerKey: 'dogs', relevantSide: 0 });
                check(
                    `AT cap (cap == |rawDelta| == ${capAbs.toFixed(3)}) -> NOT capped (capped:false, delta==rawDelta) - documented side is not-capped-at-the-line`,
                    atRes.status === 201 && atRes.json?.capped === false && near(Number(atRes.json?.delta), rawDelta, 0.002),
                    JSON.stringify(atRes.json),
                );

                await restoreConfig('tickers');
                const capBelow = capAbs - 0.001;
                await flipConfig('tickers', { tag_delta_cap_pct: capBelow });
                const tankOver = boundSlug('cap-above');
                await insertTank({ slug: tankOver, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.3, 0.7] });
                const overRes = await tagPost({ slug: tankOver, tickerKey: 'dogs', relevantSide: 0 });
                check(
                    `ABOVE cap (cap == |rawDelta| - 0.001 == ${capBelow.toFixed(3)}) -> capped:true, |delta| == cap`,
                    overRes.status === 201 && overRes.json?.capped === true && near(Math.abs(Number(overRes.json?.delta)), capBelow, 0.002),
                    JSON.stringify(overRes.json),
                );
            }
        } finally {
            await restoreConfig('tickers');
        }
    }

    // =====================================================================================
    section("8. Sustained-satisfaction discovery gate == game_config['discovery'].sustained_hours (maybeDiscover: `elapsed >= sustained_hours * 3_600_000`ms - a game_config value, NOT an env var)");
    // =====================================================================================
    {
        const dCfg = await activeConfig('discovery');
        const sustainedHours = Number(dCfg.sustained_hours);
        console.log(`  [boundaries] Active discovery.sustained_hours = ${sustainedHours}`);
        const feedingCfg = await activeConfig('feeding');
        const max = Number(feedingCfg.max_satisfaction);

        const roller = await createSessionUser(boundEmail('sustained-gate'));
        const petId = await insertPet(roller.userId);

        // ABOVE the line by a 2-second cushion (elapsed comfortably >= sustained_hours) ->
        // short cooldown window (45-60m per add_pet_discovery.sql's seed + suites/
        // discovery.ts's own "sustained-satisfied" precedent test). The cushion absorbs
        // request latency around the exact instant, which can't be hit deterministically.
        await pool.query(
            `UPDATE pets SET satisfaction_at_last_feed = $2,
                              last_fed_at = NOW() - ($3 * INTERVAL '1 hour') - INTERVAL '2 seconds',
                              next_eligible_roll_at = NOW() - INTERVAL '1 minute'
             WHERE id = $1`,
            [petId, max, sustainedHours],
        );
        await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
        const { rows: shortRows } = await pool.query(`SELECT EXTRACT(EPOCH FROM (next_eligible_roll_at - NOW())) / 60 AS mins FROM pets WHERE id = $1`, [petId]);
        const shortMins = Number(shortRows[0].mins);
        check(
            `elapsed == sustained_hours + 2s cushion (ABOVE/AT the line) -> SHORT cooldown window (45-60m)`,
            shortMins > 43 && shortMins <= 60.5,
            `got ${shortMins.toFixed(1)}m`,
        );

        // BELOW the line by a 2-minute cushion (elapsed just under sustained_hours) -> long
        // window (90-120m). Also re-arms next_eligible_roll_at into the past in the same
        // statement so this second roll is due.
        await pool.query(
            `UPDATE pets SET satisfaction_at_last_feed = $2,
                              last_fed_at = NOW() - (($3 * 60 - 2) * INTERVAL '1 minute'),
                              next_eligible_roll_at = NOW() - INTERVAL '1 minute'
             WHERE id = $1`,
            [petId, max, sustainedHours],
        );
        await api('GET', '/api/toolbar-state', { cookie: roller.cookie });
        const { rows: longRows } = await pool.query(`SELECT EXTRACT(EPOCH FROM (next_eligible_roll_at - NOW())) / 60 AS mins FROM pets WHERE id = $1`, [petId]);
        const longMins = Number(longRows[0].mins);
        check(
            `elapsed == sustained_hours - 2min cushion (BELOW the line) -> LONG cooldown window (90-120m)`,
            longMins > 88 && longMins <= 120.5,
            `got ${longMins.toFixed(1)}m`,
        );
    }

    // =====================================================================================
    section('9. Login token expiry == 15 minutes - two independent mechanisms (functions/api/login/consume.ts)');
    // =====================================================================================
    {
        // (a) the signed token's own exp claim (LOGIN_TOKEN_TTL_SECONDS = 15*60 in login.ts).
        const u1 = await createUser(boundEmail('login-ttl-exp'));
        const expiredSig = await mintLoginToken(u1.userId, { ttlSeconds: -1 });
        const expiredSigRes = await api('POST', '/api/login/consume', { body: { token: expiredSig } });
        check(
            'exp already in the past (ttlSeconds:-1) -> consume rejected (400, invalid/expired copy) - documented side is reject-past-exp',
            expiredSigRes.status === 400 && expiredSigRes.json?.message === 'This login link is invalid or has expired. Request a new one.',
            JSON.stringify(expiredSigRes.json),
        );

        const u2 = await createUser(boundEmail('login-ttl-exp-ok'));
        const validSig = await mintLoginToken(u2.userId, { ttlSeconds: 900 });
        const validSigRes = await api('POST', '/api/login/consume', { body: { token: validSig } });
        check(
            'exp AT exactly 15 minutes out (ttlSeconds:900) -> consume succeeds immediately - documented side is valid-through-exp',
            validSigRes.status === 200,
            JSON.stringify(validSigRes.json),
        );

        // (b) the DB-side login_nonce_expires_at, independent of the token's own
        // signature/exp (consume.ts checks both: verifyAuthToken, THEN the nonce row).
        const u3 = await createUser(boundEmail('login-ttl-db'));
        const dbExpired = await mintLoginToken(u3.userId, { dbTtlSeconds: -1 });
        const dbExpiredRes = await api('POST', '/api/login/consume', { body: { token: dbExpired } });
        check(
            'DB nonce already expired (dbTtlSeconds:-1, token signature/exp otherwise fine) -> consume rejected (400, "already used or replaced" copy - confirmed distinct from the invalid/expired copy above)',
            dbExpiredRes.status === 400 && dbExpiredRes.json?.message === 'This login link has already been used or replaced. Request a fresh one to log in.',
            JSON.stringify(dbExpiredRes.json),
        );

        const u4 = await createUser(boundEmail('login-ttl-db-ok'));
        const dbValid = await mintLoginToken(u4.userId, { dbTtlSeconds: 900 });
        const dbValidRes = await api('POST', '/api/login/consume', { body: { token: dbValid } });
        check('DB nonce valid (dbTtlSeconds:900) -> consume succeeds', dbValidRes.status === 200, JSON.stringify(dbValidRes.json));
    }

    // =====================================================================================
    section("10. Session sliding-refresh == 1 hour throttle (session.ts getSession(): refresh WHEN `expires_at < NOW() + 30 days - 1 hour`, strict `<`)");
    // =====================================================================================
    {
        const u = await createUser(boundEmail('session-throttle'));
        const cookie = await mintSessionCookie(u.userId);

        // Just PAST the throttle (drifted MORE than 1 hour behind a full 30 days out) ->
        // the refresh condition is true, so a slide fires. suites/discovery.ts already
        // covers a deep-drift positive case (20 days out); this is the boundary-crossing one.
        await pool.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '30 days' - INTERVAL '1 hour' - INTERVAL '10 seconds' WHERE user_id = $1`, [u.userId]);
        const { rows: beforePast } = await pool.query(`SELECT expires_at FROM sessions WHERE user_id = $1`, [u.userId]);
        const pastRes = await api('GET', '/api/toolbar-state', { cookie });
        check(
            'drift == 1h + 10s past the throttle line (JUST ABOVE it) -> Set-Cookie present, refresh fires - documented side is refresh-when-more-than-1h-behind',
            pastRes.status === 200 && (pastRes.headers.get('set-cookie') ?? '').includes('hc_session='),
            pastRes.headers.get('set-cookie') ?? '(no set-cookie header)',
        );
        const { rows: afterPast } = await pool.query(`SELECT expires_at FROM sessions WHERE user_id = $1`, [u.userId]);
        check(
            'DB expires_at moved forward to a fresh ~30 days out',
            new Date(afterPast[0].expires_at).getTime() > new Date(beforePast[0].expires_at).getTime() + 55 * 60 * 1000,
            `before ${beforePast[0].expires_at}, after ${afterPast[0].expires_at}`,
        );

        // Well WITHIN the throttle (only 50 minutes drifted, < 1 hour behind) -> no refresh.
        await pool.query(`UPDATE sessions SET expires_at = NOW() + INTERVAL '30 days' - INTERVAL '50 minutes' WHERE user_id = $1`, [u.userId]);
        const { rows: beforeWithin } = await pool.query(`SELECT expires_at FROM sessions WHERE user_id = $1`, [u.userId]);
        const withinRes = await api('GET', '/api/toolbar-state', { cookie });
        check(
            'drift == 50min, BELOW the 1h throttle line -> NO Set-Cookie, throttled - the missing negative case suites/discovery.ts does not cover',
            withinRes.status === 200 && !(withinRes.headers.get('set-cookie') ?? '').includes('hc_session='),
            withinRes.headers.get('set-cookie') ?? '(none)',
        );
        const { rows: afterWithin } = await pool.query(`SELECT expires_at FROM sessions WHERE user_id = $1`, [u.userId]);
        check(
            'DB expires_at unchanged (throttled - no UPDATE ran)',
            new Date(afterWithin[0].expires_at).getTime() === new Date(beforeWithin[0].expires_at).getTime(),
            `before ${beforeWithin[0].expires_at}, after ${afterWithin[0].expires_at}`,
        );
    }

    await cleanup();
}

export const suite: Suite = {
    name: 'boundaries',
    requiredEnv: ['SETTLE_SECRET', 'TICKER_SECRET', 'SESSION_TOKEN_SECRET'],
    run,
};
