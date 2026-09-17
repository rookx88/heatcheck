// Client for My Playbook (functions/api/plays.ts). Same-origin cookie-authed fetch, the
// notifications-client.ts shape.

import type { PlayView } from './lib/pages-functions/encounters/plays';

export type { PlayView, PlayReceipt, PlayProgress, DeliveryLine } from './lib/pages-functions/encounters/plays';

// A header menu asks whichever PlaybookHost is mounted to open the modal. The menus
// can't render it themselves: MapHud sits inside transformed frames that would trap a
// fixed overlay (see NotificationsHost).
export const OPEN_PLAYBOOK_EVENT = 'hc:open-playbook';

export function dispatchPlaybookOpen(): void {
    window.dispatchEvent(new CustomEvent(OPEN_PLAYBOOK_EVENT));
}

export interface PlaysResponse {
    current: PlayView[];
    completed: PlayView[];
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// 401 = logged out, 403 = not onboarded - "not in a state to see this", returned as null.
export async function getPlays(): Promise<PlaysResponse | null> {
    const res = await fetch('/api/plays');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/plays failed: ${res.status}`);
    return { current: data.current ?? [], completed: data.completed ?? [] };
}
