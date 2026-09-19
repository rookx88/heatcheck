// Minimal cron trigger for the automated Tank trend-curator. Mirrors worker-settle/'s
// shape exactly: this Worker exists purely to fire on a schedule and call the deployed
// curation endpoints over HTTP. All curation logic lives there
// (functions/api/curate.ts), not here - this file has no DB or Anthropic dependency at
// all.
//
// As of the v2 curation pass this fires /api/curate-sport once per sport group rather
// than /api/curate once for all four - see runCurate() below for why (subrequest budget,
// and why the calls must stay sequential). /api/curate still exists and still runs every
// group in one request; it's just no longer what the cron uses.
//
// Three cadences (2026-08-26, see wrangler.toml's [triggers] comment for the full
// rationale): the original once-daily slot ("0 10 * * *") runs the FULL chain below,
// the twice-daily sweep slots run ONLY runSweeps() - never /api/curate, since that's
// the one step here that spends real Anthropic API credits every time it fires - and
// the weekly Tuesday slot runs ONLY the NFL league auto-slate.

import { classifyRun, type JobRun } from '../../lib/ops-classify';

export interface Env {
    CURATE_URL: string;
    CURATE_SECRET: string;
    // Healthchecks.io ping URL per cron slot (secrets; optional - unset skips the ping).
    // Pre-launch Audit 4: each slot pings when its chain finishes (with /fail if any job
    // in it failed), and Healthchecks emails the founder if a ping is late or failed.
    HC_PING_CURATE_10?: string;
    HC_PING_SWEEPS_18?: string;
    HC_PING_SWEEPS_02?: string;
    HC_PING_LEAGUE?: string;
}

// Every call in one cron run, classified from status AND body (lib/ops-classify.ts): a
// 200 with group_error or errors > 0 inside is a failure. Reported to
// /api/ops/job-report at the end of the run - the hourly health check alerts on a job
// that failed or stopped running.
type Runs = JobRun[];

async function reportRun(env: Env, trigger: string, runs: Runs, pingUrl: string | undefined): Promise<void> {
    try {
        const res = await fetch(new URL('/api/ops/job-report', env.CURATE_URL).toString(), {
            method: 'POST',
            headers: { 'X-Curate-Secret': env.CURATE_SECRET, 'Content-Type': 'application/json' },
            body: JSON.stringify({ trigger, runs }),
        });
        if (!res.ok) console.error(`[worker-curate] job-report returned ${res.status}: ${await res.text()}`);
    } catch (err) {
        console.error('[worker-curate] job-report failed:', err);
    }
    if (!pingUrl) return;
    const failed = runs.filter((r) => !r.ok);
    try {
        await fetch(failed.length ? `${pingUrl.replace(/\/$/, '')}/fail` : pingUrl, {
            method: 'POST', body: failed.map((r) => `${r.job}: ${r.status} (${r.errors} errors)`).join('\n').slice(0, 10000),
        });
    } catch (err) {
        console.error('[worker-curate] healthchecks ping failed:', err);
    }
}

// The one slot allowed to spend Anthropic credits - see the event.cron branch in
// scheduled() below. Every other configured cron slot runs sweeps only.
const FULL_CHAIN_CRON = '0 10 * * *';

// Weekly NFL league auto-slate (Tuesday, after Monday Night Football concludes and
// the week's lines settle) - see the event.cron branch in scheduled() below. Neither
// the full chain nor the regular sweeps; its own third case.
const LEAGUE_SLATE_CRON = '0 12 * * 2';

// Weekly leaderboard auto-post for guilds that opted in via the setup wizard. No
// cron slot of its own - Workers Free caps the ACCOUNT at 5 triggers and they're all
// spent (see wrangler.toml) - so it piggybacks on the existing 02:00 UTC sweep slot,
// firing only when that slot lands on Monday UTC (= Sunday ~9-10pm US evening,
// right after Sunday slates wrap).
const NIGHTLY_SWEEP_CRON = '0 2 * * *';
const WEEKLY_LEADERBOARD_UTC_DAY = 1; // Monday

// The sport groups curated per run, one HTTP request each. Must match the keys of
// SPORT_GROUPS in functions/api/curate.ts - an unknown name is a 400 from
// /api/curate-sport, deliberately, rather than silently curating nothing.
const SPORT_GROUPS = ['Soccer', 'Basketball', 'Baseball', 'Football'] as const;

// One request PER SPORT against /api/curate-sport, not one combined /api/curate call.
// Each Pages Function invocation gets its own 50-subrequest budget (Cloudflare Free),
// and v2 curation - seven search categories, a verification call per match, then
// generation - does not fit four sports into one. Splitting also means one sport's
// failure costs only that sport.
//
// SEQUENTIAL, NOT Promise.all - two concrete hazards, both silent if you parallelize:
//   1. Slug races. Each request builds its own `existingSlugs` set from its own snapshot
//      of tank_pages, so two concurrent runs can mint the same slug and the second INSERT
//      dies on idx_tank_pages_slug - inside a try/catch, reported only as 'error'.
//   2. The Gamma throttle in polymarket.ts is a module-level `lastRequestAt`, which is
//      per-isolate and does not coordinate across concurrent invocations. Parallel sports
//      would burst Gamma and spend the budget on 429 retries.
//
// NO RETRIES on failure, deliberately: a timeout means "unknown", not "didn't happen" -
// the request may well have created drafts before the caller gave up, and re-running
// would duplicate them. The 7-day dedupe covers most of it, but "most" isn't a guarantee.
// A missed sport waits for tomorrow.
async function runCurate(env: Env, runs: Runs): Promise<string> {
    const perSport: Record<string, string> = {};

    for (const sport of SPORT_GROUPS) {
        const startedAt = Date.now();
        try {
            const url = new URL(`/api/curate-sport?sport=${encodeURIComponent(sport)}`, env.CURATE_URL).toString();
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'X-Curate-Secret': env.CURATE_SECRET },
            });
            const text = await res.text();
            const elapsed = Date.now() - startedAt;
            if (!res.ok) {
                console.error(`[worker-curate] curate ${sport} returned ${res.status} after ${elapsed}ms: ${text}`);
            } else {
                // Wall-clock per sport is logged because the edge cuts a request off at
                // roughly 100s without response headers, and a search-heavy sport plus a
                // verify call per match is the run most likely to approach it. Watching
                // this number is how that gets caught before it starts truncating runs.
                console.log(`[worker-curate] curate ${sport} complete in ${elapsed}ms: ${text}`);
            }
            runs.push(classifyRun(`curate-sport:${sport}`, 'preview', res.status, text, elapsed));
            perSport[sport] = text;
        } catch (err) {
            console.error(`[worker-curate] curate ${sport} call failed:`, err);
            runs.push(classifyRun(`curate-sport:${sport}`, 'preview', null, String(err), Date.now() - startedAt));
            perSport[sport] = '';
        }
    }

    const sweeps = await runSweeps(env, runs);
    return JSON.stringify({ curate: perSport, ...sweeps });
}

// The three free, idempotent housekeeping sweeps - none call Anthropic, all are safe to
// re-run any number of times in a day (see each endpoint's own header comment). Split
// out so the more-frequent cron slots can fire these without ever touching /api/curate.
async function runSweeps(env: Env, runs: Runs): Promise<{ indexLock: string; indexSettle: string; tickerSweep: string; notifySweep: string; discordSweep: string }> {
    // Exchange index slate lock - FIRST in the chain, because it is the only step here
    // whose window can close permanently. It records each index's position on games
    // kicking off in the next ~9 hours at the price they're trading at right now;
    // polymarket_props keeps no price history, so a game that isn't locked before
    // kickoff can never be scored later. The other sweeps are all catch-up tolerant and
    // lose nothing by running after it. Own request, own budget, same secret.
    const indexLock = await postSibling(env, runs, '/api/index-lock');

    // Exchange slate settlement - scores finished games and writes each index's daily
    // close. It has no cron slot of its own (the Free plan's five triggers are all
    // spent), and worker-settle's single 09:00 slot could not keep up: one pass a day
    // settles fewer games than locking creates, so the backlog compounded until it was
    // days deep and the newest indexes, last in the kickoff-ordered queue, never settled
    // at all. Riding the sweep slots too gives it four passes a day.
    //
    // That used to be sized against "a peak of ~36 markets". It isn't: measured
    // 2026-09-13, 09-12 needed 107 distinct market settles and 09-13 needed 99, against a
    // four-pass ceiling of 120 - and the coming weekend projects 164 and 144. Hence the
    // drain loop below; four passes is now four DRAINS, not four batches of 30.
    //
    // Free to over-call: settlement is idempotent (closes upsert on
    // (ticker_key, close_date)) and a pass with nothing due costs two queries. Runs
    // after the lock for the usual reason - the lock is the only step whose window can
    // close permanently.
    //
    // DRAINED rather than called once: one pass settles at most MAX_MARKETS (30) markets,
    // which no longer covers a busy day's slate on its own. See drainSibling's header for
    // the measurements and for why looping is free.
    const indexSettle = await drainSibling(env, runs, '/api/index-settle');

    // Exchange ticker tag sweep - a SEPARATE request on purpose: each Pages Function
    // invocation has its own subrequest budget, and curation's traffic already runs
    // close to it (see functions/api/ticker-sweep.ts). Same secret, sibling path.
    // Runs even when curation errored/didn't run this cycle: the sweep is the catch-all
    // for untagged published Tanks and doesn't depend on curation having succeeded.
    const tickerSweep = await postSibling(env, runs, '/api/ticker-sweep');

    // Notification sweep (pet-hungry + new-Tanks digest) - same posture: own request,
    // own budget, runs regardless of the earlier steps' outcomes.
    const notifySweep = await postSibling(env, runs, '/api/notify-sweep');

    // Post newly-published Tanks to Discord - same posture again: own request, own
    // budget, runs regardless of the earlier steps' outcomes.
    const discordSweep = await postSibling(env, runs, '/api/discord-sweep');

    return { indexLock, indexSettle, tickerSweep, notifySweep, discordSweep };
}

// Weekly NFL season-league auto-slate: creates a Community Pick per live NFL
// moneyline market for every guild with an active league_seasons row. Own request,
// same X-Curate-Secret trust domain as the other sweeps - see
// functions/api/league-slate-sweep.ts.
async function runLeagueSlateSweep(env: Env, runs: Runs): Promise<string> {
    return postSibling(env, runs, '/api/league-slate-sweep');
}

// POST a sibling endpoint repeatedly until it reports its queue is drained.
//
// WHY THIS EXISTS. /api/index-settle caps itself at MAX_MARKETS (30) per call, because
// resolution costs one Gamma call per market and a Pages Function has a hard ~50
// subrequest ceiling. Four cron passes a day therefore buy 120 market-settles a day - and
// that is no longer enough. Measured 2026-09-13: 107 distinct markets came due on 09-12
// and 99 on 09-13, while the coming weekend projects 164 (09-19) and 144 (09-20). The
// comment justifying four passes cites "a peak of ~36 markets"; the real peak is already
// three times that, and every market type added multiplies it again.
//
// Looping is the cheap fix, and it works precisely because each POST is a SEPARATE Pages
// Function invocation with its OWN subrequest budget - so draining the queue costs no
// more per call than one pass does, and MAX_MARKETS never has to rise toward the ceiling.
// No new cron trigger is needed either, which matters: the Workers Free plan caps at five
// account-wide and all five are spent (these four plus worker-settle's one).
//
// Safe to over-call by construction: settlement is idempotent (closes upsert on
// (ticker_key, close_date) and REPLACE the day's total, and a settled position is never
// re-settled), and a pass with nothing due costs two queries. The cap is a stop against
// a wedged endpoint looping forever, not a tuning knob - a run that genuinely needs more
// than 8 x 30 = 240 markets will simply continue on the next cron slot, exactly as it
// does today.
const MAX_DRAIN_CALLS = 8;

async function drainSibling(env: Env, runs: Runs, path: string): Promise<string> {
    let last = '';
    for (let i = 0; i < MAX_DRAIN_CALLS; i++) {
        last = await postSibling(env, runs, path);
        let more = false;
        try {
            // hasMore is shipped as a boolean for exactly this caller. An unparseable or
            // empty body (the endpoint errored, or the fetch threw) stops the loop rather
            // than spinning - the next cron slot picks the backlog up.
            more = JSON.parse(last)?.hasMore === true;
        } catch {
            more = false;
        }
        if (!more) {
            if (i > 0) console.log(`[worker-curate] ${path} drained in ${i + 1} calls`);
            return last;
        }
    }
    console.warn(`[worker-curate] ${path} still reported a backlog after ${MAX_DRAIN_CALLS} calls`);
    return last;
}

async function postSibling(env: Env, runs: Runs, path: string): Promise<string> {
    const job = path.replace(/^\/api\//, '');
    const startedAt = Date.now();
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
        runs.push(classifyRun(job, 'preview', res.status, text, Date.now() - startedAt));
        return text;
    } catch (err) {
        console.error(`[worker-curate] ${path} call failed:`, err);
        runs.push(classifyRun(job, 'preview', null, String(err), Date.now() - startedAt));
        return '';
    }
}

// Which Healthchecks.io check a cron slot pings.
function pingFor(env: Env, cron: string): string | undefined {
    if (cron === FULL_CHAIN_CRON) return env.HC_PING_CURATE_10;
    if (cron === LEAGUE_SLATE_CRON) return env.HC_PING_LEAGUE;
    if (cron === NIGHTLY_SWEEP_CRON) return env.HC_PING_SWEEPS_02;
    return env.HC_PING_SWEEPS_18;
}

async function runSlot(env: Env, cron: string): Promise<string> {
    const runs: Runs = [];
    let out: string;
    if (cron === FULL_CHAIN_CRON) {
        out = await runCurate(env, runs);
    } else if (cron === LEAGUE_SLATE_CRON) {
        out = await runLeagueSlateSweep(env, runs);
    } else {
        out = JSON.stringify(await runSweeps(env, runs));
        // Weekly leaderboard piggyback (see WEEKLY_LEADERBOARD_UTC_DAY comment): the
        // endpoint itself only touches guilds that opted in, so a quiet week costs one
        // no-op request. Part of the same run now, so it's reported with it.
        if (cron === NIGHTLY_SWEEP_CRON && new Date().getUTCDay() === WEEKLY_LEADERBOARD_UTC_DAY) {
            await postSibling(env, runs, '/api/weekly-leaderboard-sweep');
        }
    }
    await reportRun(env, cron, runs, pingFor(env, cron));
    return out;
}

export default {
    async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
        // event.cron tells us which configured schedule actually fired (wrangler.toml
        // can list several sharing this one handler). Only FULL_CHAIN_CRON is allowed
        // to reach /api/curate; every other slot is sweeps-only by construction, so a
        // new cron slot added to wrangler.toml without updating this check safely
        // defaults to sweeps-only rather than accidentally spending Anthropic credits.
        // runSlot() keeps that branching (FULL_CHAIN_CRON / LEAGUE_SLATE_CRON / sweeps).
        ctx.waitUntil(runSlot(env, event.cron));
    },

    // Manual-trigger shortcut for testing without waiting for the cron, e.g.
    // `curl https://<worker>.workers.dev/`. Guarded only by whatever the target
    // /api/curate endpoint itself enforces (X-Curate-Secret) - this Worker holds no
    // separate auth of its own.
    // Requires the same secret this Worker already holds (launch audit, 2026-09-07):
    //   curl -H "X-Trigger-Secret: $CURATE_SECRET" https://<worker>.workers.dev/
    // Before this it was open to anyone with the workers.dev URL - and unlike the
    // sweeps, runCurate() spends real Anthropic credits every time it fires.
    async fetch(req: Request, env: Env): Promise<Response> {
        const provided = req.headers.get('X-Trigger-Secret');
        if (!env.CURATE_SECRET || provided !== env.CURATE_SECRET) {
            return new Response(null, { status: 401 });
        }
        const text = await runSlot(env, FULL_CHAIN_CRON);
        return new Response(text, { headers: { 'Content-Type': 'application/json' } });
    },
};
