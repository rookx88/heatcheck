// Slate scoring for the Exchange indexes: which market represents a game, which side
// an index holds, what a settled position contributes, and how a day's positions
// become one close. Pure and dependency-free - no DB, no fetch, no React - so every
// rule here is directly testable and runs identically in a Worker, the build, or a
// script. The SQL lives in functions/api/index-lock.ts and index-settle.ts.
//
// THE SELECTION PROBLEM (why this file exists): a single game lists ~9.2 separate
// totals markets - O/U 4.5, 5.5, 6.5 ... 28 of them in the worst case - so "score the
// Over" is meaningless until one of them is chosen to represent the game. Counting all
// of them would measure Polymarket's line coverage rather than what happened on the
// field, and would let a game with more listed lines outvote one with fewer.
//
// Measured on the live slate (2026-08-31): volume identifies the headline line
// decisively where it exists (in sampled MLB games the volume leader was 7.5 - the real
// main total - by 10x and 40x). It agrees with the ladder-median heuristic 77% of the
// time in games trading >=5k, and where the two disagree they pick adjacent lines only
// ~0.045 apart in probability. Agreement collapses to 27% in games under 100 volume -
// but there "the main line" isn't a real thing, which is why those games are skipped
// rather than guessed at. Volume is present for 100% of games within 24h of kickoff
// and only 35% beyond three days, which is why locking runs late (see index-lock.ts).

import { leagueRuleAccepts, parseLeagueRule } from './league-rules';

export interface SlateMarketRow {
    event_id: string;
    league: string;
    market_id: string;
    condition_id: string | null;
    market_type: string;
    market_line: number | null;
    outcomes: string[] | null;
    outcome_prices: number[] | null;
    volume: number | null;
    liquidity: number | null;
    kickoff: string | null;
    away: string | null;
    home: string | null;
}

export interface PositionSpec {
    tickerKey: string;
    row: SlateMarketRow;
    sideIndex: number;
    sideLabel: string | null;
    entryProb: number;
    selVolume: number;
    selLiquidity: number;
    selRunnerUpLine: number | null;
    selMedianAgreed: boolean | null;
}

// A market nobody is trading has no trustworthy headline line and no trustworthy entry
// price - an index shouldn't take a position in it. At lock time this skips roughly 1
// game in 14; locking earlier would skip most of the slate (see the volume-by-kickoff
// measurement above), which is the real reason locking must run late.
export const MIN_SELECTION_VOLUME = 100;
// Reject sides already effectively decided. An in-progress game was observed with four
// of its lines pinned at 1.000 while still flagged open, and a p of 0 or 1 would also
// make the odds-aware payout degenerate.
export const MIN_ENTRY_PROB = 0.05;
export const MAX_ENTRY_PROB = 0.95;

const TOTALS_MARKET_TYPE = 'totals';
const MONEYLINE_MARKET_TYPE = 'moneyline';

function prices(row: SlateMarketRow): number[] | null {
    const p = row.outcome_prices;
    if (!Array.isArray(p) || p.length === 0) return null;
    const nums = p.map(Number);
    return nums.every((n) => Number.isFinite(n)) ? nums : null;
}

// Mirrors overUnderSide in tickers.ts (Kalshi totals label their sides Yes/No with
// index 0 = Over by fixed convention); duplicated rather than imported to keep this
// module free of provider dependencies.
function overUnderIndex(row: SlateMarketRow, want: 'over' | 'under'): number | null {
    const labels = row.outcomes;
    if (Array.isArray(labels)) {
        for (let i = 0; i < labels.length; i++) {
            const l = String(labels[i]).trim().toLowerCase();
            if (l.startsWith(want)) return i;
            if (l === 'yes' && want === 'over' && i === 0) return 0;
            if (l === 'no' && want === 'under' && i === 1) return 1;
        }
    }
    return null;
}

function argmaxIndex(p: number[]): number {
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    return best;
}
function argminIndex(p: number[]): number {
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] < p[best]) best = i;
    return best;
}

/** Which market type an index's rule draws from, and whether the league qualifies. */
export function marketTypeForRule(ruleType: string): string | null {
    switch (ruleType) {
        case 'total_over':
        case 'total_under':
            return TOTALS_MARKET_TYPE;
        case 'underdog':
        case 'favorite':
        case 'heavy_favorite':
        case 'longshot':
            return MONEYLINE_MARKET_TYPE;
        default:
            // League-scoped children read the same moneyline their parent does.
            return parseLeagueRule(ruleType) ? MONEYLINE_MARKET_TYPE : null;
    }
}

export function leagueQualifies(ruleType: string, league: string): boolean {
    const rule = parseLeagueRule(ruleType);
    return rule ? leagueRuleAccepts(rule, league) : true;
}

/**
 * The side an index holds in a given market, or null when this game doesn't qualify.
 * Favorite-style rules take the argmax and underdog-style the argmin, so on a two-way
 * market $CHALK and $DOGS hold opposite sides of the same game and move inversely -
 * the property the Tank-era pairs already have. $LOCKS and $MOONSHOT additionally
 * require a genuinely lopsided price, which is why they only qualify on 0-3 games a day.
 */
export function sideForRule(
    ruleType: string,
    row: SlateMarketRow,
    cfg: { locksMinProb: number; moonshotMaxProb: number },
): number | null {
    const p = prices(row);
    if (!p) return null;

    switch (ruleType) {
        case 'total_over':
            return overUnderIndex(row, 'over');
        case 'total_under':
            return overUnderIndex(row, 'under');
        case 'favorite':
            return argmaxIndex(p);
        case 'underdog':
            return argminIndex(p);
        case 'heavy_favorite': {
            const i = argmaxIndex(p);
            return p[i] >= cfg.locksMinProb ? i : null;
        }
        case 'longshot': {
            const i = argminIndex(p);
            return p[i] < cfg.moonshotMaxProb ? i : null;
        }
        default: {
            // A league child holds the same side its parent would on this game -
            // favorites take the argmax, underdogs the argmin - so a child's position
            // is literally a filtered view of the parent's, which is what makes the
            // family partition the parent exactly. leagueQualifies has already
            // screened the league by the time we get here.
            const rule = parseLeagueRule(ruleType);
            if (!rule) return null;
            return rule.side === 'favorite' ? argmaxIndex(p) : argminIndex(p);
        }
    }
}

/**
 * The one market that represents this game for this market type. Ranked by volume
 * (the market's own vote for the headline number), then liquidity, then distance from
 * a coin flip, then the lowest line - the last two purely so the choice is
 * deterministic rather than because they carry signal.
 */
export function pickCanonicalMarket(
    rows: SlateMarketRow[],
    marketType: string,
): { row: SlateMarketRow; runnerUpLine: number | null; medianAgreed: boolean | null } | null {
    const candidates = rows.filter((r) => {
        if (r.market_type !== marketType) return false;
        const p = prices(r);
        if (!p) return false;
        if ((r.liquidity ?? 0) <= 0) return false;
        if ((r.volume ?? 0) < MIN_SELECTION_VOLUME) return false;
        // Every side must be live; a decided side can't be an entry price.
        return p.every((v) => v >= MIN_ENTRY_PROB && v <= MAX_ENTRY_PROB);
    });
    if (candidates.length === 0) return null;

    const dist50 = (r: SlateMarketRow) => Math.abs((prices(r)![0]) - 0.5);
    const ranked = [...candidates].sort((a, b) =>
        (b.volume ?? 0) - (a.volume ?? 0)
        || (b.liquidity ?? 0) - (a.liquidity ?? 0)
        || dist50(a) - dist50(b)
        || (a.market_line ?? 0) - (b.market_line ?? 0));

    const winner = ranked[0];
    const runnerUpLine = ranked.length > 1 ? ranked[1].market_line : null;

    // Audit only: did the ladder's middle line agree with the volume pick? Tracked so
    // selection drift is measurable later, never used to choose.
    let medianAgreed: boolean | null = null;
    const lines = candidates.map((r) => r.market_line).filter((l): l is number => l !== null).sort((a, b) => a - b);
    if (lines.length > 0 && winner.market_line !== null) {
        const med = lines[Math.floor((lines.length - 1) / 2)];
        let nearest = candidates[0];
        for (const c of candidates) {
            if (c.market_line === null) continue;
            const bestLine = nearest.market_line ?? Infinity;
            if (Math.abs(c.market_line - med) < Math.abs(bestLine - med)) nearest = c;
        }
        medianAgreed = nearest.market_id === winner.market_id;
    }

    return { row: winner, runnerUpLine, medianAgreed };
}

/**
 * Every position to lock for one game, across all active indexes. Rows must all belong
 * to the same event_id.
 */
export function positionsForGame(
    rows: SlateMarketRow[],
    tickers: Array<{ key: string; rule_type: string }>,
    cfg: { locksMinProb: number; moonshotMaxProb: number },
): PositionSpec[] {
    const out: PositionSpec[] = [];
    if (rows.length === 0) return out;
    const league = rows[0].league;

    // One canonical pick per market type, shared by every index that draws on it - so
    // $OVERS and $UNDERS are guaranteed to hold opposite sides of the SAME line.
    const canonical = new Map<string, ReturnType<typeof pickCanonicalMarket>>();

    for (const ticker of tickers) {
        const marketType = marketTypeForRule(ticker.rule_type);
        if (!marketType || !leagueQualifies(ticker.rule_type, league)) continue;

        if (!canonical.has(marketType)) canonical.set(marketType, pickCanonicalMarket(rows, marketType));
        const pick = canonical.get(marketType);
        if (!pick) continue;

        const sideIndex = sideForRule(ticker.rule_type, pick.row, cfg);
        if (sideIndex === null) continue;

        const p = prices(pick.row);
        if (!p || sideIndex >= p.length) continue;
        const entryProb = p[sideIndex];
        if (!(entryProb > MIN_ENTRY_PROB - 1e-9 && entryProb < MAX_ENTRY_PROB + 1e-9)) continue;

        out.push({
            tickerKey: ticker.key,
            row: pick.row,
            sideIndex,
            sideLabel: pick.row.outcomes?.[sideIndex] ?? null,
            entryProb,
            selVolume: pick.row.volume ?? 0,
            selLiquidity: pick.row.liquidity ?? 0,
            selRunnerUpLine: pick.runnerUpLine,
            selMedianAgreed: pick.medianAgreed,
        });
    }
    return out;
}

// -----------------------------------------------------------------------------------
// Scoring
// -----------------------------------------------------------------------------------

/**
 * A settled position's contribution: +(1 - p) on a win, -p on a loss. Identical to the
 * Tank-side rule in computeSettleDelta (tickers.ts) and EV-neutral for the same reason:
 * on a calibrated market p(1-p) + (1-p)(-p) = 0, so an index measures how far reality
 * diverged from the price, not how often the side won. A 75% favorite winning pays only
 * +0.25; losing costs -0.75.
 */
export function contributionFor(won: boolean, entryProb: number): number {
    return Number((won ? 1 - entryProb : -entryProb).toFixed(3));
}

/**
 * A day's settled positions -> one index move.
 *
 * Dividing by (N + smoothing) rather than N alone is deliberate. A plain mean makes
 * slate sizes comparable, which is the goal - but the measured slate has 3-18 games a
 * day for the broad indexes and only 0-3 for $LOCKS/$MOONSHOT, which need a lopsided
 * price to qualify at all. On a one-game day a plain mean would make that single result
 * the entire index move (a lock losing at p=0.85 would print the largest move on the
 * board off one game). The +k denominator shrinks thin days toward zero - one game
 * carries a fifth of its weight, twenty carry 83% - while large slates behave exactly
 * like the mean.
 *
 * Returns null when there is nothing to close: a day with no settled positions must
 * write no event at all rather than print a 0.0% close.
 */
export function closeDelta(
    contributions: number[],
    cfg: { smoothing: number; scalePct: number },
): number | null {
    if (contributions.length === 0) return null;
    const sum = contributions.reduce((a, b) => a + b, 0);
    const raw = (sum / (contributions.length + cfg.smoothing)) * cfg.scalePct;
    return Number(raw.toFixed(3));
}
