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
    return squarifyInto(weights, { x: 0, y: 0, w: width, h: height });
}

// Same layout anchored anywhere, so a family can be squarified INSIDE its parent's tile
// without the caller translating every rect by hand. squarify() is this with the rect
// pinned at the origin.
export function squarifyInto(weights: number[], into: Rect): Rect[] {
    const items: Weighted[] = weights.map((weight, index) => ({ weight, index })).sort((a, b) => b.weight - a.weight);
    const out: Rect[] = new Array(weights.length);
    let rect: Rect = { ...into };
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

export function weightsFromDeltas(deltas: number[], floorRatio = WEIGHT_FLOOR_RATIO): number[] {
    const biggest = Math.max(...deltas.map((d) => Math.abs(d)), 0);
    const floor = biggest > 0 ? biggest * floorRatio : 1;
    return deltas.map((d) => Math.max(Math.abs(d), floor));
}

// ---------------------------------------------------------------------------------
// Nesting: a family drawn inside its parent's tile.
//
// Two passes, never one flat one. weightsFromDeltas floors each weight against the
// LARGEST weight in its own call, so a nested call floors children against the largest
// child - which is what we want (a quiet child stays visible next to its loud sibling)
// and is not what a single flat pass would do (it would floor children against the
// largest ROOT, collapsing every child of a quiet family into the same sliver).
// ---------------------------------------------------------------------------------

// A container's tile has to hold a header plus N children, but area tracks size of move,
// so a quiet parent would otherwise get a small tile and slice it into slivers. Each
// child buys its parent this much additional guaranteed weight, as a share of the
// biggest tile on the board. Leaves are untouched.
export const CONTAINER_CHILD_WEIGHT = 0.55;

// Children are floored far more aggressively than roots. A root tile only has to be
// clickable at its smallest; a child also has to carry a league symbol like $NBACHALK
// inside a fraction of its parent, and at the roots' 0.15 a quiet sibling lands at ~1:7
// on area against a loud one, which is a sliver too narrow for any legible type. Within
// a family you are reading which league moved, not by exactly how much - the delta text
// and the border carry that - so evening the tiles out buys legibility cheaply.
export const CHILD_WEIGHT_FLOOR_RATIO = 0.45;

export function floorContainerWeights(weights: number[], childCounts: number[]): number[] {
    const biggest = Math.max(...weights, 0);
    if (biggest <= 0) return weights;
    return weights.map((w, i) => {
        const n = childCounts[i] ?? 0;
        if (n === 0) return w;
        return Math.max(w, biggest * WEIGHT_FLOOR_RATIO * (1 + n * CONTAINER_CHILD_WEIGHT));
    });
}

export interface NestedLayout {
    /** Absolute rect per root, aligned to the input order. */
    roots: Rect[];
    /** Absolute rects per child, aligned to childDeltas[i]. Empty for leaves. */
    children: Rect[][];
    /**
     * Height of the strip at the top of each root's rect carrying the parent's own
     * symbol and value. 0 for leaves, whose whole rect is theirs.
     */
    headers: number[];
}

export interface NestOptions {
    /** Header strip as a share of the container's height, then clamped. */
    headerRatio?: number;
    headerMin?: number;
    headerMax?: number;
    /** Inset between a container's inner area and its children, in board units. */
    padding?: number;
    /** Weight floor applied within a family (see CHILD_WEIGHT_FLOOR_RATIO). */
    childFloorRatio?: number;
}

/**
 * Lay out roots by their own move, then squarify each family into its parent's rect
 * minus a header strip. Deltas are signed (direction is the caller's business); area
 * tracks magnitude.
 *
 * A container whose children have no movement at all still lays them out - they render
 * flat rather than vanishing, which is what a just-seeded index looks like before its
 * first close, and what an out-of-season league looks like all winter.
 */
export function layoutNested(
    rootDeltas: number[],
    childDeltas: number[][],
    width: number,
    height: number,
    opts: NestOptions = {}
): NestedLayout {
    const {
        headerRatio = 0.26, headerMin = 0, headerMax = Infinity, padding = 0,
        childFloorRatio = CHILD_WEIGHT_FLOOR_RATIO,
    } = opts;
    const childCounts = rootDeltas.map((_, i) => childDeltas[i]?.length ?? 0);
    const rootWeights = floorContainerWeights(weightsFromDeltas(rootDeltas), childCounts);
    const roots = squarifyInto(rootWeights, { x: 0, y: 0, w: width, h: height });

    const children: Rect[][] = [];
    const headers: number[] = [];
    roots.forEach((rect, i) => {
        const kids = childDeltas[i] ?? [];
        if (kids.length === 0) {
            children.push([]);
            headers.push(0);
            return;
        }
        const header = Math.min(Math.max(rect.h * headerRatio, headerMin), headerMax, rect.h);
        const inner: Rect = {
            x: rect.x + padding,
            y: rect.y + header,
            w: Math.max(rect.w - padding * 2, 0),
            h: Math.max(rect.h - header - padding, 0),
        };
        headers.push(header);
        children.push(inner.w > 0 && inner.h > 0 ? squarifyInto(weightsFromDeltas(kids, childFloorRatio), inner) : []);
    });
    return { roots, children, headers };
}
