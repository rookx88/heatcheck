// Minimal cron trigger for Ember settlement. Cloudflare Pages Functions can't run cron,
// only a real Worker can - this Worker exists purely to fire on a schedule and call the
// deployed /api/settle endpoint over HTTP. All settlement logic lives there
// (functions/api/settle.ts), not here, so it stays testable and reusable independent of
// the cron - this file has no DB dependency at all.
//
// Fires at BOTH SETTLE_URL (production) and PREVIEW_SETTLE_URL (auth-sessions preview) -
// see wrangler.toml's comment for why preview needs its own settle: it's currently the
// only place the ticker tag/settle pipeline runs on a real schedule at all. The two
// calls are independent (one failing/erroring never blocks or masks the other), same
// posture as worker-curate's sibling sweep calls.
//
// Also fires the Discord settlement-announcement sweep (/api/discord-settlement-sweep)
// and the Community Pick resolution sweep (/api/community-pick-settlement-sweep) as
// sibling calls right after each settle call, same "own request, own budget, runs
// regardless of the earlier step's outcome" posture worker-curate's sweep chain uses -
// both depend on settlement/resolution having just run, which only happens on THIS
// cron, not worker-curate's, so neither can live there instead.

export interface Env {
    SETTLE_URL: string;
    PREVIEW_SETTLE_URL?: string;
    SETTLE_SECRET: string;
}

async function callWithSecret(label: string, url: string, secret: string, header: string): Promise<string> {
    try {
        const res = await fetch(url, {
            method: 'POST',
            headers: { [header]: secret },
        });
        const text = await res.text();
        if (!res.ok) {
            console.error(`[worker-settle] ${label} (${url}) returned ${res.status}: ${text}`);
        } else {
            console.log(`[worker-settle] ${label} run complete: ${text}`);
        }
        return text;
    } catch (err) {
        console.error(`[worker-settle] ${label} (${url}) call failed:`, err);
        return '';
    }
}

async function callSettle(label: string, url: string, secret: string): Promise<string> {
    return callWithSecret(label, url, secret, 'X-Settle-Secret');
}

async function callSiblingSweep(name: string, path: string, label: string, settleUrl: string, secret: string): Promise<string> {
    const url = new URL(path, settleUrl).toString();
    return callWithSecret(`${label} ${name}`, url, secret, 'X-Settle-Secret');
}

async function runSettle(env: Env): Promise<string> {
    const live = await callSettle('production', env.SETTLE_URL, env.SETTLE_SECRET);
    const liveDiscord = await callSiblingSweep('discord-settlement-sweep', '/api/discord-settlement-sweep', 'production', env.SETTLE_URL, env.SETTLE_SECRET);
    const liveCommunityPicks = await callSiblingSweep('community-pick-settlement-sweep', '/api/community-pick-settlement-sweep', 'production', env.SETTLE_URL, env.SETTLE_SECRET);

    let preview = '';
    let previewDiscord = '';
    let previewCommunityPicks = '';
    if (env.PREVIEW_SETTLE_URL) {
        preview = await callSettle('preview', env.PREVIEW_SETTLE_URL, env.SETTLE_SECRET);
        previewDiscord = await callSiblingSweep('discord-settlement-sweep', '/api/discord-settlement-sweep', 'preview', env.PREVIEW_SETTLE_URL, env.SETTLE_SECRET);
        previewCommunityPicks = await callSiblingSweep('community-pick-settlement-sweep', '/api/community-pick-settlement-sweep', 'preview', env.PREVIEW_SETTLE_URL, env.SETTLE_SECRET);
    }

    return JSON.stringify({
        production: live, productionDiscordSweep: liveDiscord, productionCommunityPickSweep: liveCommunityPicks,
        preview, previewDiscordSweep: previewDiscord, previewCommunityPickSweep: previewCommunityPicks,
    });
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
