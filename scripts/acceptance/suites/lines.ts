// Acceptance suite for lines Tanks (kind='lines' - the matchup board, no story). The
// creation and hand-off writes live in the admin backend (backend.ts POST /api/tank/lines,
// PUT /api/tank/pages/:id), which this harness does not run, so rows are inserted
// directly in the shape those routes produce and the PAGES-side contracts are asserted:
//
//   1. a live lines row takes a pick like any Tank (one row == one pickable market);
//   2. a superseded lines row (a story took its market) takes NO pick - the public
//      status='published' predicate hides it, so picks.ts answers as if it did not exist;
//   3. /api/picks/mine sends a lines pick to its matchup page, never to an article URL;
//   4. /api/ticker-tags refuses a lines row outright - a lines Tank never moves an index.

import { api, check, pool, section, type Suite } from '../harness';
import { cleanupTanksBySlugPrefix, cleanupUsersByEmailPrefix, createUser, mintSessionCookie } from '../fixtures';
import { buildLinesArticle, buildLinesDeckPayload, type LinesFacts } from '../../../tank-lines';
import type { Game, Prop } from '../../../tank-types';

const SLUG_PREFIX = 'acceptance-lines-';
const EMAIL_PREFIX = 'acceptance-lines-';
const TICKER_SECRET = process.env.TICKER_SECRET || '';

async function cleanup() {
    await cleanupUsersByEmailPrefix(EMAIL_PREFIX);
    await cleanupTanksBySlugPrefix(SLUG_PREFIX);
}

// The row POST /api/tank/lines writes: kind='lines', provider polymarket, published to
// the app, a page_slug shared by the matchup, and a model_output whose call.sides are
// positional with the snapshot's outcomes.
async function insertLinesRow(opts: {
    slug: string; pageSlug: string; marketId: string; market: string; line: number | null;
    outcomes: string[]; outcomePrices: number[]; status: 'published' | 'superseded';
}): Promise<string> {
    const kickoff = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString();
    const snapshot = {
        prop: {
            id: opts.marketId, player: 'Fixture Away vs. Fixture Home', team: null, market: opts.market, line: opts.line,
            prominence: 90, odds: { outcomes: opts.outcomes, outcomePrices: opts.outcomePrices }, settleDate: kickoff,
        },
        game: { id: `acceptance-lines-game-${opts.pageSlug}`, league: 'MLB', away: 'Fixture Away', home: 'Fixture Home', kickoff, settleDate: kickoff, props: [] },
    };
    const modelOutput = {
        seo: { title: 'Fixture Away @ Fixture Home — Moneyline', meta_description: 'fixture', slug: opts.slug },
        body: '', tagline: 'Moneyline', hook: 'Fixture Away @ Fixture Home — Moneyline',
        cards: ['MLB · Fixture Away @ Fixture Home', 'Polymarket when this line was listed: 50% / 50%'],
        call: { question: 'Who wins?', sides: opts.outcomes },
    };
    const { rows } = await pool.query(
        `INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, status, visibility, published_at, kind, page_slug)
         VALUES ($1, 'polymarket', 'MLB', '', $2, $3, $4, 'app', NOW(), 'lines', $5) RETURNING id`,
        [opts.slug, JSON.stringify(snapshot), JSON.stringify(modelOutput), opts.status, opts.pageSlug],
    );
    return rows[0].id as string;
}

async function run() {
    await cleanup();

    const pageSlug = `${SLUG_PREFIX}page`;
    const liveSlug = `${pageSlug}-ml`;
    const handedOffSlug = `${pageSlug}-total`;
    await insertLinesRow({
        slug: liveSlug, pageSlug, marketId: 'acceptance-lines-market-ml', market: 'moneyline', line: null,
        outcomes: ['Fixture Away', 'Fixture Home'], outcomePrices: [0.46, 0.54], status: 'published',
    });
    await insertLinesRow({
        slug: handedOffSlug, pageSlug, marketId: 'acceptance-lines-market-total', market: 'totals', line: 8.5,
        outcomes: ['Over', 'Under'], outcomePrices: [0.5, 0.5], status: 'superseded',
    });

    const user = await createUser(`${EMAIL_PREFIX}picker@example.com`, { onboarded: true, username: 'acceptancelines' });
    const cookie = await mintSessionCookie(user.userId);

    section('1: A live lines row takes a pick like any Tank');
    const livePick = await api('POST', '/api/picks', { cookie, body: { slug: liveSlug, side: 'Fixture Home', sideIndex: 1 } });
    check('pick on the live lines row -> 201', livePick.status === 201, JSON.stringify(livePick.json));

    section('2: A superseded lines row (story took the market) takes no pick');
    const deadPick = await api('POST', '/api/picks', { cookie, body: { slug: handedOffSlug, side: 'Over', sideIndex: 0 } });
    check('pick on the superseded row -> 400 (unknown or unpublished Tank)', deadPick.status === 400, JSON.stringify(deadPick.json));
    const { rows: pickRows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM picks p JOIN tank_pages t ON t.id = p.tank_page_id WHERE t.slug = $1`, [handedOffSlug]);
    check('no picks row was written for the superseded line', pickRows[0].n === 0);

    section('3: /api/picks/mine sends a lines pick to its matchup page');
    const mine = await api('GET', '/api/picks/mine', { cookie });
    check('GET /api/picks/mine -> 200', mine.status === 200, JSON.stringify(mine.json));
    const pending = Array.isArray(mine.json?.pending) ? mine.json.pending.find((p: any) => p.slug === liveSlug) : null;
    check('the lines pick is pending', Boolean(pending));
    check('its href is the lines page, not an article',
        pending?.href === `/the-tank/lines/${pageSlug}/`, JSON.stringify(pending?.href));

    section('4: A lines row can never tag a ticker');
    if (!TICKER_SECRET) {
        check('TICKER_SECRET present for the ticker-tags refusal check', false, 'set TICKER_SECRET');
    } else {
        const { rows: tickerRows } = await pool.query(`SELECT key FROM tickers WHERE active ORDER BY key LIMIT 1`);
        const tickerKey = tickerRows[0]?.key as string | undefined;
        if (!tickerKey) {
            check('an active ticker exists to attempt the tag against', false, 'no active tickers');
        } else {
            const tag = await api('POST', '/api/ticker-tags', {
                body: { slug: liveSlug, tickerKey, relevantSide: 1 },
                headers: { 'X-Ticker-Secret': TICKER_SECRET },
            });
            check('POST /api/ticker-tags on a lines row -> 422 lines_not_taggable',
                tag.status === 422 && tag.json?.code === 'lines_not_taggable', JSON.stringify(tag.json));
            const { rows: tagRows } = await pool.query(
                `SELECT COUNT(*)::int AS n FROM ticker_tags tt JOIN tank_pages t ON t.id = tt.tank_id WHERE t.slug = $1`, [liveSlug]);
            check('no ticker_tags row exists for the lines row', tagRows[0].n === 0);
        }
    }

    section('5: Schema defaults - a row inserted without kind is a narrative');
    const { rows: kindRows } = await pool.query(
        `INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, status, visibility)
         VALUES ($1, 'polymarket', 'MLB', 'fixture', '{}'::jsonb, '{}'::jsonb, 'draft', 'app') RETURNING kind, page_slug`,
        [`${SLUG_PREFIX}default-kind`]);
    check("kind defaults to 'narrative'", kindRows[0].kind === 'narrative', String(kindRows[0].kind));
    check('page_slug defaults to NULL', kindRows[0].page_slug === null);

    // -----------------------------------------------------------------------------
    section('6: Walls are assembled from facts - no model, no source named, house price language');
    const game: Game = {
        id: 'fixture:MLB:San Diego Padres:Colorado Rockies:2026-09-17T19:10:00.000Z', league: 'MLB',
        away: 'San Diego Padres', home: 'Colorado Rockies', kickoff: '2026-09-17T19:10:00.000Z', settleDate: '2026-09-18T19:10:00.000Z', props: [],
    } as Game;
    const book = { tokenIds: ['1', '2'], bestBid: 0.64, bestAsk: 0.65, volume: 115000, liquidity: 337000 };
    const mlProp = { id: '1001', player: 'San Diego Padres vs. Colorado Rockies', team: null, market: 'moneyline', line: null, prominence: 90,
        odds: { outcomes: ['San Diego Padres', 'Colorado Rockies'], outcomePrices: [0.646, 0.355] }, book } as Prop;
    const spreadProp = { id: '1002', player: 'Spread', team: null, market: 'spreads', line: -1.5, prominence: 80, question: 'Spread: San Diego Padres (-1.5)',
        odds: { outcomes: ['San Diego Padres', 'Colorado Rockies'], outcomePrices: [0.545, 0.455] },
        // A real spread book: quoted tight with depth, and nothing traded yet.
        book: { tokenIds: ['3', '4'], bestBid: 0.54, bestAsk: 0.55, volume: 0, liquidity: 221000 } } as Prop;
    const totalProp = { id: '1003', player: 'O/U 10.5', team: null, market: 'totals', line: 10.5, prominence: 80,
        odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.515, 0.485] }, book } as Prop;
    const facts: LinesFacts = {
        asOf: '2026-09-17T14:00:00.000Z', volume: 115000, liquidity: 337000,
        dayAgo: { prob: 0.6, ts: '2026-09-16T14:00:00.000Z' },
        moneyline: { outcomes: ['San Diego Padres', 'Colorado Rockies'], probs: [0.646, 0.355] },
        records: { away: { games: 9, wins: 6, expectedWins: 5.2 }, home: { games: 4, wins: 1, expectedWins: 1.6 } },
        overs: { league: { games: 113, overs: 73 }, away: { games: 6, overs: 4 }, home: { games: 3, overs: 1 } },
        ladder: [],
    };

    const ml = buildLinesArticle(mlProp, game, facts);
    check('moneyline hook states both prices as a pair that reads as 100%',
        ml.hook === 'San Diego Padres 64.6%, Colorado Rockies 35.4%: the moneyline on San Diego Padres @ Colorado Rockies when it was listed.', ml.hook);
    check('a club with 5+ games gets its record; a club with fewer is left out, not guessed',
        ml.cards[0] === 'San Diego Padres: 6 wins in 9 games on our board; their prices added up to 5.2.' && ml.cardHeaders?.[0] === 'Wins vs prices', ml.cards[0]);
    check('movement is two levels over a bounded interval, never a difference',
        ml.cards[1].includes('The price on San Diego Padres went from 60% to 64.6% between Sep 16 and Sep 17.'), ml.cards[1]);
    check('the volume wall names its header after what it says', ml.cardHeaders?.[1] === '$115K volume', String(ml.cardHeaders?.[1]));

    const unmoved = buildLinesArticle(mlProp, game, { ...facts, dayAgo: { prob: 0.641, ts: '2026-09-16T14:00:00.000Z' } });
    check('under a point is "didn\'t move", said once and plainly',
        unmoved.cards[1].endsWith("The price on San Diego Padres didn't move between Sep 16 and Sep 17."), unmoved.cards[1]);

    const spread = buildLinesArticle(spreadProp, game, { ...facts, volume: 0, liquidity: 221000, dayAgo: null, ladder: [{ line: -2.5, prob: 0.435 }, { line: -3.5, prob: 0.02 }] });
    check('a spread quoted with depth but no volume still shows its price (the dead-book rule reads liquidity)',
        spread.hook.startsWith('San Diego Padres -1.5 54.5%, Colorado Rockies +1.5 45.5%'), spread.hook);
    check('win vs cover names the margin in the sport\'s own unit',
        spread.cards[0] === 'San Diego Padres to win was priced at 64.6%; San Diego Padres -1.5 at 54.5%. The difference is the price of San Diego Padres winning by exactly 1 run.'
        && spread.cardHeaders?.[0] === 'Win vs cover', spread.cards[0]);
    check('the next rung is the nearest LIVE one - a decided 2% rung is never shown',
        spread.cardHeaders?.[1] === 'Next: -2.5 at 43.5%' && spread.cards[1].startsWith('At San Diego Padres -2.5 the price was 43.5%.'), spread.cards[1]);

    const nflGame = { ...game, league: 'NFL', away: 'Detroit Lions', home: 'Buffalo Bills' } as Game;
    const nflSpread = { ...spreadProp, line: -5.5, question: 'Spread: Bills (-5.5)', odds: { outcomes: ['Bills', 'Lions'], outcomePrices: [0.495, 0.505] } } as Prop;
    const nfl = buildLinesArticle(nflSpread, nflGame, { ...facts, moneyline: { outcomes: ['Lions', 'Bills'], probs: [0.315, 0.685] } });
    check('a wider spread reads "N points or fewer"', nfl.cards[0].endsWith('winning by 5 points or fewer.'), nfl.cards[0]);

    const ladder = Array.from({ length: 15 }, (_, i) => ({ line: 24.5 + i * 2, prob: 0.97 - i * 0.03 })).concat([{ line: 9.5, prob: 0.585 }, { line: 11.5, prob: 0.425 }]);
    const total = buildLinesArticle(totalProp, game, { ...facts, ladder });
    check('the ladder shows this number\'s neighbours, not the bottom of the ladder',
        total.cards[0] === 'Over 9.5 was priced at 58.5%, Over 10.5 at 51.5% and Over 11.5 at 42.5%. 10.5 was the number closest to an even price.', total.cards[0]);
    check('the totals record leads with the league and adds only clubs with 5+ games',
        total.cards[1] === 'Through Sep 17, the Over landed in 73 of 113 MLB totals on our board. San Diego Padres games: 4 of 6.'
        && total.cardHeaders?.[1] === 'MLB Overs: 73 of 113', total.cards[1]);

    const bare = buildLinesArticle(totalProp, game);
    check('with no facts every wall still fills from the snapshot alone',
        bare.cards.length === 2 && bare.cards.every((c) => c.length > 0) && bare.cardHeaders?.length === 2, JSON.stringify(bare.cards));

    const everything = JSON.stringify([ml, unmoved, spread, nfl, total, bare]);
    check('no wall names a data source', !/polymarket|kalshi|gamma/i.test(everything));
    const banned = everything.match(/\b(favorite|favourite|underdog|chance|likely|probability|expects?|thinks|smart money|the money|bettors|traders|surged|plunged|jumped)\b/i);
    check('no wall uses the banned price words', !banned, banned ? banned[0] : '');
    check('exactly two cards per line (the cube closes at four walls)', [ml, spread, total, bare].every((a) => a.cards.length === 2));
    const longest = Math.max(...[ml, unmoved, spread, nfl, total, bare].flatMap((a) => [a.hook, ...a.cards]).map((t) => t.length));
    check('no wall runs longer than a story\'s longest card (189 chars measured on the live corpus)', longest <= 189, String(longest));
    check('card headers fit the wall (34 chars)', [ml, spread, total, bare].every((a) => (a.cardHeaders ?? []).every((h) => h.length <= 35)));

    const payload = buildLinesDeckPayload({ slug: 's', game_snapshot: { prop: spreadProp, game }, model_output: spread });
    check('the deck uses the row\'s own card headers', payload.contextLabel === 'Win vs cover' && payload.oddsOrMarketLabel === 'Next: -2.5 at 43.5%', `${payload.contextLabel} | ${payload.oddsOrMarketLabel}`);
    const legacy = buildLinesDeckPayload({ slug: 's', game_snapshot: { prop: mlProp, game }, model_output: { ...ml, cardHeaders: undefined } });
    check('a row created before cardHeaders existed falls back to league/line and the frozen odds',
        legacy.contextLabel === 'MLB · Moneyline' && legacy.oddsOrMarketLabel.startsWith('San Diego Padres 64.6%'), `${legacy.contextLabel} | ${legacy.oddsOrMarketLabel}`);

    await cleanup();
}

export const suite: Suite = {
    name: 'lines',
    requiredEnv: ['TICKER_SECRET'],
    run,
};
