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

    await cleanup();
}

export const suite: Suite = {
    name: 'lines',
    requiredEnv: ['TICKER_SECRET'],
    run,
};
