// Acceptance suite for the observability layer (pre-launch Audit 4):
//
//   1. The hourly health check refuses anyone without the secret.
//   2. Ledger divergence is detected: a fixture account whose cached balance is pushed
//      off its ledger shows up in /api/ops/health with the exact difference, and the
//      alert text names the account, the diff and each recent row's write path.
//   3. Alert claiming: raiseAlert sends once, stays quiet on a repeat inside the window,
//      and resolveAlert closes it - sent for real, to Resend's test inbox
//      (delivered@resend.dev), never to the founder.
//   4. Job classification (lib/ops-classify.ts): a 200 with errors inside is a failure,
//      a 405 from production is "not deployed", a throw is a failure.
//   5. Job reports land in ops_job_runs; a failed settle opens an urgent alert.
//   6. The middleware records a machine-secret rejection and a CSRF rejection in
//      ops_events, and never leaks its internal reject-reason header.
//   7. A burst of rejections crosses the threshold; the daily summary renders.
//
// Everything is scoped to 'acceptance-ops' fixtures/keys and removed afterwards; the
// ledger drift is staged on a fixture account only and restored before cleanup.

import { neon } from '@neondatabase/serverless';
import { pool, api, check, section, registerTeardown, type Suite } from '../harness';
import { createUser, seedBalance, cleanupUsersByEmailPrefix } from '../fixtures';
import { classifyRun } from '../../../lib/ops-classify';
import { raiseAlert, resolveAlert } from '../../../lib/pages-functions/alerts';
import { describeLedger, writePathFor } from '../../../lib/pages-functions/ops-health';

const PREFIX = 'acceptance-ops-';
const TRIGGER = 'acceptance-ops';
const SETTLE_SECRET = process.env.SETTLE_SECRET || '';
const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

async function cleanup(): Promise<void> {
    await pool.query(`DELETE FROM ops_job_runs WHERE trigger = $1`, [TRIGGER]);
    await pool.query(`DELETE FROM ops_alerts WHERE key LIKE '%acceptance-ops%'`);
    await pool.query(`DELETE FROM ops_events WHERE detail->>'acceptance' = 'ops' OR detail ? 'local'`);
    await cleanupUsersByEmailPrefix(PREFIX);
}

async function run(): Promise<void> {
    await cleanup();
    registerTeardown(cleanup);
    const secret = { 'X-Settle-Secret': SETTLE_SECRET };

    // ===============================================================================
    section('1. The health endpoints are secret-gated');
    // ===============================================================================
    for (const [method, path] of [['POST', '/api/ops/health-check'], ['GET', '/api/ops/health'], ['POST', '/api/ops/job-report']] as const) {
        const none = await api(method, path, { body: method === 'POST' ? {} : undefined });
        const wrong = await api(method, path, { body: method === 'POST' ? {} : undefined, headers: { 'X-Settle-Secret': 'wrong' } });
        check(`${method} ${path}: no secret -> 401, wrong secret -> 401`, none.status === 401 && wrong.status === 401, `${none.status}/${wrong.status}`);
    }

    // ===============================================================================
    section('2. Ledger divergence is detected (fixture account only)');
    // ===============================================================================
    {
        const baseline = await api('GET', '/api/ops/health', { headers: secret });
        check('baseline: GET /api/ops/health -> 200', baseline.status === 200, `status ${baseline.status}`);
        const baselineDivergent = (baseline.json?.ledger?.ember ?? []).length;
        check('baseline: every real account holds the invariant', baselineDivergent === 0, `divergent=${baselineDivergent}`);

        const { userId } = await createUser(`${PREFIX}drift@example.com`, { username: `acceptanceops${Date.now() % 100000}` });
        await seedBalance(userId, 100);
        // The staged fault: the cache moves with no ledger row - exactly the shape the
        // pre-spendLock double-debit race produced.
        await pool.query(`UPDATE ember_balances SET balance = balance - 7 WHERE user_id = $1`, [userId]);

        const drifted = await api('GET', '/api/ops/health', { headers: secret });
        const mine = (drifted.json?.ledger?.ember ?? []).find((m: any) => m.userId === userId);
        check('drift: the fixture account is reported', !!mine, JSON.stringify(drifted.json?.ledger?.ember));
        check('drift: with the exact difference (stored 93, ledger 100, diff -7)', mine?.stored === 93 && mine?.ledgerSum === 100 && mine?.diff === -7, JSON.stringify(mine));
        check('drift: and only that account', (drifted.json?.ledger?.ember ?? []).length === baselineDivergent + 1);
        check('drift: allGood is false while it lasts', drifted.json?.allGood === false);

        const text = describeLedger({ accountsChecked: 1, ember: [mine], items: [] });
        check('alert text names the account, the numbers and the write path of recent rows',
            text.includes(userId) && text.includes('diff -7') && text.includes('stored 93') && text.includes('Nothing was changed'), text.slice(0, 300));
        check('write paths map from rule keys', writePathFor('correct_call').startsWith('settlement') && writePathFor('spend_egg_standard').startsWith('egg purchase') && writePathFor('shares_buy').startsWith('TANKDAQ'));

        await pool.query(`UPDATE ember_balances SET balance = balance + 7 WHERE user_id = $1`, [userId]);
        const restored = await api('GET', '/api/ops/health', { headers: secret });
        check('restored: the account no longer appears', !(restored.json?.ledger?.ember ?? []).some((m: any) => m.userId === userId));
    }

    // ===============================================================================
    section('3. Alert claiming - one email, quiet repeats, one resolve (Resend test inbox)');
    // ===============================================================================
    if (!RESEND_API_KEY) {
        check('RESEND_API_KEY present in the runner env for the alert-claim test', false, 'unset - cannot exercise a real send');
    } else {
        const sql = neon(process.env.DATABASE_URL!);
        const env = { RESEND_API_KEY, ALERT_EMAIL: 'delivered@resend.dev' } as any;
        const key = `test:acceptance-ops:${crypto.randomUUID()}`;
        const first = await raiseAlert(sql, env, key, 'Acceptance ops test alert', 'test body');
        check('first raise -> emailed', first.emailed === true, JSON.stringify(first));
        const second = await raiseAlert(sql, env, key, 'Acceptance ops test alert', 'test body');
        check('repeat inside the window -> not emailed', second.emailed === false && !second.error, JSON.stringify(second));
        const resolved = await resolveAlert(sql, env, key, 'Acceptance ops test alert');
        check('resolve -> one resolved email', resolved.emailed === true, JSON.stringify(resolved));
        const again = await resolveAlert(sql, env, key, 'Acceptance ops test alert');
        check('resolving twice -> no second email', again.emailed === false);
        const failing = await raiseAlert(sql, { RESEND_API_KEY: 'invalid', ALERT_EMAIL: 'delivered@resend.dev' } as any, `${key}:fail`, 'x', 'y');
        const { rows } = await pool.query(`SELECT last_at FROM ops_alerts WHERE key = $1`, [`${key}:fail`]);
        check('a failed send is retried next run (last_at reset)', failing.emailed === false && !!failing.error && new Date(rows[0].last_at).getTime() === 0, JSON.stringify(failing));
    }

    // ===============================================================================
    section('4. Job classification - status AND body');
    // ===============================================================================
    check('200 with errors: 0 -> ok', classifyRun('discord-sweep', 'preview', 200, '{"guilds":2,"posted":1,"errors":0}', 5).ok);
    check('200 with errors: 2 -> failed', !classifyRun('discord-sweep', 'preview', 200, '{"errors":2}', 5).ok);
    check('200 with a group_error result -> failed', !classifyRun('curate-sport:Soccer', 'preview', 200, '{"groups":[{"results":[{"status":"group_error: 400"}]}]}', 5).ok);
    check('200 with a settle result status error -> failed', !classifyRun('settle', 'preview', 200, '{"checked":2,"results":[{"pickId":"x","status":"error"}]}', 5).ok);
    check('200 with outcome_order_mismatch -> failed (needs a human)', !classifyRun('settle', 'preview', 200, '{"results":[{"status":"outcome_order_mismatch"}]}', 5).ok);
    check('200 with ticker failures[] -> failed', !classifyRun('ticker-sweep', 'preview', 200, '{"failures":[{"slug":"a"}]}', 5).ok);
    check('401 -> failed', !classifyRun('settle', 'preview', 401, '{"message":"Unauthorized"}', 5).ok);
    check('thrown (no status) -> failed', !classifyRun('settle', 'preview', null, 'TypeError: fetch failed', 5).ok);
    check('405 from production -> ok, marked not deployed', (() => { const r = classifyRun('pvp-settlement-sweep', 'production', 405, '', 5); return r.ok && (r.summary as any).notDeployed === true; })());
    check('405 from preview -> failed', !classifyRun('pvp-settlement-sweep', 'preview', 405, '', 5).ok);

    // ===============================================================================
    section('5. Job reports land, and a failed settle opens an urgent alert');
    // ===============================================================================
    {
        const report = await api('POST', '/api/ops/job-report', {
            headers: secret,
            body: { trigger: TRIGGER, runs: [
                { job: 'notify-sweep', target: 'preview', ok: true, status: 200, durationMs: 12, errors: 0, summary: { hungryNotifications: 0 } },
                { job: 'settle', target: 'preview', ok: false, status: 500, durationMs: 40, errors: 1, summary: { body: 'boom' } },
            ] },
        });
        check('job-report -> 200 with both runs recorded and one urgent alert', report.status === 200 && report.json?.recorded === 2 && report.json?.urgentAlerts === 1, JSON.stringify(report.json));
        const { rows } = await pool.query(`SELECT job, ok FROM ops_job_runs WHERE trigger = $1 ORDER BY job`, [TRIGGER]);
        check('ops_job_runs holds them as reported', rows.length === 2 && rows.some((r) => r.job === 'settle' && r.ok === false));
        const { rows: urgent } = await pool.query(`SELECT key FROM ops_alerts WHERE key = $1 AND resolved_at IS NULL`, [`urgent:${TRIGGER}`]);
        check('the urgent settlement alert is open', urgent.length === 1);
        const curateAuth = await api('POST', '/api/ops/job-report', { headers: { 'X-Curate-Secret': process.env.CURATE_SECRET || '' }, body: { trigger: TRIGGER, runs: [{ job: 'ticker-sweep', target: 'preview', ok: true, status: 200, durationMs: 1, errors: 0 }] } });
        check('worker-curate\'s secret is accepted too', curateAuth.status === 200, `status ${curateAuth.status}`);
        await pool.query(`DELETE FROM ops_job_runs WHERE trigger = $1`, [TRIGGER]);

        // A job that has never reported is "awaiting first run", NOT missed. Without this
        // the first deploy alerts once per expected job, before any cron slot has come
        // round - which is exactly what happened live on 2026-09-19 (14 false alerts).
        const fresh = await api('GET', '/api/ops/health', { headers: secret });
        const never = (fresh.json?.jobs ?? []).filter((j: any) => j.lastRunAt === null);
        check('jobs with no run history are awaiting-first-run, never stale',
            never.length > 0 && never.every((j: any) => j.awaitingFirstRun === true && j.stale === false),
            JSON.stringify(never.map((j: any) => [j.job, j.stale, j.awaitingFirstRun])));
        check('no job reads as missed while every one is awaiting its first run',
            (fresh.json?.jobs ?? []).every((j: any) => j.stale === false), JSON.stringify((fresh.json?.jobs ?? []).filter((j: any) => j.stale)));
        const summary = await (await fetch(`${process.env.BASE_URL || 'http://localhost:8788'}/api/ops/health?format=text`, { headers: secret })).text();
        check('the summary says "first run due", not MISSED', summary.includes('first run due') && !summary.includes('MISSED'), summary.slice(0, 300));
    }

    // ===============================================================================
    section('6. The middleware records rejections, and never leaks its signal header');
    // ===============================================================================
    {
        const since = new Date();
        const bad = await api('POST', '/api/settle', { headers: { 'X-Settle-Secret': 'wrong' } });
        check('bad secret on /api/settle -> 401', bad.status === 401);
        const csrf = await api('POST', '/api/logout', { headers: { Origin: 'https://evil.example' }, body: {} });
        check('cross-site POST -> 403', csrf.status === 403);
        check('the internal reject-reason header is stripped from the response', csrf.headers.get('X-Heatchecks-Reject-Reason') === null);
        await new Promise((r) => setTimeout(r, 1500)); // waitUntil inserts land after the response
        const { rows } = await pool.query(
            `SELECT kind, path, status, detail FROM ops_events WHERE created_at >= $1 AND path IN ('/api/settle','/api/logout') ORDER BY created_at`, [since],
        );
        check('ops_events: auth_reject recorded for /api/settle', rows.some((r) => r.kind === 'auth_reject' && r.path === '/api/settle' && r.status === 401), JSON.stringify(rows));
        check('ops_events: csrf_reject recorded for /api/logout', rows.some((r) => r.kind === 'csrf_reject' && r.path === '/api/logout' && r.status === 403), JSON.stringify(rows));
        check('ops_events: dev-server traffic is tagged local (so test runs never read as attacks)', rows.length > 0 && rows.every((r) => r.detail?.local === true), JSON.stringify(rows.map((r) => r.detail)));
        const before = await api('GET', '/api/ops/health', { headers: secret });
        check('local-tagged events are excluded from the security counts', (before.json?.security?.lastHour?.authReject ?? -1) === 0, JSON.stringify(before.json?.security?.lastHour));
        await pool.query(`UPDATE ops_events SET detail = detail || '{"acceptance":"ops"}' WHERE created_at >= $1 AND path IN ('/api/settle','/api/logout')`, [since]);
    }

    // ===============================================================================
    section('7. Burst threshold and the daily summary');
    // ===============================================================================
    {
        await pool.query(
            `INSERT INTO ops_events (kind, path, status, ip_hash, detail)
             SELECT 'auth_reject', '/api/settle', 401, 'acceptanceops', '{"acceptance":"ops"}' FROM generate_series(1, 12)`,
        );
        const burst = await api('GET', '/api/ops/health', { headers: secret });
        check('12 machine-secret rejections in an hour -> a burst is reported', (burst.json?.security?.bursts ?? []).some((b: string) => b.includes('machine-secret')), JSON.stringify(burst.json?.security));
        await pool.query(`DELETE FROM ops_events WHERE detail->>'acceptance' = 'ops'`);

        const digest = await fetch(`${process.env.BASE_URL || 'http://localhost:8788'}/api/ops/health?format=text`, { headers: secret });
        const text = await digest.text();
        check('daily summary renders every section', digest.status === 200 && ['Ledger invariant', 'Scheduled jobs', 'Server errors', 'Security (24h)'].every((s) => text.includes(s)), text.slice(0, 400));
    }
}

export const suite: Suite = {
    name: 'ops',
    requiredEnv: ['SETTLE_SECRET', 'CURATE_SECRET', 'SESSION_TOKEN_SECRET'],
    run,
};
