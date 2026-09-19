// POST /api/ops/health-check - the hourly standing check (pre-launch Audit 4), fired by
// worker-settle's hourly cron. X-Settle-Secret gated, checked before anything else.
//
// Every run:
//   - Ledger invariants (Ember and items) - the check Audit 1 ran by hand. Divergence
//     raises 'ledger:ember' / 'ledger:items' with a per-account breakdown and the write
//     path of each recent row; clearing resolves it. Never repairs anything.
//   - Scheduled jobs - each expected job must have a successful run inside its window
//     (ops_job_runs, reported by the Workers). A stale or failing job raises 'job:<name>'.
//   - Security bursts and server-error rate (ops_events, from functions/_middleware.ts).
//   - Once a day, on the first run at or after 10:00 UTC (after the 09:00 settlement and
//     the 10:00 curation), emails the daily summary.
//   - Prunes ops_events older than 30 days and ops_job_runs older than 90.
//
// Returns { ok, ... } - ok=false when any condition is currently alerting, which the
// Worker turns into a Healthchecks.io /fail ping.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { secretMatches } from '../../../lib/pages-functions/secret-compare';
import { raiseAlert, resolveAlert, claimOnce, releaseOnce, sendAlertEmail, type AlertOutcome } from '../../../lib/pages-functions/alerts';
import { checkLedgers, describeLedger, checkJobs, checkSecurity, checkErrors, renderDigest } from '../../../lib/pages-functions/ops-health';

const DIGEST_HOUR_UTC = 10;

export const onRequestPost: PagesFunction<Env> = async (context) => {
    if (!(await secretMatches(context.request.headers.get('X-Settle-Secret'), context.env.SETTLE_SECRET))) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }
    const sql = getSql(context.env);
    const env = context.env;
    const alerts: AlertOutcome[] = [];

    // --- Ledger (highest priority: checked first, and its failure alone fails the run)
    const ledger = await checkLedgers(sql);
    if (ledger.ember.length) {
        alerts.push(await raiseAlert(sql, env, 'ledger:ember',
            `LEDGER DIVERGENCE: ${ledger.ember.length} account(s) - Ember balance != ledger`, describeLedger({ ...ledger, items: [] })));
    } else {
        alerts.push(await resolveAlert(sql, env, 'ledger:ember', 'Ember ledger divergence'));
    }
    if (ledger.items.length) {
        alerts.push(await raiseAlert(sql, env, 'ledger:items',
            `ITEM LEDGER DIVERGENCE: ${ledger.items.length} (account, SKU) pair(s)`, describeLedger({ ...ledger, ember: [] })));
    } else {
        alerts.push(await resolveAlert(sql, env, 'ledger:items', 'Item ledger divergence'));
    }

    // --- Scheduled jobs
    const jobs = await checkJobs(sql);
    for (const j of jobs) {
        const key = `job:${j.job}:${j.target}`;
        if (j.stale || j.failingNow) {
            const why = j.stale
                ? `no successful run since ${j.lastSuccessAt ?? 'ever (in the last 9 days)'}`
                : `its most recent run (${j.lastRunAt}) failed`;
            alerts.push(await raiseAlert(sql, env, key, `Scheduled job problem: ${j.label} - ${j.stale ? 'missed' : 'failed'}`,
                `${j.label} (${j.job}, ${j.target}): ${why}.\nFailures in the last 24h: ${j.failures24h}.\n\n` +
                `The failing response body is in ops_job_runs.summary and in the cron Worker's logs (Cloudflare dashboard > Workers > Logs).`));
        } else {
            alerts.push(await resolveAlert(sql, env, key, `Scheduled job problem: ${j.label}`));
        }
    }

    // --- Security and errors
    const security = await checkSecurity(sql);
    if (security.bursts.length) {
        alerts.push(await raiseAlert(sql, env, 'security:burst', `Unusual request activity: ${security.bursts[0]}`,
            security.bursts.join('\n') + `\n\nLast hour: ${JSON.stringify(security.lastHour)}\nDetails: SELECT * FROM ops_events WHERE created_at > NOW() - INTERVAL '1 hour' ORDER BY created_at DESC;`));
    } else {
        alerts.push(await resolveAlert(sql, env, 'security:burst', 'Unusual request activity'));
    }
    const errors = await checkErrors(sql);
    if (errors.elevated) {
        alerts.push(await raiseAlert(sql, env, 'errors:elevated', `Server errors elevated: ${errors.last24h} in 24h`,
            `${errors.last24h} server errors in the last 24h vs a ${errors.dailyAvgPrev7d}/day average over the previous week.\n` +
            `Top paths: ${errors.topPaths.map((p) => `${p.path} x${p.n}`).join(', ')}\nStack traces: Sentry.`));
    } else {
        alerts.push(await resolveAlert(sql, env, 'errors:elevated', 'Server errors elevated'));
    }

    // --- Housekeeping
    await sql`DELETE FROM ops_events WHERE created_at < NOW() - INTERVAL '30 days'`;
    await sql`DELETE FROM ops_events WHERE detail ? 'local' AND created_at < NOW() - INTERVAL '1 day'`; // harness traffic
    await sql`DELETE FROM ops_job_runs WHERE created_at < NOW() - INTERVAL '90 days'`;

    const open = await sql`SELECT key FROM ops_alerts WHERE resolved_at IS NULL AND key NOT LIKE 'digest:%' ORDER BY key` as any[];
    const openAlerts = open.map((r) => r.key as string);

    // --- Daily summary
    let digest: 'sent' | 'not_due' | 'already_sent' | 'failed' = 'not_due';
    const now = new Date();
    if (now.getUTCHours() >= DIGEST_HOUR_UTC) {
        const key = `digest:${now.toISOString().slice(0, 10)}`;
        if (await claimOnce(sql, key)) {
            const d = renderDigest({ ledger, jobs, security, errors, openAlerts });
            try {
                await sendAlertEmail(env, d.subject, d.text);
                digest = 'sent';
            } catch (err) {
                console.error('[POST /api/ops/health-check] daily summary send failed:', err);
                await releaseOnce(sql, key); // let the next hourly run try again
                digest = 'failed';
            }
        } else {
            digest = 'already_sent';
        }
    }

    return jsonResponse({
        ok: openAlerts.length === 0,
        openAlerts,
        ledger: { accountsChecked: ledger.accountsChecked, emberDivergent: ledger.ember.length, itemDivergent: ledger.items.length },
        jobs: jobs.map((j) => ({ job: j.job, target: j.target, stale: j.stale, failingNow: j.failingNow, lastSuccessAt: j.lastSuccessAt })),
        security: { lastHour: security.lastHour, bursts: security.bursts },
        errors,
        alertsEmailed: alerts.filter((a) => a.emailed).map((a) => a.key),
        alertSendErrors: alerts.filter((a) => a.error).map((a) => ({ key: a.key, error: a.error })),
        digest,
    });
};
