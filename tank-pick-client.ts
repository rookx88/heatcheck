// ===================================================================================
// HEATCHECKS TANK — PICK CLIENT (tank-pick-client.ts)
// ===================================================================================
// Plain fetch() calls to the Cloudflare Pages Functions under functions/api/ (same-
// origin, no API key needed - deliberately not folded into apiClient.ts, which is
// built around VITE_API_URL/X-API-Key for the separate, not-deployed Express backend).
// ===================================================================================

import { getOrCreateVisitorId } from './tank-analytics-client';

const ACCOUNT_CACHE_KEY = 'hc_account';

// The account (email + verified) is the only thing worth persisting to localStorage
// long-term - which picks exist and how many remain is now inherently a server-side,
// day-scoped fact (see getTodayStatus below), unlike the old one-pick-ever model where
// a single cached pick object could safely stand in for "have I picked" indefinitely.
export interface CachedAccount {
    email: string;
    verified: boolean;
}

export function getCachedAccount(): CachedAccount | null {
    try {
        const raw = window.localStorage.getItem(ACCOUNT_CACHE_KEY);
        return raw ? (JSON.parse(raw) as CachedAccount) : null;
    } catch {
        return null;
    }
}

export function setCachedAccount(account: CachedAccount): void {
    try {
        window.localStorage.setItem(ACCOUNT_CACHE_KEY, JSON.stringify(account));
    } catch {
        // best-effort UX cache only - never load-bearing
    }
}

export interface PickResult {
    slug: string;
    side: string;
    createdAt: string;
}

export interface SubmitPickResponse {
    pick: PickResult;
    verified: boolean;
    picksToday: number;
    remaining: number;
}

export interface TodayStatus {
    picks: PickResult[];
    picksToday: number;
    remaining: number;
    verified: boolean;
}

// Already picked THIS specific tank (idx_picks_waitlist_tank conflict) - a different
// case from DailyCapError below, which means "picked elsewhere already, cap reached."
export class PickConflictError extends Error {
    existingPick: (PickResult & { verified?: boolean }) | null;
    constructor(existingPick: (PickResult & { verified?: boolean }) | null) {
        super('You already made this call.');
        this.name = 'PickConflictError';
        this.existingPick = existingPick;
    }
}

export class DailyCapError extends Error {
    picksToday: number;
    remaining: number;
    // Whether this email is already verified - a 429 is purely a volume rejection,
    // unrelated to verification, but it's often the first server response a fresh
    // session ever sees (no cached account => no earlier GET /api/picks/today to learn
    // this from), so the caller needs it to avoid showing a stale "confirm your email"
    // prompt to an account that's actually already verified.
    verified: boolean;
    constructor(picksToday: number, remaining: number, verified: boolean) {
        super("You've used today's picks — back tomorrow.");
        this.name = 'DailyCapError';
        this.picksToday = picksToday;
        this.remaining = remaining;
        this.verified = verified;
    }
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

export async function submitPick(email: string, slug: string, side: string, sideIndex: number): Promise<SubmitPickResponse> {
    const visitorId = getOrCreateVisitorId();
    const res = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, slug, side, sideIndex, visitorId }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 409) throw new PickConflictError(data.pick ?? null);
    if (res.status === 429) throw new DailyCapError(data.picksToday ?? 3, data.remaining ?? 0, Boolean(data.verified));
    if (!res.ok) throw new Error(data.message || `POST /api/picks failed: ${res.status}`);
    return data as SubmitPickResponse;
}

// The client's source of truth for "which tanks have I picked today / how many
// remain" - re-fetched on every CallContent mount (once an account is known) rather
// than trusting a client cache that could drift across days/devices.
export async function getTodayStatus(email: string): Promise<TodayStatus> {
    const res = await fetch(`/api/picks/today?email=${encodeURIComponent(email)}`);
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/picks/today failed: ${res.status}`);
    return data as TodayStatus;
}

export async function verifyEmailCode(email: string, code: string): Promise<{ verified?: boolean; alreadyVerified?: boolean }> {
    const visitorId = getOrCreateVisitorId();
    const res = await fetch('/api/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code, visitorId }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/verify-email failed: ${res.status}`);
    return data;
}

export async function resendVerificationCode(email: string): Promise<{ sent?: boolean; alreadyVerified?: boolean }> {
    const res = await fetch('/api/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/resend-verification failed: ${res.status}`);
    return data;
}

export async function optIntoNewsletter(email: string): Promise<{ optedIn: boolean }> {
    const visitorId = getOrCreateVisitorId();
    const res = await fetch('/api/newsletter-optin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, visitorId }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/newsletter-optin failed: ${res.status}`);
    return data;
}
