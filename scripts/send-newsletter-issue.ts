// Manual trigger for a weekly newsletter send - "manual now, cron later," same posture
// as settlement. A Node script rather than a Pages Function/HTTP endpoint for two
// reasons: (1) @react-email/render is proven working in this exact Node/tsx setup (see
// scripts/preview-newsletter-email.ts) but unproven in the Cloudflare Workers runtime
// this project's Pages Functions run in, and (2) the pick link has to be personalized
// per recipient (it encodes their specific waitlist_id in a signed token - see
// lib/pages-functions/tokens.ts, whose signToken/verifyToken pair is generic Web Crypto
// with no Workers-only dependency, so it works fine here in Node too - so the pick can
// attribute to them without a login step), which Resend Broadcasts'
// one-shared-Broadcast-per-Audience model doesn't support - this sends individual emails
// via Resend's /emails endpoint instead, one per recipient, sequentially, same raw-fetch
// pattern and "predictable cost/rate per call" philosophy already used for Tank
// generation and Polymarket sync. Resend Audience sync (functions/api/newsletter-optin.ts)
// still matters for its own sake - unsubscribe-list management - it's just not the send
// mechanism itself.
//
// Run: npx tsx scripts/send-newsletter-issue.ts --week=2026-W34
// Dry run (renders the real approved content to a local file, sends nothing, writes
// nothing): npx tsx scripts/send-newsletter-issue.ts --week=2026-W34 --dry-run

import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
dotenv.config();

import { render } from '@react-email/render';
import NewsletterIssueEmail, { type NewsletterIssue } from '../emails/NewsletterIssue';
import { signToken } from '../lib/pages-functions/tokens';
import type { NewsletterPickTokenPayload } from '../lib/newsletter-pick-token';

const BASE_URL = process.env.BASE_URL || 'https://heatchecks.io';
const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days - generous; "once per issue" is DB-enforced, not expiry-enforced

interface IssueRow {
    id: string;
    week_key: string;
    tank_slug: string;
    this_week_recap: string | null;
    lore_title: string | null;
    lore_body: string | null;
    content_approved_at: string | null;
    sent_at: string | null;
}

interface TankRow {
    hook: string;
}

interface SubscriberRow {
    id: string;
    email: string;
}

async function sendOne(apiKey: string, to: string, subject: string, html: string): Promise<void> {
    const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: 'Heatchecks <hello@heatchecks.io>', to, subject, html }),
    });
    if (!res.ok) {
        throw new Error(`Resend API error: ${res.status} ${await res.text()}`);
    }
}

async function main() {
    const weekArg = process.argv.find(a => a.startsWith('--week='));
    const weekKey = weekArg ? weekArg.slice('--week='.length) : '';
    const dryRun = process.argv.includes('--dry-run');
    if (!weekKey) {
        console.error('Usage: npx tsx scripts/send-newsletter-issue.ts --week=2026-W34 [--dry-run]');
        process.exit(1);
    }

    const apiKey = process.env.RESEND_API_KEY;
    const tokenSecret = process.env.NEWSLETTER_TOKEN_SECRET;
    if (!apiKey || !tokenSecret) {
        console.error('RESEND_API_KEY and NEWSLETTER_TOKEN_SECRET must both be set.');
        process.exit(1);
    }

    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        const issueRows = await pool.query('SELECT * FROM newsletter_issues WHERE week_key = $1', [weekKey]);
        if (issueRows.rowCount === 0) {
            console.error(`No newsletter_issues row for week ${weekKey}.`);
            process.exit(1);
        }
        const issue = issueRows.rows[0] as IssueRow;

        // A dry run is meant to help the pre-approval review itself, so it deliberately
        // skips the sent/approved gates below - only the real send enforces those.
        if (!dryRun) {
            if (issue.sent_at) {
                console.error(`Issue ${weekKey} was already sent at ${issue.sent_at}.`);
                process.exit(1);
            }
            if (!issue.content_approved_at) {
                console.error(`Issue ${weekKey} has not been approved yet - approve it in the Newsletter admin tab first.`);
                process.exit(1);
            }
        }
        if (!issue.this_week_recap?.trim() || !issue.lore_title?.trim() || !issue.lore_body?.trim()) {
            console.error(`Issue ${weekKey} is missing recap or lore content.`);
            process.exit(1);
        }

        const tankRows = await pool.query(
            `SELECT model_output->>'hook' AS hook FROM tank_pages WHERE slug = $1 AND visibility = 'newsletter_only' AND status = 'published'`,
            [issue.tank_slug]
        );
        if (tankRows.rowCount === 0) {
            console.error(`Tank "${issue.tank_slug}" for issue ${weekKey} is not a published newsletter_only Tank.`);
            process.exit(1);
        }
        const tank = tankRows.rows[0] as TankRow;
        const subject = tank.hook;

        if (dryRun) {
            // No real recipient to personalize for, and none needed - this is for visual/
            // content QA, not a functional link. No Resend calls, no DB writes.
            const previewToken = await signToken<NewsletterPickTokenPayload>(
                { userId: 'preview', newsletterIssueId: issue.id },
                tokenSecret,
                TOKEN_TTL_SECONDS
            );
            const pickUrl = `${BASE_URL}/newsletter-pick/?token=${encodeURIComponent(previewToken)}&issue=${encodeURIComponent(issue.id)}`;
            const emailProps: NewsletterIssue = {
                weekKey: issue.week_key,
                exclusiveTank: { slug: issue.tank_slug, hook: tank.hook, pickUrl },
                thisWeek: issue.this_week_recap!,
                loreSpotlight: { title: issue.lore_title!, body: issue.lore_body! },
            };
            const html = await render(NewsletterIssueEmail(emailProps));

            const outDir = path.join(process.cwd(), 'scratch');
            fs.mkdirSync(outDir, { recursive: true });
            const outPath = path.join(outDir, `newsletter-dry-run-${weekKey}.html`);
            fs.writeFileSync(outPath, html);

            console.log(`Subject would be: "${subject}"`);
            console.log(`Dry run only - nothing sent, issue not marked sent. Wrote ${outPath}`);
            return;
        }

        const subscriberRows = await pool.query(
            `SELECT id, email FROM waitlist WHERE newsletter_opt_in = true AND email_verified = true`
        );
        const subscribers = subscriberRows.rows as SubscriberRow[];
        console.log(`Sending issue ${weekKey} to ${subscribers.length} subscriber(s)...`);

        let succeeded = 0;
        let failed = 0;
        // Sequential, not parallel - see header comment.
        for (const subscriber of subscribers) {
            try {
                const token = await signToken<NewsletterPickTokenPayload>(
                    { userId: subscriber.id, newsletterIssueId: issue.id },
                    tokenSecret,
                    TOKEN_TTL_SECONDS
                );
                const pickUrl = `${BASE_URL}/newsletter-pick/?token=${encodeURIComponent(token)}&issue=${encodeURIComponent(issue.id)}`;

                const emailProps: NewsletterIssue = {
                    weekKey: issue.week_key,
                    exclusiveTank: { slug: issue.tank_slug, hook: tank.hook, pickUrl },
                    thisWeek: issue.this_week_recap!,
                    loreSpotlight: { title: issue.lore_title!, body: issue.lore_body! },
                };
                const html = await render(NewsletterIssueEmail(emailProps));

                await sendOne(apiKey, subscriber.email, subject, html);
                succeeded++;
            } catch (err: any) {
                failed++;
                console.error(`  Failed for ${subscriber.email}:`, err.message);
            }
        }

        await pool.query('UPDATE newsletter_issues SET sent_at = NOW() WHERE id = $1', [issue.id]);

        // System-triggered send, not a browser event - events.visitor_id has no natural
        // anonymous identity to attach here, so this uses a fresh synthetic id purely as
        // an audit-trail row, not for visitor-history bridging like every other event.
        await pool.query(
            `INSERT INTO events (visitor_id, event_type, metadata) VALUES (gen_random_uuid(), 'newsletter_sent', $1)`,
            [JSON.stringify({ weekKey, issueId: issue.id, succeeded, failed })]
        );

        // In-app trace of the send: one informational notification per opted-in,
        // onboarded subscriber, so a missed email isn't a silently-gone exclusive.
        // Idempotent per (week, user) - re-running against an already-sent issue is
        // blocked earlier anyway, but the key makes this safe regardless.
        const notifResult = await pool.query(
            `INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
             SELECT w.id, 'informational',
                    'This week''s exclusive Tank is live — check your email for your one-tap pick.',
                    'newsletter', $1, 'newsletter:' || $1 || ':' || w.id
             FROM waitlist w
             WHERE w.newsletter_opt_in = true AND w.onboarded_at IS NOT NULL
             ON CONFLICT (idempotency_key) DO NOTHING`,
            [weekKey]
        );
        console.log(`In-app notifications inserted: ${notifResult.rowCount}`);

        console.log(`Done. ${succeeded} sent, ${failed} failed. Issue marked sent.`);
    } finally {
        await pool.end();
    }
}

main();
