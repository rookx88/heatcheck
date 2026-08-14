// Plain Date-math ISO week key ('2026-W34') - deliberately dependency-free and runtime-
// agnostic (no Node-only APIs) so it can be imported from both backend.ts (Node/Express)
// and Cloudflare Pages Functions (Workers runtime) without any compat flag.

export function getISOWeekKey(date: Date): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const dayNum = d.getUTCDay() || 7; // Monday=1 .. Sunday=7
    d.setUTCDate(d.getUTCDate() + 4 - dayNum); // move to this week's Thursday
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
    return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}
