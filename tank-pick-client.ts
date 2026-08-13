// ===================================================================================
// HEATCHECKS TANK — PICK CLIENT (tank-pick-client.ts)
// ===================================================================================
// Plain fetch() calls to the Cloudflare Pages Functions under functions/api/ (same-
// origin, no API key needed - deliberately not folded into apiClient.ts, which is
// built around VITE_API_URL/X-API-Key for the separate, not-deployed Express backend).
// ===================================================================================

import { getOrCreateVisitorId } from './tank-analytics-client';

const PICK_CACHE_KEY = 'hc_pick';

export interface CachedPick {
    slug: string;
    side: string;
    createdAt: string;
}

export function getCachedPick(): CachedPick | null {
    try {
        const raw = window.localStorage.getItem(PICK_CACHE_KEY);
        return raw ? (JSON.parse(raw) as CachedPick) : null;
    } catch {
        return null;
    }
}

export function setCachedPick(pick: CachedPick): void {
    try {
        window.localStorage.setItem(PICK_CACHE_KEY, JSON.stringify(pick));
    } catch {
        // best-effort UX cache only - never load-bearing
    }
}

export class PickConflictError extends Error {
    existingPick: CachedPick | null;
    constructor(existingPick: CachedPick | null) {
        super("You've already made your call.");
        this.name = 'PickConflictError';
        this.existingPick = existingPick;
    }
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

export async function submitPick(email: string, slug: string, side: string, sideIndex: number): Promise<CachedPick> {
    const visitorId = getOrCreateVisitorId();
    const res = await fetch('/api/picks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, slug, side, sideIndex, visitorId }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 409) throw new PickConflictError(data.pick ?? null);
    if (!res.ok) throw new Error(data.message || `POST /api/picks failed: ${res.status}`);
    return data.pick as CachedPick;
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
