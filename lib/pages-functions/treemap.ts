// Squarified treemap (Bruls et al.) - weights in, percentage rects out. Pure and
// dependency-free (no React, no DOM), so the same layout runs in the TANKDAQ client
// island and in the homepage's server-rendered SVG board. Sharing it is the point:
// two implementations of this would eventually disagree about where a tile sits.
//
// Items are sorted internally by weight descending; the returned rects are positionally
// aligned to the INPUT weights array, not to the sorted order.

export interface Weighted { weight: number; index: number }
export interface Rect { x: number; y: number; w: number; h: number }

// Aspect quality of a candidate row laid against the remaining rect's shorter side:
// strip thickness = (row weight / remaining weight) x (remaining area / side length),
// each tile's length along the strip is its share of the side. Lower is squarer.
function worstRatio(row: Weighted[], rect: Rect, total: number): number {
    const side = Math.min(rect.w, rect.h);
    const sum = row.reduce((s, r) => s + r.weight, 0);
    if (sum === 0 || side === 0 || total === 0) return Infinity;
    const thickness = (sum / total) * ((rect.w * rect.h) / side);
    let worst = 0;
    for (const r of row) {
        const len = (r.weight / sum) * side;
        if (len === 0 || thickness === 0) return Infinity;
        worst = Math.max(worst, len / thickness, thickness / len);
    }
    return worst;
}

// Carve the row's strip off the remaining rect (vertical strip when the rect is wide,
// horizontal when tall) and return what's left.
function layoutRow(row: Weighted[], rect: Rect, total: number, out: Rect[]): Rect {
    const sum = row.reduce((s, r) => s + r.weight, 0);
    let offset = 0;
    if (rect.w >= rect.h) {
        const w = (sum / total) * rect.w;
        for (const r of row) {
            const h = (r.weight / sum) * rect.h;
            out[r.index] = { x: rect.x, y: rect.y + offset, w, h };
            offset += h;
        }
        return { x: rect.x + w, y: rect.y, w: rect.w - w, h: rect.h };
    } else {
        const h = (sum / total) * rect.h;
        for (const r of row) {
            const w = (r.weight / sum) * rect.w;
            out[r.index] = { x: rect.x + offset, y: rect.y, w, h };
            offset += w;
        }
        return { x: rect.x, y: rect.y + h, w: rect.w, h: rect.h - h };
    }
}

export function squarify(weights: number[], width: number, height: number): Rect[] {
    const items: Weighted[] = weights.map((weight, index) => ({ weight, index })).sort((a, b) => b.weight - a.weight);
    const out: Rect[] = new Array(weights.length);
    let rect: Rect = { x: 0, y: 0, w: width, h: height };
    let total = weights.reduce((s, w) => s + w, 0);
    let row: Weighted[] = [];
    for (const item of items) {
        if (row.length === 0 || worstRatio([...row, item], rect, total) <= worstRatio(row, rect, total)) {
            row.push(item);
        } else {
            rect = layoutRow(row, rect, total, out);
            total -= row.reduce((s, r) => s + r.weight, 0);
            row = [item];
        }
    }
    if (row.length) layoutRow(row, rect, total, out);
    return out;
}

// The weight rule both boards use: a tile's area tracks the SIZE of its move, with a
// floor so an index that barely moved is still visible and clickable rather than a
// sliver. An all-quiet board degrades to equal tiles.
export const WEIGHT_FLOOR_RATIO = 0.15;

export function weightsFromDeltas(deltas: number[]): number[] {
    const biggest = Math.max(...deltas.map((d) => Math.abs(d)), 0);
    const floor = biggest > 0 ? biggest * WEIGHT_FLOOR_RATIO : 1;
    return deltas.map((d) => Math.max(Math.abs(d), floor));
}
