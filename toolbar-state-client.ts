// Client for GET /api/toolbar-state - the consolidated ambient read the header chrome
// (PetWidget, MapHud) hydrates from: session + Ember balance + pet + notifications in
// one request - and, via getToolbarState()'s in-flight sharing below, ONE request per
// page load however many chrome components mount together. Same-origin cookie-authed,
// deliberately separate from apiClient.ts (which targets the local Express admin
// backend) - the same split as egg-shop-client.ts / notifications-client.ts.
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

// Announces an Ember balance change made on the SAME page - a TANKDAQ trade, a shop
// purchase - so the header chrome (MapHud) re-hydrates without a reload. Same idiom as
// PET_UPDATED_EVENT / NOTIFICATIONS_UPDATED_EVENT. Before this existed nothing told the
// HUD about a spend: the egg shop refreshed its own modal-local number while the chip
// above it kept the pre-purchase total until Back or a reload.
export const BALANCE_UPDATED_EVENT = 'hc:balance-updated';
export function dispatchBalanceUpdated(): void {
    window.dispatchEvent(new CustomEvent(BALANCE_UPDATED_EVENT));
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// The page-load dedupe point. MapHud, PetWidget and the ticker page's TradePanel each
// hydrate from this endpoint in their own mount effect, and they mount in the SAME
// React commit (ContentChrome / LandScreen / TankScreen render the pair together), so
// without this every chrome page fired the request twice and the ticker page three
// times - each a full getSession + four-statement transaction + discovery roll on the
// server. Sharing the in-flight promise collapses those to one. Deliberately NOT a
// result cache and no TTL: the promise is dropped the moment it settles, so every
// event-driven refetch (BALANCE_UPDATED_EVENT, PET_UPDATED_EVENT,
// NOTIFICATIONS_UPDATED_EVENT, bfcache pageshow) still reaches the server fresh and
// nothing the chrome shows can be stale. Concurrent callers all receive the same
// resolved value, or all see the same rejection - exactly what separate fetches of
// the same URL in the same tick would have given them, minus the extra requests.
let inflight: Promise<ToolbarState | null> | null = null;

// null = logged out (401). Un-onboarded is NOT null here (unlike the 403->null of the
// single-purpose wrappers): the endpoint returns the partial shape instead, so the
// header can still show identity and route to /welcome/.
export function getToolbarState(): Promise<ToolbarState | null> {
    if (inflight) return inflight;
    inflight = fetchToolbarState().finally(() => { inflight = null; });
    return inflight;
}

async function fetchToolbarState(): Promise<ToolbarState | null> {
    // `place` is the page this chrome is mounted on. The server turns it into a
    // footprint for the pet (lib/pages-functions/discovery.ts placeFromPath - an
    // allowlist, so an unknown path is ignored rather than an error): a pet only finds
    // things after its owner has taken it to enough new places, which is what makes
    // discovery an exploration reward instead of a timer. Sent as a query param so this
    // stays a plain same-origin GET (no preflight, no CSRF posture change).
    const res = await fetch(`/api/toolbar-state?place=${encodeURIComponent(window.location.pathname)}`);
    if (res.status === 401) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/toolbar-state failed: ${res.status}`);
    // Every real 200 carries `session` (the un-onboarded partial shape included), so a
    // 200 without one isn't this endpoint answering - it's a static-fallback HTML page
    // being served at this path, which parseJsonSafe quietly turns into {}. Treat that
    // as logged out rather than letting callers render a phantom identity: MapHud would
    // otherwise show a nameless chip, and the article pages hide their register banner
    // whenever that chip appears.
    if (!data || typeof data !== 'object' || !data.session) return null;
    return data as ToolbarState;
}
