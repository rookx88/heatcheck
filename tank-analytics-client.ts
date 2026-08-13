// ===================================================================================
// HEATCHECKS TANK — ANALYTICS CLIENT (tank-analytics-client.ts)
// ===================================================================================
// Plain fetch() to POST /api/track, same pattern as tank-pick-client.ts. visitorId is
// a separate, purely anonymous, analytics-only identifier (localStorage) - it has no
// bearing on the one-pick-per-account limit, which stays keyed to email/waitlist_id.
// Analytics must never break the actual UX: trackEvent() swallows all errors.
// ===================================================================================

const VISITOR_ID_KEY = 'hc_visitor_id';

export function getOrCreateVisitorId(): string {
    try {
        const existing = window.localStorage.getItem(VISITOR_ID_KEY);
        if (existing) return existing;
        const id = crypto.randomUUID();
        window.localStorage.setItem(VISITOR_ID_KEY, id);
        return id;
    } catch {
        return crypto.randomUUID(); // private browsing / storage disabled - best effort, not persisted
    }
}

export interface TrackEventData {
    path?: string;
    tankSlug?: string;
    wallKind?: string;
    metadata?: Record<string, unknown>;
}

export function trackEvent(eventType: string, data: TrackEventData = {}): void {
    try {
        const visitorId = getOrCreateVisitorId();
        fetch('/api/track', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visitorId, eventType, ...data }),
        }).catch(() => { /* fire-and-forget - never surface analytics failures to the user */ });
    } catch {
        // localStorage/crypto unavailable or similar - silently skip
    }
}
