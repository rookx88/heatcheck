// POST /api/notify-sweep - protected, machine-to-machine only (worker-curate/'s daily
// cron fires it right after /api/ticker-sweep; shares X-Curate-Secret - same caller,
// same trust domain). Its own endpoint for the same reason ticker-sweep is: every
// Pages Function invocation has a hard subrequest budget, so daily housekeeping runs
// as its own request. This one is cheap anyway - two set-based SQL statements, zero
// external calls.
//
// Two idempotent notification writers ('informational' rows; settlement's 'claimable'
// path is elsewhere and untouched):
//
// 1. PET HUNGRY - satisfaction is derive-on-read (lib/pages-functions/pets.ts, no
//    decay cron), so the Hungry crossing is observable only by computing it from the
//    stored facts - which this does in SQL against the active game_config['feeding']
//    row. Key 'hungry:<petId>:<epoch of last_fed_at>' = exactly one notification per
//    feed-cycle: feeding resets last_fed_at (re-arming the next cycle), and a
//    still-hungry pet never re-nags on later runs.
//
// 2. DAILY DROP DIGEST - one row per onboarded user per UTC day, ONLY when new Tanks
//    were published in the last 24h (no new content = no notification; a bare "pick
//    refreshed" every single day is spam). Key 'daily:<userId>:<date>'.
//
// Safe to call any time, any number of times - both writers are ON CONFLICT no-ops.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const sql = getSql(context.env);

    // 1. Pet hungry. The satisfaction expression mirrors pets.ts's computeSatisfaction
    // (decay per hour since last feed, floored at 0 - the floor can't matter for a
    // below-threshold comparison). Message is in the pet's voice - the widget bubble
    // speaks it.
    const hungryRows = await sql`
        INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
        SELECT p.user_id, 'informational',
               'My tummy''s rumbling — I haven''t eaten in a while. Got a snack for me?',
               'pet', p.id::text,
               'hungry:' || p.id || ':' || FLOOR(EXTRACT(EPOCH FROM p.last_fed_at))::bigint
        FROM pets p,
             (SELECT config FROM game_config WHERE key = 'feeding' AND active LIMIT 1) cfg
        WHERE p.satisfaction_at_last_feed
                - (cfg.config->>'decay_rate_per_hour')::numeric
                  * (EXTRACT(EPOCH FROM (NOW() - p.last_fed_at)) / 3600)
              < (cfg.config->>'hungry_threshold')::numeric
        ON CONFLICT (idempotency_key) DO NOTHING
        RETURNING id
    `;

    // 2. Daily drop digest. Count first (also feeds the message's singular/plural);
    // zero new Tanks = no inserts at all.
    const countRows = await sql`
        SELECT COUNT(*)::int AS n FROM tank_pages
        WHERE status = 'published' AND visibility = 'app'
          AND published_at > NOW() - INTERVAL '24 hours'
    `;
    const newTanks = (countRows[0]?.n as number) ?? 0;
    let digestCount = 0;
    if (newTanks > 0) {
        const message = newTanks === 1
            ? 'Fresh drop: a new Tank just landed and your daily pick is refreshed — come make your call!'
            : `Fresh drop: ${newTanks} new Tanks just landed and your daily pick is refreshed — come make your call!`;
        const digestRows = await sql`
            INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
            SELECT w.id, 'informational', ${message}, 'tanks', CURRENT_DATE::text,
                   'daily:' || w.id || ':' || CURRENT_DATE
            FROM waitlist w
            WHERE w.onboarded_at IS NOT NULL
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
        `;
        digestCount = digestRows.length;
    }

    return jsonResponse({
        hungryNotifications: hungryRows.length,
        newTanksLast24h: newTanks,
        digestNotifications: digestCount,
    });
};
