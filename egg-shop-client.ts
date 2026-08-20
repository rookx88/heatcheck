// ===================================================================================
// HEATCHECKS HATCHERY — EGG SHOP CLIENT (egg-shop-client.ts)
// ===================================================================================
// Plain fetch() calls to the Cloudflare Pages Functions under functions/api/ (same-
// origin, cookie-authed via hc_session - same conventions as tank-pick-client.ts,
// deliberately not apiClient.ts). Covers the egg lifecycle: shop listings, Ember
// balance, owned eggs, purchase, hatch.
// ===================================================================================

export interface ShopEgg {
    catalogKey: string;
    name: string;
    price: number;
    // Known-outcome contract: the exact resulting color/render inputs are listed up
    // front. hue drives the shown colorway for 'filter' eggs; assetKey for custom ones.
    color: string | null;
    renderMode: string | null;
    hue: number | null;
    assetKey: string | null;
    availableUntil: string | null;
}

export interface OwnedEgg {
    id: string; // the inventory row - eggs are one row each; this id is what hatch consumes
    catalogKey: string;
    name: string;
    color: string | null;
    renderMode: string | null;
    hue: number | null;
    assetKey: string | null;
    acquiredAt: string;
}

export interface ShopFood {
    catalogKey: string;
    name: string;
    price: number;
    satisfactionPoints: number | null;
    vendor: string | null;
}

export interface OwnedFood {
    catalogKey: string;
    name: string;
    quantity: number;
}

// The only pet shape the server ever returns (satisfaction is a two-state label, never
// a number - see lib/pages-functions/pets.ts petPublic()).
export interface PetInfo {
    id: string;
    color: string;
    render_mode: string;
    render_config: Record<string, unknown>;
    name: string | null;
    is_captain: boolean;
    state: 'hungry' | 'satisfied';
}

// 402 - the buy was rejected for balance; carries the server's current balance so the
// UI can show the real number instead of a stale one.
export class InsufficientEmberError extends Error {
    balance: number;
    constructor(balance: number) {
        super('Not enough Ember.');
        this.name = 'InsufficientEmberError';
        this.balance = balance;
    }
}

// Buy 404 - the SKU is gone (deactivated, or a time-boxed window closed mid-browse).
export class EggUnavailableError extends Error {
    constructor(message?: string) {
        super(message || 'That egg is no longer available.');
        this.name = 'EggUnavailableError';
    }
}

// Hatch 404 - the egg row isn't there to hatch (already hatched elsewhere, or a stale
// list). Not-yours and already-gone are deliberately indistinguishable server-side.
export class EggGoneError extends Error {
    constructor(message?: string) {
        super(message || "You don't have that egg to hatch.");
        this.name = 'EggGoneError';
    }
}

// Feed 409 - the pet is at max satisfaction; feeding is rejected before any write
// (the food is NOT consumed).
export class PetFullError extends Error {
    constructor(message?: string) {
        super(message || 'Your pet is already full.');
        this.name = 'PetFullError';
    }
}

// Name 409 - taken by another pet or an account username, or the pet is already
// named (naming is one-time).
export class NameRejectedError extends Error {
    taken: boolean;
    constructor(message: string | undefined, taken: boolean) {
        super(message || 'That name is taken.');
        this.name = 'NameRejectedError';
        this.taken = taken;
    }
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// 401 = logged out, 403 = not onboarded - both "not in a state to see this" rather
// than errors; returned as null so callers render the logged-out prompt.
export async function getShopEggs(): Promise<ShopEgg[] | null> {
    const res = await fetch('/api/shop');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/shop failed: ${res.status}`);
    return (data.items as (ShopEgg & { itemType: string })[]).filter((i) => i.itemType === 'egg');
}

// One vendor's food menu ('quickboost' | 'champions').
export async function getShopFood(vendor: string): Promise<ShopFood[] | null> {
    const res = await fetch('/api/shop');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/shop failed: ${res.status}`);
    return (data.items as (ShopFood & { itemType: string })[]).filter(
        (i) => i.itemType === 'food' && i.vendor === vendor
    );
}

// Owned food stacks (catalogKey -> quantity), for "Owned: N" badges in the shops.
export async function getOwnedFood(): Promise<OwnedFood[] | null> {
    const res = await fetch('/api/inventory');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/inventory failed: ${res.status}`);
    return ((data.items ?? []) as (OwnedFood & { itemType: string })[]).filter((i) => i.itemType === 'food');
}

// Food buys ride the same atomic spend-and-grant as eggs, but the grant is a quantity
// upsert (food stacks) - the response reports the new stack size.
export async function buyFood(catalogKey: string, purchaseToken: string): Promise<{ quantity: number }> {
    const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogKey, purchaseToken }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 402) throw new InsufficientEmberError(typeof data.balance === 'number' ? data.balance : 0);
    if (res.status === 404) throw new EggUnavailableError(data.message || 'That item is not available.');
    if (!res.ok) throw new Error(data.message || `POST /api/shop/buy failed: ${res.status}`);
    return { quantity: (data.item?.quantity as number) ?? 0 };
}

// Server-ordered newest-first (created_at DESC) - the UI must not re-sort.
export async function getOwnedEggs(): Promise<OwnedEgg[] | null> {
    const res = await fetch('/api/inventory');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/inventory failed: ${res.status}`);
    return (data.eggs ?? []) as OwnedEgg[];
}

export async function getEmberBalance(): Promise<number | null> {
    const res = await fetch('/api/balance');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/balance failed: ${res.status}`);
    return typeof data.balance === 'number' ? data.balance : 0;
}

// null = no pet yet (a normal state), AND null on logged-out - callers that need to
// distinguish should check another GET's null first.
export async function getPet(): Promise<PetInfo | null> {
    const res = await fetch('/api/pets');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/pets failed: ${res.status}`);
    return (data.pet ?? null) as PetInfo | null;
}

// purchaseToken: crypto.randomUUID(), minted ONCE when the confirm step opens, reused
// verbatim on a retry of that same intent (that's what makes a double-submit debit
// once), discarded when the confirm is dismissed. inventoryItemId is null on an
// idempotent replay.
export async function buyEgg(catalogKey: string, purchaseToken: string): Promise<{ inventoryItemId: string | null }> {
    const res = await fetch('/api/shop/buy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ catalogKey, purchaseToken }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 402) throw new InsufficientEmberError(typeof data.balance === 'number' ? data.balance : 0);
    if (res.status === 404) throw new EggUnavailableError(data.message);
    if (!res.ok) throw new Error(data.message || `POST /api/shop/buy failed: ${res.status}`);
    return { inventoryItemId: (data.item?.inventoryItemId as string) ?? null };
}

// Feed the pet one unit of an owned food. feedToken: crypto.randomUUID() minted once
// per feed intent; a double-submit with the same token applies once (server-side
// last_feed_token gate). 409 = pet already at max (nothing consumed); 404 = no pet or
// no such food in stock.
export async function feedPet(foodCatalogKey: string, feedToken: string): Promise<{ pet: PetInfo }> {
    const res = await fetch('/api/pets/feed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ foodCatalogKey, feedToken }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 409) throw new PetFullError(data.message);
    if (res.status === 404) throw new EggGoneError(data.message || "You don't have that food.");
    if (!res.ok) throw new Error(data.message || `POST /api/pets/feed failed: ${res.status}`);
    return { pet: data.pet as PetInfo };
}

// One-time pet naming. 400 = invalid shape (server message explains the rules);
// 409 = taken (another pet or a username) or already named.
export async function namePet(name: string): Promise<{ pet: PetInfo }> {
    const res = await fetch('/api/pets/name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 409) throw new NameRejectedError(data.message, Boolean(data.taken));
    if (!res.ok) throw new Error(data.message || `POST /api/pets/name failed: ${res.status}`);
    return { pet: data.pet as PetInfo };
}

// The real, irreversible hatch: the server deletes the egg row and creates the pet in
// one transaction. created:false means a pet already existed (the egg was NOT consumed
// - one pet per account this build) or this request lost a double-fire race the other
// tap won; either way the returned pet is the account's real pet.
export async function hatchEgg(inventoryItemId: string): Promise<{ pet: PetInfo; created: boolean }> {
    const res = await fetch('/api/pets/hatch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryItemId }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 404) throw new EggGoneError(data.message);
    if (!res.ok) throw new Error(data.message || `POST /api/pets/hatch failed: ${res.status}`);
    return { pet: data.pet as PetInfo, created: Boolean(data.created) };
}
