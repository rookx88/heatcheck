// POST /api/pets/feed - consume one held food item and top up the pet's satisfaction.
// Feeding spends no Ember (buying the food did). Feeding a pet already at max is a hard
// constraint, not a silent no-op: it is rejected outright before any write, matching the
// daily-pick-cap's reject-then-nothing pattern. Otherwise the food is consumed and
// satisfaction rises by the food's points, clamped to max, atomically. A double-submit
// with the same feedToken applies once. No numeric satisfaction ever leaves here - only
// the Hungry/Satisfied label.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, UUID_RE, type Env } from '../../../lib/pages-functions/db';
import { getSession, requireSameOrigin, requireOnboarded } from '../../../lib/pages-functions/session';
import { feed, getGameConfig, computeSatisfaction, petPublic, type FeedingConfig, type PetRow } from '../../../lib/pages-functions/pets';

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
    const foodCatalogKey = typeof body?.foodCatalogKey === 'string' ? body.foodCatalogKey.trim() : '';
    const feedToken = typeof body?.feedToken === 'string' && UUID_RE.test(body.feedToken) ? body.feedToken : '';
    if (!foodCatalogKey) return jsonResponse({ message: 'Missing foodCatalogKey.' }, { status: 400, headers: authHeaders });
    if (!feedToken) return jsonResponse({ message: 'Missing or invalid feedToken.' }, { status: 400, headers: authHeaders });

    const sql = getSql(context.env);

    try {
        const cfg = (await getGameConfig(sql, 'feeding')) as unknown as FeedingConfig;

        const petRows = await sql`SELECT id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at, last_feed_token FROM pets WHERE user_id = ${session.userId} LIMIT 1`;
        if (petRows.length === 0) {
            return jsonResponse({ message: 'You have no pet to feed yet.' }, { status: 404, headers: authHeaders });
        }
        const pet = petRows[0] as unknown as PetRow & { last_feed_token: string | null };
        const current = computeSatisfaction(pet, cfg);

        // Hard ceiling: reject at (or above) max before any write. Checked at exactly max.
        if (current >= cfg.max_satisfaction) {
            return jsonResponse(
                { message: 'Your pet is already full — no need to feed right now.', full: true },
                { status: 409, headers: authHeaders }
            );
        }

        // The food SKU's satisfaction_points.
        const foodRows = await sql`SELECT config FROM items_catalog WHERE key = ${foodCatalogKey} AND item_type = 'food' LIMIT 1`;
        if (foodRows.length === 0) {
            return jsonResponse({ message: 'Unknown food.' }, { status: 400, headers: authHeaders });
        }
        const points = Number((foodRows[0].config as Record<string, unknown>)?.satisfaction_points ?? 0);

        const updated = await feed(sql, {
            userId: session.userId,
            foodCatalogKey,
            points,
            currentSatisfaction: current,
            max: cfg.max_satisfaction,
            feedToken,
        });

        if (updated) {
            return jsonResponse({ pet: petPublic(updated, cfg) }, { headers: authHeaders });
        }

        // Nothing consumed. Either an idempotent retry (this token already fed the pet),
        // or there's no food to consume.
        if (pet.last_feed_token === feedToken) {
            return jsonResponse({ pet: petPublic(pet, cfg) }, { headers: authHeaders });
        }
        return jsonResponse({ message: "You don't have that food." }, { status: 404, headers: authHeaders });
    } catch (err) {
        console.error('[POST /api/pets/feed] Error:', err);
        return jsonResponse({ message: 'Internal server error' }, { status: 500, headers: authHeaders });
    }
};
