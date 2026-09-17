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

// The opt-out mirror of the upsert above (functions/api/account/prefs.ts,
// functions/api/email/unsubscribe.ts, functions/api/account/delete.ts). Resend's update
// endpoint addresses a contact by id OR email in the path; marking rather than deleting
// keeps the suppression on Resend's side too, so a stray Broadcast could never reach
// them. A 404 means the address was never added to the audience (opted in before the
// audience existed, or RESEND_AUDIENCE_ID was unset then) - nothing to suppress, so it
// is success, not an error. Callers are fire-and-forget: the DB flag is the source of
// truth and has already been written by the time this runs.
export async function unsubscribeResendAudienceContact(apiKey: string, audienceId: string, email: string): Promise<void> {
    const res = await fetch(`https://api.resend.com/audiences/${audienceId}/contacts/${encodeURIComponent(email)}`, {
        method: 'PATCH',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ unsubscribed: true }),
    });
    if (res.status === 404) return;
    if (!res.ok) {
        throw new Error(`Resend audience unsubscribe failed: ${res.status} ${await res.text()}`);
    }
}
