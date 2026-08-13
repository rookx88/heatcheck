// Minimal cron trigger for Ember settlement. Cloudflare Pages Functions can't run cron,
// only a real Worker can - this Worker exists purely to fire on a schedule and call the
// deployed /api/settle endpoint over HTTP. All settlement logic lives there
// (functions/api/settle.ts), not here, so it stays testable and reusable independent of
// the cron - this file has no DB dependency at all.

export interface Env {
    SETTLE_URL: string;
    SETTLE_SECRET: string;
}

async function runSettle(env: Env): Promise<string> {
    const res = await fetch(env.SETTLE_URL, {
        method: 'POST',
        headers: { 'X-Settle-Secret': env.SETTLE_SECRET },
    });
    const text = await res.text();
    if (!res.ok) {
        console.error(`[worker-settle] /api/settle returned ${res.status}: ${text}`);
    } else {
        console.log(`[worker-settle] settle run complete: ${text}`);
    }
    return text;
}

export default {
    async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        ctx.waitUntil(runSettle(env));
    },

    // Manual-trigger shortcut for testing without waiting for the cron, e.g.
    // `curl https://<worker>.workers.dev/`. Guarded only by whatever the target
    // /api/settle endpoint itself enforces (X-Settle-Secret) - this Worker holds no
    // separate auth of its own.
    async fetch(_req: Request, env: Env): Promise<Response> {
        const text = await runSettle(env);
        return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    },
};
