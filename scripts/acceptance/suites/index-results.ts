// Acceptance suite for the slate-sourced Recent Results path and the draw-market lock
// guard (2026-09-11). Run after any change to lib/pages-functions/index-slate.ts,
// getTickerResults (lib/pages-functions/tickers.ts), buildResultSentence
// (lib/pages-functions/market-movers.ts), or functions/api/index-settle.ts.
//
// Three tiers:
//   1. Pure - sentence forms and the draw exclusion, on hand-built rows shaped like the
//      live index_positions data sampled 2026-09-11 (MLS Yes/No moneylines, MLB team
//      moneylines, totals with a line).
//   2. DB - fixture positions + a far-past fixture close, read back through the REAL
//      getTickerResults over a pg adapter (proves the statement is plain SQL, the same
//      way generate-static-site.ts runs it at build time).
//   3. HTTP - /api/tickers/detail and the SSR homepage tape render those fixtures.
// Writes to index_positions and ticker_events (source='slate'); cleanupIndexFixtures
// is registered as a teardown so an aborted run still removes them.

import { BASE_URL, check, near, section, warn, registerTeardown, type Suite } from '../harness';
import {
    cleanupIndexFixtures, insertIndexPositionDirect, insertSlateCloseDirect, sqlViaPool, INDEX_FIXTURE_PREFIX,
} from '../fixtures';
import { getTickerResults, type TickerResultItem } from '../../../lib/pages-functions/tickers';
import { buildResultSentence, toResultSentences } from '../../../lib/pages-functions/market-movers';
import {
    isDrawMarket,
    parseYesNoQuestion,
    pickCanonicalMarket,
    positionShareOfClose,
    positionsForGame,
    type SlateMarketRow,
} from '../../../lib/pages-functions/index-slate';

// Far in the past on purpose: the partial UNIQUE (ticker_key, close_date) WHERE
// source='slate' would otherwise collide with today's real close.
const FIXTURE_CLOSE_DATE = '1999-01-01';
const AWAY = 'Acceptance FC';
const HOME = 'Fixture United';
const MONEY_FLOW = /Buyers|applaud|up in arms|climbs|sinks|local (high|low)/i;

function item(over: Partial<TickerResultItem>): TickerResultItem {
    return {
        tickerKey: 'chalk', won: true, delta: 0.5, occurredAt: '2026-09-11T02:01:02.000Z',
        marketType: 'moneyline', marketLine: null, sideLabel: 'Philadelphia Phillies', sideIndex: 1,
        away: 'Houston Astros', home: 'Philadelphia Phillies', league: 'MLB', question: null,
        ...over,
    };
}

function slateRow(over: Partial<SlateMarketRow>): SlateMarketRow {
    return {
        event_id: 'evt-1', league: 'EPL', market_id: 'm', condition_id: null, market_type: 'moneyline',
        market_line: null, outcomes: ['Yes', 'No'], outcome_prices: [0.4, 0.6], volume: 5000, liquidity: 800,
        kickoff: '2026-09-12T15:00:00.000Z', away: 'Chelsea FC', home: 'Hull City AFC', question: null,
        ...over,
    };
}

async function run() {
    // --- 1. Pure: one descriptive form per case -----------------------------------
    section('Result sentences - one descriptive form per case, no money-flow language');
    const cases: Array<{ name: string; item: TickerResultItem; ticker: string; expect: string }> = [
        {
            name: 'team moneyline, home side won',
            item: item({ sideLabel: 'Philadelphia Phillies', won: true, delta: 0.365 }),
            ticker: '$CHALK',
            expect: 'Philadelphia Phillies won against Houston Astros; $CHALK rose 0.4 points.',
        },
        {
            name: 'team moneyline, away side lost',
            item: item({ sideLabel: 'Houston Astros', sideIndex: 0, won: false, delta: -0.365 }),
            ticker: '$DOGS',
            expect: 'Houston Astros lost at Philadelphia Phillies; $DOGS fell 0.4 points.',
        },
        {
            name: 'Yes/No moneyline, No held and lost (the verbatim example)',
            item: item({
                sideLabel: 'No', sideIndex: 1, won: false, delta: -0.5, league: 'MLS',
                away: 'San Jose Earthquakes', home: 'San Diego FC',
                question: 'Will San Jose Earthquakes win on 2026-09-09?',
            }),
            ticker: '$CHALK',
            expect: 'San Jose Earthquakes won at San Diego FC; $CHALK, which held the other side, fell 0.5 points.',
        },
        {
            name: 'Yes/No moneyline, No held and won',
            item: item({
                sideLabel: 'No', sideIndex: 1, won: true, delta: 0.345, league: 'MLS',
                away: 'St. Louis City SC', home: 'Portland Timbers',
                question: 'Will St. Louis City SC win on 2026-09-09?',
            }),
            ticker: '$CHALK',
            expect: 'St. Louis City SC did not win at Portland Timbers; $CHALK, which held the other side, rose 0.3 points.',
        },
        {
            name: 'Yes/No moneyline, Yes held and won',
            item: item({
                sideLabel: 'Yes', sideIndex: 0, won: true, delta: 0.76, league: 'MLS',
                away: 'San Jose Earthquakes', home: 'San Diego FC',
                question: 'Will San Jose Earthquakes win on 2026-09-09?',
            }),
            ticker: '$DOGS',
            expect: 'San Jose Earthquakes won at San Diego FC; $DOGS rose 0.8 points.',
        },
        {
            name: 'Yes/No moneyline, Yes held and lost',
            item: item({
                sideLabel: 'Yes', sideIndex: 0, won: false, delta: -0.345, league: 'MLS',
                away: 'St. Louis City SC', home: 'Portland Timbers',
                question: 'Will St. Louis City SC win on 2026-09-09?',
            }),
            ticker: '$DOGS',
            expect: 'St. Louis City SC did not win at Portland Timbers; $DOGS fell 0.3 points.',
        },
        {
            name: 'totals, Over held, line cleared',
            item: item({ marketType: 'totals', marketLine: 3.5, sideLabel: 'Over', sideIndex: 0, won: true, delta: 0.57, away: 'St. Louis City SC', home: 'Portland Timbers' }),
            ticker: '$OVERS',
            expect: 'Over 3.5 hit in St. Louis City SC vs. Portland Timbers; $OVERS rose 0.6 points.',
        },
        {
            name: 'totals, Under held, line cleared (Under lost)',
            item: item({ marketType: 'totals', marketLine: 3.5, sideLabel: 'Under', sideIndex: 1, won: false, delta: -0.57, away: 'St. Louis City SC', home: 'Portland Timbers' }),
            ticker: '$UNDERS',
            expect: 'Over 3.5 hit in St. Louis City SC vs. Portland Timbers; $UNDERS fell 0.6 points.',
        },
        {
            name: 'totals, Under held, stayed under',
            item: item({ marketType: 'totals', marketLine: 8.5, sideLabel: 'Under', sideIndex: 1, won: true, delta: 0.25 }),
            ticker: '$UNDERS',
            expect: 'Houston Astros vs. Philadelphia Phillies stayed under 8.5; $UNDERS rose 0.3 points.',
        },
        {
            name: 'totals, Over held, stayed under, no line recorded',
            item: item({ marketType: 'totals', marketLine: null, sideLabel: 'Over', sideIndex: 0, won: false, delta: -0.25 }),
            ticker: '$OVERS',
            expect: 'Houston Astros vs. Philadelphia Phillies stayed under the total; $OVERS fell 0.3 points.',
        },
        {
            name: 'legacy draw market, Yes held, draw happened',
            item: item({ sideLabel: 'Yes', sideIndex: 0, won: true, delta: 0.7, league: 'MLS', away: 'CF Montréal', home: 'Philadelphia Union', question: 'Will Philadelphia Union vs. CF Montréal end in a draw?' }),
            ticker: '$DOGS',
            expect: 'CF Montréal vs. Philadelphia Union ended in a draw; $DOGS rose 0.7 points.',
        },
        {
            name: 'legacy draw market, No held, draw happened',
            item: item({ sideLabel: 'No', sideIndex: 1, won: false, delta: -0.7, league: 'MLS', away: 'CF Montréal', home: 'Philadelphia Union', question: 'Will Philadelphia Union vs. CF Montréal end in a draw?' }),
            ticker: '$CHALK',
            expect: 'CF Montréal vs. Philadelphia Union ended in a draw; $CHALK, which held the other side, fell 0.7 points.',
        },
        {
            name: 'Yes/No with no readable question falls back to the literal side',
            item: item({ sideLabel: 'Yes', sideIndex: 0, won: true, delta: 0.2, question: null }),
            ticker: '$DOGS',
            expect: 'Houston Astros vs. Philadelphia Phillies: the Yes side came in; $DOGS rose 0.2 points.',
        },
        {
            name: 'a share that rounds to 0.0 shows two decimals rather than a zero move',
            item: item({ sideLabel: 'Philadelphia Phillies', won: true, delta: 0.035 }),
            ticker: '$LOCKS',
            expect: 'Philadelphia Phillies won against Houston Astros; $LOCKS rose 0.04 points.',
        },
    ];
    for (const c of cases) {
        const got = buildResultSentence(c.item, c.ticker, 0);
        check(c.name, got === c.expect, `got: ${got}`);
        check(`${c.name} - no money-flow language`, !MONEY_FLOW.test(got), got);
    }
    check('templateIndex no longer rotates phrasing (same input reads the same way)',
        buildResultSentence(cases[0].item, '$CHALK', 1) === cases[0].expect
        && buildResultSentence(cases[0].item, '$CHALK', 2) === cases[0].expect);
    const vms = toResultSentences([cases[0].item, cases[1].item], '$X');
    check('toResultSentences keeps the {text, won} contract with won from the item, not the sign',
        vms.length === 2 && vms[0].won === true && vms[1].won === false && vms.every((v) => v.text.length > 0));

    // --- 2. Pure: draw exclusion + share formula -----------------------------------
    section('Slate lock - draw markets never represent a game; share-of-close formula');
    check('parseYesNoQuestion reads the team out of "Will <TEAM> win on <date>?"',
        JSON.stringify(parseYesNoQuestion('Will Chelsea FC win on 2026-09-12?')) === JSON.stringify({ kind: 'team', team: 'Chelsea FC' }));
    check('parseYesNoQuestion flags "end in a draw?"', parseYesNoQuestion('Will Chelsea FC vs. Hull City AFC end in a draw?')?.kind === 'draw');
    check('parseYesNoQuestion is null for anything else', parseYesNoQuestion('Chelsea vs Hull: total corners') === null && parseYesNoQuestion(null) === null);

    const teamWin = slateRow({ market_id: 'win', question: 'Will Chelsea FC win on 2026-09-12?', volume: 5000 });
    // Deliberately the volume leader, so the old ranking alone would have picked it.
    const draw = slateRow({ market_id: 'draw', question: 'Will Chelsea FC vs. Hull City AFC end in a draw?', outcome_prices: [0.25, 0.75], volume: 9000 });
    const total = slateRow({ market_id: 'tot', market_type: 'totals', market_line: 2.5, outcomes: ['Over', 'Under'], outcome_prices: [0.55, 0.45], volume: 3000 });
    check('isDrawMarket', isDrawMarket(draw) && !isDrawMarket(teamWin) && !isDrawMarket(total));
    const pick = pickCanonicalMarket([teamWin, draw, total], 'moneyline');
    check('pickCanonicalMarket(moneyline) skips the higher-volume draw market', pick?.row.market_id === 'win', pick?.row.market_id ?? '(none)');
    check('a game whose only moneyline is a draw market gets no moneyline pick', pickCanonicalMarket([draw, total], 'moneyline') === null);
    const specs = positionsForGame([teamWin, draw, total],
        [{ key: 'dogs', rule_type: 'underdog' }, { key: 'chalk', rule_type: 'favorite' }, { key: 'overs', rule_type: 'total_over' }],
        { locksMinProb: 0.8, moonshotMaxProb: 0.2 });
    check('positionsForGame never references the draw market', specs.length === 3 && specs.every((s) => s.row.market_id !== 'draw'),
        JSON.stringify(specs.map((s) => [s.tickerKey, s.row.market_id])));
    check('positionShareOfClose(0.6, N=6, k=4, scale=10) = 0.6', near(positionShareOfClose(0.6, { positionsCounted: 6, smoothing: 4, scalePct: 10 }) ?? NaN, 0.6));
    check('positionShareOfClose is null on a degenerate denominator', positionShareOfClose(0.6, { positionsCounted: 0, smoothing: 0, scalePct: 10 }) === null);

    // --- 3. DB fixtures -------------------------------------------------------------
    section('Fixtures - settled positions rolled into a far-past close');
    await cleanupIndexFixtures();
    registerTeardown(cleanupIndexFixtures);
    const closeMeta = { positionsCounted: 6, positionsWon: 3, scalePct: 10, smoothing: 4 };
    const oversClose = await insertSlateCloseDirect('overs', FIXTURE_CLOSE_DATE, 0.1, closeMeta);
    const chalkClose = await insertSlateCloseDirect('chalk', FIXTURE_CLOSE_DATE, 0.1, closeMeta);
    const nowMs = Date.now();
    const oversWin = await insertIndexPositionDirect({
        tickerKey: 'overs', eventId: `${INDEX_FIXTURE_PREFIX}g1`, marketId: `${INDEX_FIXTURE_PREFIX}m1`,
        away: AWAY, home: HOME, marketType: 'totals', marketLine: 3.5, sideIndex: 0, sideLabel: 'Over',
        entryProb: 0.4, result: 'win', closeId: oversClose, settledAt: new Date(nowMs).toISOString(),
    });
    const oversLoss = await insertIndexPositionDirect({
        tickerKey: 'overs', eventId: `${INDEX_FIXTURE_PREFIX}g2`, marketId: `${INDEX_FIXTURE_PREFIX}m2`,
        away: AWAY, home: HOME, marketType: 'totals', marketLine: 8.5, sideIndex: 0, sideLabel: 'Over',
        entryProb: 0.5, result: 'loss', closeId: oversClose, settledAt: new Date(nowMs - 60_000).toISOString(),
    });
    const chalkWin = await insertIndexPositionDirect({
        tickerKey: 'chalk', eventId: `${INDEX_FIXTURE_PREFIX}g1`, marketId: `${INDEX_FIXTURE_PREFIX}m3`,
        away: AWAY, home: HOME, marketType: 'moneyline', sideIndex: 1, sideLabel: HOME,
        entryProb: 0.7, result: 'win', closeId: chalkClose, settledAt: new Date(nowMs).toISOString(),
    });
    const expectShare = (contrib: number) => positionShareOfClose(contrib, closeMeta) ?? NaN;
    const OVERS_WIN_SENTENCE = `Over 3.5 hit in ${AWAY} vs. ${HOME}; $OVERS rose 0.6 points.`;
    const OVERS_LOSS_SENTENCE = `${AWAY} vs. ${HOME} stayed under 8.5; $OVERS fell 0.5 points.`;
    const CHALK_WIN_SENTENCE = `${HOME} won against ${AWAY}; $CHALK rose 0.3 points.`;

    // --- 4. The real reader through pg --------------------------------------------
    section('getTickerResults - reads index_positions through the pg adapter');
    const byKey = await getTickerResults(sqlViaPool, 6);
    const overs = byKey.overs ?? [];
    const chalk = byKey.chalk ?? [];
    check('overs[0] is the newest fixture (win)', overs[0]?.won === true && overs[0]?.marketLine === 3.5 && overs[0]?.away === AWAY, JSON.stringify(overs[0]));
    check('overs[1] is the older fixture (loss), i.e. newest first', overs[1]?.won === false && overs[1]?.marketLine === 8.5, JSON.stringify(overs[1]));
    check('delta is the game\'s share of its close: contrib * scalePct / (N + smoothing)',
        near(overs[0]?.delta ?? NaN, expectShare(oversWin.contrib)) && near(overs[1]?.delta ?? NaN, expectShare(oversLoss.contrib))
        && near(chalk[0]?.delta ?? NaN, expectShare(chalkWin.contrib)),
        `overs ${overs[0]?.delta}/${overs[1]?.delta} chalk ${chalk[0]?.delta}`);
    check('question is null when no polymarket_props row exists (LEFT JOIN tolerance)', overs[0]?.question === null);
    check('at most limitPerTicker rows per index', Object.values(byKey).every((list) => list.length <= 6));
    check('every row is a win or loss with a settled timestamp', Object.values(byKey).flat().every((r) => typeof r.won === 'boolean' && !isNaN(new Date(r.occurredAt).getTime())));

    // --- 5. The API -----------------------------------------------------------------
    section('/api/tickers/detail - fixture sentences composed server-side');
    const oversDetail = await fetch(`${BASE_URL}/api/tickers/detail?key=overs`).then((r) => r.json()) as any;
    const oversResults: Array<{ text: string; won: boolean }> = oversDetail?.results ?? [];
    check('detail overs results[0] is the fixture win sentence', oversResults[0]?.text === OVERS_WIN_SENTENCE && oversResults[0]?.won === true, oversResults[0]?.text ?? '(none)');
    check('detail overs results[1] is the fixture loss sentence', oversResults[1]?.text === OVERS_LOSS_SENTENCE && oversResults[1]?.won === false, oversResults[1]?.text ?? '(none)');
    check('detail overs has at most 6 results', oversResults.length <= 6);
    check('no detail result carries money-flow language', oversResults.every((r) => !MONEY_FLOW.test(r.text)));
    const chalkDetail = await fetch(`${BASE_URL}/api/tickers/detail?key=chalk`).then((r) => r.json()) as any;
    const chalkResults: Array<{ text: string; won: boolean }> = chalkDetail?.results ?? [];
    check('detail chalk results[0] is the fixture team-win sentence', chalkResults[0]?.text === CHALK_WIN_SENTENCE && chalkResults[0]?.won === true, chalkResults[0]?.text ?? '(none)');

    // --- 6. The SSR homepage tape ---------------------------------------------------
    section('Homepage - the tape headline is the index\'s newest settled game');
    // A cookie (any value) bypasses the anonymous whole-page cache, but the content
    // memo is per isolate for 30s, so poll until the render is fresh or shows the row.
    let tapeBody = '';
    let tapeFresh = '';
    for (let attempt = 0; attempt < 9; attempt++) {
        const res = await fetch(`${BASE_URL}/`, { headers: { Cookie: 'hc_session=not-a-real-token' } });
        tapeBody = await res.text();
        tapeFresh = res.headers.get('x-homepage-content') ?? '';
        if (tapeBody.includes(OVERS_WIN_SENTENCE) || tapeFresh === 'fresh') break;
        await new Promise((r) => setTimeout(r, 5000));
    }
    const tapeIdx = tapeBody.indexOf('hc-tape-headline');
    check('homepage renders a tape headline', tapeIdx >= 0, `content=${tapeFresh}`);
    check('the $OVERS tape headline is the fixture sentence', tapeBody.includes(`hc-tape-headline">${OVERS_WIN_SENTENCE}</span>`), `content=${tapeFresh}`);
    check('the homepage carries no money-flow result language', !/hc-tape-headline">[^<]*(Buyers|applaud|up in arms)/.test(tapeBody));
    if (tapeBody.includes('data-ticker="overs"')) {
        check('the $OVERS Market Movers card lists the fixture sentence', tapeBody.includes(`</span> ${OVERS_WIN_SENTENCE}</li>`));
    } else {
        warn('$OVERS is not the headline gainer/loser card right now - card-level Recent Results not asserted (tape covers the same VM)');
    }

    await cleanupIndexFixtures();
    check('cleanup removed the fixture positions and closes',
        (await sqlViaPool`SELECT COUNT(*)::int AS n FROM index_positions WHERE event_id LIKE ${`${INDEX_FIXTURE_PREFIX}%`}`)[0].n === 0
        && (await sqlViaPool`SELECT COUNT(*)::int AS n FROM ticker_events WHERE source = 'slate' AND metadata @> '{"acceptance": true}'::jsonb`)[0].n === 0);
}

export const suite: Suite = {
    name: 'index-results',
    requiredEnv: [],
    run,
};
