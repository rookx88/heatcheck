// Acceptance suite for the Ember-price quote on every index surface (2026-09-11):
// "$DOGS 45.23 (+1.2%)" - the price, then the price's % change over the boards'
// adaptive window in parentheses. Run after any change to lib/pages-functions/
// ticker-format.ts, ticker-price.ts (priceReturnPct), ticker-window.ts
// (chooseWindowFromSums), getTickerWindowSums (tickers.ts), market-movers.ts, or
// functions/api/tickers/tank.ts.
//
// Three tiers:
//   1. Pure - the formatters, the return identity, and the SQL-sums window rule agreeing
//      with the series-fed rule on hand-built data.
//   2. HTTP - the SSR homepage: every top-level index's tape quote is well-formed, its
//      price is the API's price, its sign class matches its parenthesised sign, the
//      headline cards and the board tooltips quote the same string, and the price note
//      is present. /api/tickers/tank carries price + window return per tag.
//   3. Bundles - the island bundles on disk carry the new class names, not the old.
// Read-only: no fixtures, no cleanup.

import { BASE_URL, check, near, section, warn, type Suite } from '../harness';
import { pool } from '../harness';
import { sqlViaPool } from '../fixtures';
import { formatEmber, formatQuote, formatSignedPct, signOf } from '../../../lib/pages-functions/ticker-format';
import { PRICE_NOTE, priceFromValue, priceReturnPct, windowReturnPct } from '../../../lib/pages-functions/ticker-price';
import { chooseWindow, chooseWindowFromSums, type WindowSums, type WindowedEvent } from '../../../lib/pages-functions/ticker-window';
import { getTickerWindowSums } from '../../../lib/pages-functions/tickers';
import { escapeHtml } from '../../utils/html-escape';
import * as fs from 'node:fs';
import * as path from 'node:path';

const QUOTE_RE = /^\d[\d,]*\.\d{2} \([+−]\d+\.\d%\)$/;
const H = 3600_000;

async function run() {
    // --- 1. Pure ------------------------------------------------------------------
    section('Formatters and the price-return identity');
    check('formatQuote(45.2345, 1.23) === "45.23 (+1.2%)"', formatQuote(45.2345, 1.23) === '45.23 (+1.2%)', formatQuote(45.2345, 1.23));
    check('formatQuote(1234.5, -0) === "1,234.50 (+0.0%)"', formatQuote(1234.5, -0) === '1,234.50 (+0.0%)', formatQuote(1234.5, -0));
    check('formatSignedPct(-3.14) uses a real minus', formatSignedPct(-3.14) === '−3.1%');
    check('formatEmber groups thousands and keeps two decimals', formatEmber(1234567.891) === '1,234,567.89' && formatEmber(0.5) === '0.50');
    check('signOf', signOf(0.01) === 'pos' && signOf(-0.01) === 'neg' && signOf(0) === 'zero' && signOf(-0) === 'zero');
    check('priceReturnPct(0, scale) === 0', priceReturnPct(0, 115) === 0);
    check('priceReturnPct(scale * ln 2, scale) === +100%', near(priceReturnPct(90 * Math.LN2, 90), 100, 1e-9));
    check('priceReturnPct(delta, scale) === windowReturnPct(anchor + delta, anchor) for any anchor',
        [[-91.69, 3.2, 115], [12, -4.5, 20], [0, 0.7, 42]].every(([anchor, delta, scale]) =>
            near(priceReturnPct(delta, scale), windowReturnPct(anchor + delta, anchor, { baseline: 100, scale }), 1e-9)));
    check('the quoted return is the exact price ratio: price(v+d)/price(v) - 1',
        near(priceReturnPct(3.2, 115), (priceFromValue(-88.49, { baseline: 100, scale: 115 }) / priceFromValue(-91.69, { baseline: 100, scale: 115 }) - 1) * 100, 1e-3));

    section('chooseWindowFromSums agrees with chooseWindow on the same data');
    const now = Date.parse('2026-09-11T12:00:00.000Z');
    const at = (hoursAgo: number, delta: number): WindowedEvent => ({ delta, occurredAt: new Date(now - hoursAgo * H).toISOString() });
    const sumsOf = (series: Record<string, WindowedEvent[]>): Record<string, WindowSums> => {
        const out: Record<string, WindowSums> = {};
        for (const [k, evs] of Object.entries(series)) {
            const within = (h: number) => Number(evs.filter((e) => now - Date.parse(e.occurredAt) <= h * H).reduce((a, e) => a + e.delta, 0).toFixed(3));
            out[k] = { h24: within(24), d7: within(24 * 7), d30: within(24 * 30) };
        }
        return out;
    };
    const tickers = [{ key: 'a', value: 5 }, { key: 'b', value: -2 }];
    const cases: Array<[string, Record<string, WindowedEvent[]>]> = [
        ['24h has movement', { a: [at(3, 0.5), at(40, 1)], b: [at(100, -1)] }],
        ['24h silent, 7d has movement', { a: [at(40, 1)], b: [at(100, -1)] }],
        ['7d silent, 30d has movement', { a: [at(24 * 20, 0.25)], b: [] }],
        ['a month silent -> all-time values', { a: [at(24 * 45, 1)], b: [at(24 * 60, -3)] }],
    ];
    for (const [name, series] of cases) {
        const fromSeries = chooseWindow(tickers, series, now);
        const fromSums = chooseWindowFromSums(tickers, sumsOf(series));
        check(`${name}: same window and deltas`,
            JSON.stringify(fromSeries) === JSON.stringify(fromSums), `${JSON.stringify(fromSeries)} vs ${JSON.stringify(fromSums)}`);
    }
    check('a ticker absent from the sums reads as 0 in every window',
        JSON.stringify(chooseWindowFromSums([{ key: 'a', value: 1 }, { key: 'ghost', value: 9 }], { a: { h24: 0.5, d7: 0.5, d30: 0.5 } }).deltas) === '[0.5,0]');

    // --- 2. HTTP ------------------------------------------------------------------
    section('/api/tickers carries prices; getTickerWindowSums matches a direct sum');
    const list = (await fetch(`${BASE_URL}/api/tickers`).then((r) => r.json())) as { priceNote?: string; tickers: Array<{ key: string; value: number; price: number; priceBaseline: number; priceScale: number; parentKey: string | null }> };
    const apiByKey = new Map(list.tickers.map((t) => [t.key, t]));
    check('/api/tickers ships priceNote', list.priceNote === PRICE_NOTE);
    const sums = await getTickerWindowSums(sqlViaPool);
    const { rows: direct } = await pool.query(`
        SELECT e.ticker_key,
               COALESCE(SUM(e.delta) FILTER (WHERE e.occurred_at >= NOW() - INTERVAL '24 hours'), 0)::float8 AS h24
        FROM ticker_events e LEFT JOIN tank_pages t ON t.id = e.tank_id
        WHERE (e.source = 'slate' OR t.visibility = 'app') GROUP BY e.ticker_key`);
    check('window sums (24h) equal a direct sum with the getTickerValues predicate',
        direct.every((r) => near(sums[r.ticker_key as string]?.h24 ?? 0, r.h24 as number)));
    check('getTickerWindowSums(keys) narrows to those keys',
        Object.keys(await getTickerWindowSums(sqlViaPool, ['dogs'])).every((k) => k === 'dogs'));

    section('Homepage - tape, cards and board quote the same Ember price');
    let body = '';
    let content = '';
    for (let attempt = 0; attempt < 9; attempt++) {
        const res = await fetch(`${BASE_URL}/`, { headers: { Cookie: 'hc_session=not-a-real-token' } });
        body = await res.text();
        content = res.headers.get('x-homepage-content') ?? '';
        if (content === 'fresh') break;
        await new Promise((r) => setTimeout(r, 5000));
    }
    const tapeRe = /<li class="hc-tape-item is-(pos|neg|zero)"><a class="hc-tape-link" href="\/tankdaq\/(\w+)\/">[^<]+<\/a> <span class="hc-mm-quote is-(pos|neg|zero)">([^<]+)<\/span>/g;
    const tape = new Map<string, { sign: string; quote: string }>();
    for (const m of body.matchAll(tapeRe)) tape.set(m[2], { sign: m[1], quote: m[4] });
    const topLevel = list.tickers.filter((t) => !t.parentKey).map((t) => t.key);
    check('every top-level index has a tape quote', topLevel.length > 0 && topLevel.every((k) => tape.has(k)), `missing: ${topLevel.filter((k) => !tape.has(k)).join(',')} content=${content}`);
    check('every tape quote is "<price> (<signed pct>%)"', [...tape.values()].every((t) => QUOTE_RE.test(t.quote)), [...tape.values()].map((t) => t.quote).join(' | '));
    // The homepage renders from live data at request time, and this is a SHARED
    // database: another run's slate fixtures (or a real close) can move a price between
    // this suite's API read and its page read. A second API snapshot after the render
    // brackets the page, so the price must match one of the two.
    const listAfter = (await fetch(`${BASE_URL}/api/tickers`).then((r) => r.json())) as typeof list;
    const afterByKey = new Map(listAfter.tickers.map((t) => [t.key, t]));
    const priceMismatches = [...tape.entries()].filter(([k, t]) =>
        !t.quote.startsWith(`${formatEmber(apiByKey.get(k)!.price)} (`)
        && !t.quote.startsWith(`${formatEmber(afterByKey.get(k)?.price ?? NaN)} (`));
    check('tape price part equals formatEmber(api price) (before or after the render)', priceMismatches.length === 0,
        priceMismatches.map(([k, t]) => `${k}: tape ${t.quote} api ${apiByKey.get(k)!.price}/${afterByKey.get(k)?.price}`).join(' | '));
    check('tape sign class agrees with the parenthesised sign',
        [...tape.values()].every((t) => {
            const pct = t.quote.slice(t.quote.indexOf('(') + 1, -1); // "+0.5%"
            const s = pct === '+0.0%' ? 'zero' : pct.startsWith('+') ? 'pos' : 'neg';
            return s === t.sign;
        }), [...tape.entries()].map(([k, t]) => `${k}:${t.sign}:${t.quote}`).join(' '));
    const cardRe = /data-ticker="(\w+)"[\s\S]*?data-quote-for="\1"><span class="hc-mm-price">([^<]+)<\/span> <span class="hc-mm-return">\(([^<)]+)\)<\/span>/g;
    const cards = [...body.matchAll(cardRe)];
    check('at least one headline card renders a split quote', cards.length >= 1);
    check('each headline card quote equals the tape quote for that index',
        cards.every((m) => tape.get(m[1])?.quote === `${m[2]} (${m[3]})`), cards.map((m) => `${m[1]}: ${m[2]} (${m[3]})`).join(' | '));
    check('board tooltips carry the same price and return',
        [...tape.entries()].every(([k, t]) => {
            const [price, ret] = [t.quote.slice(0, t.quote.indexOf(' (')), t.quote.slice(t.quote.indexOf('(') + 1, -1)];
            return body.includes(`${price} Ember (${ret} over `);
        }));
    check('the card label names the window', /hc-mm-quote-label">Ember price &middot; (24H|7D|30D|ALL) change</.test(body));
    check('PRICE_NOTE renders inside #market-movers', body.includes(`hc-mm-price-note">${escapeHtml(PRICE_NOTE)}</p>`));
    check('the old cumulative-% class is gone', !body.includes('hc-mm-value'));

    section('/api/tickers/tank - price + window return per tag');
    const { rows: tanks } = await pool.query(`
        SELECT t.slug FROM tank_pages t
        WHERE t.status = 'published' AND t.visibility = 'app' AND t.slug IS NOT NULL
          AND EXISTS (SELECT 1 FROM ticker_tags tt WHERE tt.tank_id = t.id)
        ORDER BY t.published_at DESC LIMIT 1`);
    if (tanks.length === 0) {
        warn('no tagged app-visible Tank in the database - /api/tickers/tank price checks skipped');
    } else {
        const slug = tanks[0].slug as string;
        const tank = (await fetch(`${BASE_URL}/api/tickers/tank?slug=${encodeURIComponent(slug)}`).then((r) => r.json())) as any;
        const tags: any[] = tank?.tags ?? [];
        check('tank endpoint ships priceNote and a window', tank?.priceNote === PRICE_NOTE && ['24H', '7D', '30D', 'ALL'].includes(tank?.window?.short), JSON.stringify(tank?.window));
        check('every active tag carries price === priceFromValue(value, params)',
            tags.filter((t) => t.price !== null).every((t) => near(t.price, priceFromValue(t.tickerValue, { baseline: t.priceBaseline, scale: t.priceScale }), 1e-3)));
        check('every active tag carries priceReturnPct === priceReturnPct(windowDelta, scale)',
            tags.filter((t) => t.price !== null).every((t) => near(t.priceReturnPct, priceReturnPct(t.windowDelta, t.priceScale), 1e-6)));
        const short = tank?.window?.short as string;
        const col = short === '24H' ? 'h24' : short === '7D' ? 'd7' : short === '30D' ? 'd30' : null;
        check('windowDelta equals the chosen window\'s sum (or the all-time value under ALL)',
            tags.filter((t) => t.price !== null).every((t) => near(t.windowDelta, col ? (sums[t.tickerKey]?.[col as keyof WindowSums] ?? 0) : t.tickerValue)),
            JSON.stringify(tags.map((t) => [t.tickerKey, t.windowDelta])));
    }

    // --- 3. Bundles ----------------------------------------------------------------
    section('Island bundles on disk carry the quote markup');
    const asset = (name: string) => {
        const p = path.join(process.cwd(), 'dist', 'assets', name);
        return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    };
    const board = asset('tankdaq-indexes.js');
    const article = asset('tank-article-deck.js');
    const detail = asset('tankdaq-ticker.js');
    check('tankdaq-indexes.js has hc-tqb-quote and no hc-tqb-total', board.includes('hc-tqb-quote') && !board.includes('hc-tqb-total'), board ? '' : 'bundle missing - run npm run build:static');
    check('tank-article-deck.js has hc-tai-quote and no hc-tai-val', article.includes('hc-tai-quote') && !article.includes('hc-tai-val"'), article ? '' : 'bundle missing');
    check('tankdaq-ticker.js no longer prints the 24-hour points line', detail.length > 0 && !detail.includes('last 24 hours'), detail ? '' : 'bundle missing');
}

export const suite: Suite = {
    name: 'index-quotes',
    requiredEnv: [],
    run,
};
