// ===================================================================================
// RESEND TRANSPORT (resend.ts)
// ===================================================================================
// One place where this app talks to Resend. Before 2026-09-22 there were six
// copy-pasted raw fetch() calls - three in email.ts, one in alerts.ts, two in
// resend-audience.ts - none with a timeout, none with a retry, and every one of them
// collapsing "no API key", "rate limited", "Resend is down" and "the network vanished"
// into a single untyped Error carrying a string. No caller could tell those apart, so no
// caller tried.
//
// That matters more here than for any other dependency in this codebase, because
// authentication is passwordless. If Resend cannot deliver, nobody can sign in. Resend
// is the single point of failure with the widest blast radius we have.
//
// WHAT THIS DELIBERATELY DOES NOT DO: retry a timeout or a 5xx. When a request times out
// or the server errors mid-flight, we genuinely cannot tell whether the mail went out.
// Re-sending a magic link that was already delivered is worse than not sending one - it
// invalidates the link the person is holding (login.ts rotates the nonce per send) and it
// trains people to expect duplicates. 429 is the one status where Resend is telling us
// plainly that it did NOT accept the message, so 429 is the one status retried.
// ===================================================================================

const RESEND_BASE_URL = 'https://api.resend.com';

// Generous next to a healthy Resend response (tens of ms) and far below the point where a
// Pages Function would be killed with the request still open. Before this, a hung
// connection held a login request - or a whole settlement batch's worth of them - open
// until the platform gave up.
const RESEND_TIMEOUT_MS = 10_000;

// A 429's Retry-After is honoured up to this; beyond it the caller is better served by a
// fast, honest failure than by a request that outlives the user's patience.
const RESEND_MAX_RETRY_WAIT_MS = 3_000;

/**
 * Why a call failed, in a form callers can branch on.
 *
 * `retriable` means "trying again later could plausibly work" - an outage, a rate limit,
 * a timeout. It is false for a misconfiguration or a rejected payload, where trying again
 * changes nothing. functions/api/login.ts uses this to decide whether to hand the
 * person's daily link budget back.
 */
export class ResendError extends Error {
    /** HTTP status, or null when the request never produced a response at all. */
    readonly status: number | null;
    readonly retriable: boolean;
    /** True when the request may have been delivered despite the error (timeout, 5xx). */
    readonly possiblyDelivered: boolean;

    constructor(message: string, status: number | null, retriable: boolean, possiblyDelivered: boolean) {
        super(message);
        this.name = 'ResendError';
        this.status = status;
        this.retriable = retriable;
        this.possiblyDelivered = possiblyDelivered;
    }
}

interface ResendRequest {
    path: string;                       // e.g. '/emails'
    method?: 'POST' | 'PATCH' | 'DELETE';
    body?: unknown;
    /** Statuses to treat as success - Resend uses 404 for "contact was never added". */
    okStatuses?: number[];
    /** Short label for the error message, e.g. 'login link'. */
    label: string;
}

export async function resendRequest(apiKey: string | undefined, req: ResendRequest): Promise<void> {
    if (!apiKey) {
        throw new ResendError(`${req.label}: RESEND_API_KEY is not configured.`, null, false, false);
    }

    for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
            res = await fetch(`${RESEND_BASE_URL}${req.path}`, {
                method: req.method ?? 'POST',
                headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                body: req.body === undefined ? undefined : JSON.stringify(req.body),
                signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
            });
        } catch (err: any) {
            const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
            throw new ResendError(
                `${req.label}: ${timedOut ? `no response within ${RESEND_TIMEOUT_MS}ms` : String(err?.message ?? err)}`,
                null,
                true,
                // A timeout is the ambiguous case: the message may well have gone out.
                true,
            );
        }

        if (res.ok || req.okStatuses?.includes(res.status)) return;

        // The one retry, and only for the one status that means "not accepted".
        if (res.status === 429 && attempt === 0) {
            const retryAfter = Number(res.headers.get('Retry-After'));
            const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
                ? Math.min(retryAfter * 1000, RESEND_MAX_RETRY_WAIT_MS)
                : 500;
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
        }

        const detail = (await res.text().catch(() => '')).slice(0, 300);
        throw new ResendError(
            `${req.label}: Resend returned ${res.status}. ${detail}`,
            res.status,
            res.status === 429 || res.status >= 500,
            res.status >= 500,
        );
    }
}

/** The common case: send one email. */
export function sendResendEmail(
    apiKey: string | undefined,
    label: string,
    payload: Record<string, unknown>,
): Promise<void> {
    return resendRequest(apiKey, { path: '/emails', body: payload, label });
}
