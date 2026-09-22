// Shared Resend Audience contact upsert. Goes through lib/pages-functions/resend.ts like
// every other Resend call, so it inherits the timeout and the 429 retry. Still
// runtime-agnostic (plain fetch, no Node-only or Workers-only API) so it works from both
// a Cloudflare Pages Function (functions/api/newsletter-optin.ts) and a Node script
// (scripts/backfill-resend-audience.ts).

import { resendRequest } from './pages-functions/resend';

export async function upsertResendAudienceContact(apiKey: string, audienceId: string, email: string): Promise<void> {
    await resendRequest(apiKey, {
        path: `/audiences/${audienceId}/contacts`,
        body: { email, unsubscribed: false },
        label: 'audience upsert',
    });
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
    await resendRequest(apiKey, {
        path: `/audiences/${audienceId}/contacts/${encodeURIComponent(email)}`,
        method: 'PATCH',
        body: { unsubscribed: true },
        okStatuses: [404], // never added to the audience - nothing to suppress, see above
        label: 'audience unsubscribe',
    });
}
