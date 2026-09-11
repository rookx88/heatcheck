// Time-window math over a ticker's event series, shared by the TANKDAQ surfaces:
// the Index Board (which picks a window) and an index's detail page (which sums a
// fixed 24h). Pure and dependency-free - no React, no DOM - so it runs in a client
// bundle, a Worker, or a plain script alike.
//
// Why the board adapts: ticker events arrive in bursts (a publish tags, a resolved
// game settles), so plenty of real days have none at all, and a board where every
// index reads 0.0% collapses into equal grey blocks that look broken rather than
// quiet. chooseWindow widens 24h -> 7d -> 30d -> all-time until it finds real
// movement. It never invents movement; the caller labels whichever lens it got.

export interface WindowedEvent {
    delta: number;
    occurredAt: string;
}

export interface WindowInfo {
    label: string;    // "the last 24 hours" - reads inside a sentence
    short: string;    // "24H" - the chip next to a value
    widened: boolean; // true once 24h came back empty and we looked further out
}

const HOUR_MS = 3600_000;

// Tried in order; the first with any movement wins.
export const WINDOWS = [
    { ms: 24 * HOUR_MS, label: 'the last 24 hours', short: '24H' },
    { ms: 7 * 24 * HOUR_MS, label: 'the last 7 days', short: '7D' },
    { ms: 30 * 24 * HOUR_MS, label: 'the last 30 days', short: '30D' },
] as const;

// NUMERIC(6,3) deltas: anything under half a milli-point is a rounding artifact, not
// a move (it would format as 0.0% anyway).
const MOVEMENT_EPSILON = 0.0005;

export function sumSince(events: WindowedEvent[] | undefined, cutoffMs: number): number {
    let sum = 0;
    for (const e of events ?? []) {
        if (new Date(e.occurredAt).getTime() >= cutoffMs) sum += e.delta;
    }
    return Number(sum.toFixed(3));
}

// A ticker's points moved inside each of WINDOWS, as SQL can sum them in one statement
// (getTickerWindowSums, tickers.ts) for a surface that has no series loaded.
export interface WindowSums {
    h24: number;
    d7: number;
    d30: number;
}

export interface WindowChoice {
    deltas: number[]; // cumulative POINTS moved per ticker, same order as `tickers`
    info: WindowInfo;
}

// The selection rule itself, shared by both entry points below so a surface fed from
// SQL sums and a surface fed from a loaded series can never pick different windows
// for the same data. perWindowDeltas[i] is every ticker's delta for WINDOWS[i].
function pickWindow(tickers: Array<{ key: string; value: number }>, perWindowDeltas: number[][]): WindowChoice {
    for (const [i, w] of WINDOWS.entries()) {
        const deltas = perWindowDeltas[i];
        if (deltas.some((d) => Math.abs(d) > MOVEMENT_EPSILON)) {
            return { deltas, info: { label: w.label, short: w.short, widened: i > 0 } };
        }
    }
    // Nothing has moved in a month: show where each index actually stands instead of
    // a grid of zeroes.
    return {
        deltas: tickers.map((t) => t.value),
        info: { label: 'all time', short: 'ALL', widened: true },
    };
}

// The narrowest window in which ANY index moved, falling back to all-time standings
// when a whole month has been silent.
export function chooseWindow(
    tickers: Array<{ key: string; value: number }>,
    series: Record<string, WindowedEvent[]>,
    now: number,
): WindowChoice {
    return pickWindow(tickers, WINDOWS.map((w) => tickers.map((t) => sumSince(series[t.key], now - w.ms))));
}

// Same rule over pre-summed windows. A ticker missing from `sums` has moved 0 in every
// window (no events at all), exactly as sumSince reads an undefined series.
export function chooseWindowFromSums(
    tickers: Array<{ key: string; value: number }>,
    sums: Record<string, WindowSums>,
): WindowChoice {
    const pick = (t: { key: string }, k: keyof WindowSums) => sums[t.key]?.[k] ?? 0;
    return pickWindow(tickers, [
        tickers.map((t) => pick(t, 'h24')),
        tickers.map((t) => pick(t, 'd7')),
        tickers.map((t) => pick(t, 'd30')),
    ]);
}
