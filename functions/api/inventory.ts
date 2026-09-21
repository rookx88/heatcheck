// GET /api/inventory - the account's owned items with display metadata. Empty arrays for
// a new account (a legitimate zero-state, not a 404). Four shapes, matching how the
// four kinds are owned:
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
//   memorabilia  - stacked trinkets the pet digs up (add_memorabilia_items.sql). The
//                  FOOD model, not the collectible one: no serial, no mint cap, just a
//                  quantity - scarcity is the drop weight, not a supply ledger. Art
//                  comes from config.image (the collectibles' cover_image contract), so
//                  the client never derives a path from the key.
//
// Every shape carries `description` off config.description - the hover copy rendered by
// components/ItemTooltip.tsx. One key name across all item types, so the tooltip needs
// no per-type branch.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';

interface InventoryRow {
    catalog_key: string;
    item_type: string;
    name: string;
    config: Record<string, unknown>;
    quantity: number;
    is_equipped: boolean;
    slot: string | null;
}

interface MemorabiliaRow {
    catalog_key: string;
    name: string;
    config: Record<string, unknown>;
    quantity: number;
    created_at: string;
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

    // Four independent reads of the same table, so they go in ONE batched round trip
    // rather than four sequential ones (the shape toolbar-state.ts uses, and for the
    // same reason). The inventory modal opens all four tabs' data at once, so this was
    // the single most round-trip-heavy read on the site (efficiency audit, 2026-09-20).
    // Newest-first orderings below are contracts the UI shuffles in - id DESC tiebreaks
    // rows sharing created_at (migrated clones, rapid buys).
    const [rows, eggRows, collectibleRows, memorabiliaRows] = await sql.transaction([
        sql`
            SELECT i.catalog_key, i.item_type, c.name, c.config, i.quantity, i.is_equipped, i.slot
            FROM inventory_items i
            JOIN items_catalog c ON c.key = i.catalog_key
            WHERE i.user_id = ${session.userId}
              AND (i.item_type = 'food' AND i.quantity > 0 OR i.item_type = 'equipment')
            ORDER BY i.item_type, c.name
        `,
        sql`
            SELECT i.id, i.catalog_key, c.name, c.config, i.created_at
            FROM inventory_items i
            JOIN items_catalog c ON c.key = i.catalog_key
            WHERE i.user_id = ${session.userId} AND i.item_type = 'egg'
            ORDER BY i.created_at DESC, i.id DESC
        `,
        sql`
            SELECT i.id, i.catalog_key, c.name, c.config, i.serial_number, i.created_at
            FROM inventory_items i
            JOIN items_catalog c ON c.key = i.catalog_key
            WHERE i.user_id = ${session.userId} AND i.item_type = 'collectible'
            ORDER BY i.created_at DESC, i.id DESC
        `,
        // Stacked like food, so one row per SKU with a quantity - created_at is when the
        // stack STARTED, which is the honest "first found" date and what the tab shows.
        sql`
            SELECT i.catalog_key, c.name, c.config, i.quantity, i.created_at
            FROM inventory_items i
            JOIN items_catalog c ON c.key = i.catalog_key
            WHERE i.user_id = ${session.userId} AND i.item_type = 'memorabilia' AND i.quantity > 0
            ORDER BY i.created_at DESC, i.catalog_key
        `,
    ]);

    const items = (rows as unknown as InventoryRow[]).map((r) => ({
        catalogKey: r.catalog_key,
        itemType: r.item_type,
        name: r.name,
        quantity: r.quantity,
        isEquipped: r.is_equipped,
        slot: r.slot,
        description: (r.config.description as string) ?? null,
    }));

    const eggs = (eggRows as unknown as EggRow[]).map((r) => ({
        id: r.id,
        catalogKey: r.catalog_key,
        name: r.name,
        color: (r.config.color as string) ?? null,
        renderMode: (r.config.render_mode as string) ?? null,
        hue: (r.config.hue as number) ?? null,
        assetKey: (r.config.asset_key as string) ?? null,
        description: (r.config.description as string) ?? null,
        acquiredAt: r.created_at,
    }));

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
        description: (r.config.description as string) ?? null,
        acquiredAt: r.created_at,
    }));

    const memorabilia = (memorabiliaRows as unknown as MemorabiliaRow[]).map((r) => ({
        catalogKey: r.catalog_key,
        name: r.name,
        quantity: r.quantity,
        image: (r.config.image as string) ?? null,
        description: (r.config.description as string) ?? null,
        acquiredAt: r.created_at,
    }));

    return jsonResponse({ items, eggs, collectibles, memorabilia }, { headers: authHeaders });
};
