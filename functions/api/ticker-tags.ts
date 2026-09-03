// POST /api/ticker-tags - protected, machine-to-machine only: the backend half of the
// curator "tag this Tank to a ticker" action (the curator tool's UI wiring lives with
// that tool, not here). Auth is a shared secret header, same convention as
// X-Settle-Secret/X-Curate-Secret: compare X-Ticker-Secret against Env.TICKER_SECRET.
//
// Eligibility is validated HERE, at tag time, against the Tank's own frozen snapshot
// odds - an ineligible tag (e.g. a favorite to $DOGS) is rejected immediately, never
// deferred to settlement. There is deliberately no direction/opinion field anywhere in
// this flow: the tag event's delta is the tagged side's real 3-day CLOB price movement
// (capped), and the settle direction doesn't exist until the market actually resolves.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../lib/pages-functions/db';
import {
    RETROSPECTIVE_NOTE,
    TaggingError,
    checkEligibility,
    fetchTagDelta,
    fetchKalshiTagDelta,
    getTicker,
    getTickerConfig,
    insertTagWithEvent,
    tagScaleOf,
} from '../../lib/pages-functions/tickers';

interface TankRow {
    id: string;
    slug: string | null;
    provider: string;
    league: string | null;
    market_id: string | null;
    market: string | null;   // game_snapshot.prop.market - totals/league eligibility
    outcome_prices: unknown; // game_snapshot.prop.odds.outcomePrices (JSONB array)
    outcome_labels: unknown; // game_snapshot.prop.odds.outcomes (JSONB array) - Over/Under detection
}

function reject(status: number, code: string, message: string, extra?: Record<string, unknown>): Response {
    return jsonResponse({ code, message, ...extra }, { status });
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Ticker-Secret');
    if (!secret || secret !== context.env.TICKER_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return reject(400, 'invalid_body', 'Invalid JSON body.');
    }
    const tankId = typeof body?.tankId === 'string' ? body.tankId.trim() : '';
    const slug = typeof body?.slug === 'string' ? body.slug.trim() : '';
    const tickerKey = typeof body?.tickerKey === 'string' ? body.tickerKey.trim() : '';
    const relevantSide = body?.relevantSide;
    if ((!tankId && !slug) || (tankId && !UUID_RE.test(tankId)) || !tickerKey) {
        return reject(400, 'invalid_body', 'Provide tickerKey plus either tankId (UUID) or slug.');
    }
    if (typeof relevantSide !== 'number' || !Number.isInteger(relevantSide) || relevantSide < 0) {
        return reject(400, 'invalid_relevant_side', 'relevantSide must be a non-negative outcome index.');
    }

    const sql = getSql(context.env);

    const ticker = await getTicker(sql, tickerKey);
    if (!ticker) return reject(404, 'unknown_ticker', `No active ticker "${tickerKey}".`);

    const tankRows = tankId
        ? await sql`SELECT id, slug, provider, league,
                           game_snapshot->'prop'->>'id' AS market_id,
                           game_snapshot->'prop'->>'market' AS market,
                           game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices,
                           game_snapshot->'prop'->'odds'->'outcomes' AS outcome_labels
                    FROM tank_pages WHERE id = ${tankId} LIMIT 1`
        : await sql`SELECT id, slug, provider, league,
                           game_snapshot->'prop'->>'id' AS market_id,
                           game_snapshot->'prop'->>'market' AS market,
                           game_snapshot->'prop'->'odds'->'outcomePrices' AS outcome_prices,
                           game_snapshot->'prop'->'odds'->'outcomes' AS outcome_labels
                    FROM tank_pages WHERE slug = ${slug} LIMIT 1`;
    if (tankRows.length === 0) return reject(404, 'tank_not_found', 'No Tank matches that id/slug.');
    const tank = tankRows[0] as unknown as TankRow;

    if (!['polymarket', 'kalshi'].includes(tank.provider)) {
        return reject(422, 'unsupported_provider', `Tanks from "${tank.provider}" can't be tagged - no price history and no auto-settlement path.`);
    }
    if (!tank.market_id) {
        return reject(422, 'missing_market_id', 'This Tank has no market id in its snapshot.');
    }
    const outcomePrices = Array.isArray(tank.outcome_prices) ? tank.outcome_prices : null;
    if (!outcomePrices || outcomePrices.length === 0) {
        return reject(422, 'missing_snapshot_odds', 'This Tank has no odds.outcomePrices in its snapshot.');
    }
    if (relevantSide >= outcomePrices.length) {
        return reject(422, 'side_out_of_range', `relevantSide ${relevantSide} is out of range - this Tank has ${outcomePrices.length} sides.`);
    }
    const sideProb = Number(outcomePrices[relevantSide]);

    const cfg = await getTickerConfig(sql);
    const eligibility = checkEligibility(ticker.rule_type, {
        side: relevantSide,
        probs: outcomePrices.map(Number),
        league: tank.league,
        market: tank.market,
        outcomes: Array.isArray(tank.outcome_labels) ? tank.outcome_labels.map(String) : null,
    }, cfg);
    if (!eligibility.ok) {
        return reject(422, 'ineligible', `${ticker.display_name} ${eligibility.reason}`, { snapshotProb: sideProb });
    }

    // Friendly pre-check; the UNIQUE (tank_id, ticker_key) constraint is the real
    // guarantee - a concurrent double-POST loses on the insert below and also maps to 409.
    const existing = await sql`SELECT 1 FROM ticker_tags WHERE tank_id = ${tank.id} AND ticker_key = ${tickerKey} LIMIT 1`;
    if (existing.length > 0) {
        return reject(409, 'already_tagged', `This Tank is already tagged to ${ticker.display_name}.`);
    }

    let tagDelta;
    try {
        tagDelta = tank.provider === 'kalshi'
            ? await fetchKalshiTagDelta(tank.market_id, relevantSide, cfg.tag_delta_cap_pct, tagScaleOf(cfg))
            : await fetchTagDelta(tank.market_id, relevantSide, cfg.tag_delta_cap_pct, tagScaleOf(cfg));
    } catch (err) {
        if (err instanceof TaggingError) {
            return reject(err.retriable ? 502 : 422, err.code, err.message, { retriable: err.retriable });
        }
        throw err;
    }

    const tagId = crypto.randomUUID();
    try {
        await insertTagWithEvent(sql, {
            tagId,
            tankId: tank.id,
            tickerKey,
            relevantSide,
            delta: tagDelta.delta,
            metadata: {
                rawDelta: tagDelta.rawDelta,
                capped: tagDelta.capped,
                capPct: cfg.tag_delta_cap_pct,
                priceNow: tagDelta.priceNow,
                price3dAgo: tagDelta.price3dAgo,
                tokenId: tagDelta.tokenId,
                historyPoints: tagDelta.historyPoints,
                thinHistory: tagDelta.thinHistory,
                snapshotProb: sideProb,
                marketId: tank.market_id,
                provider: tank.provider,
            },
        });
    } catch (err) {
        if ((err as { code?: string })?.code === '23505') {
            return reject(409, 'already_tagged', `This Tank is already tagged to ${ticker.display_name}.`);
        }
        throw err;
    }

    return jsonResponse(
        {
            tagId,
            tankId: tank.id,
            slug: tank.slug,
            tickerKey,
            relevantSide,
            delta: tagDelta.delta,
            rawDelta: tagDelta.rawDelta,
            capped: tagDelta.capped,
            priceNow: tagDelta.priceNow,
            price3dAgo: tagDelta.price3dAgo,
            note: RETROSPECTIVE_NOTE,
        },
        { status: 201 },
    );
};
