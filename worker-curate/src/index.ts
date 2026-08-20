// Minimal cron trigger for the automated Tank trend-curator. Mirrors worker-settle/'s
// shape exactly: this Worker exists purely to fire on a schedule and call the deployed
// /api/curate endpoint over HTTP. All curation logic lives there
// (functions/api/curate.ts), not here - this file has no DB or Anthropic dependency at
// all.

export interface Env {
    CURATE_URL: string;
    CURATE_SECRET: string;
}

async function runCurate(env: Env): Promise<string> {
    const res = await fetch(env.CURATE_URL, {
        method: 'POST',
        headers: { 'X-Curate-Secret': env.CURATE_SECRET },
    });
    const text = await res.text();
    if (!res.ok) {
        console.error(`[worker-curate] /api/curate returned ${res.status}: ${text}`);
    } else {
        console.log(`[worker-curate] curate run complete: ${text}`);
    }

    // Exchange ticker tag sweep - a SEPARATE request on purpose: each Pages Function
    // invocation has its own subrequest budget, and curation's traffic already runs
    // close to it (see functions/api/ticker-sweep.ts). Same secret, sibling path.
    // Runs even when curation errored: the sweep is the catch-all for untagged
    // published Tanks and doesn't depend on curation having succeeded.
    const sweepText = await postSibling(env, '/api/ticker-sweep');

    // Daily notification sweep (pet-hungry + new-Tanks digest) - same posture: own
    // request, own budget, runs regardless of the earlier steps' outcomes.
    const notifyText = await postSibling(env, '/api/notify-sweep');

    return JSON.stringify({ curate: text, tickerSweep: sweepText, notifySweep: notifyText });
}

async function postSibling(env: Env, path: string): Promise<string> {
    try {
        const url = new URL(path, env.CURATE_URL).toString();
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'X-Curate-Secret': env.CURATE_SECRET },
        });
        const text = await res.text();
        if (!res.ok) {
            console.error(`[worker-curate] ${path} returned ${res.status}: ${text}`);
        } else {
            console.log(`[worker-curate] ${path} complete: ${text}`);
        }
        return text;
    } catch (err) {
        console.error(`[worker-curate] ${path} call failed:`, err);
        return '';
    }
}

export default {
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(runCurate(env));
    },

    // Manual-trigger shortcut for testing without waiting for the cron, e.g.
    // `curl https://<worker>.workers.dev/`. Guarded only by whatever the target
    // /api/curate endpoint itself enforces (X-Curate-Secret) - this Worker holds no
    // separate auth of its own.
    async fetch(_req: Request, env: Env): Promise<Response> {
        const text = await runCurate(env);
        return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    },
};
