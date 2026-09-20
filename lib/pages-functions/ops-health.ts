// The standing health checks behind /api/ops/health-check (hourly) and /api/ops/health
// (on demand). Pre-launch Audit 4 turned Audit 1's one-time ledger query and the manual
// "did the crons actually work" inspection into these functions, so neither ever needs
// to be run by hand again. Read-only throughout: a check reports, it never repairs -
// fixing a divergence stays a deliberate human action (lib/pages-functions/ledger.ts
// rebuildBalance()), taken with the root cause understood.

import type { NeonQueryFunction } from '@neondatabase/serverless';

type Sql = NeonQueryFunction<false, false>;

// ---------------------------------------------------------------------------------
// 1. Ledger invariants
// ---------------------------------------------------------------------------------

export interface EmberMismatch {
    userId: string;
    username: string | null;
    ledgerSum: number;
    stored: number | null;   // null = no ember_balances row
    diff: number;            // stored - ledgerSum
    balanceUpdatedAt: string | null;
    recentRows: Array<{ at: string; amount: number; entryType: string; ruleKey: string; key: string }>;
}

export interface LedgerReport {
    accountsChecked: number;
    ember: EmberMismatch[];
    items: Array<{ userId: string; catalogKey: string; ledger: number; held: number }>;
}

// SUM(ember_ledger.amount) == ember_balances.balance for every account (Audit 1), and
// SUM(item_ledger.delta) == SUM(inventory_items.quantity) per account and SKU
// (reconcile_item_ledger_deploy_gap.sql's final check). One snapshot for all of it, so
// a write landing mid-check can't show up as a false divergence.
export async function checkLedgers(sql: Sql): Promise<LedgerReport> {
    const [emberRows, itemRows, countRows] = await sql.transaction([
        sql`
            WITH led AS (SELECT user_id, SUM(amount)::bigint AS s FROM ember_ledger GROUP BY user_id),
                 ids AS (SELECT user_id FROM led UNION SELECT user_id FROM ember_balances)
            SELECT ids.user_id, w.username, COALESCE(led.s, 0) AS ledger_sum, b.balance AS stored, b.updated_at
            FROM ids
            LEFT JOIN led ON led.user_id = ids.user_id
            LEFT JOIN ember_balances b ON b.user_id = ids.user_id
            LEFT JOIN waitlist w ON w.id = ids.user_id
            WHERE COALESCE(b.balance, 0) <> COALESCE(led.s, 0) OR b.user_id IS NULL
        `,
        sql`
            WITH led AS (SELECT user_id, catalog_key, SUM(delta)::int AS total FROM item_ledger GROUP BY 1, 2),
                 inv AS (SELECT user_id, catalog_key, SUM(quantity)::int AS total FROM inventory_items GROUP BY 1, 2)
            SELECT COALESCE(l.user_id, i.user_id) AS user_id, COALESCE(l.catalog_key, i.catalog_key) AS catalog_key,
                   COALESCE(l.total, 0) AS ledger, COALESCE(i.total, 0) AS held
            FROM led l FULL OUTER JOIN inv i ON l.user_id = i.user_id AND l.catalog_key = i.catalog_key
            WHERE COALESCE(l.total, 0) <> COALESCE(i.total, 0)
        `,
        sql`SELECT COUNT(*)::int AS n FROM waitlist`,
    ], { isolationLevel: 'RepeatableRead', readOnly: true });

    // Ledger rows with no balance row are only a divergence if they don't net to zero
    // (ledger-trace's rule: an absent row is fine when nothing was ever earned).
    const diverged = (emberRows as any[]).filter((r) => r.stored !== null || Number(r.ledger_sum) !== 0);
    const ember: EmberMismatch[] = [];
    if (diverged.length > 0) {
        // ONE windowed query for every diverging account's recent rows, not one per
        // account: this path runs exactly when the ledger is already broken, which is
        // the worst moment for the alerting path to fan out into N round trips.
        const ids = diverged.map((r) => r.user_id as string);
        const recentRows = await sql`
            SELECT user_id, created_at, amount, entry_type, rule_key, idempotency_key
            FROM (
                SELECT user_id, created_at, amount, entry_type, rule_key, idempotency_key,
                       ROW_NUMBER() OVER (PARTITION BY user_id ORDER BY created_at DESC) AS rn
                FROM ember_ledger WHERE user_id = ANY(${ids}::uuid[])
            ) ranked
            WHERE rn <= 10
            ORDER BY user_id, created_at DESC
        ` as any[];
        const byUser = new Map<string, EmberMismatch['recentRows']>();
        for (const x of recentRows) {
            const list = byUser.get(x.user_id) ?? [];
            list.push({
                at: new Date(x.created_at).toISOString(), amount: Number(x.amount),
                entryType: x.entry_type, ruleKey: x.rule_key, key: x.idempotency_key,
            });
            byUser.set(x.user_id, list);
        }
        for (const r of diverged) {
            const stored = r.stored === null ? null : Number(r.stored);
            ember.push({
                userId: r.user_id,
                username: r.username ?? null,
                ledgerSum: Number(r.ledger_sum),
                stored,
                diff: (stored ?? 0) - Number(r.ledger_sum),
                balanceUpdatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
                recentRows: byUser.get(r.user_id) ?? [],
            });
        }
    }
    return {
        accountsChecked: Number((countRows as any[])[0].n),
        ember,
        items: (itemRows as any[]).map((r) => ({ userId: r.user_id, catalogKey: r.catalog_key, ledger: Number(r.ledger), held: Number(r.held) })),
    };
}

// Which write path produced a ledger row, from its rule_key - what Audit 1 asked a
// divergence report to name.
export function writePathFor(ruleKey: string): string {
    if (ruleKey === 'correct_call' || ruleKey === 'participation') return 'settlement (settleCall)';
    if (ruleKey.startsWith('spend_egg')) return 'egg purchase (purchaseConsumable)';
    if (ruleKey.startsWith('spend_food')) return 'food purchase (purchaseConsumable)';
    if (ruleKey.startsWith('shares_')) return 'TANKDAQ trade (buyShares/sellShares)';
    if (ruleKey === 'discovery_find') return 'discovery find (discoveryFindEmber)';
    if (ruleKey.startsWith('encounter_gift')) return 'NPC gift (encounterGiftEmber)';
    if (ruleKey === 'welcome_gift') return 'welcome gift (welcomeGiftEmber)';
    return 'other / manual';
}

export function describeLedger(report: LedgerReport): string {
    const lines: string[] = [];
    if (report.ember.length) {
        lines.push(`EMBER: ${report.ember.length} account(s) where SUM(ember_ledger.amount) != ember_balances.balance`, '');
        for (const m of report.ember) {
            lines.push(`- ${m.username ?? '(no username)'} ${m.userId}`);
            lines.push(`  ledger sum ${m.ledgerSum}, stored ${m.stored ?? 'NO ROW'}, diff ${m.diff > 0 ? '+' : ''}${m.diff}; balance last updated ${m.balanceUpdatedAt ?? 'n/a'}`);
            lines.push('  most recent ledger rows (newest first):');
            for (const r of m.recentRows) lines.push(`    ${r.at}  ${r.amount > 0 ? '+' : ''}${r.amount}  ${r.entryType}/${r.ruleKey}  -> ${writePathFor(r.ruleKey)}`);
            lines.push('');
        }
    }
    if (report.items.length) {
        lines.push(`ITEMS: ${report.items.length} (account, SKU) pair(s) where SUM(item_ledger.delta) != inventory held`);
        for (const i of report.items) lines.push(`- ${i.userId} ${i.catalogKey}: ledger ${i.ledger}, held ${i.held}`);
        lines.push('');
    }
    lines.push('Nothing was changed. Rebuilding a balance (ledger.ts rebuildBalance) is a deliberate step once the cause is understood.');
    return lines.join('\n');
}

// ---------------------------------------------------------------------------------
// 2. Scheduled jobs - did each one run recently, and did its last run succeed?
// ---------------------------------------------------------------------------------

// Every job the two cron Workers run, with how stale its last successful run may get.
// Windows are the schedule's gap plus slack: daily jobs 26h; the sweeps run at 02, 10
// and 18 UTC, so 9h; weekly jobs 8 days. `match` is a prefix so per-sport curation
// counts as one job.
export const EXPECTED_JOBS: Array<{ job: string; target: 'preview' | 'production'; maxAgeHours: number; label: string }> = [
    { job: 'settle', target: 'preview', maxAgeHours: 26, label: 'Settlement (preview code)' },
    { job: 'settle', target: 'production', maxAgeHours: 26, label: 'Settlement (production fallback)' },
    { job: 'index-settle', target: 'preview', maxAgeHours: 9, label: 'Index settle' },
    { job: 'index-lock', target: 'preview', maxAgeHours: 9, label: 'Index lock' },
    { job: 'ticker-sweep', target: 'preview', maxAgeHours: 9, label: 'Ticker tag sweep' },
    { job: 'notify-sweep', target: 'preview', maxAgeHours: 9, label: 'Notification sweep' },
    { job: 'discord-sweep', target: 'preview', maxAgeHours: 9, label: 'Discord posting sweep' },
    { job: 'discord-settlement-sweep', target: 'preview', maxAgeHours: 26, label: 'Discord settlement posts' },
    { job: 'community-pick-settlement-sweep', target: 'preview', maxAgeHours: 26, label: 'Community pick settlement' },
    { job: 'pvp-settlement-sweep', target: 'preview', maxAgeHours: 26, label: 'PvP settlement' },
    { job: 'tank-resolution-sweep', target: 'preview', maxAgeHours: 26, label: 'Tank resolution' },
    { job: 'curate-sport:', target: 'preview', maxAgeHours: 26, label: 'Curation (any sport)' },
    { job: 'league-slate-sweep', target: 'preview', maxAgeHours: 8 * 24, label: 'NFL league slate (weekly)' },
    { job: 'weekly-leaderboard-sweep', target: 'preview', maxAgeHours: 8 * 24, label: 'Weekly leaderboard (Monday)' },
];

export interface JobStatus {
    label: string;
    job: string;
    target: string;
    lastRunAt: string | null;
    lastOk: boolean | null;
    lastSuccessAt: string | null;
    failures24h: number;
    stale: boolean;        // has run before, but not successfully inside maxAgeHours
    failingNow: boolean;   // most recent run failed
    awaitingFirstRun: boolean; // never reported at all yet
}

// The six reads below are split into a statement builder and a pure mapper so
// opsSnapshot() can send them as ONE batched round trip (see its comment). Each
// checkX() wrapper keeps the standalone form for callers that want just one.

export const jobsStatement = (sql: Sql) => sql`
        SELECT job, target,
               MAX(created_at) AS last_run_at,
               MAX(created_at) FILTER (WHERE ok) AS last_success_at,
               COUNT(*) FILTER (WHERE NOT ok AND created_at > NOW() - INTERVAL '24 hours')::int AS failures_24h,
               (ARRAY_AGG(ok ORDER BY created_at DESC))[1] AS last_ok
        FROM ops_job_runs
        WHERE created_at > NOW() - INTERVAL '9 days'
        GROUP BY job, target
    `;

export function mapJobs(rows: any[], nowMs: number = Date.now()): JobStatus[] {
    return EXPECTED_JOBS.map((e) => {
        const mine = rows.filter((r) => r.target === e.target && (e.job.endsWith(':') ? String(r.job).startsWith(e.job) : r.job === e.job));
        const latest = (field: string) => mine.reduce<Date | null>((acc, r) => {
            if (!r[field]) return acc;
            const d = new Date(r[field]);
            return !acc || d > acc ? d : acc;
        }, null);
        const lastRun = latest('last_run_at');
        const lastSuccess = latest('last_success_at');
        const newest = mine.slice().sort((a, b) => new Date(b.last_run_at).getTime() - new Date(a.last_run_at).getTime())[0];
        // A job that has NEVER reported is not "missed" - it is a job whose cron slot
        // hasn't come round since reporting was deployed. Alerting on that turns every
        // first deploy into a flood of false misses (seen live, 2026-09-19); it becomes
        // alertable the moment it has one run to be late against.
        const awaitingFirstRun = !lastRun;
        return {
            label: e.label, job: e.job, target: e.target,
            lastRunAt: lastRun?.toISOString() ?? null,
            lastOk: newest ? Boolean(newest.last_ok) : null,
            lastSuccessAt: lastSuccess?.toISOString() ?? null,
            failures24h: mine.reduce((n, r) => n + Number(r.failures_24h), 0),
            stale: !awaitingFirstRun && (!lastSuccess || nowMs - lastSuccess.getTime() > e.maxAgeHours * 3600_000),
            failingNow: newest ? !newest.last_ok : false,
            awaitingFirstRun,
        };
    });
}

export async function checkJobs(sql: Sql, nowMs: number = Date.now()): Promise<JobStatus[]> {
    return mapJobs(await jobsStatement(sql) as any[], nowMs);
}

// ---------------------------------------------------------------------------------
// 3. Security bursts and error rate (ops_events, written by functions/_middleware.ts)
// ---------------------------------------------------------------------------------

export const BURST = {
    machineSecretRejectsPerHour: 10,
    rejectsPerIpPerHour: 50,
    csrfRejectsPerHour: 30,
};

export interface SecurityReport {
    lastHour: { authReject: number; csrfReject: number; throttle: number; rejected: number; topIp: { ipHash: string; n: number } | null };
    last24h: { authReject: number; csrfReject: number; throttle: number; rejected: number };
    bursts: string[];
}

export const securityCountsStatement = (sql: Sql) => sql`
        SELECT
          COUNT(*) FILTER (WHERE kind = 'auth_reject' AND created_at > NOW() - INTERVAL '1 hour')::int AS auth_1h,
          COUNT(*) FILTER (WHERE kind = 'csrf_reject' AND created_at > NOW() - INTERVAL '1 hour')::int AS csrf_1h,
          COUNT(*) FILTER (WHERE kind = 'throttle' AND created_at > NOW() - INTERVAL '1 hour')::int AS throttle_1h,
          COUNT(*) FILTER (WHERE kind = 'rejected' AND created_at > NOW() - INTERVAL '1 hour')::int AS rejected_1h,
          COUNT(*) FILTER (WHERE kind = 'auth_reject')::int AS auth_24h,
          COUNT(*) FILTER (WHERE kind = 'csrf_reject')::int AS csrf_24h,
          COUNT(*) FILTER (WHERE kind = 'throttle')::int AS throttle_24h,
          COUNT(*) FILTER (WHERE kind = 'rejected')::int AS rejected_24h
        FROM ops_events WHERE created_at > NOW() - INTERVAL '24 hours' AND kind <> 'server_error' AND NOT (detail ? 'local')
    `;

export const topIpStatement = (sql: Sql) => sql`
        SELECT ip_hash, COUNT(*)::int AS n FROM ops_events
        WHERE created_at > NOW() - INTERVAL '1 hour' AND kind <> 'server_error' AND ip_hash IS NOT NULL AND NOT (detail ? 'local')
        GROUP BY ip_hash ORDER BY n DESC LIMIT 1
    `;

export function mapSecurity(countRows: any[], topRows: any[]): SecurityReport {
    const counts = countRows[0];
    const top = topRows;
    const topIp = top.length ? { ipHash: top[0].ip_hash as string, n: Number(top[0].n) } : null;
    const bursts: string[] = [];
    if (counts.auth_1h >= BURST.machineSecretRejectsPerHour) bursts.push(`${counts.auth_1h} machine-secret rejections in the last hour`);
    if (counts.csrf_1h >= BURST.csrfRejectsPerHour) bursts.push(`${counts.csrf_1h} cross-site rejections in the last hour`);
    if (topIp && topIp.n >= BURST.rejectsPerIpPerHour) bursts.push(`${topIp.n} rejected requests from one source (ip hash ${topIp.ipHash}) in the last hour`);
    return {
        lastHour: { authReject: counts.auth_1h, csrfReject: counts.csrf_1h, throttle: counts.throttle_1h, rejected: counts.rejected_1h, topIp },
        last24h: { authReject: counts.auth_24h, csrfReject: counts.csrf_24h, throttle: counts.throttle_24h, rejected: counts.rejected_24h },
        bursts,
    };
}

export async function checkSecurity(sql: Sql): Promise<SecurityReport> {
    const [counts, top] = await sql.transaction([securityCountsStatement(sql), topIpStatement(sql)]);
    return mapSecurity(counts as any[], top as any[]);
}

export interface ErrorReport { last24h: number; dailyAvgPrev7d: number; elevated: boolean; topPaths: Array<{ path: string; n: number }> }

// "Elevated" = at least 10 server errors in 24h AND at least 3x the previous week's
// daily average - a small absolute floor so one bad request on a quiet day isn't news.
export const errorCountsStatement = (sql: Sql) => sql`
        SELECT COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')::int AS d1,
               COUNT(*) FILTER (WHERE created_at <= NOW() - INTERVAL '24 hours')::int AS prev
        FROM ops_events WHERE kind = 'server_error' AND created_at > NOW() - INTERVAL '8 days' AND NOT (detail ? 'local')
    `;

export const errorPathsStatement = (sql: Sql) => sql`
        SELECT path, COUNT(*)::int AS n FROM ops_events
        WHERE kind = 'server_error' AND created_at > NOW() - INTERVAL '24 hours' AND NOT (detail ? 'local')
        GROUP BY path ORDER BY n DESC LIMIT 5
    `;

export function mapErrors(countRows: any[], pathRows: any[]): ErrorReport {
    const c = countRows[0];
    const paths = pathRows;
    const avg = Number(c.prev) / 7;
    return {
        last24h: Number(c.d1),
        dailyAvgPrev7d: Math.round(avg * 10) / 10,
        elevated: Number(c.d1) >= 10 && Number(c.d1) >= 3 * Math.max(avg, 1),
        topPaths: paths.map((p) => ({ path: p.path, n: Number(p.n) })),
    };
}

export async function checkErrors(sql: Sql): Promise<ErrorReport> {
    const [counts, paths] = await sql.transaction([errorCountsStatement(sql), errorPathsStatement(sql)]);
    return mapErrors(counts as any[], paths as any[]);
}

export const openAlertsStatement = (sql: Sql) => sql`
    SELECT key FROM ops_alerts WHERE resolved_at IS NULL AND key NOT LIKE 'digest:%' ORDER BY key
`;

export interface OpsSnapshot { jobs: JobStatus[]; security: SecurityReport; errors: ErrorReport; openAlerts: string[] }

// Everything the hourly check and the on-demand view read, in ONE batched round trip.
// It used to be six separate awaits, and with the 14 per-job alert statements the whole
// check cost ~28 Neon round trips every hour (efficiency audit, 2026-09-19). The
// statements are independent reads, so batching changes nothing but the wire cost - and
// it gives them all one consistent snapshot, which the split reads never had.
export async function opsSnapshot(sql: Sql, nowMs: number = Date.now()): Promise<OpsSnapshot> {
    const [jobRows, secCounts, topIp, errCounts, errPaths, openRows] = await sql.transaction([
        jobsStatement(sql), securityCountsStatement(sql), topIpStatement(sql),
        errorCountsStatement(sql), errorPathsStatement(sql), openAlertsStatement(sql),
    ], { isolationLevel: 'RepeatableRead', readOnly: true });
    return {
        jobs: mapJobs(jobRows as any[], nowMs),
        security: mapSecurity(secCounts as any[], topIp as any[]),
        errors: mapErrors(errCounts as any[], errPaths as any[]),
        openAlerts: (openRows as any[]).map((r) => r.key as string),
    };
}

// ---------------------------------------------------------------------------------
// 4. The daily summary
// ---------------------------------------------------------------------------------

export function renderDigest(input: {
    ledger: LedgerReport; jobs: JobStatus[]; security: SecurityReport; errors: ErrorReport; openAlerts: string[];
}): { subject: string; text: string; allGood: boolean } {
    const { ledger, jobs, security, errors, openAlerts } = input;
    const ledgerOk = ledger.ember.length === 0 && ledger.items.length === 0;
    const jobProblems = jobs.filter((j) => j.stale || j.failingNow || j.failures24h > 0);
    const allGood = ledgerOk && jobProblems.length === 0 && !errors.elevated && security.bursts.length === 0 && openAlerts.length === 0;
    const mark = (ok: boolean) => (ok ? 'OK  ' : 'FAIL');
    const fmt = (iso: string | null) => (iso ? iso.replace('T', ' ').slice(0, 16) + 'Z' : 'never');

    const lines = [
        `Heatchecks daily health - ${new Date().toISOString().slice(0, 10)}`,
        '',
        `${mark(ledgerOk)}  Ledger invariant: ${ledgerOk ? `holding for all ${ledger.accountsChecked} accounts (Ember and items)` : `${ledger.ember.length} Ember and ${ledger.items.length} item divergence(s) - see the open alert`}`,
        `${mark(jobProblems.length === 0)}  Scheduled jobs: ${jobProblems.length === 0 ? 'every job ran and succeeded on schedule' : `${jobProblems.length} need attention`}`,
    ];
    for (const j of jobs) {
        const flag = j.awaitingFirstRun ? 'first run due' : j.stale ? 'MISSED' : j.failingNow ? 'FAILED' : j.failures24h > 0 ? `${j.failures24h} fail/24h` : 'ok';
        lines.push(`        ${flag.padEnd(14)} ${j.label} - last success ${fmt(j.lastSuccessAt)}`);
    }
    lines.push(
        `${mark(!errors.elevated)}  Server errors: ${errors.last24h} in 24h (prev 7-day avg ${errors.dailyAvgPrev7d}/day)${errors.topPaths.length ? ' - top: ' + errors.topPaths.map((p) => `${p.path} x${p.n}`).join(', ') : ''}`,
        `${mark(security.bursts.length === 0)}  Security (24h): ${security.last24h.authReject} bad-secret, ${security.last24h.csrfReject} cross-site, ${security.last24h.throttle} throttled, ${security.last24h.rejected} rejected trades/purchases/tags`,
        '',
        openAlerts.length ? `Open alerts: ${openAlerts.join(', ')}` : 'No open alerts.',
        '',
        'Error details and stack traces: Sentry. Missed-run pings: Healthchecks.io.',
    );
    return {
        subject: `${allGood ? 'All good' : 'NEEDS ATTENTION'} - Heatchecks daily health ${new Date().toISOString().slice(0, 10)}`,
        text: lines.join('\n'),
        allGood,
    };
}
