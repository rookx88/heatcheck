// GET /api/toolbar-state - the consolidated ambient read: session identity + Ember
// balance + pet + notifications in ONE request and one getSession() round-trip,
// replacing the 4-GET fan-out (/api/session, /api/balance, /api/pets,
// /api/notifications) the header chrome used to make per page load. Those endpoints
// stay for their other callers; this is what PetWidget/MapHud hydrate from.
//
// Gate semantics deviate from the requireOnboarded endpoints on purpose: no session is
// still 401, but an un-onboarded session gets { session, balance: null, pet: null,
// notifications: null } instead of a 403 - one endpoint has to serve every header
// state, including the "you still need to onboard" one (same reason /api/session has
// no gate).
//
// This endpoint is also the trigger surface for Pet Random Event Discovery
// (lib/pages-functions/discovery.ts): the roll check runs as a side effect of this
// ambient read, so there is no isolated player action that "is the check". The common
// case costs zero extra queries; when a roll actually grants, balance + notifications
// are re-read so the find (and its claimable notification) land in this same response.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';
import { petPublic, type FeedingConfig } from '../../lib/pages-functions/pets';
import { maybeDiscover, type DiscoveryPetRow } from '../../lib/pages-functions/discovery';

interface NotificationRow {
    id: string;
    type: string;
    message: string;
    ref_type: string | null;
    ref_id: string | null;
    read_at: string | null;
    claimed_at: string | null;
    created_at: string;
}

// Same wire mapping as functions/api/notifications.ts.
function mapNotifications(rows: NotificationRow[]) {
    return rows.map((r) => ({
        id: r.id,
        type: r.type,
        message: r.message,
        refType: r.ref_type,
        refId: r.ref_id,
        readAt: r.read_at,
        claimedAt: r.claimed_at,
        createdAt: r.created_at,
    }));
}

export const onRequestGet: PagesFunction<Env> = async (context) => {
    const session = await getSession(context.request, context.env);
    if (!session) return jsonResponse({ message: 'Login required.' }, { status: 401 });
    const authHeaders = session.refreshedSetCookie ? { 'Set-Cookie': session.refreshedSetCookie } : undefined;

    const sessionInfo = {
        userId: session.userId,
        email: session.email,
        verified: session.verified,
        username: session.username,
        onboarded: session.onboarded,
    };
    if (!session.onboarded) {
        return jsonResponse(
            { session: sessionInfo, balance: null, pet: null, notifications: null },
            { headers: authHeaders }
        );
    }

    const sql = getSql(context.env);
    const balanceStatement = () =>
        sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
    const notificationsStatement = () => sql`
        SELECT id, type, message, ref_type, ref_id, read_at, claimed_at, created_at
        FROM notifications WHERE user_id = ${session.userId}
        ORDER BY created_at DESC
        LIMIT 100
    `;

    // Independent reads, so the batched array form is right here - one Neon HTTP
    // round-trip instead of four.
    const [petRows, cfgRows, balanceRows, notificationRows] = await sql.transaction([
        sql`
            SELECT id, user_id, color, render_mode, render_config, name, is_captain,
                   satisfaction_at_last_feed, last_fed_at, next_eligible_roll_at
            FROM pets WHERE user_id = ${session.userId} LIMIT 1
        `,
        sql`SELECT config FROM game_config WHERE key = 'feeding' AND active = true LIMIT 1`,
        balanceStatement(),
        notificationsStatement(),
    ]);
    if (cfgRows.length === 0) throw new Error('No active game_config row for key "feeding"');
    const feedingCfg = (cfgRows[0] as unknown as { config: FeedingConfig }).config;
    const pet = petRows.length ? (petRows[0] as unknown as DiscoveryPetRow) : null;

    let balanceValue = balanceRows.length ? (balanceRows[0] as unknown as { balance: number }).balance : 0;
    let notifications = mapNotifications(notificationRows as unknown as NotificationRow[]);

    // Petless accounts no-op inside maybeDiscover before it touches anything - the
    // precondition lives in the module so every trigger surface inherits it.
    const outcome = await maybeDiscover(sql, { userId: session.userId, pet, feedingCfg });
    if (outcome.kind === 'found_ember' || outcome.kind === 'found_food') {
        // Rare path: a find just landed - re-read so this response already carries the
        // new balance and the claimable notification instead of them popping in a
        // fetch later.
        const [freshBalance, freshNotifications] = await sql.transaction([
            balanceStatement(),
            notificationsStatement(),
        ]);
        balanceValue = freshBalance.length ? (freshBalance[0] as unknown as { balance: number }).balance : 0;
        notifications = mapNotifications(freshNotifications as unknown as NotificationRow[]);
    }

    return jsonResponse(
        {
            session: sessionInfo,
            balance: balanceValue,
            pet: pet ? petPublic(pet, feedingCfg) : null,
            notifications,
        },
        { headers: authHeaders }
    );
};
