// POST /api/shop/buy - buy one unit of a consumable SKU (egg or food) with Ember. The
// debit and the item grant happen in one atomic, idempotent statement
// (ledger.purchaseConsumable), so a rapid double-submit with the same purchaseToken
// debits once and grants once. No client-asserted price or grant is ever trusted: the
// server reads the SKU's price from its ember_rules sink and does the whole thing
// server-side. Insufficient balance -> 402, nothing written.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { purchaseConsumable } from '../../../lib/pages-functions/ledger';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const csrf = requireSameOrigin(context.request);
    if (csrf) return csrf;

    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const gate = requireOnboarded(session);
    if (gate) return gate;
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    let body: any;
    try {
        body = await context.request.json();
    } catch {
        return jsonResponse({ message: 'Invalid JSON body.' }, { status: 400, headers: authHeaders });
    }

    const catalogKey = typeof body?.catalogKey === 'string' ? body.catalogKey.trim() : '';
    // A client-supplied idempotency token (UUID): a double-submit reuses it and no-ops.
    const purchaseToken = typeof body?.purchaseToken === 'string' && UUID_RE.test(body.purchaseToken) ? body.purchaseToken : '';
    if (!catalogKey) return jsonResponse({ message: 'Missing catalogKey.' }, { status: 400, headers: authHeaders });
    if (!purchaseToken) return jsonResponse({ message: 'Missing or invalid purchaseToken.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);

    // The SKU must exist, be active, be a buyable consumable, and be inside its purchase
    // window (founder eggs are time-boxed). Equipment is not buyable this build.
    const skuRows = await sql`
        SELECT item_type, price_rule_key
        FROM items_catalog
        WHERE key = ${catalogKey}
          AND active = true
          AND item_type IN ('egg', 'food')
          AND (available_from IS NULL OR available_from <= NOW())
          AND (available_until IS NULL OR available_until > NOW())
        LIMIT 1
    `;
    if (skuRows.length === 0) {
        return jsonResponse({ message: 'That item is not available.' }, { status: 404, headers: authHeaders });
    }
    const itemType = skuRows[0].item_type as string;
    const priceRuleKey = skuRows[0].price_rule_key as string;

    try {
        const result = await purchaseConsumable(sql, {
            userId: session.userId,
            priceRuleKey,
            catalogKey,
            itemType,
            purchaseScope: purchaseToken,
        });
        if (!result.ok) {
            const balanceRows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
            const balance = balanceRows.length ? (balanceRows[0].balance as number) : 0;
            return jsonResponse({ message: 'Not enough Ember.', balance }, { status: 402, headers: authHeaders });
        }
        const qtyRows = await sql`SELECT quantity FROM inventory_items WHERE user_id = ${session.userId} AND catalog_key = ${catalogKey} LIMIT 1`;
        const quantity = qtyRows.length ? (qtyRows[0].quantity as number) : 0;
        return jsonResponse({ ok: true, item: { catalogKey, quantity } }, { headers: authHeaders });
    } catch (err) {
        console.error('[POST /api/shop/buy] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
