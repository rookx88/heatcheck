// POST /api/ops/job-report - the cron Workers report every job they just called, once
// per chain (pre-launch Audit 4). Accepts X-Settle-Secret (worker-settle) or
// X-Curate-Secret (worker-curate), the same two trust domains the jobs themselves use.
//
// Body: { trigger: string, runs: [{ job, target, ok, status, durationMs, errors, summary }] }
// The Worker classifies ok/errors itself because it holds the response body - a job that
// answers 200 with errors inside (curation's group_error, a sweep's errors > 0) is a
// failure here even though HTTP says it succeeded.
//
// A failed settlement or index settlement alerts immediately - those touch paid-out
// Ember and daily index closes, and shouldn't wait for the hourly check. Everything
// else is picked up by /api/ops/health-check within the hour.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { secretMatches } from '../../../lib/pages-functions/secret-compare';
import { raiseAlert } from '../../../lib/pages-functions/alerts';

const URGENT_JOBS = new Set(['settle', 'index-settle']);
const MAX_RUNS = 40;
const MAX_SUMMARY_CHARS = 4000;

interface RunIn { job: unknown; target: unknown; ok: unknown; status: unknown; durationMs: unknown; errors: unknown; summary: unknown }

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const [settleOk, curateOk] = await Promise.all([
        secretMatches(context.request.headers.get('X-Settle-Secret'), context.env.SETTLE_SECRET),
        secretMatches(context.request.headers.get('X-Curate-Secret'), context.env.CURATE_SECRET),
    ]);
    if (!settleOk && !curateOk) return jsonResponse({ message: 'Unauthorized' }, { status: 401 });

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400 });
    }
    const trigger = typeof body?.trigger === 'string' ? body.trigger.slice(0, 40) : 'unknown';
    const runs: RunIn[] = Array.isArray(body?.runs) ? body.runs.slice(0, MAX_RUNS) : [];
    if (runs.length === 0) return jsonResponse({ message: 'No runs.' }, { status: 400 });

    const sql = getSql(context.env);
    const failedUrgent: string[] = [];
    // Validate every run first, then write them in ONE multi-row insert (the unnest
    // shape index-settle.ts already uses for its bulk writes). A chain reports up to
    // MAX_RUNS rows and paid a Neon round trip each (efficiency audit, 2026-09-19).
    const jobs: string[] = [], targets: string[] = [], oks: boolean[] = [];
    const statuses: Array<number | null> = [], durations: Array<number | null> = [];
    const errorCounts: number[] = [], summaries: string[] = [];
    for (const r of runs) {
        const job = typeof r.job === 'string' ? r.job.slice(0, 80) : '';
        if (!job) continue;
        const target = r.target === 'production' ? 'production' : 'preview';
        const ok = r.ok === true;
        const status = Number.isInteger(r.status) ? (r.status as number) : null;
        const errors = Number.isInteger(r.errors) ? Math.max(0, r.errors as number) : 0;
        let summary = JSON.stringify(r.summary ?? {});
        if (summary.length > MAX_SUMMARY_CHARS) summary = JSON.stringify({ truncated: summary.slice(0, MAX_SUMMARY_CHARS) });
        jobs.push(job); targets.push(target); oks.push(ok);
        statuses.push(status);
        durations.push(Number.isInteger(r.durationMs) ? (r.durationMs as number) : null);
        errorCounts.push(errors); summaries.push(summary);
        if (!ok && URGENT_JOBS.has(job)) failedUrgent.push(`${job} (${target}): HTTP ${status ?? 'no response'}, ${errors} error(s)\n${summary.slice(0, 1500)}`);
    }
    let recorded = 0;
    if (jobs.length > 0) {
        await sql`
            INSERT INTO ops_job_runs (job, trigger, target, ok, status, duration_ms, errors, summary)
            SELECT * FROM unnest(
                ${jobs}::text[], ${jobs.map(() => trigger)}::text[],
                ${targets}::text[], ${oks}::boolean[], ${statuses}::int[], ${durations}::int[],
                ${errorCounts}::int[], ${summaries}::jsonb[]
            )
        `;
        recorded = jobs.length;
    }

    if (failedUrgent.length) {
        await raiseAlert(sql, context.env, `urgent:${trigger}`, `SETTLEMENT FAILURE in the ${trigger} run`,
            failedUrgent.join('\n\n') + '\n\nFull bodies: ops_job_runs, and the cron Worker logs in the Cloudflare dashboard.');
    }
    return jsonResponse({ recorded, urgentAlerts: failedUrgent.length });
};
