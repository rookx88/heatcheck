// A club's running market residual, as a pure SVG string. Server-rendered into the team
// page: nothing on that page is live, so the chart is built once at build time and the
// island adds no chart of its own - crawlers get the real thing, and there is no flash.
// Same posture as market-movers.ts's renderTickerChartSvg: a string builder, escapeHtml
// and types only, no DOM.
//
// Time-scaled x (kickoff), like the TANKDAQ detail chart, so a fortnight of daily MLB
// games and a fortnight of weekly NFL games read at their real cadence. y is the running
// sum of contributionFor over the club's directional games, anchored at 0 - the line's
// distance from that anchor IS the residual.

import { escapeHtml } from '../../scripts/utils/html-escape';
import { NEON_RGB, signOf } from './ticker-format';
import { shortDate, signedResidual } from './team-copy';
import type { TeamSeriesPoint } from './team-pages';

const CW = 720;
const CH = 260;
const PAD = { top: 14, right: 18, bottom: 26, left: 56 };
const MIN_SPAN = 1; // a flat series still gets a readable band

function scaleFor(values: number[], minSpan: number): { lo: number; hi: number; y: (v: number) => number } {
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    if (hi - lo < minSpan) {
        const mid = (hi + lo) / 2;
        lo = mid - minSpan / 2;
        hi = mid + minSpan / 2;
    }
    const span = hi - lo;
    return { lo, hi, y: (v: number) => PAD.top + ((hi - v) / span) * (CH - PAD.top - PAD.bottom) };
}

/** Empty string when there is nothing to draw (no directional games). */
export function renderTeamChartSvg(series: TeamSeriesPoint[], display: string): string {
    const pts = series.filter((p) => p.occurredAt && Number.isFinite(Date.parse(p.occurredAt)));
    if (pts.length === 0) return '';

    const times = pts.map((p) => Date.parse(p.occurredAt));
    const t0 = Math.min(...times);
    const t1 = Math.max(...times);
    // A single game still needs a span to draw across; give it a day either side.
    const DAY = 86_400_000;
    const start = t1 - t0 < DAY ? t0 - DAY : t0;
    const end = t1 - t0 < DAY ? t1 + DAY : t1;
    const x = (t: number) => PAD.left + ((t - start) / (end - start)) * (CW - PAD.left - PAD.right);

    // The series starts at the anchor (0) just before the first game.
    const values = [0, ...pts.map((p) => p.cumulative)];
    const V = scaleFor(values, MIN_SPAN);
    const last = pts[pts.length - 1].cumulative;
    const sign = signOf(last);
    const rgb = NEON_RGB[sign];
    const stroke = `rgb(${rgb})`;

    const linePts: Array<[number, number]> = [[x(start), V.y(0)], ...pts.map((p, i) => [x(times[i]), V.y(p.cumulative)] as [number, number])];
    const path = linePts.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' ');
    const areaPath = `${path} ${x(times[times.length - 1]).toFixed(1)},${V.y(0).toFixed(1)} ${x(start).toFixed(1)},${V.y(0).toFixed(1)}`;

    const gridVals = [V.hi, (V.hi + V.lo) / 2, V.lo];
    const grid = gridVals.map((v) => {
        const y = V.y(v).toFixed(1);
        return `<line x1="${PAD.left}" x2="${CW - PAD.right}" y1="${y}" y2="${y}" stroke="rgba(255,255,255,0.08)"/>`
            + `<text class="hc-tq-ylabel" x="${PAD.left - 6}" y="${(Number(y) + 3.5).toFixed(1)}" text-anchor="end">${escapeHtml(signedResidual(v))}</text>`;
    }).join('');

    const zeroY = V.y(0).toFixed(1);
    const anchor = `<line x1="${PAD.left}" x2="${CW - PAD.right}" y1="${zeroY}" y2="${zeroY}" stroke="rgba(255,255,255,0.3)" stroke-dasharray="5 5"/>`;

    const n = Math.min(4, Math.max(1, pts.length));
    const ticks = Array.from({ length: n + 1 }, (_, i) => start + ((end - start) * i) / n).map((t, i) => {
        const anchorAttr = i === 0 ? 'start' : i === n ? 'end' : 'middle';
        return `<text class="hc-tq-tick" x="${x(t).toFixed(1)}" y="${CH - 8}" text-anchor="${anchorAttr}">${escapeHtml(shortDate(new Date(t).toISOString()))}</text>`;
    }).join('');

    const dots = pts.map((p, i) => {
        const title = `${shortDate(p.occurredAt)} · ${signedResidual(p.delta)} (running ${signedResidual(p.cumulative)})`;
        return `<circle cx="${x(times[i]).toFixed(1)}" cy="${V.y(p.cumulative).toFixed(1)}" r="3.5" fill="${stroke}" stroke="#160c27" stroke-width="1"><title>${escapeHtml(title)}</title></circle>`;
    }).join('');

    const summary = `${display}: market residual ${signedResidual(last)} over ${pts.length} directional game${pts.length === 1 ? '' : 's'}`;

    return `<svg class="hc-tq-svg" viewBox="0 0 ${CW} ${CH}" role="img" aria-label="${escapeHtml(summary)}">`
        + `<title>${escapeHtml(summary)}</title>`
        + `<defs><linearGradient id="hc-team-grad-${sign}" x1="0" x2="0" y1="0" y2="1">`
        + `<stop offset="0" stop-color="${stroke}" stop-opacity="0.35"/><stop offset="1" stop-color="${stroke}" stop-opacity="0"/>`
        + `</linearGradient></defs>`
        + grid + anchor
        + `<polygon points="${areaPath}" fill="url(#hc-team-grad-${sign})"/>`
        + `<polyline points="${path}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`
        + dots + ticks
        + `</svg>`;
}
