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

import { marketFamilyForSide, leagueRuleAccepts, parseLeagueRule } from './league-rules';

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
    // polymarket_props.question. Only read for Yes/No markets, where the outcome labels
    // say nothing about what the market is (see parseYesNoQuestion / isDrawMarket).
    question: string | null;
}

// -----------------------------------------------------------------------------------
// Yes/No market questions. Polymarket lists soccer moneylines as "Will <TEAM> win on
// <date>?" with outcomes ['Yes','No'], so the side label alone never names the team; and
// it lists "Will <A> vs. <B> end in a draw?" under the same 'moneyline' market_type even
// though it is a side bet on one outcome of a three-way, not the game's line. Both need
// the question to be read. Same regex forms as yesSideLabel in market-movement.ts, kept
// local so this module stays free of that file's tank-deck dependencies.
// -----------------------------------------------------------------------------------

export type YesNoQuestion = { kind: 'team'; team: string } | { kind: 'draw' };

export function parseYesNoQuestion(question: string | null | undefined): YesNoQuestion | null {
    if (!question) return null;
    const q = question.trim();
    if (/\bend in a draw\b/i.test(q)) return { kind: 'draw' };
    const win = q.match(/^Will\s+(.+?)\s+win\b/i);
    if (win) return { kind: 'team', team: win[1].trim() };
    return null;
}

export function isDrawMarket(row: Pick<SlateMarketRow, 'question'>): boolean {
    return parseYesNoQuestion(row.question)?.kind === 'draw';
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
// The floor that replaces volume on the market types that don't carry it. Spreads and
// BTTS are quoted with real liquidity but frequently no volume at all (see
// pickCanonicalMarket's header), so this is the "somebody is actually making a market
// here" test for them. Median liquidity is 4164 across 793 open spread events and 13256
// across 322 BTTS events, so 250 excludes the dead rungs without touching a real line.
export const MIN_SELECTION_LIQUIDITY = 250;

// Declared here rather than lower down because SELECTION_POLICY below keys off them -
// an object literal's computed keys are evaluated when the const initialises, so a
// forward reference would be a temporal-dead-zone ReferenceError at import time.
const TOTALS_MARKET_TYPE = 'totals';
const MONEYLINE_MARKET_TYPE = 'moneyline';
const SPREADS_MARKET_TYPE = 'spreads';
const BTTS_MARKET_TYPE = 'both_teams_to_score';

interface SelectionPolicy {
    volumeFloor: number;
    liquidityFloor: number;
    /** 'volume' = the headline-line rule; 'nearest_even' = the true-spread rule. */
    rank: 'volume' | 'nearest_even';
}

// One row per market type, so a new family declares its selection rule in a single place
// instead of growing an `if (marketType === ...)` inside the picker.
//
// moneyline and totals keep EXACTLY the behaviour they had before this table existed
// (volumeFloor = MIN_SELECTION_VOLUME, liquidityFloor = 0, volume ranking), so no live
// index changes which market it holds.
const SELECTION_POLICY: Record<string, SelectionPolicy> = {
    [MONEYLINE_MARKET_TYPE]: { volumeFloor: MIN_SELECTION_VOLUME, liquidityFloor: 0, rank: 'volume' },
    [TOTALS_MARKET_TYPE]: { volumeFloor: MIN_SELECTION_VOLUME, liquidityFloor: 0, rank: 'volume' },
    [SPREADS_MARKET_TYPE]: { volumeFloor: 0, liquidityFloor: MIN_SELECTION_LIQUIDITY, rank: 'nearest_even' },
    // BTTS has exactly one market per game (322 of 322), so ranking never actually
    // decides anything - but it keeps the volume rule for the day that stops being true.
    [BTTS_MARKET_TYPE]: { volumeFloor: 0, liquidityFloor: MIN_SELECTION_LIQUIDITY, rank: 'volume' },
};

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

// "Spread: Miami Dolphins (-7.5)". Verified against the live board 2026-09-13: outcome 0
// is ALWAYS the team the question names, and market_line is ALWAYS NEGATIVE - 4398 of
// 4398 open spread rows, range -21.5 to -0.5. So the named team is always the side LAYING
// the points, which is what lets the side be decided structurally instead of by price.
const SPREAD_QUESTION = /^Spread:\s*(.+?)\s*\(\s*([-+]?\d+(?:\.\d+)?)\s*\)\s*$/i;

export function parseSpreadQuestion(q: string | null | undefined): { team: string; line: number } | null {
    if (!q) return null;
    const m = q.trim().match(SPREAD_QUESTION);
    if (!m) return null;
    const line = Number(m[2]);
    return Number.isFinite(line) ? { team: m[1].trim(), line } : null;
}

/**
 * Which outcome is the favourite laying the points, and which is the dog taking them.
 *
 * DELIBERATELY NOT argmax/argmin. The canonical spread is the market priced nearest a
 * coin flip (that is how pickCanonicalMarket finds the true line), so the two sides sit
 * at roughly 0.50 each and the argmax flips between them game to game on noise. $COVER
 * would hold the favourite in one game and the underdog in the next, and the pair would
 * stop being a mirror. The question names the team laying the points; that is a fact
 * about the market, not about its current price, so it is stable.
 *
 * Every failure path returns null - positionsForGame reads that as "this index sits this
 * game out", which is always correct and never a guessed side.
 */
function spreadSideIndex(row: SlateMarketRow, want: 'favorite' | 'underdog'): number | null {
    const labels = row.outcomes;
    if (!Array.isArray(labels) || labels.length !== 2) return null;
    const parsed = parseSpreadQuestion(row.question);
    // A non-negative line means the question is not naming a side that lays points, so
    // "favorite" has no referent here. Refuse rather than guess.
    if (!parsed || !(parsed.line < 0)) return null;
    // Equality, not substring: softening this would hide a format drift rather than
    // refuse it, and a mis-resolved side settles real Ember.
    const named = labels.findIndex((l) => String(l).trim().toLowerCase() === parsed.team.toLowerCase());
    if (named < 0) return null;
    return want === 'favorite' ? named : 1 - named;
}

// Both-teams-to-score is a plain Yes/No market - 322 of 322 open rows carry exactly
// ["Yes","No"] and exactly one market per game. Matched on the LABEL rather than the
// index so that a reordering by Polymarket becomes a refusal, not an inverted position.
function yesNoIndex(row: SlateMarketRow, want: 'yes' | 'no'): number | null {
    const labels = row.outcomes;
    if (!Array.isArray(labels) || labels.length !== 2) return null;
    const i = labels.findIndex((l) => String(l).trim().toLowerCase() === want);
    return i < 0 ? null : i;
}

// Strict: null when no single side is shortest (or longest). A tie used to fall through
// to index 0, which made the favorite rule and the underdog rule pick the SAME side of
// a pick'em - so $CHALK and $DOGS held one identical position and moved together, and
// $MLBCHALK and $MLBDOGS did the same. A market with no shortest price has no favorite,
// so it qualifies for neither index and is simply skipped.
function argmaxIndex(p: number[]): number | null {
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i;
    return p.every((q, i) => i === best || q < p[best]) ? best : null;
}
function argminIndex(p: number[]): number | null {
    let best = 0;
    for (let i = 1; i < p.length; i++) if (p[i] < p[best]) best = i;
    return p.every((q, i) => i === best || q > p[best]) ? best : null;
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
        case 'spread_favorite':
        case 'spread_underdog':
            return SPREADS_MARKET_TYPE;
        case 'btts_yes':
        case 'btts_no':
            return BTTS_MARKET_TYPE;
        default: {
            // League-scoped children read the same market their parent does - a
            // moneyline for a $CHALK/$DOGS slice, a total for an $OVERS/$UNDERS one.
            //
            // Routed through marketFamilyForSide rather than a ternary on purpose: that
            // switch is exhaustive over RuleSide, so a side added without a case here
            // fails to compile instead of quietly resolving to a moneyline.
            const rule = parseLeagueRule(ruleType);
            if (!rule) return null;
            return marketFamilyForSide(rule.side);
        }
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
            return i !== null && p[i] >= cfg.locksMinProb ? i : null;
        }
        case 'longshot': {
            const i = argminIndex(p);
            return i !== null && p[i] < cfg.moonshotMaxProb ? i : null;
        }
        case 'spread_favorite':
            return spreadSideIndex(row, 'favorite');
        case 'spread_underdog':
            return spreadSideIndex(row, 'underdog');
        case 'btts_yes':
            return yesNoIndex(row, 'yes');
        case 'btts_no':
            return yesNoIndex(row, 'no');
        default: {
            // A league child holds the same side its parent would on this game -
            // favorites take the argmax, underdogs the argmin, and a totals child takes
            // the same Over or Under - so a child's position is literally a filtered
            // view of the parent's, which is what makes the family partition the parent
            // exactly. leagueQualifies has already screened the league by the time we
            // get here.
            //
            // Every arm below is load-bearing rather than cosmetic: falling through to
            // argmin for 'total_under' would take the CHEAPEST side of the totals market
            // rather than the Under. On a total priced 0.52/0.48 those are the same side
            // only by luck, and the mistake is a wrong position that settles real Ember
            // - never an error anyone would see.
            //
            // Written as an EXHAUSTIVE switch over RuleSide with no default, so the next
            // side added here fails to compile rather than falling into one of these.
            // It used to end `rule.side === 'favorite' ? argmax : argmin`, which would
            // have silently taken the argmin for every spread and every BTTS side the
            // moment those joined RuleSide.
            const rule = parseLeagueRule(ruleType);
            if (!rule) return null;
            switch (rule.side) {
                case 'total_over': return overUnderIndex(row, 'over');
                case 'total_under': return overUnderIndex(row, 'under');
                case 'favorite': return argmaxIndex(p);
                case 'underdog': return argminIndex(p);
                case 'spread_favorite': return spreadSideIndex(row, 'favorite');
                case 'spread_underdog': return spreadSideIndex(row, 'underdog');
                case 'btts_yes': return yesNoIndex(row, 'yes');
                case 'btts_no': return yesNoIndex(row, 'no');
            }
        }
    }
}

/**
 * The one market that represents this game for this market type. Moneylines and totals
 * are ranked by volume (the market's own vote for the headline number), then liquidity,
 * then distance from a coin flip, then the lowest line - the last two purely so the
 * choice is deterministic rather than because they carry signal.
 *
 * SPREADS RANK DIFFERENTLY, and must. Two measurements from the live board (2026-09-13)
 * break the volume rule there:
 *
 *   1. Volume is usually ABSENT on spreads. In a sampled NFL game nearly every spread
 *      market had volume NULL or 0 while liquidity was populated (12-920). Gating on
 *      MIN_SELECTION_VOLUME would reject the entire market type, every game.
 *   2. "Lowest line" is actively WRONG when every line is negative (-21.5..-0.5, 4398 of
 *      4398 rows). It would systematically select the most lopsided novelty rung on the
 *      ladder - Dolphins -21.5 at 0.15 - rather than the real line.
 *
 * The true spread is the one priced nearest a coin flip; that is what a spread IS. So
 * spreads rank on |p - 0.5| ascending, tie-broken by liquidity.
 *
 * THAT SORT IS ALSO THE MIRROR DEDUPE, and deliberately so. Polymarket lists a spread
 * ladder from BOTH teams' perspective, so one NFL game carried both "Spread: 49ers
 * (-8.5)" at [0.48, 0.52] and "Spread: Dolphins (-8.5)" at [0.19, 0.81] - the same
 * number, opposite teams, only one of them the real market. The wrong-team mirror is by
 * construction far from 50/50 (that is what makes it the wrong team), so it can never
 * win this sort. Do not add a separate dedupe pass: it would be a second place for the
 * rule to live and drift out of step with this one.
 */
export function pickCanonicalMarket(
    rows: SlateMarketRow[],
    marketType: string,
): { row: SlateMarketRow; runnerUpLine: number | null; medianAgreed: boolean | null } | null {
    const policy = SELECTION_POLICY[marketType] ?? SELECTION_POLICY[MONEYLINE_MARKET_TYPE];
    const candidates = rows.filter((r) => {
        if (r.market_type !== marketType) return false;
        // A draw market is not a game's line, whatever its volume says - $CHALK holding
        // "No draw" at 0.76 measures nothing the index is about. Six such positions were
        // locked before this guard existed (MLS, 2026-09) and stay as history.
        if (isDrawMarket(r)) return false;
        const p = prices(r);
        if (!p) return false;
        if ((r.liquidity ?? 0) <= 0) return false;
        if ((r.volume ?? 0) < policy.volumeFloor) return false;
        if ((r.liquidity ?? 0) < policy.liquidityFloor) return false;
        // Every side must be live; a decided side can't be an entry price.
        return p.every((v) => v >= MIN_ENTRY_PROB && v <= MAX_ENTRY_PROB);
    });
    if (candidates.length === 0) return null;

    const dist50 = (r: SlateMarketRow) => Math.abs((prices(r)![0]) - 0.5);
    const ranked = [...candidates].sort(
        policy.rank === 'nearest_even'
            ? (a, b) =>
                dist50(a) - dist50(b)
                || (b.liquidity ?? 0) - (a.liquidity ?? 0)
                // |line| and then market_id purely for determinism - a stable choice
                // matters more than which of two equally-priced rungs wins.
                || Math.abs(a.market_line ?? 0) - Math.abs(b.market_line ?? 0)
                || (a.market_id < b.market_id ? -1 : a.market_id > b.market_id ? 1 : 0)
            : (a, b) =>
                (b.volume ?? 0) - (a.volume ?? 0)
                || (b.liquidity ?? 0) - (a.liquidity ?? 0)
                || dist50(a) - dist50(b)
                || (a.market_line ?? 0) - (b.market_line ?? 0));

    const winner = ranked[0];
    const runnerUpLine = ranked.length > 1 ? ranked[1].market_line : null;

    // Audit only: did the ladder's middle line agree with the volume pick? Tracked so
    // selection drift is measurable later, never used to choose.
    //
    // Left NULL for anything not ranked by volume. The question it asks is "did the
    // market's volume vote match the shape of the ladder", which has no meaning for a
    // spread ladder quoted from both teams' perspectives (its median line is a mix of two
    // opposing ladders), nor for BTTS, which lists exactly one market per game. Recording
    // a boolean there would be inventing an audit signal rather than measuring one.
    let medianAgreed: boolean | null = null;
    const lines = policy.rank === 'volume'
        ? candidates.map((r) => r.market_line).filter((l): l is number => l !== null).sort((a, b) => a - b)
        : [];
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
 *
 * EXACT, AND THEREFORE ORDER-INDEPENDENT. Contributions are summed as integer
 * thousandths, not as floats. Every contribution is already a 3dp value
 * (contributionFor rounds to 3dp; index_positions.contrib is NUMERIC(6,3)), so nothing
 * is lost, and an integer sum is the same in any order.
 *
 * The float sum it replaced was not. Float addition isn't associative, and the settle
 * job sums a ticker's rows in whatever order Postgres returns them, so a mirror pair's
 * two closes could round apart. Measured 2026-09-14: $NFLO closed +1.737 and $NFLU
 * -1.738 on eight games whose contributions were exact opposites. The true value was
 * 2.085 / 12 * 10 = 1.7375 exactly, and 3,528 of the 40,320 possible summation orders
 * of those eight numbers landed on the other side of the half.
 *
 * Rounding is half AWAY from zero on the exact milli-point value - the same rule
 * Postgres NUMERIC applies - and is taken on the magnitude, so a close and its mirror
 * are always exact negatives. With integer scalePct and smoothing (the live config),
 * the milli value is num/den of two integers, so an exact half is exactly representable
 * and cannot be misrounded by float error.
 */
export function closeDelta(
    contributions: number[],
    cfg: { smoothing: number; scalePct: number },
): number | null {
    if (contributions.length === 0) return null;
    const toMilli = (x: number) => Math.sign(x) * Math.round(Math.abs(x) * 1000);
    const sumMilli = contributions.reduce((acc, c) => acc + toMilli(c), 0);
    const deltaMilli = (sumMilli * cfg.scalePct) / (contributions.length + cfg.smoothing);
    const rounded = Math.sign(deltaMilli) * Math.round(Math.abs(deltaMilli));
    // `+ 0` folds -0 into 0, so a flat day can never print as "-0.000".
    return rounded / 1000 + 0;
}

/**
 * One position's exact share of the close closeDelta() built from it: the same term,
 * unrounded, so a day's shares sum to that day's close. This is the "points" a Recent
 * Results sentence quotes for a single game (getTickerResults, tickers.ts) - the
 * inputs come from the close event's own metadata, never recomputed from config, so
 * the number stays true even after a v4 retune. Null when the metadata is unusable.
 */
export function positionShareOfClose(
    contrib: number,
    close: { positionsCounted: number; smoothing: number; scalePct: number },
): number | null {
    const denom = close.positionsCounted + close.smoothing;
    if (!Number.isFinite(denom) || denom <= 0 || !Number.isFinite(contrib) || !Number.isFinite(close.scalePct)) return null;
    return (contrib * close.scalePct) / denom;
}
