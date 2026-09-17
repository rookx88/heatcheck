// Acceptance suite for the TANKDAQ detail page's reader layer (2026-09-12): the read
// line (readLineFor, lib/pages-functions/ticker-copy.ts), the portfolio overlay
// endpoint (functions/api/tankdaq/overlay.ts) and the built island's markup. Run after
// any change to those, to snapshotEligibilityContext / checkEligibility (tickers.ts),
// or to the close scoring in index-slate.ts.
//
// Three tiers:
//   1. Pure - every active ticker's rule_type produces a read line that names the index,
//      stays past-tense/neutral, and says so when nothing moved.
//   2. HTTP - the overlay's gates (401/403/400/404) and its classification: fixture picks
//      on three fixture tanks, each settled by hand the way ledger.ts's settleCall stamps
//      them, then read back per index. The picks are re-run through the SAME rule the
//      tag path applies, so $DOGS sees the 0.38 side, $OVERS the Over, $CHALK and
//      $GRIDIRON the NFL favorite - and nothing else.
//   3. Bundle - dist/assets/tankdaq-ticker.js carries "What moved it" and no longer
//      prints "Recent Results".
// Fixture tanks are newsletter_only so they never reach the live feed; cleanup is by
// slug/email prefix and registered as a teardown.

import fs from 'node:fs';
import path from 'node:path';
import { pool, api, check, near, section, registerTeardown, type Suite } from '../harness';
import {
    activeConfig, cleanupTanksBySlugPrefix, cleanupUsersByEmailPrefix, createSessionUser, insertTank, insertUserWithPick,
} from '../fixtures';
import { readLineFor } from '../../../lib/pages-functions/ticker-copy';
import { closeDelta, contributionFor } from '../../../lib/pages-functions/index-slate';

const PREFIX = 'acceptance-overlay-';
const EMAIL = `${PREFIX}user@example.com`;
const EMAIL_UNONBOARDED = `${PREFIX}new@example.com`;
// Forward-looking or probability language has no place in a read line.
const NOT_NEUTRAL = /\b(will|expect|expects|likely|should|predict|forecast|probab)/i;

async function cleanup() {
    await cleanupUsersByEmailPrefix(PREFIX);
    await cleanupTanksBySlugPrefix(PREFIX);
}

async function settlePick(pickId: string, result: 'correct' | 'incorrect'): Promise<void> {
    // The same row write ledger.ts's settleCall performs (minus the Ember leg).
    await pool.query(`UPDATE picks SET result = $1, settled_at = NOW() WHERE id = $2 AND result IS NULL`, [result, pickId]);
}

async function run() {
    await cleanup();
    registerTeardown(cleanup);

    // --- 1. Pure: the read line ----------------------------------------------------
    section('readLineFor - one neutral sentence per rule family, per direction');
    const list = await api('GET', '/api/tickers');
    const tickers: Array<{ key: string; displayName: string; ruleType: string }> = list.json?.tickers ?? [];
    check('active tickers loaded for the sweep', tickers.length > 0);
    for (const t of tickers) {
        for (const pts of [1.2, -1.2, 0]) {
            const line = readLineFor(t.ruleType, t.displayName, pts, 'the past 3 days');
            const ok = line.includes(t.displayName) && line.includes('the past 3 days') && !NOT_NEUTRAL.test(line)
                && (pts === 0 ? line.startsWith('No settled results') : line.includes(pts > 0 ? 'is up 1.2 points' : 'is down 1.2 points'));
            check(`${t.key} (${t.ruleType}) at ${pts}: "${line}"`, ok);
        }
    }
    check('a league child names its league up front',
        readLineFor('nba_favorite', '$NBACHALK', -0.9, 'the past week') === 'In NBA over the past week, favorites got rolled more often than not; $NBACHALK is down 0.9 points.',
        readLineFor('nba_favorite', '$NBACHALK', -0.9, 'the past week'));
    check('the soccer family reads as plain "soccer"', readLineFor('soccer_underdog', '$SOCDOGS', 0.4, 'the past week').startsWith('In soccer over the past week,'));
    check('an unknown rule_type still reads, generically',
        readLineFor('made_up_rule', '$X', 0.3, 'the past week') === 'Over the past week the results this index tracks went its way; $X is up 0.3 points.');
    check('a move under 0.05 points reads as quiet, not "0.0 points"',
        readLineFor('underdog', '$DOGS', 0.04, 'the past 24 hours') === 'No settled results have moved $DOGS over the past 24 hours.');
    check('the whole-history label reads for the SSR fallback',
        readLineFor('underdog', '$DOGS', 2.5, 'its whole history') === 'Over its whole history the overlooked sides came through more often than not; $DOGS is up 2.5 points.');

    // --- 2. HTTP: the overlay ------------------------------------------------------
    section('/api/tankdaq/overlay - gates');
    const since = new Date(Date.now() - 3600_000).toISOString();
    const anon = await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(since)}`);
    check('anonymous -> 401', anon.status === 401);
    const fresh = await createSessionUser(EMAIL_UNONBOARDED, { onboarded: false });
    const gated = await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(since)}`, { cookie: fresh.cookie });
    check('signed in but not onboarded -> 403', gated.status === 403);
    const user = await createSessionUser(EMAIL, { username: 'overlay_fixture' });
    const noKey = await api('GET', `/api/tankdaq/overlay?since=${encodeURIComponent(since)}`, { cookie: user.cookie });
    check('missing key -> 400', noKey.status === 400);
    const noSince = await api('GET', '/api/tankdaq/overlay?key=dogs', { cookie: user.cookie });
    check('missing since -> 400', noSince.status === 400);
    const stale = await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(new Date(Date.now() - 40 * 24 * 3600_000).toISOString())}`, { cookie: user.cookie });
    check('since older than 31 days -> 400', stale.status === 400);
    const unknown = await api('GET', `/api/tankdaq/overlay?key=nope&since=${encodeURIComponent(since)}`, { cookie: user.cookie });
    check('unknown ticker -> 404', unknown.status === 404);
    const empty = await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(since)}`, { cookie: user.cookie });
    check('a user with no settled picks -> matched 0, points null',
        empty.status === 200 && empty.json?.matched === 0 && empty.json?.won === 0 && empty.json?.lost === 0 && empty.json?.points === null
        && typeof empty.json?.note === 'string' && empty.json?.key === 'dogs',
        JSON.stringify(empty.json));

    section('/api/tankdaq/overlay - classification by the index rule');
    // Three tanks, one pick each, all settled now:
    //   NBA moneyline [0.62, 0.38], pick side 1 (the dog), correct   -> $DOGS, $NBADOGS
    //   totals Over/Under [0.55, 0.45], pick side 0 (Over), correct  -> $OVERS, $CHALK
    //   NFL moneyline [0.70, 0.30], pick side 0 (the fav), incorrect -> $CHALK, $GRIDIRON
    const nbaTank = await insertTank({ slug: `${PREFIX}nba`, marketId: `${PREFIX}m1`, outcomes: ['Hawks', 'Magic'], outcomePrices: [0.62, 0.38], league: 'NBA', market: 'moneyline', visibility: 'newsletter_only' });
    const totTank = await insertTank({ slug: `${PREFIX}tot`, marketId: `${PREFIX}m2`, outcomes: ['Over', 'Under'], outcomePrices: [0.55, 0.45], league: 'MLB', market: 'totals', visibility: 'newsletter_only' });
    const nflTank = await insertTank({ slug: `${PREFIX}nfl`, marketId: `${PREFIX}m3`, outcomes: ['Eagles', 'Giants'], outcomePrices: [0.7, 0.3], league: 'NFL', market: 'moneyline', visibility: 'newsletter_only' });
    const p1 = await insertUserWithPick(EMAIL, nbaTank, `${PREFIX}nba`, 1, 0.38);
    const p2 = await insertUserWithPick(EMAIL, totTank, `${PREFIX}tot`, 0, 0.55);
    const p3 = await insertUserWithPick(EMAIL, nflTank, `${PREFIX}nfl`, 0, 0.7);
    check('the picks landed on the session user', p1.userId === user.userId && p2.userId === user.userId && p3.userId === user.userId);
    await settlePick(p1.pickId, 'correct');
    await settlePick(p2.pickId, 'correct');
    await settlePick(p3.pickId, 'incorrect');

    const cfg = await activeConfig('tickers');
    const scoring = { smoothing: Number(cfg.close_smoothing), scalePct: Number(cfg.close_scale_pct) };
    const hasCloseKeys = Number.isFinite(scoring.smoothing) && Number.isFinite(scoring.scalePct);
    const expectPoints = (contribs: number[]) => (hasCloseKeys ? closeDelta(contribs, scoring) : null);
    const read = async (key: string) => (await api('GET', `/api/tankdaq/overlay?key=${key}&since=${encodeURIComponent(since)}`, { cookie: user.cookie })).json;

    const dogs = await read('dogs');
    check('$DOGS matches only the 0.38 side: 1-0', dogs?.matched === 1 && dogs?.won === 1 && dogs?.lost === 0, JSON.stringify(dogs));
    check('$DOGS points = closeDelta([contributionFor(true, 0.38)]) with the live close config',
        (dogs?.points === null && !hasCloseKeys) || near(dogs?.points ?? NaN, expectPoints([contributionFor(true, 0.38)]) ?? NaN),
        `${dogs?.points} vs ${expectPoints([contributionFor(true, 0.38)])}`);
    const nbadogs = await read('nbadogs');
    check('$NBADOGS (league child) matches the same NBA dog: 1-0', nbadogs?.matched === 1 && nbadogs?.won === 1, JSON.stringify(nbadogs));
    const overs = await read('overs');
    check('$OVERS matches only the Over pick: 1-0', overs?.matched === 1 && overs?.won === 1 && overs?.lost === 0, JSON.stringify(overs));
    const unders = await read('unders');
    check('$UNDERS matches nothing', unders?.matched === 0, JSON.stringify(unders));
    const chalk = await read('chalk');
    check('$CHALK matches the Over (0.55) and the NFL favorite: 1-1', chalk?.matched === 2 && chalk?.won === 1 && chalk?.lost === 1, JSON.stringify(chalk));
    check('$CHALK points are the two matched contributions scored as one slate',
        (chalk?.points === null && !hasCloseKeys) || near(chalk?.points ?? NaN, expectPoints([contributionFor(true, 0.55), contributionFor(false, 0.7)]) ?? NaN),
        `${chalk?.points}`);
    const gridiron = await read('gridiron');
    check('$GRIDIRON matches only the NFL favorite: 0-1', gridiron?.matched === 1 && gridiron?.won === 0 && gridiron?.lost === 1, JSON.stringify(gridiron));
    const futureSince = new Date(Date.now() + 60_000).toISOString();
    const outside = (await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(futureSince)}`, { cookie: user.cookie })).json;
    check('a window that starts after the settle matches nothing', outside?.matched === 0, JSON.stringify(outside));
    const other = await createSessionUser(`${PREFIX}other@example.com`, { username: 'overlay_other' });
    const theirs = (await api('GET', `/api/tankdaq/overlay?key=dogs&since=${encodeURIComponent(since)}`, { cookie: other.cookie })).json;
    check('another user sees none of these picks', theirs?.matched === 0, JSON.stringify(theirs));

    // --- 3. Bundle -----------------------------------------------------------------
    section('Island bundle on disk');
    const bundlePath = path.join(process.cwd(), 'dist', 'assets', 'tankdaq-ticker.js');
    const bundle = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, 'utf8') : '';
    check('tankdaq-ticker.js renders "What moved it" and no "Recent Results" heading',
        bundle.length > 0 && bundle.includes('What moved it') && !bundle.includes('Recent Results') && bundle.includes('hc-tq-read'),
        bundle ? '' : 'bundle missing - run npm run build:static');

    await cleanup();
}

export const suite: Suite = {
    name: 'index-overlay',
    requiredEnv: ['SESSION_TOKEN_SECRET'],
    run,
};
