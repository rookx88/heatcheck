// Minimal cron trigger for Ember settlement. Cloudflare Pages Functions can't run cron,
// only a real Worker can - this Worker exists purely to fire on a schedule and call the
// deployed /api/settle endpoint over HTTP. All settlement logic lives there
// (functions/api/settle.ts), not here, so it stays testable and reusable independent of
// the cron - this file has no DB dependency at all.
//
// Fires at BOTH PREVIEW_SETTLE_URL (auth-sessions preview) and SETTLE_URL (production),
// IN THAT ORDER - see runSettle()'s comment for why preview must go first (shared DB;
// preview carries the hardened settle code, production is stale main until promotion)
// and wrangler.toml's comment for why preview needs its own settle at all. The two
// calls are independent (one failing/erroring never blocks or masks the other), same
// posture as worker-curate's sibling sweep calls.
//
// Preview also fires /api/tank-resolution-sweep last in its chain - the Stage 3 Tank
// resolution callback, which is the only sibling here that spends Anthropic credits.
//
// Also fires the Discord settlement-announcement sweep (/api/discord-settlement-sweep)
// and the Community Pick resolution sweep (/api/community-pick-settlement-sweep) as
// sibling calls right after each settle call, same "own request, own budget, runs
// regardless of the earlier step's outcome" posture worker-curate's sweep chain uses -
// both depend on settlement/resolution having just run, which only happens on THIS
// cron, not worker-curate's, so neither can live there instead.
//
// Observability (pre-launch Audit 4): every call is timed and classified from its status
// AND body (lib/ops-classify.ts - a 200 carrying errors is a failure), the whole chain is
// reported to /api/ops/job-report, and the run pings Healthchecks.io (with /fail when
// anything failed) so a chain that errors - or never runs at all - emails the founder.
// The hourly slot runs only /api/ops/health-check: the standing ledger-invariant, job
// freshness, security-burst and daily-summary check.

import { classifyRun, type JobRun } from '../../lib/ops-classify';

export interface Env {
    SETTLE_URL: string;
    PREVIEW_SETTLE_URL?: string;
    SETTLE_SECRET: string;
    // Healthchecks.io ping URLs (secrets). Optional - unset means that ping is skipped.
    HC_PING_SETTLE?: string;
    HC_PING_OPS?: string;
}

const SETTLE_CRON = '0 9 * * *';
const OPS_CRON = '0 * * * *';

class Chain {
    runs: JobRun[] = [];
    constructor(private secret: string) {}

    async call(job: string, target: JobRun['target'], url: string): Promise<string> {
        const started = Date.now();
        try {
            const res = await fetch(url, { method: 'POST', headers: { 'X-Settle-Secret': this.secret } });
            const text = await res.text();
            if (!res.ok) {
                console.error(`[worker-settle] ${target} ${job} (${url}) returned ${res.status}: ${text}`);
            } else {
                console.log(`[worker-settle] ${target} ${job} run complete: ${text}`);
            }
            this.runs.push(classifyRun(job, target, res.status, text, Date.now() - started));
            return text;
        } catch (err) {
            console.error(`[worker-settle] ${target} ${job} (${url}) call failed:`, err);
            this.runs.push(classifyRun(job, target, null, String(err), Date.now() - started));
            return '';
        }
    }

    sibling(job: string, target: JobRun['target'], settleUrl: string): Promise<string> {
        return this.call(job, target, new URL(`/api/${job}`, settleUrl).toString());
    }

    get failed(): JobRun[] {
        return this.runs.filter((r) => !r.ok);
    }
}

// Reports the chain to the preview's /api/ops/job-report (the ops endpoints only exist
// on the preview branch until the port) and pings Healthchecks. Both best-effort: a
// failure to report must never look like - or cause - a settlement failure.
async function report(env: Env, trigger: string, chain: Chain, pingUrl: string | undefined): Promise<void> {
    const opsBase = env.PREVIEW_SETTLE_URL ?? env.SETTLE_URL;
    try {
        const res = await fetch(new URL('/api/ops/job-report', opsBase).toString(), {
            method: 'POST',
            headers: { 'X-Settle-Secret': env.SETTLE_SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger, runs: chain.runs }),
        });
        if (!res.ok) console.error(`[worker-settle] job-report returned ${res.status}: ${await res.text()}`);
    } catch (err) {
        console.error('[worker-settle] job-report failed:', err);
    }
    await ping(pingUrl, chain.failed.length > 0, chain.failed.map((r) => `${r.target} ${r.job}: ${r.status}`).join('\n'));
}

async function ping(pingUrl: string | undefined, fail: boolean, body = ''): Promise<void> {
    if (!pingUrl) return;
    try {
        await fetch(fail ? `${pingUrl.replace(/\/$/, '')}/fail` : pingUrl, { method: 'POST', body: body.slice(0, 10000) });
    } catch (err) {
        console.error('[worker-settle] healthchecks ping failed:', err);
    }
}

async function runSettle(env: Env): Promise<string> {
    // Preview FIRST, production second - deliberate, not cosmetic (2026-08-27). Both
    // targets share the same Neon DB, so whichever /api/settle runs first claims every
    // pending pick. Preview (auth-sessions) carries the hardened settle code - the
    // outcome-order-mismatch guard, Kalshi resolution, ticker-tag settlement, the
    // side/matchup email copy - while production is stale main without any of that.
    // Running preview first means the guarded code settles everything and production's
    // pass is a redundant no-op fallback (kept in case the preview deploy ever breaks).
    // At promotion this ordering stops mattering and PREVIEW_SETTLE_URL goes away.
    const chain = new Chain(env.SETTLE_SECRET);
    if (env.PREVIEW_SETTLE_URL) {
        const p = env.PREVIEW_SETTLE_URL;
        await chain.call('settle', 'preview', p);
        await chain.sibling('discord-settlement-sweep', 'preview', p);
        await chain.sibling('community-pick-settlement-sweep', 'preview', p);
        await chain.sibling('pvp-settlement-sweep', 'preview', p);
        // Exchange slate settlement: scores each index's locked positions against the
        // real results and writes the day's close per index. Preview-only for the same
        // reason as the rest of this block - only preview carries the slate code.
        await chain.sibling('index-settle', 'preview', p);
        // Tank resolution callbacks (Stage 3): writes "what was claimed vs. what
        // happened" onto settled Tanks, which the next static build renders at the foot
        // of the article. Preview-only for the same reason as index-settle above.
        //
        // Runs LAST in the preview chain: it is the only step here that spends Anthropic
        // credits, and nothing else depends on it, so if the invocation is going to run
        // out of room it should be the thing that misses a day - never settlement itself.
        await chain.sibling('tank-resolution-sweep', 'preview', p);
    }

    await chain.call('settle', 'production', env.SETTLE_URL);
    await chain.sibling('discord-settlement-sweep', 'production', env.SETTLE_URL);
    await chain.sibling('community-pick-settlement-sweep', 'production', env.SETTLE_URL);
    // PvP rides this same cron rather than getting its own trigger.
    await chain.sibling('pvp-settlement-sweep', 'production', env.SETTLE_URL);

    await report(env, SETTLE_CRON, chain, env.HC_PING_SETTLE);
    return JSON.stringify(chain.runs.map((r) => ({ job: r.job, target: r.target, ok: r.ok, status: r.status, errors: r.errors })));
}

// The hourly standing check. Its own ping: if this stops arriving, Healthchecks emails -
// which covers the case where the Worker, Pages or the database is down entirely.
async function runOpsCheck(env: Env): Promise<string> {
    const opsBase = env.PREVIEW_SETTLE_URL ?? env.SETTLE_URL;
    try {
        const res = await fetch(new URL('/api/ops/health-check', opsBase).toString(), {
            method: 'POST', headers: { 'X-Settle-Secret': env.SETTLE_SECRET },
        });
        const text = await res.text();
        let ok = res.ok;
        try { ok = ok && JSON.parse(text)?.ok === true; } catch { ok = false; }
        if (!res.ok) console.error(`[worker-settle] ops health-check returned ${res.status}: ${text}`);
        else console.log(`[worker-settle] ops health-check: ${text}`);
        await ping(env.HC_PING_OPS, !ok, text);
        return text;
    } catch (err) {
        console.error('[worker-settle] ops health-check call failed:', err);
        await ping(env.HC_PING_OPS, true, String(err));
        return '';
    }
}

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        if (event.cron === OPS_CRON) {
            ctx.waitUntil(runOpsCheck(env));
        } else {
            ctx.waitUntil(runSettle(env));
        }
    },

    // Manual-trigger shortcut for testing without waiting for the cron:
    //   curl -H "X-Trigger-Secret: $SETTLE_SECRET" https://<worker>.workers.dev/
    //   curl -H "X-Trigger-Secret: $SETTLE_SECRET" https://<worker>.workers.dev/?ops=1   (health check only)
    // Requires the same secret this Worker already holds. Before this it was open to
    // anyone with the workers.dev URL (launch audit, 2026-09-07): every target endpoint
    // is idempotent, but a stranger could still burn the whole chain's subrequests,
    // Resend sends and Neon time on demand.
    async fetch(req: Request, env: Env): Promise<Response> {
        const provided = req.headers.get('X-Trigger-Secret');
        if (!env.SETTLE_SECRET || provided !== env.SETTLE_SECRET) {
            return new Response(null, { status: 401 });
        }
        const text = new URL(req.url).searchParams.get('ops') ? await runOpsCheck(env) : await runSettle(env);
        return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    },
};
