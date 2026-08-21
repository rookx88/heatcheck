// Client for GET /api/toolbar-state - the consolidated ambient read the header chrome
// (PetWidget, MapHud) hydrates from: session + Ember balance + pet + notifications in
// one request. Same-origin cookie-authed, deliberately separate from apiClient.ts
// (which targets the local Express admin backend) - the same split as
// egg-shop-client.ts / notifications-client.ts.
//
// The single-purpose GETs (/api/session, /api/balance, /api/pets, /api/notifications)
// and their wrappers still exist for callers that need just one thing (modals,
// Fishtank); this is only the page-load/refresh consolidation.

import type { SessionInfo } from './tank-pick-client';
import type { PetInfo } from './egg-shop-client';
import type { NotificationItem } from './notifications-client';

export interface ToolbarState {
    session: SessionInfo;
    // null on the un-onboarded partial shape (the endpoint returns identity only until
    // the welcome letter is signed).
    balance: number | null;
    // null when un-onboarded OR petless - callers that must distinguish check
    // session.onboarded.
    pet: PetInfo | null;
    notifications: NotificationItem[] | null;
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// null = logged out (401). Un-onboarded is NOT null here (unlike the 403->null of the
// single-purpose wrappers): the endpoint returns the partial shape instead, so the
// header can still show identity and route to /welcome/.
export async function getToolbarState(): Promise<ToolbarState | null> {
    const res = await fetch('/api/toolbar-state');
    if (res.status === 401) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/toolbar-state failed: ${res.status}`);
    return data as ToolbarState;
}
