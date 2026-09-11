// ===================================================================================
// HEATCHECKS TANK — MARKET MOVEMENT (market-movement.ts)
// ===================================================================================
// How a Tank's own Polymarket market behaved around its storyline, reduced to the one
// sentence the writer is allowed to say about it. Pure functions, no I/O - the same
// posture as tank-curation.ts and tank-filter.ts - so every rule below is testable with
// hand-built fixtures (scripts/acceptance/suites/market-movement.ts) and importable from
// Workers, Node and the acceptance script alike. The one network call lives in
// lib/pages-functions/clob.ts.
//
// WHY THIS IS SO CAREFUL ABOUT WHEN TO SAY NOTHING
// This is the first number in a Tank article that comes from our own data rather than
// from a source the curator found, and it lands in the crawlable body that search
// engines and AI answer engines quote. So every path that cannot measure the move
// honestly returns a reason instead of a number:
//   - no news time, or a story too old or undatable -> nothing to anchor "after" to
//   - a dead or missing order book                  -> the "price" is an empty book's midpoint
//   - a market that opened after the news           -> the window is never clamped forward
//   - too little, or too stale, price history       -> "steady" must be measured, never inferred
//   - a move that starts at exactly 0.500           -> probably an empty book at the start
// The sentence is skipped in those cases, never estimated.
//
// WHY THE STATUS HAS THREE LEVELS
// Real markets mostly don't move (Broncos-Chiefs was flat for the whole week after
// Mahomes was confirmed). "Didn't move" is only true under 1 point; "stayed around 52%"
// covers 1-3; anything larger is written as two levels ("from 52% to 58%"). There is
// deliberately no up/down field: a direction invites "climbed", "slid", "surged".
// ===================================================================================

import type { Prop, TankArticle } from './tank-types';
import type { RecencyWindow } from './tank-curation';
import { isLiveBook } from './tank-deck-format';

export interface PricePoint {
    t: number; // unix seconds
    p: number; // price 0-1 (the bid/ask midpoint, for outcome 0)
}

export type MovementStatus = 'unchanged' | 'steady' | 'moved';

export const UNCHANGED_BELOW_PP = 1;
export const MOVED_AT_PP = 3;
const HOUR_S = 3600;
// History is fetched from 6h before the news, so the price AT the news is the last
// point at or before it even across Polymarket's occasional missing hours.
export const LOOKBACK_BEFORE_NEWS_S = 6 * HOUR_S;
// A market that opened within an hour after the news still brackets it closely enough;
// later than that and "after the news" would describe a price that didn't exist yet.
export const ANCHOR_AFTER_NEWS_S = 1 * HOUR_S;
// Shorter than this and there is no interval worth describing.
export const MIN_WINDOW_S = 6 * HOUR_S;
// The newest point must be recent, or "at the time of writing" is a stale reading.
export const MAX_END_STALENESS_S = 3 * HOUR_S;

export interface MarketContext {
    source: 'Polymarket';
    // Yes/No markets name ONE side (the Yes side, labelled from the market's question);
    // team and Over/Under markets name both, in the market's own outcome order.
    yes_no: boolean;
    side_labels: string[];
    from_pct: number[];     // whole percents, parallel to side_labels
    to_pct: number[];
    status: MovementStatus;
    window_hours: number;   // news -> writing, the same interval as time_context.hours_since_trend
    from_date_label: string;
    to_date_label: string;
    // Audit only, kept on the curation record - never sent to the writer, which would
    // otherwise quote "43.5%" instead of the rounded level (see toWriterMarketContext).
    from_price: number;
    to_price: number;
    from_ts: string;
    to_ts: string;
}

export type WriterMarketContext = Omit<MarketContext, 'from_price' | 'to_price' | 'from_ts' | 'to_ts'>;

export function isYesNo(outcomes: string[] | null | undefined): boolean {
    return Array.isArray(outcomes) && outcomes.length === 2
        && outcomes[0].trim().toLowerCase() === 'yes' && outcomes[1].trim().toLowerCase() === 'no';
}

// The Yes side of a Yes/No market, in words, from the market's own question:
//   "Will Chelsea FC win on 2026-09-12?"                 -> "a Chelsea FC win"
//   "Will Chelsea FC vs. Hull City AFC end in a draw?"   -> "a draw"
// Null when the question doesn't say - such a market gets no movement sentence, because
// the only honest label for its price would be a guess.
export function yesSideLabel(question: string | null | undefined): string | null {
    if (!question) return null;
    const q = question.trim();
    if (/\bend in a draw\b/i.test(q)) return 'a draw';
    const win = q.match(/^Will\s+(.+?)\s+win\b/i);
    if (win) return `a ${win[1].trim()} win`;
    return null;
}

// Side labels a reader can't misread. A spread market's outcomes are bare team names
// ("Chelsea FC" / "Hull City AFC"), but its price is the price of Chelsea COVERING -2.5,
// not of Chelsea winning - so "Chelsea FC's price went from 38% to 37%" would read as the
// moneyline. Spread sides carry their line from the market's question ("Spread: Chelsea
// FC (-2.5)"); total sides carry prop.line ("Over 44.5"). Anything else - moneylines,
// Yes/No, a question that doesn't parse - keeps the market's own outcomes.
//
// Snapshots taken before `question` was captured still get lined spread labels from
// prop.line: Gamma's spread `line` is outcome 0's handicap (verified 100 of 100 open
// spread markets on 2026-09-10 - outcome 0 is always the team the question names, and
// `line` always equals the question's number).
export function sideLabelsFor(prop: Pick<Prop, 'odds' | 'question' | 'line' | 'market'>): string[] {
    const outcomes = prop.odds?.outcomes ?? [];
    if (outcomes.length !== 2) return outcomes.slice();
    const signed = (v: number) => (v > 0 ? `+${v}` : `${v}`);
    const spread = prop.question?.trim().match(/^Spread:\s*(.+?)\s*\(([-+]?\d+(?:\.\d+)?)\)$/i);
    if (spread) {
        const line = Number(spread[2]);
        const named = outcomes.findIndex((o) => o.trim().toLowerCase() === spread[1].trim().toLowerCase());
        if (Number.isFinite(line) && named >= 0) {
            return outcomes.map((o, i) => `${o} ${signed(i === named ? line : -line)}`);
        }
    }
    if (!prop.question && prop.market === 'spreads' && typeof prop.line === 'number' && Number.isFinite(prop.line)) {
        const line = prop.line;
        return [`${outcomes[0]} ${signed(line)}`, `${outcomes[1]} ${signed(-line)}`];
    }
    const lower = outcomes.map((o) => o.trim().toLowerCase());
    if (lower[0] === 'over' && lower[1] === 'under' && typeof prop.line === 'number' && Number.isFinite(prop.line)) {
        return [`Over ${prop.line}`, `Under ${prop.line}`];
    }
    return outcomes.slice();
}

// The last price point at or before `ts` (unix seconds), or null. Points must be sorted.
export function priceAsOf(points: PricePoint[], ts: number): PricePoint | null {
    let found: PricePoint | null = null;
    for (const pt of points) {
        if (pt.t <= ts) found = pt;
        else break;
    }
    return found;
}

function dateLabel(tsSeconds: number): string {
    return new Date(tsSeconds * 1000).toLocaleDateString('en-US', {
        month: 'short', day: 'numeric', timeZone: 'America/New_York',
    });
}

export type MovementPlan =
    | { ok: true; tokenId: string; fromTs: number; startTs: number; endTs: number }
    | { ok: false; reason: 'no_source_timestamp' | 'recency_not_usable' | 'no_price_data' | 'dead_book' | 'unlabelled_yes_no' | 'window_too_short' };

// Everything that can rule a movement sentence out WITHOUT spending a network call.
// Only an ok plan is worth the CLOB request.
export function planMovementWindow(input: {
    prop: Pick<Prop, 'odds' | 'book' | 'question'>;
    sourceTimestamp: string | null;
    recency: RecencyWindow;
    now: Date;
}): MovementPlan {
    const { prop, sourceTimestamp, recency, now } = input;
    const sourceMs = sourceTimestamp ? new Date(sourceTimestamp).getTime() : NaN;
    if (!Number.isFinite(sourceMs)) return { ok: false, reason: 'no_source_timestamp' };
    // Stale and unknown stories are exactly the ones whose "after the news" window would
    // sweep in unrelated movement; the stale-anchor rule already covers their prose.
    if (recency !== 'fresh' && recency !== 'aging') return { ok: false, reason: 'recency_not_usable' };

    const outcomes = prop.odds?.outcomes ?? [];
    const tokenIds = prop.book?.tokenIds ?? [];
    if (outcomes.length !== 2 || tokenIds.length !== 2 || !tokenIds[0]) return { ok: false, reason: 'no_price_data' };
    if (!isLiveBook(prop.book)) return { ok: false, reason: 'dead_book' };
    if (isYesNo(outcomes) && !yesSideLabel(prop.question)) return { ok: false, reason: 'unlabelled_yes_no' };

    const nowS = Math.floor(now.getTime() / 1000);
    const fromTs = Math.floor(sourceMs / 1000);
    if (nowS - fromTs < MIN_WINDOW_S) return { ok: false, reason: 'window_too_short' };
    return { ok: true, tokenId: tokenIds[0], fromTs, startTs: fromTs - LOOKBACK_BEFORE_NEWS_S, endTs: nowS };
}

export type MarketContextResult =
    | { ok: true; context: MarketContext }
    | { ok: false; reason: 'no_price_data' | 'thin_history' | 'market_newer_than_news' | 'stale_history' | 'empty_book_start' | 'unlabelled_yes_no' };

// Turns token 0's price history into the MarketContext the writer receives, or a reason
// there isn't one. `fromTs` is the news time (unix seconds), from planMovementWindow.
export function buildMarketContext(input: {
    prop: Pick<Prop, 'odds' | 'question' | 'line' | 'market'>;
    history: PricePoint[];
    fromTs: number;
    now: Date;
}): MarketContextResult {
    const outcomes = input.prop.odds?.outcomes ?? [];
    if (outcomes.length !== 2) return { ok: false, reason: 'no_price_data' };

    const points = input.history
        .filter((pt) => pt && Number.isFinite(pt.t) && Number.isFinite(pt.p) && pt.p >= 0 && pt.p <= 1)
        .slice()
        .sort((a, b) => a.t - b.t);
    if (points.length < 2) return { ok: false, reason: 'thin_history' };

    // The price at the news: the last point at or before it, within the lookback.
    let from = priceAsOf(points, input.fromTs);
    if (from && from.t < input.fromTs - LOOKBACK_BEFORE_NEWS_S) from = null;
    if (!from) {
        // Tolerate a market that opened within the hour after the news. Anything later
        // means the market is newer than the story, and the window is never clamped
        // forward - that would re-anchor the number while the prose still says "after".
        const firstAfter = points.find((pt) => pt.t > input.fromTs);
        if (firstAfter && firstAfter.t <= input.fromTs + ANCHOR_AFTER_NEWS_S) from = firstAfter;
    }
    if (!from) return { ok: false, reason: 'market_newer_than_news' };

    const to = points[points.length - 1];
    if (to.t <= from.t) return { ok: false, reason: 'thin_history' };
    const nowS = input.now.getTime() / 1000;
    if (nowS - to.t > MAX_END_STALENESS_S) return { ok: false, reason: 'stale_history' };

    // Snapped to 1e-6 of a point: 0.43 - 0.40 is 2.9999999999999996 in floating point,
    // and a 3-point move must classify as 3 points.
    const movePp = Math.round(Math.abs(to.p - from.p) * 100 * 1e6) / 1e6;
    // A new market often sits at an empty book's exact 0.500 midpoint before market
    // makers arrive. A window starting there and ending on a real book would report a
    // move ("from 50% to 62%") that never happened.
    if (Math.abs(from.p - 0.5) < 1e-9 && movePp >= MOVED_AT_PP) return { ok: false, reason: 'empty_book_start' };

    // Classified on UNROUNDED values; percentages are rounded only for display.
    const status: MovementStatus = movePp < UNCHANGED_BELOW_PP ? 'unchanged' : movePp < MOVED_AT_PP ? 'steady' : 'moved';

    const yesNo = isYesNo(outcomes);
    const fromPct = Math.round(from.p * 100);
    const toPct = Math.round(to.p * 100);
    let sideLabels: string[];
    let fromPcts: number[];
    let toPcts: number[];
    if (yesNo) {
        const label = yesSideLabel(input.prop.question);
        if (!label) return { ok: false, reason: 'unlabelled_yes_no' };
        sideLabels = [label];
        fromPcts = [fromPct];
        toPcts = [toPct];
    } else {
        // The two tokens share one mirrored book, so side 1 is exactly the complement.
        sideLabels = sideLabelsFor(input.prop);
        fromPcts = [fromPct, 100 - fromPct];
        toPcts = [toPct, 100 - toPct];
    }

    return {
        ok: true,
        context: {
            source: 'Polymarket',
            yes_no: yesNo,
            side_labels: sideLabels,
            from_pct: fromPcts,
            to_pct: toPcts,
            status,
            window_hours: Math.max(1, Math.round((nowS - input.fromTs) / HOUR_S)),
            from_date_label: dateLabel(input.fromTs),
            to_date_label: dateLabel(nowS),
            from_price: from.p,
            to_price: to.p,
            from_ts: new Date(from.t * 1000).toISOString(),
            to_ts: new Date(to.t * 1000).toISOString(),
        },
    };
}

export function toWriterMarketContext(ctx: MarketContext): WriterMarketContext {
    return {
        source: ctx.source,
        yes_no: ctx.yes_no,
        side_labels: ctx.side_labels,
        from_pct: ctx.from_pct,
        to_pct: ctx.to_pct,
        status: ctx.status,
        window_hours: ctx.window_hours,
        from_date_label: ctx.from_date_label,
        to_date_label: ctx.to_date_label,
    };
}

export interface WriterProp {
    id: string;
    player: string;
    team: string | null;
    market: string;
    line: number | null;
    prominence: number;
    settleDate?: string;
    question?: string;
    odds: { outcomes: string[] } | null;
}

// What the narrative writer is shown of a Prop. An explicit ALLOWLIST, not a copy with
// fields deleted, so a field added to Prop later never reaches the model by default.
// Drops the order book and every price: the writer used to receive prop.odds with its
// outcomePrices, i.e. a price it was forbidden to quote sitting right in its input. The
// only price it may now see is the one in market_context.
export function toWriterProp(prop: Prop): WriterProp {
    return {
        id: prop.id,
        player: prop.player,
        team: prop.team,
        market: prop.market,
        line: prop.line,
        prominence: prop.prominence,
        settleDate: prop.settleDate,
        question: prop.question,
        odds: prop.odds ? { outcomes: prop.odds.outcomes } : null,
    };
}

export interface MovementCheck {
    ok: boolean;
    problems: string[];
}

// Banned in the market sentence and the sentences either side of it - money-flow, crowd
// and prediction language turns a price into a take. Mirrors the narrative prompt's list.
const BANNED_NEAR_PRICE = [
    'knows', 'thinks', 'believes', 'expects', 'priced in', 'baked in',
    'sharp', 'smart money', 'the money', 'action', 'steam',
    'buyers', 'sellers', 'traders', 'bettors',
    'reacted', 'shrugged', 'ignored', 'took notice',
    'chance', 'likely', 'probability', 'favorite', 'favourite', 'underdog',
    'jumped', 'surged', 'soared', 'plunged', 'crashed', 'spiked',
    'because', 'in response to', 'on the news', 'as a result',
];

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function percentagesIn(text: string): number[] {
    const out: number[] = [];
    const re = /(\d+(?:\.\d+)?)\s*%/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push(Number(m[1]));
    return out;
}

// The after-generation code check on what the writer actually produced. Stored on the
// curation record as a review FLAG, not a gate - a human reviews every draft anyway -
// the same "check in code, don't trust" posture as the curation gates.
export function checkMovementProse(
    article: Pick<TankArticle, 'body' | 'hook' | 'cards' | 'tagline' | 'seo' | 'call'>,
    ctx: Pick<MarketContext, 'status' | 'side_labels' | 'from_pct' | 'to_pct'> | null,
): MovementCheck {
    const problems: string[] = [];

    const elsewhere: Array<[string, string | undefined]> = [
        ['hook', article.hook],
        ['tagline', article.tagline],
        ['title', article.seo?.title],
        ['meta description', article.seo?.meta_description],
        ['call question', article.call?.question],
        ...(article.cards ?? []).map((c, i) => [`card ${i + 1}`, c] as [string, string]),
        ...(article.call?.sides ?? []).map((s, i) => [`side ${i + 1}`, s] as [string, string]),
    ];
    for (const [where, text] of elsewhere) {
        if (text && /%/.test(text)) problems.push(`percentage in ${where}`);
    }

    const body = article.body ?? '';
    const found = percentagesIn(body);

    if (!ctx) {
        if (found.length > 0) problems.push('percentage in body with no market_context');
        if (/\bPolymarket\b/i.test(body)) problems.push('Polymarket mentioned with no market_context');
        return { ok: problems.length === 0, problems };
    }

    const allowed = new Set([...ctx.from_pct, ...ctx.to_pct]);
    for (const n of found) {
        if (!allowed.has(n)) problems.push(`body quotes ${n}%, which is not a measured price`);
    }

    const sentences = body.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
    const marketIdx = sentences.map((s, i) => (/\bPolymarket\b/i.test(s) ? i : -1)).filter((i) => i >= 0);
    if (marketIdx.length === 0) {
        problems.push('market sentence missing');
        return { ok: false, problems };
    }
    if (marketIdx.length > 1) problems.push('Polymarket named in more than one sentence');

    if (ctx.status === 'moved' && !ctx.side_labels.some((_, i) => found.includes(ctx.from_pct[i]) && found.includes(ctx.to_pct[i]))) {
        problems.push('the market moved, but its from/to prices are not both quoted');
    }

    const idx = marketIdx[0];
    const sentence = sentences[idx];
    const near = sentences.slice(Math.max(0, idx - 1), idx + 2).join(' ');
    for (const term of BANNED_NEAR_PRICE) {
        if (new RegExp(`\\b${escapeRegExp(term)}\\b`, 'i').test(near)) problems.push(`"${term}" near the market sentence`);
    }
    if (/\bpoints?\b/i.test(sentence)) problems.push('market move written as points');
    if (/\b(?:is now|has held|has moved|has stayed|since)\b/i.test(sentence)) problems.push('market sentence is not bounded in the past');
    if (idx === sentences.length - 1) problems.push('body closes on the market sentence');

    return { ok: problems.length === 0, problems };
}
