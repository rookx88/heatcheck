// Acceptance suite for the Exchange ticker layer (and the settlement paths it touches).
// This IS the ticker acceptance suite: run it after any change to
// functions/api/settle.ts, lib/pages-functions/gamma.ts, lib/pages-functions/tickers.ts,
// or the ticker endpoints. Lifted verbatim (behavior-preserving) from the original
// standalone scripts/acceptance-tickers.ts into the consolidated runner.
//
// Uses real Polymarket data on purpose: eligibility/tag tests hit a live high-volume
// Gamma market (so the CLOB price-history integration is exercised for real), and
// settlement tests hand-insert ticker_tags on a real RESOLVED market (the same path
// retrotagging uses) so /api/settle resolves a genuine closed market.
//
// Manual post-deploy smoke checklist (prod, after migrations + secret provisioning):
//   curl https://heatchecks.io/api/tickers                         -> 8 tickers, note, numeric values
//   curl "https://heatchecks.io/api/tickers/chart?key=dogs"        -> ordered events, cumulative sums
//   curl -X POST https://heatchecks.io/api/ticker-tags             -> 401 (no secret)
//   curl -X POST -H "X-Settle-Secret: ..." https://heatchecks.io/api/settle  (twice)
//        -> second run settles nothing new; pick results shape unchanged

import { pool, api, check, warn, near, section, type Suite } from '../harness';
import {
    insertTank, insertTagDirect, insertUserWithPick, findMarkets, findKalshiMarkets, tickerValue, settleEventDelta,
    flipConfig, restoreConfig, cleanupUsersByEmailPrefix, cleanupTanksBySlugPrefix,
} from '../fixtures';

const TICKER_SECRET = process.env.TICKER_SECRET || '';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const SLUG_PREFIX = 'acceptance-ticker-';

const tagPost = (body: unknown, secret = TICKER_SECRET) => api('POST', '/api/ticker-tags', { body, headers: { 'X-Ticker-Secret': secret } });
const settlePost = () => api('POST', '/api/settle', { headers: { 'X-Settle-Secret': SETTLE_SECRET } });

async function cleanup() {
    await cleanupUsersByEmailPrefix(SLUG_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

async function run() {
    await cleanup();

    const markets = await findMarkets();
    const W = markets.resolved.winningIndex;
    const L = 1 - W;
    console.log(`Live market: ${markets.live.id}; resolved market: ${markets.resolved.id} (winner index ${W})`);

    // --- Read shapes, pre-fixture baseline ---
    section('Read endpoints');
    const list = await api('GET', '/api/tickers');
    check('GET /api/tickers returns 200 with note', list.status === 200 && typeof list.json?.note === 'string');
    const keys = (list.json?.tickers ?? []).map((t: any) => t.key);
    const EXPECTED_KEYS = ['dogs', 'chalk', 'locks', 'moonshot', 'overs', 'unders', 'gridiron', 'footy',
        'nbachalk', 'mlbchalk', 'nbadogs', 'mlbdogs', 'nfldogs', 'socdogs'];
    check('all fourteen tickers present, ordered by tab_order (add_tickers_batch2/3.sql are deploy prerequisites)',
        JSON.stringify(keys.filter((k: string) => EXPECTED_KEYS.includes(k))) === JSON.stringify(EXPECTED_KEYS));
    // Each family partitions its parent by league, so a child must name a parent that
    // is itself top-level - a child of a child would double-count on the nested board.
    const EXPECTED_FAMILIES: Record<string, string> = {
        gridiron: 'chalk', footy: 'chalk', nbachalk: 'chalk', mlbchalk: 'chalk',
        nbadogs: 'dogs', mlbdogs: 'dogs', nfldogs: 'dogs', socdogs: 'dogs',
    };
    check('the eight league sub-indexes point at chalk/dogs, and no other ticker has a parent',
        (list.json?.tickers ?? []).every((t: any) => (t.parentKey ?? null) === (EXPECTED_FAMILIES[t.key] ?? null)));
    check('values are numeric (not NUMERIC strings)', (list.json?.tickers ?? []).every((t: any) => typeof t.value === 'number'));
    check('fallback pcts seeded: dogs/chalk symmetric 5/5, locks 5/15, moonshot 20/5, batch-2 all 5/5',
        ['dogs:5:5', 'chalk:5:5', 'locks:5:15', 'moonshot:20:5', 'overs:5:5', 'unders:5:5', 'gridiron:5:5', 'footy:5:5'].every((spec) => {
            const [k, w, l] = spec.split(':');
            const t = list.json?.tickers?.find((x: any) => x.key === k);
            return t && near(t.settleWinPct, Number(w)) && near(t.settleLossPct, Number(l));
        }));
    const unknownChart = await api('GET', '/api/tickers/chart?key=nope');
    check('chart with unknown key -> 404', unknownChart.status === 404);
    const detail = await api('GET', '/api/tickers/detail?key=dogs');
    check('detail returns 200 with note, meta, numeric value, arrays',
        detail.status === 200 && typeof detail.json?.note === 'string'
        && detail.json?.ticker?.key === 'dogs' && typeof detail.json?.ticker?.value === 'number'
        && typeof detail.json?.ticker?.indexLabel === 'string'
        && Array.isArray(detail.json?.series) && Array.isArray(detail.json?.news) && Array.isArray(detail.json?.results));
    check('detail results carry composed sentences when present',
        (detail.json?.results ?? []).every((r: any) => typeof r.text === 'string' && r.text.length > 0 && typeof r.won === 'boolean'));
    const unknownDetail = await api('GET', '/api/tickers/detail?key=nope');
    check('detail with unknown key -> 404', unknownDetail.status === 404);
    const noKeyDetail = await api('GET', '/api/tickers/detail');
    check('detail without key -> 400', noKeyDetail.status === 400);
    const badTank = await api('GET', '/api/tickers/tank');
    check('tank endpoint without slug/id -> 400', badTank.status === 400);

    // --- Tag endpoint: auth + validation + eligibility ---
    section('Tag endpoint - auth, validation, eligibility (frozen snapshot probs)');
    const tankA = `${SLUG_PREFIX}live-a`;
    await insertTank({ slug: tankA, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });
    const mockTank = `${SLUG_PREFIX}mock`;
    await insertTank({ slug: mockTank, provider: 'mock', marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });

    const noAuth = await api('POST', '/api/ticker-tags', { body: { slug: tankA, tickerKey: 'dogs', relevantSide: 1 } });
    check('no secret -> 401', noAuth.status === 401);
    const badSide = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: -1 });
    check('negative relevantSide -> 400', badSide.status === 400);
    const oob = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 5 });
    check('out-of-range relevantSide -> 422 side_out_of_range', oob.status === 422 && oob.json?.code === 'side_out_of_range');
    const unknownTicker = await tagPost({ slug: tankA, tickerKey: 'rockets', relevantSide: 0 });
    check('unknown ticker -> 404', unknownTicker.status === 404);
    const mock = await tagPost({ slug: mockTank, tickerKey: 'dogs', relevantSide: 1 });
    check('non-polymarket/kalshi tank -> 422 unsupported_provider', mock.status === 422 && mock.json?.code === 'unsupported_provider');

    for (const [ticker, side, prob] of [['dogs', 0, '0.62'], ['chalk', 1, '0.38'], ['locks', 0, '0.62'], ['moonshot', 1, '0.38']] as const) {
        const res = await tagPost({ slug: tankA, tickerKey: ticker, relevantSide: side });
        check(`${ticker} rejects side at ${prob} -> 422 ineligible`, res.status === 422 && res.json?.code === 'ineligible', JSON.stringify(res.json));
    }

    // --- Batch-2 eligibility: totals labels + league-scoped market favorites ---
    section('Batch-2 tickers - overs/unders (totals labels), gridiron/footy (league + argmax side)');
    // tankA is market 'acceptance_market', league NBA - wrong shape for every batch-2 rule.
    const notTotals = await tagPost({ slug: tankA, tickerKey: 'overs', relevantSide: 0 });
    check('overs rejects a non-totals market -> 422 ineligible', notTotals.status === 422 && notTotals.json?.code === 'ineligible', JSON.stringify(notTotals.json));
    const notNfl = await tagPost({ slug: tankA, tickerKey: 'gridiron', relevantSide: 0 });
    check('gridiron rejects a non-NFL tank -> 422 ineligible', notNfl.status === 422 && notNfl.json?.code === 'ineligible', JSON.stringify(notNfl.json));
    const notSoccer = await tagPost({ slug: tankA, tickerKey: 'footy', relevantSide: 0 });
    check('footy rejects a non-soccer tank -> 422 ineligible', notSoccer.status === 422 && notSoccer.json?.code === 'ineligible', JSON.stringify(notSoccer.json));

    const tankT = `${SLUG_PREFIX}totals`;
    await insertTank({ slug: tankT, marketId: markets.live.id, market: 'totals', outcomes: ['Over', 'Under'], outcomePrices: [0.55, 0.45] });
    const wrongOverSide = await tagPost({ slug: tankT, tickerKey: 'overs', relevantSide: 1 });
    check('overs rejects the Under side -> 422 ineligible', wrongOverSide.status === 422 && wrongOverSide.json?.code === 'ineligible');
    const wrongUnderSide = await tagPost({ slug: tankT, tickerKey: 'unders', relevantSide: 0 });
    check('unders rejects the Over side -> 422 ineligible', wrongUnderSide.status === 422 && wrongUnderSide.json?.code === 'ineligible');
    const oversOk = await tagPost({ slug: tankT, tickerKey: 'overs', relevantSide: 0 });
    check('overs tags the Over side -> 201 with real tag delta', oversOk.status === 201 && typeof oversOk.json?.delta === 'number', JSON.stringify(oversOk.json));
    const undersOk = await tagPost({ slug: tankT, tickerKey: 'unders', relevantSide: 1 });
    check('unders tags the Under side -> 201 (both totals sides land, dogs/chalk pattern)', undersOk.status === 201, JSON.stringify(undersOk.json));

    const tankN = `${SLUG_PREFIX}nfl`;
    await insertTank({ slug: tankN, league: 'NFL', marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.62, 0.38] });
    const notFav = await tagPost({ slug: tankN, tickerKey: 'gridiron', relevantSide: 1 });
    check('gridiron rejects the non-favored side -> 422 ineligible', notFav.status === 422 && notFav.json?.code === 'ineligible');
    const gridironOk = await tagPost({ slug: tankN, tickerKey: 'gridiron', relevantSide: 0 });
    check('gridiron tags the NFL market favorite -> 201', gridironOk.status === 201, JSON.stringify(gridironOk.json));

    // 3-way snapshot (soccer moneyline shape): argmax side 1 at 0.45 is the market
    // favorite even though no side reaches 0.5 - the rule dogs/chalk can't express.
    const tankFooty = `${SLUG_PREFIX}footy`;
    await insertTank({ slug: tankFooty, league: 'EPL', marketId: markets.live.id, outcomes: ['Home', 'Away', 'Draw'], outcomePrices: [0.30, 0.45, 0.25] });
    const footyNotFav = await tagPost({ slug: tankFooty, tickerKey: 'footy', relevantSide: 0 });
    check('footy rejects a non-argmax side of a 3-way market -> 422 ineligible', footyNotFav.status === 422 && footyNotFav.json?.code === 'ineligible');
    const footyOk = await tagPost({ slug: tankFooty, tickerKey: 'footy', relevantSide: 1 });
    check('footy tags the sub-0.5 argmax favorite of a 3-way market -> 201', footyOk.status === 201, JSON.stringify(footyOk.json));

    // --- Successful tag: real CLOB 3-day delta, immediate value movement ---
    section('Tag event - real CLOB delta, cap, immediate value movement');
    const dogsBefore = await tickerValue('dogs');
    const tagOk = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 1 });
    check('eligible dogs tag -> 201', tagOk.status === 201, JSON.stringify(tagOk.json));
    const delta = tagOk.json?.delta;
    check('delta is numeric, within default +/-10 cap', typeof delta === 'number' && Math.abs(delta) <= 10 + 0.0005);
    check('response carries retrospective note', typeof tagOk.json?.note === 'string' && tagOk.json.note.includes('not a forecast'));
    const dogsAfter = await tickerValue('dogs');
    check('ticker value moved by exactly the tag delta, pre-settlement', near(dogsAfter - dogsBefore, delta));
    const dup = await tagPost({ slug: tankA, tickerKey: 'dogs', relevantSide: 1 });
    check('duplicate (tank,ticker) -> 409', dup.status === 409);
    const { rows: evCount } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ticker_events e JOIN tank_pages t ON t.id = e.tank_id WHERE t.slug = $1`, [tankA]);
    check('duplicate did not append an event', evCount[0].n === 1);

    // --- Kalshi: same tag-creation path, real trade-history delta instead of CLOB ---
    section('Kalshi provider - tag creation success path (parallel to the polymarket path above)');
    const kalshiMarkets = await findKalshiMarkets();
    console.log(`Kalshi live market: ${kalshiMarkets.live.id}; resolved market: ${kalshiMarkets.resolved.id}`);
    const tankK = `${SLUG_PREFIX}kalshi-live`;
    await insertTank({
        slug: tankK, provider: 'kalshi', marketId: kalshiMarkets.live.id,
        outcomes: kalshiMarkets.live.outcomes, outcomePrices: [0.5, 0.5],
    });
    const kalshiTagOk = await tagPost({ slug: tankK, tickerKey: 'dogs', relevantSide: 1 });
    check('eligible kalshi dogs tag -> 201', kalshiTagOk.status === 201, JSON.stringify(kalshiTagOk.json));
    const kalshiDelta = kalshiTagOk.json?.delta;
    check('kalshi delta is numeric, non-fabricated (historyPoints > 0 implied by success)', typeof kalshiDelta === 'number');
    const kalshiDup = await tagPost({ slug: tankK, tickerKey: 'dogs', relevantSide: 1 });
    check('duplicate kalshi (tank,ticker) -> 409', kalshiDup.status === 409);

    // --- Kalshi settlement: hand-inserted tag on a real resolved Kalshi market ---
    section('Kalshi provider - settlement (proves the settle.ts provider dispatch)');
    const kW = kalshiMarkets.resolved.winningIndex;
    // The tagged (winning) side frozen at 0.40 - odds-aware settle pays +(1-0.4)*10 = +6.
    const tankKRes = await insertTank({
        slug: `${SLUG_PREFIX}kalshi-res`, provider: 'kalshi', marketId: kalshiMarkets.resolved.id,
        outcomes: kalshiMarkets.resolved.outcomes, outcomePrices: kW === 0 ? [0.4, 0.6] : [0.6, 0.4],
    });
    const kDogsWin = await insertTagDirect(tankKRes, 'dogs', kW, 1.5);
    const kalshiSettle = await settlePost();
    const kTrFor = (tagId: string) => kalshiSettle.json?.tickerResults?.find((r: any) => r.tagId === tagId);
    check('kalshi zero-pick dogs(win at p=0.40) settled odds-aware +6', kTrFor(kDogsWin)?.status === 'settled_win' && near(await settleEventDelta(kDogsWin) ?? NaN, 6), JSON.stringify(kTrFor(kDogsWin)));

    // --- Config-driven behavior (no code change) ---
    section('Config tunables - version-flip changes behavior with no code change');
    const tankB = `${SLUG_PREFIX}live-b`;
    await insertTank({ slug: tankB, marketId: markets.live.id, outcomes: markets.live.outcomes, outcomePrices: [0.85, 0.15] });
    try {
        await flipConfig('tickers', { locks_min_prob: 0.9 });
        const strict = await tagPost({ slug: tankB, tickerKey: 'locks', relevantSide: 0 });
        check('locks at 0.85 rejected under flipped locks_min_prob=0.90', strict.status === 422 && strict.json?.code === 'ineligible');
        await restoreConfig('tickers');
        const lenient = await tagPost({ slug: tankB, tickerKey: 'locks', relevantSide: 0 });
        check('locks at 0.85 accepted under restored locks_min_prob=0.80', lenient.status === 201, JSON.stringify(lenient.json));

        await flipConfig('tickers', { tag_delta_cap_pct: 0.01 });
        const capped = await tagPost({ slug: tankB, tickerKey: 'moonshot', relevantSide: 1 });
        check('tag under cap=0.01 -> |delta| <= 0.01', capped.status === 201 && Math.abs(capped.json?.delta) <= 0.01 + 0.0005, JSON.stringify(capped.json));
        if (capped.status === 201 && capped.json?.capped !== true) {
            warn('live market moved < 0.01pp over 3 days - clamp path not strictly proven this run (capped=false)');
        } else {
            check('capped flag set when raw delta exceeds cap', capped.json?.capped === true);
        }
    } finally {
        await restoreConfig('tickers');
    }

    // --- Settlement fixtures: hand-inserted tags on a real resolved market ---
    section('Settlement - zero-pick tags, odds-aware payouts, fallback, hardening');
    const ro = markets.resolved.outcomes;
    const roRev = [...ro].reverse();
    const rid = markets.resolved.id;
    const pricesWinHeavy = W === 0 ? [0.85, 0.15] : [0.15, 0.85];
    const pricesLoseHeavy = W === 0 ? [0.15, 0.85] : [0.85, 0.15];
    const pricesDogWin = W === 0 ? [0.6, 0.4] : [0.4, 0.6];

    const tankC = await insertTank({ slug: `${SLUG_PREFIX}res-c`, marketId: rid, outcomes: ro, outcomePrices: pricesWinHeavy });
    const cLocksWin = await insertTagDirect(tankC, 'locks', W, 1.5);
    const cMoonLoss = await insertTagDirect(tankC, 'moonshot', L, 1.5);
    const tankD = await insertTank({ slug: `${SLUG_PREFIX}res-d`, marketId: rid, outcomes: ro, outcomePrices: pricesLoseHeavy });
    const dLocksLoss = await insertTagDirect(tankD, 'locks', L, 1.5);
    const dMoonWin = await insertTagDirect(tankD, 'moonshot', W, 1.5);
    const tankE = await insertTank({ slug: `${SLUG_PREFIX}res-e`, marketId: rid, outcomes: ro, outcomePrices: pricesDogWin });
    const eDogs = await insertTagDirect(tankE, 'dogs', L, 1.5);
    const eChalk = await insertTagDirect(tankE, 'chalk', W, 1.5);
    const tankF = await insertTank({ slug: `${SLUG_PREFIX}res-f`, visibility: 'newsletter_only', marketId: rid, outcomes: ro, outcomePrices: pricesDogWin });
    const fDogs = await insertTagDirect(tankF, 'dogs', W, 3.3);
    // No outcomePrices in the snapshot at all -> settle falls back to the flat per-ticker pcts.
    const tankFB = await insertTank({ slug: `${SLUG_PREFIX}res-fb`, marketId: rid, outcomes: ro });
    const fbDogs = await insertTagDirect(tankFB, 'dogs', W, 1.5);
    const tankG = await insertTank({ slug: `${SLUG_PREFIX}res-g`, marketId: rid, outcomes: roRev, outcomePrices: pricesDogWin });
    const gDogs = await insertTagDirect(tankG, 'dogs', W, 1.5);
    const gPick = await insertUserWithPick(`${SLUG_PREFIX}g@example.com`, tankG, `${SLUG_PREFIX}res-g`, W, 0.5);
    const tankH = await insertTank({ slug: `${SLUG_PREFIX}res-h`, marketId: rid, outcomes: ro, outcomePrices: [0.5, 0.5] });
    const hPick = await insertUserWithPick(`${SLUG_PREFIX}h@example.com`, tankH, `${SLUG_PREFIX}res-h`, W, 0.5);

    const settle1 = await settlePost();
    check('POST /api/settle -> 200 with tickerResults', settle1.status === 200 && Array.isArray(settle1.json?.tickerResults));
    const trFor = (tagId: string) => settle1.json?.tickerResults?.find((r: any) => r.tagId === tagId);
    const prFor = (pickId: string) => settle1.json?.results?.find((r: any) => r.pickId === pickId);

    // Odds-aware payouts: +(1-p)*10 on a win, -p*10 on a loss, p = frozen snapshot prob
    // of the tagged side. The expected-vs-surprising character the old per-ticker
    // asymmetry hand-tuned now comes from p itself.
    check('locks(win at p=0.85) barely moves: +1.5', trFor(cLocksWin)?.status === 'settled_win' && near(await settleEventDelta(cLocksWin) ?? NaN, 1.5));
    check('moonshot(loss at p=0.15) barely moves: -1.5', trFor(cMoonLoss)?.status === 'settled_loss' && near(await settleEventDelta(cMoonLoss) ?? NaN, -1.5));
    check('locks(loss at p=0.85) is the surprise: -8.5', trFor(dLocksLoss)?.status === 'settled_loss' && near(await settleEventDelta(dLocksLoss) ?? NaN, -8.5));
    check('moonshot(win at p=0.15) is the surprise: +8.5', trFor(dMoonWin)?.status === 'settled_win' && near(await settleEventDelta(dMoonWin) ?? NaN, 8.5));
    const eDogsDelta = await settleEventDelta(eDogs);
    const eChalkDelta = await settleEventDelta(eChalk);
    check('dogs/chalk inverse on the same real outcome (dogs loss -4, chalk win +4)',
        eDogsDelta !== null && eChalkDelta !== null && ((eDogsDelta > 0) !== (eChalkDelta > 0)) && near(Math.abs(eDogsDelta), 4) && near(Math.abs(eChalkDelta), 4));
    check('newsletter_only tag still settles', (await settleEventDelta(fDogs)) !== null);
    check('no snapshot prob -> flat fallback: dogs(win) +5', trFor(fbDogs)?.status === 'settled_win' && near(await settleEventDelta(fbDogs) ?? NaN, 5), JSON.stringify(trFor(fbDogs)));
    const { rows: fbMeta } = await pool.query(
        `SELECT metadata FROM ticker_events WHERE ticker_tag_id = $1 AND event_type = 'settle'`, [fbDogs]);
    check('fallback settle flagged oddsAware=false in metadata', fbMeta[0]?.metadata?.oddsAware === false);
    const { rows: calcRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM ticker_tags WHERE id = ANY($1) AND calculated_at IS NOT NULL`,
        [[cLocksWin, cMoonLoss, dLocksLoss, dMoonWin, eDogs, eChalk, fDogs, fbDogs]]);
    check('calculated_at stamped on all settled tags', calcRows[0].n === 8);

    check('reversed-outcome tag skipped: outcome_order_mismatch', trFor(gDogs)?.status === 'outcome_order_mismatch' && (await settleEventDelta(gDogs)) === null);
    check('reversed-outcome pick skipped: outcome_order_mismatch', prFor(gPick.pickId)?.status === 'outcome_order_mismatch');
    const hResult = prFor(hPick.pickId);
    check('pick path regression: correct pick settles with formula payout (20 * min(1/0.5, 2.5) = 40)',
        hResult?.status === 'settled_correct' && hResult?.payoutAmount === 40, JSON.stringify(hResult));

    // --- Idempotency ---
    section('Idempotency - re-running settlement is a no-op');
    const { rows: pre } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(delta), 0)::float8 AS s FROM ticker_events`);
    const settle2 = await settlePost();
    const ourTagIds = new Set([cLocksWin, cMoonLoss, dLocksLoss, dMoonWin, eDogs, eChalk, fDogs, fbDogs]);
    const resettled = (settle2.json?.tickerResults ?? []).filter((r: any) => ourTagIds.has(r.tagId));
    check('settled tags absent from the second run\'s pending scan', resettled.length === 0, JSON.stringify(resettled));
    const { rows: post } = await pool.query(`SELECT COUNT(*)::int AS n, COALESCE(SUM(delta), 0)::float8 AS s FROM ticker_events`);
    check('no new events, SUM(delta) unchanged', pre[0].n === post[0].n && near(pre[0].s, post[0].s));

    // --- Read-side visibility + chart consistency ---
    section('Read side - newsletter exclusion, chart = cumulative event log');
    const { rows: sqlDogs } = await pool.query(
        `SELECT COALESCE(SUM(e.delta) FILTER (WHERE t.visibility = 'app'), 0)::float8 AS app_only,
                COALESCE(SUM(e.delta), 0)::float8 AS all_events
         FROM ticker_events e JOIN tank_pages t ON t.id = e.tank_id WHERE e.ticker_key = 'dogs'`);
    const apiDogs = await tickerValue('dogs');
    check('API dogs value == app-visible SUM(delta) from the log', near(apiDogs, sqlDogs[0].app_only));
    check('newsletter_only events exist but are excluded (sums differ)', !near(sqlDogs[0].app_only, sqlDogs[0].all_events));
    const chart = await api('GET', '/api/tickers/chart?key=dogs');
    const dogsSeries: any[] = chart.json?.series?.dogs ?? [];
    const { rows: fEventRows } = await pool.query(`SELECT id FROM ticker_events WHERE ticker_tag_id = $1`, [fDogs]);
    const fEventIds = new Set(fEventRows.map((r) => r.id));
    check('newsletter tank\'s events absent from the chart', dogsSeries.every((e) => !fEventIds.has(e.id)));
    let cumOk = dogsSeries.length > 0;
    let running = 0;
    for (const e of dogsSeries) {
        running += e.delta;
        if (!near(running, e.cumulative)) cumOk = false;
    }
    check('chart cumulative = running sum of deltas, in order', cumOk);
    const lastCum = dogsSeries.length ? dogsSeries[dogsSeries.length - 1].cumulative : NaN;
    check('chart final cumulative == ticker current value (same log, same filter)', near(lastCum, apiDogs));
    const tankView = await api('GET', `/api/tickers/tank?slug=${SLUG_PREFIX}res-c`);
    check('tank endpoint lists its tags with event ids for highlighting',
        tankView.status === 200
        && (tankView.json?.tags ?? []).length === 2
        && (tankView.json?.tags ?? []).every((t: any) => Array.isArray(t.eventIds) && t.eventIds.length === 2));

    await cleanup();
}

export const suite: Suite = {
    name: 'tickers',
    requiredEnv: ['TICKER_SECRET', 'SETTLE_SECRET'],
    run,
};
