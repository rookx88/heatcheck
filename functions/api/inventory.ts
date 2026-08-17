// GET /api/inventory - the account's owned items with display metadata. Empty for a new
// account (a legitimate zero-state, not a 404). Consumables (egg/food) report quantity;
// equipment fields are carried for forward-compatibility but no equipment ships yet.

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
          AND (i.item_type IN ('egg', 'food') AND i.quantity > 0 OR i.item_type = 'equipment')
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
    return jsonResponse({ items }, { headers: authHeaders });
};
