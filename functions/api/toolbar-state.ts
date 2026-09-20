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
// ambient read, so there is no isolated player action that "is the check". The chrome
// passes the page it's on as `?place=<pathname>` so the pet's footprints (the
// exploration gate) accumulate from the same call - the server derives the place key
// from an allowlist, and an unknown path is simply ignored. The common case costs zero
// extra queries (one UPDATE only when the place is new for the pet); when a roll
// actually grants, balance + notifications are re-read so the find (and its claimable
// notification) land in this same response.
//
// NPC encounters (lib/pages-functions/encounters/) ride the same read: one extra
// statement in the batch gathers the facts (lifetime Ember, counts, memorabilia held, the
// user's encounter and Play rows), evaluateEncounters() completes any Play that is done -
// including handing over a delivery when this page is the character's home - and fires
// at most one new encounter, and the
// response carries `encounter` - the oldest one the player hasn't watched yet - for the
// EncounterStage to play. An encounter writes NO notification (the scene shows what it
// hands over, so an inbox echo of it was redundant); it still shares the re-read below
// because its Ember gift moves the balance in this same response.

import type { PagesFunction } from '@cloudflare/workers-types';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { getSession } from '../../lib/pages-functions/session';
import { petPublic, unwrapGameConfig, type FeedingConfig } from '../../lib/pages-functions/pets';
import { maybeDiscover, sustainedSatisfied, type DiscoveryConfig, type DiscoveryPetRow } from '../../lib/pages-functions/discovery';
import { buildFacts, encounterFactsStatement, evaluateEncounters, type EncounterFactsRow, type PetFacts } from '../../lib/pages-functions/encounters/evaluate';
import { forcedFind } from '../../lib/pages-functions/encounters/plays';

interface NotificationRow {
    id: string;
    type: string;
    message: string;
    ref_type: string | null;
    ref_id: string | null;
    read_at: string | null;
    claimed_at: string | null;
    created_at: string;
    mood: 'happy' | 'sad' | null;
    art: string | null;
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
        mood: r.mood,
        art: r.art,
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
            { session: sessionInfo, balance: null, pet: null, notifications: null, encounter: null },
            { headers: authHeaders }
        );
    }

    const sql = getSql(context.env);
    const balanceStatement = () =>
        sql`SELECT balance FROM ember_balances WHERE user_id = ${session.userId} LIMIT 1`;
    const notificationsStatement = () => sql`
        SELECT id, type, message, ref_type, ref_id, read_at, claimed_at, created_at, mood, art
        FROM notifications WHERE user_id = ${session.userId}
        ORDER BY created_at DESC
        LIMIT 100
    `;

    // Independent reads, so the batched array form is right here - one Neon HTTP
    // round-trip instead of six. The discovery config joins the batch because the Plays
    // care objective needs its sustained_hours; it is then handed to maybeDiscover, which
    // would otherwise read the same row again later in the request.
    const [petRows, cfgRows, balanceRows, notificationRows, factsRows, discoveryCfgRows] = await sql.transaction([
        sql`
            SELECT id, user_id, color, render_mode, render_config, name, is_captain,
                   satisfaction_at_last_feed, last_fed_at, next_eligible_roll_at, places_since_find, feed_count, find_count
            FROM pets WHERE user_id = ${session.userId} LIMIT 1
        `,
        sql`SELECT config FROM game_config WHERE key = 'feeding' AND active = true LIMIT 1`,
        balanceStatement(),
        notificationsStatement(),
        encounterFactsStatement(sql, session.userId),
        sql`SELECT config FROM game_config WHERE key = 'discovery' AND active = true LIMIT 1`,
    ]);
    // Same guard the getGameConfig helper applies, shared rather than re-typed: these two
    // rows ride the batch above (one round trip for six statements), so they can't call
    // the helper itself without giving that up.
    const feedingCfg = unwrapGameConfig(cfgRows, 'feeding') as unknown as FeedingConfig;
    const discoveryCfg = unwrapGameConfig(discoveryCfgRows, 'discovery') as unknown as DiscoveryConfig;
    const pet = petRows.length ? (petRows[0] as unknown as DiscoveryPetRow & { feed_count: number; name: string | null }) : null;
    const factsRow = factsRows.length ? (factsRows[0] as unknown as EncounterFactsRow) : null;
    // What only this request knows about the pet. Sustained satisfaction uses discovery's
    // own definition, so "kept fed" means the same thing to a Play as it does to the
    // short find cooldown.
    const petFacts: PetFacts | null = pet
        ? {
              feedCount: Number(pet.feed_count ?? 0),
              named: typeof pet.name === 'string' && pet.name.length > 0,
              sustainedSatisfied: sustainedSatisfied(pet, feedingCfg, discoveryCfg.sustained_hours),
          }
        : null;

    let balanceValue = balanceRows.length ? (balanceRows[0] as unknown as { balance: number }).balance : 0;
    let notifications = mapNotifications(notificationRows as unknown as NotificationRow[]);

    // Petless accounts no-op inside maybeDiscover before it touches anything - the
    // precondition lives in the module so every trigger surface inherits it. The raw
    // ?place= goes through untouched: normalization and the allowlist are the module's.
    const placePath = new URL(context.request.url).searchParams.get('place');
    const outcome = await maybeDiscover(sql, {
        userId: session.userId,
        pet,
        feedingCfg,
        cfg: discoveryCfg,
        placePath,
        // The Plays find guarantee, evaluated only if a roll is actually due. Reads the
        // batch facts already in hand, so it costs no query.
        forcedFind: pet && factsRow && petFacts
            ? (everyNth) => {
                  const facts = buildFacts(factsRow, petFacts, placePath);
                  return forcedFind(facts.plays, facts, Number(pet.find_count ?? 0), everyNth);
              }
            : undefined,
    });
    // Every find kind, matched by prefix rather than listed: a new reward category
    // (memorabilia was one) must not be able to ship with the re-read silently
    // skipped, which would leave that drop invisible until the NEXT poll - rare
    // enough to pass a casual test and confusing when it happens.
    const found = outcome.kind.startsWith('found_');
    // A find changed what a delivery counts - memorabilia or food, since a Play can ask
    // for either. Fold it into the facts so a player who finds the last item while
    // standing at the character's home hands it over on this same page load.
    if (factsRow && (outcome.kind === 'found_memorabilia' || outcome.kind === 'found_food')) {
        const held = { ...(factsRow.holdings ?? {}) };
        held[outcome.catalogKey] = Number(held[outcome.catalogKey] ?? 0) + 1;
        factsRow.holdings = held;
    }

    // Encounters: petless no-ops before any query, same as discovery.
    const encounters = await evaluateEncounters(sql, {
        userId: session.userId,
        pet: pet && petFacts ? { id: pet.id, ...petFacts } : null,
        placePath,
        facts: factsRow,
    });

    if (found || encounters.fired || encounters.delivered) {
        // Rare path: a find or an encounter just landed - re-read so this response
        // already carries the new balance and the notification instead of them
        // popping in a fetch later.
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
            encounter: encounters.pending,
        },
        { headers: authHeaders }
    );
};
