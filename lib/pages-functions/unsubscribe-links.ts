// One-click email unsubscribe links, shared by the two senders that need them: the
// settlement email (lib/pages-functions/email.ts, a Pages Function) and the weekly
// newsletter (scripts/send-newsletter-issue.ts, a Node script). Runtime-agnostic on
// purpose - only Web Crypto via auth-tokens.ts, so both callers get byte-identical
// links and functions/api/email/unsubscribe.ts has one verifier for both.
//
// The token authorizes exactly one thing: flipping one preference off for one account.
// It is signed under SESSION_TOKEN_SECRET with purpose 'email_unsubscribe', so
// getSession() (purpose 'session' + a live sessions row) can never accept it as a
// credential, and consume.ts (purpose 'login' + a matching nonce) can't either. The TTL
// is long because emails sit in inboxes for months; an expired link lands on the
// "invalid" copy of /unsubscribed/, which points at the account page instead.

import { signAuthToken } from './auth-tokens';
import type { EmailUnsubscribeTokenPayload } from '../auth-token-payloads';

export const UNSUBSCRIBE_TOKEN_TTL_SECONDS = 180 * 24 * 3600;

export type UnsubscribeKind = EmailUnsubscribeTokenPayload['kind'];

export async function buildUnsubscribeUrl(origin: string, secret: string, userId: string, kind: UnsubscribeKind): Promise<string> {
    const token = await signAuthToken<EmailUnsubscribeTokenPayload>(
        { userId, purpose: 'email_unsubscribe', kind },
        secret,
        UNSUBSCRIBE_TOKEN_TTL_SECONDS,
    );
    return `${origin.replace(/\/$/, '')}/api/email/unsubscribe?token=${encodeURIComponent(token)}`;
}

// The account page's Notifications tab - the "manage everything" link every email
// footer carries next to its one-click unsubscribe.
export function buildManagePrefsUrl(origin: string): string {
    return `${origin.replace(/\/$/, '')}/account/?tab=notifications`;
}

// RFC 8058 one-click headers. Gmail/Yahoo/Apple Mail surface their own native
// "Unsubscribe" affordance from these and POST to the URL with the body
// `List-Unsubscribe=One-Click` - functions/api/email/unsubscribe.ts accepts that POST
// alongside the GET the footer link makes.
export function listUnsubscribeHeaders(unsubscribeUrl: string): Record<string, string> {
    return {
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    };
}
