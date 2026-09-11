// Acceptance suite for market movement (market-movement.ts) and the dead-book price
// guard (tank-deck-format.ts).
//
// No DB, no HTTP, no API key - pure functions against hand-built fixtures shaped on real
// markets probed live on 2026-09-10 (Broncos-Chiefs 3335127, Yankees-Twins 4363827's
// empty book, Chelsea's Yes/No 3989227).
//
// This is the first number in a Tank article that comes from our own data, so the
// negative cases matter most: every path that can't measure a move honestly must return
// a reason, never a number.

import { check, section, type Suite } from '../harness';
import {
    isYesNo,
    yesSideLabel,
    priceAsOf,
    planMovementWindow,
    buildMarketContext,
    toWriterProp,
    toWriterMarketContext,
    sideLabelsFor,
    checkMovementProse,
    UNCHANGED_BELOW_PP,
    MOVED_AT_PP,
    type PricePoint,
    type MarketContext,
} from '../../../market-movement';
import { isLiveBook, hasShowablePrices, formatOddsLabel, deriveSidesImpliedProb } from '../../../tank-deck-format';
import type { Prop } from '../../../tank-types';

const NOW = new Date('2026-09-10T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const H = 3600;
const iso = (s: number) => new Date(s * 1000).toISOString();

// Hourly history from fromS to toS inclusive, priced by price(t); `skip` drops hours to
// simulate Polymarket's occasional gaps.
function hourly(fromS: number, toS: number, price: (t: number) => number, skip: number[] = []): PricePoint[] {
    const pts: PricePoint[] = [];
    for (let t = fromS; t <= toS; t += H) {
        if (!skip.includes(t)) pts.push({ t, p: price(t) });
    }
    return pts;
}

// A result's failure reason, or 'ok'. Uses `in` rather than narrowing on `.ok`: the main
// tsconfig isn't strict, and a boolean discriminant doesn't narrow without strictNullChecks.
function why(r: { ok: boolean }): string {
    return 'reason' in r ? String((r as { reason: unknown }).reason) : 'ok';
}

const LIVE_BOOK = { tokenIds: ['tok0', 'tok1'], bestBid: 0.43, bestAsk: 0.44, volume: 13612 };
const DEAD_BOOK = { tokenIds: ['tok0', 'tok1'], bestBid: 0.06, bestAsk: 0.94, volume: null };

function teamProp(over: Partial<Prop> = {}): Prop {
    return {
        id: '3335127',
        player: 'Denver Broncos vs. Kansas City Chiefs',
        team: null,
        market: 'moneyline',
        line: null,
        prominence: 90,
        odds: { outcomes: ['Broncos', 'Chiefs'], outcomePrices: [0.435, 0.565] },
        question: 'Broncos vs. Chiefs',
        book: LIVE_BOOK,
        ...over,
    };
}

function yesNoProp(question?: string): Prop {
    return {
        id: '3989227',
        player: 'Chelsea FC vs. Hull City AFC',
        team: null,
        market: 'moneyline',
        line: null,
        prominence: 90,
        odds: { outcomes: ['Yes', 'No'], outcomePrices: [0.795, 0.205] },
        question,
        book: { tokenIds: ['y0', 'y1'], bestBid: 0.79, bestAsk: 0.8, volume: 3369 },
    };
}

async function run() {
    // -----------------------------------------------------------------------------
    section('isLiveBook - an empty book is not a price');
    check('Yankees-Twins shape (0.06/0.94, no volume) is dead', !isLiveBook({ bestBid: 0.06, bestAsk: 0.94, volume: null }));
    check('a tight book with volume is live', isLiveBook({ bestBid: 0.79, bestAsk: 0.8, volume: 3369 }));
    check('zero volume is dead even with a tight book', !isLiveBook({ bestBid: 0.43, bestAsk: 0.44, volume: 0 }));
    check('a missing bid is dead', !isLiveBook({ bestBid: null, bestAsk: 0.44, volume: 100 }));
    check('a spread of exactly 10 points is still live (inclusive)', isLiveBook({ bestBid: 0.4, bestAsk: 0.5, volume: 100 }));
    check('a spread of 11 points is dead', !isLiveBook({ bestBid: 0.4, bestAsk: 0.51, volume: 100 }));
    check('no book at all is not live', !isLiveBook(null) && !isLiveBook(undefined));

    // -----------------------------------------------------------------------------
    section('Deck odds - never a fake 50/50');
    const halfOdds = { outcomes: ['Mets', 'Rays'], outcomePrices: [0.5, 0.5] };
    const realOdds = { outcomes: ['Broncos', 'Chiefs'], outcomePrices: [0.435, 0.565] };
    check('a dead book gives no label (the caller falls back to the market label)', formatOddsLabel(realOdds, DEAD_BOOK) === null);
    check('a live book gives the price', formatOddsLabel(realOdds, LIVE_BOOK) === 'Broncos 43.5% / Chiefs 56.5%',
        String(formatOddsLabel(realOdds, LIVE_BOOK)));
    check('no book data + an all-0.500 two-way market is treated as an empty book (the 9 published articles)',
        formatOddsLabel(halfOdds) === null);
    check('no book data + a real price still shows it', formatOddsLabel(realOdds) === 'Broncos 43.5% / Chiefs 56.5%');
    check('a dead book gives no implied probability (no "Chiefs (50%)" Discord button)',
        deriveSidesImpliedProb(realOdds, 2, DEAD_BOOK) === undefined);
    check('mismatched outcome and price counts are not showable',
        !hasShowablePrices({ outcomes: ['A', 'B'], outcomePrices: [0.4] }));

    // -----------------------------------------------------------------------------
    section('Yes/No markets are labelled from the question, or not at all');
    check('isYesNo recognises Yes/No and nothing else', isYesNo(['Yes', 'No']) && !isYesNo(['Broncos', 'Chiefs']));
    check('"Will Chelsea FC win on 2026-09-12?" -> "a Chelsea FC win"',
        yesSideLabel('Will Chelsea FC win on 2026-09-12?') === 'a Chelsea FC win');
    check('"...end in a draw?" -> "a draw"',
        yesSideLabel('Will Chelsea FC vs. Hull City AFC end in a draw?') === 'a draw');
    check('an unrecognised question gives no label',
        yesSideLabel('Chelsea vs Hull: total corners') === null && yesSideLabel(undefined) === null);

    // -----------------------------------------------------------------------------
    section('priceAsOf - the last price at or before a moment');
    const gappy: PricePoint[] = [{ t: 0, p: 0.4 }, { t: H, p: 0.41 }, { t: 3 * H, p: 0.45 }];
    check('finds the last point at or before, across a missing hour', priceAsOf(gappy, 2.5 * H)?.p === 0.41);
    check('an exact match counts', priceAsOf(gappy, 3 * H)?.p === 0.45);
    check('before the first point there is none', priceAsOf(gappy, -1) === null);

    // -----------------------------------------------------------------------------
    section('planMovementWindow - rule it out before spending a call');
    const news = iso(NOW_S - 48 * H);
    const plan = (over: Partial<Parameters<typeof planMovementWindow>[0]>) =>
        planMovementWindow({ prop: teamProp(), sourceTimestamp: news, recency: 'fresh', now: NOW, ...over });
    const reasonOf = why;
    check('no news time -> no sentence', reasonOf(plan({ sourceTimestamp: null })) === 'no_source_timestamp');
    check('a stale story -> no sentence', reasonOf(plan({ recency: 'stale' })) === 'recency_not_usable');
    check('an undatable story -> no sentence', reasonOf(plan({ recency: 'unknown' })) === 'recency_not_usable');
    check('no book (the cached and admin paths) -> no sentence',
        reasonOf(plan({ prop: teamProp({ book: undefined }) })) === 'no_price_data');
    check('a dead book -> no sentence', reasonOf(plan({ prop: teamProp({ book: DEAD_BOOK }) })) === 'dead_book');
    check('a Yes/No market with no question -> no sentence', reasonOf(plan({ prop: yesNoProp(undefined) })) === 'unlabelled_yes_no');
    check('news 3h ago -> window too short', reasonOf(plan({ sourceTimestamp: iso(NOW_S - 3 * H) })) === 'window_too_short');
    const okPlan = plan({});
    check('a fresh story on a live book plans a window from 6h before the news to now',
        okPlan.ok && okPlan.tokenId === 'tok0' && okPlan.startTs === okPlan.fromTs - 6 * H && okPlan.endTs === Math.floor(NOW_S),
        JSON.stringify(okPlan));

    // -----------------------------------------------------------------------------
    section('buildMarketContext - classification on unrounded values');
    const fromTs = NOW_S - 48 * H;
    const ctxFor = (history: PricePoint[], prop: Prop = teamProp()) => buildMarketContext({ prop, history, fromTs, now: NOW });
    const move = (from: number, to: number) => ctxFor(hourly(fromTs - 6 * H, NOW_S, (t) => (t <= fromTs ? from : to)));

    const flat = ctxFor(hourly(fromTs - 6 * H, NOW_S, () => 0.435));
    check('a flat market is "unchanged"', flat.ok && flat.context.status === 'unchanged', JSON.stringify(flat));
    check('both sides are given, complementary, in the market order',
        flat.ok && flat.context.side_labels.join('/') === 'Broncos/Chiefs' && flat.context.to_pct[0] + flat.context.to_pct[1] === 100);
    check('the window is the news-to-now interval', flat.ok && flat.context.window_hours === 48);

    const pp04 = move(0.40, 0.404);
    check(`0.4 points is "unchanged" (under ${UNCHANGED_BELOW_PP})`, pp04.ok && pp04.context.status === 'unchanged');
    const pp299 = move(0.40, 0.4299);
    check('2.99 points is "steady" - "didn\'t move" would be false', pp299.ok && pp299.context.status === 'steady');
    const pp300 = move(0.40, 0.43);
    check(`3.00 points is "moved" (at ${MOVED_AT_PP})`,
        pp300.ok && pp300.context.status === 'moved' && pp300.context.from_pct[0] === 40 && pp300.context.to_pct[0] === 43,
        JSON.stringify(pp300));

    // -----------------------------------------------------------------------------
    section('buildMarketContext - honest windows only');
    const newer = ctxFor(hourly(fromTs + 3 * H, NOW_S, () => 0.5));
    check('a market that opened 3h after the news -> no sentence (never clamp forward)',
        why(newer) === 'market_newer_than_news');
    const soonAfter = ctxFor(hourly(fromTs + 1800, NOW_S, () => 0.44));
    check('a market that opened 30 min after the news still brackets it', soonAfter.ok, JSON.stringify(soonAfter));
    const thin = ctxFor([{ t: fromTs - H, p: 0.44 }]);
    check('a single point -> thin history', why(thin) === 'thin_history');
    const staleEnd = ctxFor(hourly(fromTs - 6 * H, NOW_S - 5 * H, () => 0.44));
    check('newest point 5h old -> stale history', why(staleEnd) === 'stale_history');
    const emptyStart = move(0.5, 0.62);
    check('a move starting at exactly 0.500 -> suspected empty-book start',
        why(emptyStart) === 'empty_book_start');
    const smallFromHalf = move(0.5, 0.51);
    check('a small move off 0.500 is still allowed', smallFromHalf.ok && smallFromHalf.context.status === 'steady');
    const withGap = ctxFor(hourly(fromTs - 6 * H, NOW_S, (t) => (t <= fromTs ? 0.40 : 0.46), [fromTs, fromTs - H]));
    check('the price at the news is found across missing hours',
        withGap.ok && withGap.context.from_pct[0] === 40, JSON.stringify(withGap));

    // -----------------------------------------------------------------------------
    section('buildMarketContext - Yes/No markets name the Yes side only');
    const yn = buildMarketContext({
        prop: yesNoProp('Will Chelsea FC win on 2026-09-12?'),
        history: hourly(fromTs - 6 * H, NOW_S, () => 0.795),
        fromTs,
        now: NOW,
    });
    check('one side, labelled from the question',
        yn.ok && yn.context.yes_no && yn.context.side_labels.join('|') === 'a Chelsea FC win' && yn.context.to_pct.length === 1,
        JSON.stringify(yn));

    // -----------------------------------------------------------------------------
    section('Spread and total sides carry their line');
    const spreadProp = teamProp({
        id: '3993288', market: 'spreads', line: -2.5, question: 'Spread: Chelsea FC (-2.5)',
        odds: { outcomes: ['Chelsea FC', 'Hull City AFC'], outcomePrices: [0.365, 0.635] },
    });
    check('a spread side reads as the spread, not the moneyline',
        sideLabelsFor(spreadProp).join('|') === 'Chelsea FC -2.5|Hull City AFC +2.5', sideLabelsFor(spreadProp).join('|'));
    const totalProp = teamProp({
        market: 'totals', line: 44.5, question: 'Broncos vs. Chiefs: O/U 44.5',
        odds: { outcomes: ['Over', 'Under'], outcomePrices: [0.52, 0.48] },
    });
    check('a total side carries its line', sideLabelsFor(totalProp).join('|') === 'Over 44.5|Under 44.5', sideLabelsFor(totalProp).join('|'));
    check('a moneyline keeps the bare outcomes', sideLabelsFor(teamProp()).join('|') === 'Broncos|Chiefs');
    const oldSpread = teamProp({
        market: 'spreads', line: -4.5, question: undefined,
        odds: { outcomes: ['Eagles', 'Commanders'], outcomePrices: [0.515, 0.485] },
    });
    check('a spread snapshotted before `question` is lined from prop.line (outcome 0\'s handicap)',
        sideLabelsFor(oldSpread).join('|') === 'Eagles -4.5|Commanders +4.5', sideLabelsFor(oldSpread).join('|'));
    check('an unreadable spread question falls back to the bare outcomes',
        sideLabelsFor(teamProp({ question: 'Chelsea spread', odds: spreadProp.odds })).join('|') === 'Chelsea FC|Hull City AFC');
    const spreadCtx = ctxFor(hourly(fromTs - 6 * H, NOW_S, () => 0.365), spreadProp);
    check('the movement context uses the lined labels',
        spreadCtx.ok && spreadCtx.context.side_labels.join('|') === 'Chelsea FC -2.5|Hull City AFC +2.5', JSON.stringify(spreadCtx));

    // -----------------------------------------------------------------------------
    section('What the writer is shown');
    const writer = JSON.stringify(toWriterProp(teamProp()));
    check('toWriterProp carries no price',
        !writer.includes('0.435') && !writer.includes('0.565') && !writer.includes('outcomePrices'), writer);
    check('toWriterProp carries no order book',
        !writer.includes('tok0') && !writer.includes('bestBid') && !writer.includes('book'), writer);
    check('toWriterProp keeps the outcomes and the question', writer.includes('"Broncos"') && writer.includes('Broncos vs. Chiefs'));
    if (pp300.ok) {
        const wctx = JSON.stringify(toWriterMarketContext(pp300.context));
        check('toWriterMarketContext drops the unrounded prices and timestamps',
            !wctx.includes('from_price') && !wctx.includes('to_ts') && wctx.includes('"from_pct"'), wctx);
    }

    // -----------------------------------------------------------------------------
    section('checkMovementProse - the after-generation check');
    const ctx: Pick<MarketContext, 'status' | 'side_labels' | 'from_pct' | 'to_pct'> = {
        status: 'moved', side_labels: ['Broncos', 'Chiefs'], from_pct: [48, 52], to_pct: [42, 58],
    };
    const article = (body: string, hook = 'Mahomes is back.') => ({
        body,
        hook,
        cards: ['One beat.'],
        tagline: 'Mahomes Returns',
        seo: { title: 'Broncos vs. Chiefs', meta_description: 'Mahomes returns.', slug: 'x' },
        call: { question: 'Broncos or Chiefs?', sides: ['Broncos', 'Chiefs'] },
    });
    const clean = 'Reid confirmed the start on Monday. In the two days after, the Chiefs\' price on Polymarket went from 52% to 58%. Now the call is yours.';
    check('a clean "moved" sentence passes', checkMovementProse(article(clean), ctx).ok,
        JSON.stringify(checkMovementProse(article(clean), ctx)));
    const pts = 'Reid confirmed the start. In the two days after, the Chiefs\' price on Polymarket went up 6 points to 58%. The call is yours.';
    check('"6 points" is flagged', !checkMovementProse(article(pts), ctx).ok);
    const priced = 'Reid confirmed the start. In the two days after, the Chiefs\' price on Polymarket went from 52% to 58%, so it was priced in. The call is yours.';
    check('"priced in" is flagged', checkMovementProse(article(priced), ctx).problems.some((p) => p.includes('priced in')));
    check('a percentage in the hook is flagged',
        checkMovementProse(article(clean, 'KC at 58%.'), ctx).problems.some((p) => p.includes('hook')));
    const wrongNum = 'Reid confirmed the start. In the two days after, the Chiefs\' price on Polymarket went from 52% to 61%. The call is yours.';
    check('a percentage that was not measured is flagged',
        checkMovementProse(article(wrongNum), ctx).problems.some((p) => p.includes('61%')));
    const closes = 'Reid confirmed the start. In the two days after, the Chiefs\' price on Polymarket went from 52% to 58%.';
    check('closing the body on the market sentence is flagged',
        checkMovementProse(article(closes), ctx).problems.some((p) => p.includes('closes')));
    const present = 'Reid confirmed the start. The Chiefs\' price on Polymarket has held at 58% since then. The call is yours.';
    check('present-perfect "has held ... since" is flagged',
        checkMovementProse(article(present), { ...ctx, status: 'steady' }).problems.some((p) => p.includes('bounded')));
    check('a missing market sentence, when a context was given, is flagged',
        !checkMovementProse(article('Reid confirmed the start. The call is yours.'), ctx).ok);
    check('with no context, any percentage in the body is flagged',
        !checkMovementProse(article('KC sits at 58%. The call is yours.'), null).ok);
    check('with no context, plain prose passes',
        checkMovementProse(article('Reid confirmed the start. The call is yours.'), null).ok);
}

export const suite: Suite = {
    name: 'market-movement',
    requiredEnv: [],
    run,
};
