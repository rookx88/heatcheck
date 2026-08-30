// GET /api/tickers/detail?key=dogs - everything one TANKDAQ index detail page needs in
// a single fetch: the ticker's meta + current value, its full event series (the chart
// source - the client windows it for the 24H/3D/1W toggle and computes the 24h delta),
// recent tagged storylines, and composed Recent Results sentences (toResultSentences -
// the exact copy the homepage Market Movers cards show). Public, read-only, no session.
// Same retrospective-framing contract as every ticker read endpoint.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import {
    RETROSPECTIVE_NOTE,
    getTickerNews,
    getTickerResults,
    getTickerSeries,
    getTickerValues,
} from '../../../lib/pages-functions/tickers';
import { indexLabelOf, toResultSentences } from '../../../lib/pages-functions/market-movers';

const NEWS_LIMIT = 4;
const RESULTS_LIMIT = 6;

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const url = new URL(context.request.url);
    const key = url.searchParams.get('key') ?? '';
    if (!key) {
        return jsonResponse({ message: 'Provide a ticker key (?key=dogs).' }, { status: 400 });
    }
    const sql = getSql(context.env);

    const values = await getTickerValues(sql);
    const ticker = values.find((t) => t.key === key);
    if (!ticker) {
        return jsonResponse({ message: `No active ticker "${key}".` }, { status: 404 });
    }

    const [series, newsMap, resultsMap] = await Promise.all([
        getTickerSeries(sql, key),
        getTickerNews(sql, NEWS_LIMIT),
        getTickerResults(sql, RESULTS_LIMIT),
    ]);

    return jsonResponse({
        note: RETROSPECTIVE_NOTE,
        ticker: {
            key: ticker.key,
            displayName: ticker.displayName,
            indexLabel: indexLabelOf(ticker.ruleType),
            description: ticker.description,
            ruleType: ticker.ruleType,
            value: ticker.value,
            eventCount: ticker.eventCount,
        },
        series: series[key] ?? [],
        news: (newsMap[key] ?? []).map((n) => ({
            href: `/the-tank/articles/${n.slug}/`,
            hook: n.hook,
            excerpt: n.excerpt,
            league: n.league,
            taggedAt: n.taggedAt,
        })),
        results: toResultSentences(resultsMap[key] ?? [], ticker.displayName),
    });
};
