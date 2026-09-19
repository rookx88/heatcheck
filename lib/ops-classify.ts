// Shared by worker-settle and worker-curate (bundled into each at deploy): decides whether
// one scheduled-job call succeeded, from its HTTP status AND its body. Pre-launch Audit 4:
// most of these endpoints catch their own failures and answer 200 with the damage inside
// the body (curation's group_error, a sweep's `errors: 3`, settle's per-pick 'error'
// results), so a green HTTP status alone is how a job fails silently for days - the
// 2026-09-09 curation outage looked exactly like that. Dependency-free on purpose.

export interface JobRun {
    job: string;
    target: 'preview' | 'production';
    ok: boolean;
    status: number | null;
    durationMs: number;
    errors: number;
    summary: unknown;
}

const BAD_RESULT_STATUSES = new Set(['error', 'outcome_order_mismatch']);

function countBadResults(list: unknown): number {
    if (!Array.isArray(list)) return 0;
    return list.filter((r: any) => {
        const s = typeof r?.status === 'string' ? r.status : '';
        return BAD_RESULT_STATUSES.has(s) || s.startsWith('group_error');
    }).length;
}

export function countBodyErrors(body: any): number {
    if (!body || typeof body !== 'object') return 0;
    let n = 0;
    if (typeof body.errors === 'number') n += body.errors;
    else if (Array.isArray(body.errors)) n += body.errors.length;
    if (Array.isArray(body.failures)) n += body.failures.length;
    n += countBadResults(body.results);
    n += countBadResults(body.tickerResults);
    if (Array.isArray(body.groups)) for (const g of body.groups) n += countBadResults(g?.results);
    return n;
}

export function classifyRun(job: string, target: JobRun['target'], status: number | null, text: string, durationMs: number): JobRun {
    // Threw before any response (network, timeout).
    if (status === null) return { job, target, ok: false, status, durationMs, errors: 1, summary: { error: text.slice(0, 500) } };
    // worker-settle still calls sweeps on production that only exist on the preview
    // branch until the port; 405 there means "not deployed yet", not a failure.
    if (status === 405 && target === 'production') {
        return { job, target, ok: true, status, durationMs, errors: 0, summary: { notDeployed: true } };
    }
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* non-JSON */ }
    let errors = countBodyErrors(body);
    if (!body && text.includes('group_error')) errors += 1;
    const ok = status >= 200 && status < 300 && errors === 0;
    // Keep the whole body when something went wrong (it's the evidence); otherwise only
    // enough to read counts at a glance.
    const summary = ok
        ? (text.length <= 600 ? (body ?? text) : { truncated: text.slice(0, 600) })
        : { body: text.slice(0, 3000) };
    return { job, target, ok, status, durationMs, errors: ok ? 0 : Math.max(errors, 1), summary };
}
