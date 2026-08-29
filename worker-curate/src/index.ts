// Minimal cron trigger for the automated Tank trend-curator. Mirrors worker-settle/'s
// shape exactly: this Worker exists purely to fire on a schedule and call the deployed
// /api/curate endpoint over HTTP. All curation logic lives there
// (functions/api/curate.ts), not here - this file has no DB or Anthropic dependency at
// all.
//
// Three cadences (2026-08-26, see wrangler.toml's [triggers] comment for the full
// rationale): the original once-daily slot ("0 10 * * *") runs the FULL chain below,
// the twice-daily sweep slots run ONLY runSweeps() - never /api/curate, since that's
// the one step here that spends real Anthropic API credits every time it fires - and
// the weekly Tuesday slot runs ONLY the NFL league auto-slate.

export interface Env {
    CURATE_URL: string;
    CURATE_SECRET: string;
}

// The one slot allowed to spend Anthropic credits - see the event.cron branch in
// scheduled() below. Every other configured cron slot runs sweeps only.
const FULL_CHAIN_CRON = '0 10 * * *';

// Weekly NFL league auto-slate (Tuesday, after Monday Night Football concludes and
// the week's lines settle) - see the event.cron branch in scheduled() below. Neither
// the full chain nor the regular sweeps; its own third case.
const LEAGUE_SLATE_CRON = '0 12 * * 2';

// Weekly leaderboard auto-post (Sunday evening, after US slates wrap) for guilds
// that opted in via the setup wizard - its own fourth case below.
const WEEKLY_LEADERBOARD_CRON = '0 23 * * 0';

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

    const sweeps = await runSweeps(env);
    return JSON.stringify({ curate: text, ...sweeps });
}

// The three free, idempotent housekeeping sweeps - none call Anthropic, all are safe to
// re-run any number of times in a day (see each endpoint's own header comment). Split
// out so the more-frequent cron slots can fire these without ever touching /api/curate.
async function runSweeps(env: Env): Promise<{ tickerSweep: string; notifySweep: string; discordSweep: string }> {
    // Exchange ticker tag sweep - a SEPARATE request on purpose: each Pages Function
    // invocation has its own subrequest budget, and curation's traffic already runs
    // close to it (see functions/api/ticker-sweep.ts). Same secret, sibling path.
    // Runs even when curation errored/didn't run this cycle: the sweep is the catch-all
    // for untagged published Tanks and doesn't depend on curation having succeeded.
    const tickerSweep = await postSibling(env, '/api/ticker-sweep');

    // Notification sweep (pet-hungry + new-Tanks digest) - same posture: own request,
    // own budget, runs regardless of the earlier steps' outcomes.
    const notifySweep = await postSibling(env, '/api/notify-sweep');

    // Post newly-published Tanks to Discord - same posture again: own request, own
    // budget, runs regardless of the earlier steps' outcomes.
    const discordSweep = await postSibling(env, '/api/discord-sweep');

    return { tickerSweep, notifySweep, discordSweep };
}

// Weekly NFL season-league auto-slate: creates a Community Pick per live NFL
// moneyline market for every guild with an active league_seasons row. Own request,
// same X-Curate-Secret trust domain as the other sweeps - see
// functions/api/league-slate-sweep.ts.
async function runLeagueSlateSweep(env: Env): Promise<string> {
    return postSibling(env, '/api/league-slate-sweep');
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
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        // event.cron tells us which configured schedule actually fired (wrangler.toml
        // can list several sharing this one handler). Only FULL_CHAIN_CRON is allowed
        // to reach /api/curate; every other slot is sweeps-only by construction, so a
        // new cron slot added to wrangler.toml without updating this check safely
        // defaults to sweeps-only rather than accidentally spending Anthropic credits.
        if (event.cron === FULL_CHAIN_CRON) {
            ctx.waitUntil(runCurate(env));
        } else if (event.cron === LEAGUE_SLATE_CRON) {
            ctx.waitUntil(runLeagueSlateSweep(env));
        } else if (event.cron === WEEKLY_LEADERBOARD_CRON) {
            ctx.waitUntil(postSibling(env, '/api/weekly-leaderboard-sweep'));
        } else {
            ctx.waitUntil(runSweeps(env));
        }
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
