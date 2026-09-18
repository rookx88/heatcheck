// GET /api/shop - the currently-purchasable SKUs with their price and guaranteed result.
// "Known outcome only": every egg lists its exact resulting color and render mode here,
// at listing time - there is no rarity roll and no hidden-until-hatch outcome. Price is
// read live from each SKU's active ember_rules sink, so it always matches what buy will
// actually debit. Founder/time-boxed SKUs drop out of the list once their window closes.
//
// Scarcity is a COUNT, in the same spirit: each egg colour is a run of 500 for the
// entire user base (add_egg_supply_caps.sql), and supply/remaining say exactly where
// that run stands. A colour that runs out stays listed at remaining 0 - sold out is a
// thing the shelf shows, not a thing that quietly disappears.

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
    supply: number | null;    // null = uncapped (no sku_supply row)
    remaining: number | null; // units of the site-wide run left; 0 = sold out
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
               (r.config->>'amount')::int AS price,
               -- Finite supply, shared by the whole user base (add_egg_supply_caps.sql).
               -- A LEFT join: a SKU with no pool row is uncapped and both columns come
               -- back null. GREATEST(...,0) so a sold-out row reads 0 rather than a
               -- negative, which the CHECK constraint should make impossible anyway.
               s.supply,
               GREATEST(s.supply - s.sold_count, 0) AS remaining
        FROM items_catalog c
        JOIN ember_rules r ON r.key = c.price_rule_key AND r.active = true
        LEFT JOIN sku_supply s ON s.catalog_key = c.key
        WHERE c.active = true
          AND c.item_type IN ('egg', 'food')
          -- A food with no config.vendor is stocked by no shop: it's a discovery-only
          -- SKU (add_discovery_foods.sql), active and feedable but never for sale.
          -- The vendor FILTER is client-side (egg-shop-client getShopFood), so without
          -- this the seven concession foods would still be listed here with
          -- vendor: null and be buyable by key. Eggs have no vendor and are unaffected.
          AND (c.item_type <> 'food' OR c.config ? 'vendor')
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
        // A couple of sentences about the item, shown as a hover/tap tooltip
        // (components/ItemTooltip.tsx). Same config key on every item type.
        description: (r.config.description as string) ?? null,
        availableUntil: r.available_until,
        // Scarcity, as a count rather than a tier: how many of this SKU will ever be
        // sold and how many are left. Both null on an uncapped SKU (every food today).
        // A sold-out SKU deliberately STAYS in this list with remaining 0 - the shelf
        // showing an empty slot is the point, and /api/shop/buy refuses it with a 409
        // whatever the client does with that.
        supply: r.supply ?? null,
        remaining: r.supply === null ? null : (r.remaining ?? 0),
    }));
    return jsonResponse({ items }, { headers: authHeaders });
};
