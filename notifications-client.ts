// Client for the in-app notification feed (functions/api/notifications*). Same-origin
// cookie-authed fetches, deliberately separate from apiClient.ts (which targets the
// local Express admin backend) - the same split as egg-shop-client.ts.
//
// PHASE NOTE: only the list + read endpoints are wrapped here. POST
// /api/notifications/claim exists server-side but is intentionally NOT exposed yet -
// claiming is a later phase, and read_at vs claimed_at are independent facts (see
// create_notifications_table.sql's warning; conflating them was a real shipped bug).

export interface NotificationItem {
    id: string;
    type: 'claimable' | 'informational';
    message: string;
    refType: string | null;
    refId: string | null;
    readAt: string | null;
    claimedAt: string | null;
    createdAt: string;
}

// Window events, mirroring PetNameForm's PET_UPDATED_EVENT idiom:
// - OPEN_INBOX_EVENT: a header menu asks whichever NotificationsHost is mounted to
//   open the inbox modal (the menus can't render the modal themselves - MapHud sits
//   inside transformed frames that would trap a fixed overlay).
// - NOTIFICATIONS_UPDATED_EVENT: something changed read state; badge owners refetch.
export const OPEN_INBOX_EVENT = 'hc:open-inbox';
export const NOTIFICATIONS_UPDATED_EVENT = 'hc:notifications-updated';

export function dispatchInboxOpen(): void {
    window.dispatchEvent(new CustomEvent(OPEN_INBOX_EVENT));
}

export function dispatchNotificationsUpdated(): void {
    window.dispatchEvent(new CustomEvent(NOTIFICATIONS_UPDATED_EVENT));
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// Newest first (the API's order). 401 = logged out, 403 = not onboarded - both "not
// in a state to see this" rather than errors, returned as null. The oldest unread is
// the LAST element of the readAt === null filter.
export async function getNotifications(): Promise<NotificationItem[] | null> {
    const res = await fetch('/api/notifications');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/notifications failed: ${res.status}`);
    return data.notifications as NotificationItem[];
}

// Stamps read_at only (idempotent server-side). Returns the readAt timestamp, or null
// when the notification no longer exists (tolerated - the next feed fetch reconciles).
export async function markNotificationRead(id: string): Promise<string | null> {
    const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
    });
    if (res.status === 404) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `POST /api/notifications/read failed: ${res.status}`);
    return (data.readAt as string) ?? null;
}
