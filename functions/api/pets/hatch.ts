// POST /api/pets/hatch - consume one held egg and create the account's pet, atomically.
// A pet is created ONLY here, never auto-provisioned. One pet per account this build:
// if a pet already exists the egg is left untouched and the existing pet is returned
// (so a double-submit, or a second hatch attempt, is a safe no-op). The egg's color /
// render_mode / render_config are copied onto the pet from the SKU's catalog config.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { hatch, getGameConfig, petPublic, type FeedingConfig, type PetRow } from '../../../lib/pages-functions/pets';

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
    const eggCatalogKey = typeof body?.eggCatalogKey === 'string' ? body.eggCatalogKey.trim() : '';
    if (!eggCatalogKey) return jsonResponse({ message: 'Missing eggCatalogKey.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);

    try {
        const cfg = (await getGameConfig(sql, 'feeding')) as unknown as FeedingConfig;

        // Already has a pet -> return it, egg untouched (idempotent; enforces one pet).
        const existingRows = await sql`SELECT id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at FROM pets WHERE user_id = ${session.userId} LIMIT 1`;
        if (existingRows.length > 0) {
            return jsonResponse({ pet: petPublic(existingRows[0] as unknown as PetRow, cfg), created: false }, { headers: authHeaders });
        }

        // Look up the egg SKU's render attributes.
        const eggRows = await sql`SELECT config FROM items_catalog WHERE key = ${eggCatalogKey} AND item_type = 'egg' LIMIT 1`;
        if (eggRows.length === 0) {
            return jsonResponse({ message: 'Unknown egg.' }, { status: 400, headers: authHeaders });
        }
        const eggConfig = (eggRows[0].config as Record<string, unknown>) ?? {};
        const color = String(eggConfig.color ?? 'default');
        const renderMode = String(eggConfig.render_mode ?? 'filter');
        const renderConfig = renderMode === 'custom_asset'
            ? { asset_key: eggConfig.asset_key }
            : { hue: eggConfig.hue };
        const startSatisfaction = Number(cfg.hatch_start_satisfaction ?? 100);

        const pet = await hatch(sql, {
            userId: session.userId,
            eggCatalogKey,
            color,
            renderMode,
            renderConfig,
            startSatisfaction,
        });
        if (!pet) {
            // No egg was available to consume (e.g. quantity 0, or a race lost the egg).
            return jsonResponse({ message: "You don't have that egg to hatch." }, { status: 404, headers: authHeaders });
        }
        return jsonResponse({ pet: petPublic(pet, cfg), created: true }, { status: 201, headers: authHeaders });
    } catch (err: any) {
        // A racing hatch won the captain slot first: report the pet that actually exists.
        if (err?.code === '23505') {
            try {
                const sqlRetry = getSql(context.env);
                const cfg = (await getGameConfig(sqlRetry, 'feeding')) as unknown as FeedingConfig;
                const rows = await sqlRetry`SELECT id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at FROM pets WHERE user_id = ${session.userId} LIMIT 1`;
                if (rows.length > 0) {
                    return jsonResponse({ pet: petPublic(rows[0] as unknown as PetRow, cfg), created: false }, { headers: authHeaders });
                }
            } catch { /* fall through */ }
        }
        console.error('[POST /api/pets/hatch] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
