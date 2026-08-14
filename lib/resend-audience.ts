// Shared Resend Audience contact upsert - raw fetch, no SDK, matching the existing Resend
// integration style (lib/pages-functions/email.ts). Runtime-agnostic (plain fetch, no
// Node-only or Workers-only API) so it works from both a Cloudflare Pages Function
// (functions/api/newsletter-optin.ts) and a Node script (scripts/backfill-resend-audience.ts).

export async function upsertResendAudienceContact(apiKey: string, audienceId: string, email: string): Promise<void> {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, unsubscribed: false }),
    });
    if (!res.ok) {
        throw new Error(`Resend audience upsert failed: ${res.status} ${await res.text()}`);
    }
}
