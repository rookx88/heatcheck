// ===================================================================================
// HEATCHECKS TANK — PICK CLIENT (tank-pick-client.ts)
// ===================================================================================
// Plain fetch() calls to the Cloudflare Pages Functions under functions/api/ (same-
// origin, no API key needed - deliberately not folded into apiClient.ts, which is
// built around VITE_API_URL/X-API-Key for the separate, not-deployed Express backend).
// ===================================================================================

import { getOrCreateVisitorId } from './tank-analytics-client';

const ACCOUNT_CACHE_KEY = 'hc_account';

// Window event, mirroring notifications-client.ts's OPEN_INBOX_EVENT idiom: fired
// whenever a pick response changes today's picksToday/remaining counts, so any other
// mounted "picks left" display (e.g. the homepage's #hc-picks-status footer, which
// fetches its own independent getTodayStatus() rather than sharing CallContent's
// React state) knows to refetch instead of showing a stale count after a pick made
// elsewhere on the page.
export const PICKS_UPDATED_EVENT = 'hc:picks-updated';

export function dispatchPicksUpdated(): void {
    window.dispatchEvent(new CustomEvent(PICKS_UPDATED_EVENT));
}

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

// The user's pick on one specific tank regardless of date/source (GET
// /api/picks/today?slug=...) - unlike the day-scoped `picks` list, this is what lets
// the deck lock its UI for a tank picked yesterday or via a newsletter issue.
export interface PickHere extends PickResult {
    result: 'correct' | 'incorrect' | null;
    settledAt: string | null;
}

export interface TodayStatus {
    picks: PickResult[];
    picksToday: number;
    remaining: number;
    verified: boolean;
    pickHere?: PickHere | null; // only present when getTodayStatus was given a slug
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
// remain" - re-fetched on every CallContent mount rather than trusting a client cache
// that could drift across days/devices. Cookie-authed since the magic-link auth
// rollout (the hc_session cookie rides along automatically on same-origin fetches);
// 401 just means "not logged in" - a normal state, returned as null rather than
// thrown, so callers render the logged-out UI instead of an error.
export async function getTodayStatus(slug?: string): Promise<TodayStatus | null> {
    const res = await fetch(slug ? `/api/picks/today?slug=${encodeURIComponent(slug)}` : '/api/picks/today');
    // 401 = logged out; 403 = logged in but not onboarded (the server-side gate). Both
    // are "not in a state to show today's picks" rather than errors - the Fishtank
    // onboarding gate normally redirects to /welcome/ before this is ever called, so a
    // 403 here only happens under deploy skew; return null instead of throwing.
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/picks/today failed: ${res.status}`);
    // Every real 200 carries a picks array (functions/api/picks/today.ts), so a 200
    // without one isn't this endpoint answering - it's a static-fallback HTML page
    // served at this path, which parseJsonSafe quietly turns into {}. Returning that
    // as a TodayStatus hands callers an object missing its declared-required fields,
    // and Fishtank's `todayStatus?.picks.find(...)` then throws through the optional
    // chain's blind spot and takes the whole artifact down with it. Same guard, and
    // same reasoning, as getToolbarState's in toolbar-state-client.ts.
    if (!data || !Array.isArray(data.picks)) return null;
    return data as TodayStatus;
}

export interface SessionInfo {
    userId: string;
    email: string;
    verified: boolean;
    // NULL / false until the first-login welcome letter is signed (/welcome/);
    // Fishtank hard-gates on onboarded === false.
    username: string | null;
    onboarded: boolean;
}

// "Am I logged in?" - the identity source of truth on load, replacing the old role of
// the hc_account localStorage cache (which survives only as a best-effort prefill
// hint for logged-out states). 401 -> null, same reasoning as getTodayStatus.
export async function getSessionInfo(): Promise<SessionInfo | null> {
    const res = await fetch('/api/session');
    if (res.status === 401) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/session failed: ${res.status}`);
    return data as SessionInfo;
}

// Request a magic login link (POST /api/login). The server enforces the real rate
// limit (1/60s, 10/day per email); callers surface its message on 429.
export async function requestLoginLink(email: string): Promise<{ sent: boolean }> {
    const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/login failed: ${res.status}`);
    return data as { sent: boolean };
}

export async function logout(): Promise<void> {
    const res = await fetch('/api/logout', { method: 'POST' });
    if (!res.ok) {
        const data = await parseJsonSafe(res);
        throw new Error(data.message || `POST /api/logout failed: ${res.status}`);
    }
    // The cache is only a prefill hint, but a hint pointing at an account the person
    // just logged out of is worse than none.
    try {
        window.localStorage.removeItem(ACCOUNT_CACHE_KEY);
    } catch {
        // best-effort, same as setCachedAccount
    }
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
