// Founder alerting (pre-launch Audit 4). Everything that should reach a human without
// them going looking - ledger divergence, a failed or missing scheduled job, a burst of
// rejected requests, the daily health summary - goes through here, by email to
// ALERT_EMAIL via the same Resend account the app already sends from.
//
// ops_alerts (create_ops_tables.sql) keeps one row per alert condition so an ongoing
// problem emails when it starts, then at most every REPEAT_HOURS while it lasts, and
// once more when it clears. The claim is a single guarded upsert, so two health checks
// racing on the same condition can't both send.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Env } from './db';

type Sql = NeonQueryFunction<false, false>;

export const ALERT_REPEAT_HOURS = 6;
const FROM = 'Heatchecks Ops <hello@heatchecks.io>';

// Plain text on purpose: these are read on a phone to decide whether to open a laptop.
export async function sendAlertEmail(env: Env, subject: string, text: string): Promise<void> {
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured.');
    if (!env.ALERT_EMAIL) throw new Error('ALERT_EMAIL is not configured.');
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: FROM, to: env.ALERT_EMAIL, subject, text }),
    });
    if (!res.ok) throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
}

export interface AlertOutcome { key: string; emailed: boolean; error?: string }

// Opens (or keeps open) the alert `key` and emails if it is new, was resolved, or has
// been open longer than ALERT_REPEAT_HOURS since the last email. A failed send resets
// last_at so the next health check tries again instead of going quiet for hours.
export async function raiseAlert(sql: Sql, env: Env, key: string, subject: string, text: string): Promise<AlertOutcome> {
    const claimed = await sql`
        INSERT INTO ops_alerts (key, detail) VALUES (${key}, ${subject})
        ON CONFLICT (key) DO UPDATE SET
            first_at = CASE WHEN ops_alerts.resolved_at IS NOT NULL THEN NOW() ELSE ops_alerts.first_at END,
            count = CASE WHEN ops_alerts.resolved_at IS NOT NULL THEN 1 ELSE ops_alerts.count + 1 END,
            last_at = NOW(),
            resolved_at = NULL,
            detail = EXCLUDED.detail
        WHERE ops_alerts.resolved_at IS NOT NULL
           OR ops_alerts.last_at < NOW() - make_interval(hours => ${ALERT_REPEAT_HOURS})
        RETURNING count
    `;
    if (claimed.length === 0) return { key, emailed: false };
    const count = Number(claimed[0].count);
    try {
        await sendAlertEmail(env, count > 1 ? `[still failing] ${subject}` : subject, text);
        return { key, emailed: true };
    } catch (err) {
        await sql`UPDATE ops_alerts SET last_at = 'epoch' WHERE key = ${key}`;
        return { key, emailed: false, error: String(err) };
    }
}

// Closes `key` if it is open and sends one "resolved" email. No-op when nothing was open.
export async function resolveAlert(sql: Sql, env: Env, key: string, subject: string): Promise<AlertOutcome> {
    const closed = await sql`
        UPDATE ops_alerts SET resolved_at = NOW() WHERE key = ${key} AND resolved_at IS NULL RETURNING first_at
    `;
    if (closed.length === 0) return { key, emailed: false };
    try {
        await sendAlertEmail(env, `[resolved] ${subject}`, `Cleared at ${new Date().toISOString()} (open since ${new Date(closed[0].first_at as string).toISOString()}).`);
        return { key, emailed: true };
    } catch (err) {
        return { key, emailed: false, error: String(err) };
    }
}

// Resolves MANY keys in one statement - the all-clear path of the hourly health check,
// which has one key per expected job plus the ledger/security/error ones. Calling
// resolveAlert per key cost ~18 Neon round trips an hour to usually close nothing
// (efficiency audit, 2026-09-19). Only keys that were actually open come back, so the
// email loop below runs as rarely as it did before.
export async function resolveAlerts(sql: Sql, env: Env, entries: Array<{ key: string; subject: string }>): Promise<AlertOutcome[]> {
    if (entries.length === 0) return [];
    const keys = entries.map((e) => e.key);
    const closed = await sql`
        UPDATE ops_alerts SET resolved_at = NOW()
        WHERE key = ANY(${keys}::text[]) AND resolved_at IS NULL
        RETURNING key, first_at
    ` as any[];
    const out: AlertOutcome[] = [];
    for (const row of closed) {
        const subject = entries.find((e) => e.key === row.key)?.subject ?? row.key;
        try {
            await sendAlertEmail(env, `[resolved] ${subject}`, `Cleared at ${new Date().toISOString()} (open since ${new Date(row.first_at as string).toISOString()}).`);
            out.push({ key: row.key, emailed: true });
        } catch (err) {
            out.push({ key: row.key, emailed: false, error: String(err) });
        }
    }
    return out;
}

// Once-only sends (the daily summary): true for exactly one caller per key, ever.
export async function claimOnce(sql: Sql, key: string): Promise<boolean> {
    const rows = await sql`
        INSERT INTO ops_alerts (key, resolved_at, detail) VALUES (${key}, NOW(), 'once')
        ON CONFLICT (key) DO NOTHING RETURNING key
    `;
    return rows.length > 0;
}

export async function releaseOnce(sql: Sql, key: string): Promise<void> {
    await sql`DELETE FROM ops_alerts WHERE key = ${key}`;
}

// Salted, truncated IP hash for ops_events - enough to spot one source hammering an
// endpoint, never enough to store who someone is. Salted with SESSION_TOKEN_SECRET so
// the hash can't be reversed with a precomputed table of IPv4 addresses.
export async function hashIp(env: Env, ip: string | null): Promise<string | null> {
    if (!ip) return null;
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${env.SESSION_TOKEN_SECRET}:${ip}`));
    return Array.from(new Uint8Array(digest).slice(0, 8)).map((b) => b.toString(16).padStart(2, '0')).join('');
}
