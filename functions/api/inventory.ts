// GET /api/inventory - the account's owned items with display metadata. Empty arrays for
// a new account (a legitimate zero-state, not a 404). Three shapes, matching how the
// three kinds are owned:
//   items        - stacked consumables (food) plus persistent equipment (declared type,
//                  no shipped SKUs yet).
//   eggs         - one entry PER OWNED EGG, newest-first. Eggs are never
//                  quantity-stacked: each is its own inventory row with its own id,
//                  which is exactly what hatch consumes. Two same-color eggs are
//                  genuinely identical — same SKU, no distinguishing data beyond which
//                  row they are.
//   collectibles - one entry PER OWNED CARD, newest-first (the egg model, NOT the food
//                  stack): each row carries its serial_number, and the catalog config
//                  supplies the display metadata (edition, mint size, cover art, the
//                  match text inside the card).

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';

interface InventoryRow {
    catalog_key: string;
    item_type: string;
    name: string;
    quantity: number;
    is_equipped: boolean;
    slot: string | null;
}

interface EggRow {
    id: string;
    catalog_key: string;
    name: string;
    config: Record<string, unknown>;
    created_at: string;
}

interface CollectibleRow {
    id: string;
    catalog_key: string;
    name: string;
    config: Record<string, unknown>;
    serial_number: number;
    created_at: string;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const rows = await sql`
        SELECT i.catalog_key, i.item_type, c.name, i.quantity, i.is_equipped, i.slot
        FROM inventory_items i
        JOIN items_catalog c ON c.key = i.catalog_key
        WHERE i.user_id = ${session.userId}
          AND (i.item_type = 'food' AND i.quantity > 0 OR i.item_type = 'equipment')
        ORDER BY i.item_type, c.name
    `;
    const items = (rows as unknown as InventoryRow[]).map((r) => ({
        catalogKey: r.catalog_key,
        itemType: r.item_type,
        name: r.name,
        quantity: r.quantity,
        isEquipped: r.is_equipped,
        slot: r.slot,
    }));

    // Newest-first is the contract the inventory/incubator UI shuffles in. id DESC
    // tiebreaks rows sharing created_at (migrated clones, rapid buys).
    const eggRows = await sql`
        SELECT i.id, i.catalog_key, c.name, c.config, i.created_at
        FROM inventory_items i
        JOIN items_catalog c ON c.key = i.catalog_key
        WHERE i.user_id = ${session.userId} AND i.item_type = 'egg'
        ORDER BY i.created_at DESC, i.id DESC
    `;
    const eggs = (eggRows as unknown as EggRow[]).map((r) => ({
        id: r.id,
        catalogKey: r.catalog_key,
        name: r.name,
        color: (r.config.color as string) ?? null,
        renderMode: (r.config.render_mode as string) ?? null,
        hue: (r.config.hue as number) ?? null,
        assetKey: (r.config.asset_key as string) ?? null,
        acquiredAt: r.created_at,
    }));

    const collectibleRows = await sql`
        SELECT i.id, i.catalog_key, c.name, c.config, i.serial_number, i.created_at
        FROM inventory_items i
        JOIN items_catalog c ON c.key = i.catalog_key
        WHERE i.user_id = ${session.userId} AND i.item_type = 'collectible'
        ORDER BY i.created_at DESC, i.id DESC
    `;
    const collectibles = (collectibleRows as unknown as CollectibleRow[]).map((r) => ({
        id: r.id,
        catalogKey: r.catalog_key,
        name: r.name,
        edition: (r.config.edition as string) ?? null,
        series: (r.config.series as string) ?? null,
        serial: r.serial_number,
        mintSize: (r.config.mint_size as number) ?? null,
        coverImage: (r.config.cover_image as string) ?? null,
        matchTitle: (r.config.match_title as string) ?? null,
        matchCaption: (r.config.match_caption as string) ?? null,
        acquiredAt: r.created_at,
    }));

    return jsonResponse({ items, eggs, collectibles }, { headers: authHeaders });
};
