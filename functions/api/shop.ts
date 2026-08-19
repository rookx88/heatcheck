// GET /api/shop - the currently-purchasable SKUs with their price and guaranteed result.
// "Known outcome only": every egg lists its exact resulting color and render mode here,
// at listing time - there is no rarity roll and no hidden-until-hatch outcome. Price is
// read live from each SKU's active ember_rules sink, so it always matches what buy will
// actually debit. Founder/time-boxed SKUs drop out of the list once their window closes.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession, requireOnboarded } from '../../lib/pages-functions/session';

interface ShopRow {
    key: string;
    item_type: string;
    name: string;
    config: Record<string, unknown>;
    available_until: string | null;
    price: number;
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sql = getSql(context.env);
    const rows = await sql`
        SELECT c.key, c.item_type, c.name, c.config, c.available_until,
               (r.config->>'amount')::int AS price
        FROM items_catalog c
        JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
        WHERE c.active = true
          AND c.item_type IN ('egg', 'food')
          AND (c.available_from IS NULL OR c.available_from <= NOW())
          AND (c.available_until IS NULL OR c.available_until > NOW())
        ORDER BY c.item_type, price, c.name
    `;
    const items = (rows as unknown as ShopRow[]).map((r) => ({
        catalogKey: r.key,
        itemType: r.item_type,
        name: r.name,
        price: r.price,
        // Egg: the guaranteed color + how it renders (hue/assetKey are the actual render
        // inputs the client derives the shown colorway from). Food: its satisfaction points.
        color: (r.config.color as string) ?? null,
        renderMode: (r.config.render_mode as string) ?? null,
        hue: (r.config.hue as number) ?? null,
        assetKey: (r.config.asset_key as string) ?? null,
        satisfactionPoints: (r.config.satisfaction_points as number) ?? null,
        // Food: which Tank Land shop stocks it ('quickboost' | 'champions').
        vendor: (r.config.vendor as string) ?? null,
        availableUntil: r.available_until,
    }));
    return jsonResponse({ items }, { headers: authHeaders });
};
