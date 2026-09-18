// NPC encounters - server-side evaluation. Runs as a side effect of GET
// /api/toolbar-state right after discovery's roll, on the same doctrine: the server
// owns every fact, the client only ever sees the result, and everything that grants
// is one atomic statement whose race guard is an INSERT ... ON CONFLICT DO NOTHING
// that every grant leg selects FROM (see create_encounters.sql).
//
// Cost model: the facts arrive in the endpoint's existing batch (encounterFactsStatement
// rides the same HTTP round trip as the pet SELECT), so the common case - nothing new
// fireable, no open Play touched by this page - costs zero extra queries. Reading
// game_config['encounters'] is skipped whenever no unfired encounter needs a threshold.
// At most ONE encounter fires per request, in registry order, so two characters never
// arrive on the same page load.
//
// Pure functions (triggerSatisfied, fireableEncounters, and the Play rules in plays.ts)
// carry the rules and are imported directly by the acceptance suite. Adding a
// trigger/objective kind is one case here or in plays.ts; adding an effect kind is one
// leg in fireEncounter's statement.

import type { NeonQueryFunction } from '@neondatabase/serverless';
import { getGameConfig } from '../pets';
import { placeFromPath } from '../discovery';
import { encounterGiftEmber } from '../ledger';
import { itemIdempotencyKey } from '../item-ledger';
import { CHARACTERS, ENCOUNTERS, ENCOUNTER_BY_KEY } from './index';
import { deliverPlay } from './deliver';
import { deliveryOf, placeMatches, playComplete, type PlayFacts, type PlayRow, type StoredObjective } from './plays';
import type { Encounter, EncounterGrants, EncounterView, Objective, PlayDefinition, Trigger } from './types';

export { placeMatches };
export type { PlayRow };

export interface EncounterRow {
    id: string;
    key: string;
    status: 'offered' | 'seen';
    grants: EncounterGrants;
}

// The row encounterFactsStatement returns (json columns arrive parsed).
export interface EncounterFactsRow {
    lifetime_earned: number;
    picks: number;
    collectibles: number;
    encounters: EncounterRow[];
    plays: PlayRow[];
    // Memorabilia AND food held, catalog key -> quantity. Both, because a delivery Play
    // can ask for either.
    holdings: Record<string, number>;
    // Settled picks that came in.
    wins: number;
    // Positions closed above cost.
    profit_sells: number;
    // TANKDAQ positions held now, ticker key -> shares.
    shares: Record<string, number>;
    // Any held position older than one of its index's daily closes.
    held_through_close: boolean;
}

// What only the request knows about the pet. `sustainedSatisfied` is computed by the
// caller with discovery's own rule (discovery.ts sustainedSatisfied), so the Play and
// the short find cooldown can never disagree about what "kept fed" means.
export interface PetFacts {
    feedCount: number;
    named: boolean;
    sustainedSatisfied: boolean;
}

// Everything a trigger or objective can ask about, in one object.
export interface Facts extends PlayFacts {
    collectibles: number;
    encounters: EncounterRow[];
    plays: PlayRow[];
}

// One statement for the toolbar-state batch. Petless users get zero rows (the EXISTS
// guard is an index probe), so evaluateEncounters no-ops for them without a query of
// its own. This runs on every page load for every pet owner: every subquery must stay
// index-backed - ember_balances PK, idx_picks_waitlist_created, idx_inventory_user_id,
// idx_encounters_user_key, idx_plays_user_key, idx_share_holdings_user,
// idx_share_trades_user_created, idx_ticker_events_key_time. Do not join anything
// unindexed here.
//
// The picks and inventory facts are FILTERed aggregates over one scan each rather than
// separate subqueries over the same index, so counting wins costs nothing beyond
// counting picks, and holdings cover food and memorabilia in one pass.
export function encounterFactsStatement(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`
        SELECT
            COALESCE((SELECT lifetime_earned FROM ember_balances WHERE user_id = ${userId}), 0)::int AS lifetime_earned,
            (SELECT COUNT(*) FROM picks WHERE waitlist_id = ${userId})::int AS picks,
            (SELECT COUNT(*) FILTER (WHERE result = 'correct')
             FROM picks WHERE waitlist_id = ${userId})::int AS wins,
            (SELECT COUNT(*) FROM inventory_items WHERE user_id = ${userId} AND item_type = 'collectible')::int AS collectibles,
            COALESCE((SELECT json_object_agg(m.catalog_key, m.quantity)
                      FROM inventory_items m
                      WHERE m.user_id = ${userId} AND m.item_type IN ('memorabilia', 'food')), '{}'::json) AS holdings,
            (SELECT COUNT(*) FROM share_trades
             WHERE user_id = ${userId} AND side = 'sell' AND realized_pnl > 0)::int AS profit_sells,
            COALESCE((SELECT json_object_agg(h.ticker_key, h.shares)
                      FROM share_holdings h
                      WHERE h.user_id = ${userId} AND h.shares > 0), '{}'::json) AS shares,
            EXISTS (SELECT 1
                    FROM share_holdings h
                    JOIN ticker_events e ON e.ticker_key = h.ticker_key
                     AND e.source = 'slate' AND e.event_type = 'close'
                     AND e.occurred_at > h.held_since
                    WHERE h.user_id = ${userId} AND h.shares > 0) AS held_through_close,
            COALESCE((SELECT json_agg(json_build_object('id', e.id, 'key', e.encounter_key, 'status', e.status, 'grants', e.grants)
                                      ORDER BY e.created_at)
                      FROM encounters e WHERE e.user_id = ${userId}), '[]'::json) AS encounters,
            COALESCE((SELECT json_agg(json_build_object('id', p.id, 'key', p.play_key, 'objective', p.objective,
                                                        'baseline', p.baseline, 'visited', p.visited,
                                                        'startedAt', p.started_at,
                                                        'completedAt', p.completed_at,
                                                        'rewardEncounterKey', p.reward_encounter_key)
                                      ORDER BY p.started_at)
                      FROM plays p WHERE p.user_id = ${userId}), '[]'::json) AS plays
        WHERE EXISTS (SELECT 1 FROM pets WHERE user_id = ${userId})
    `;
}

// The facts row plus what only the request knows (the pet's feed counter, the page).
// Shared by evaluateEncounters, GET /api/plays and toolbar-state's forced-find callback,
// so all three see a Play the same way.
export function buildFacts(row: EncounterFactsRow, pet: PetFacts, placePath: string | null): Facts {
    return {
        lifetimeEarned: Number(row.lifetime_earned),
        picks: Number(row.picks),
        wins: Number(row.wins ?? 0),
        collectibles: Number(row.collectibles),
        feeds: Number(pet.feedCount),
        place: placeFromPath(placePath)?.key ?? null,
        holdings: { ...(row.holdings ?? {}) },
        profitSells: Number(row.profit_sells ?? 0),
        shares: Object.fromEntries(Object.entries(row.shares ?? {}).map(([k, v]) => [k, Number(v)])),
        heldThroughClose: Boolean(row.held_through_close),
        petSustainedSatisfied: Boolean(pet.sustainedSatisfied),
        petNamed: Boolean(pet.named),
        encounters: (row.encounters ?? []).map((e) => ({ ...e, grants: e.grants ?? {} })),
        plays: (row.plays ?? []).map((p) => ({ ...p, visited: p.visited ?? [] })),
    };
}

// Does this objective want the place the request came from recorded? Recursing one level
// means a compound beat's visit or reading part still gets its progress written.
function placeWanted(o: StoredObjective | Objective, place: string): boolean {
    if (o.kind === 'visit_places') return o.places.some((want) => placeMatches(place, want));
    if (o.kind === 'read_articles') return place.startsWith('article:');
    if (o.kind === 'all_of') return o.parts.some((part) => placeWanted(part, place));
    return false;
}

export function triggerSatisfied(t: Trigger, facts: Facts, cfg: Record<string, number>): boolean {
    switch (t.kind) {
        case 'lifetime_earned_at_least': {
            const amount = Number(cfg[t.configKey]);
            // A missing threshold never fires (the registry sanity check in the
            // acceptance suite is what catches the misconfiguration loudly).
            return Number.isFinite(amount) && facts.lifetimeEarned >= amount;
        }
        case 'collectibles_at_least': return facts.collectibles >= t.count;
        case 'picks_at_least': return facts.picks >= t.count;
        case 'feeds_at_least': return facts.feeds >= t.count;
        case 'at_place': return placeMatches(facts.place, t.place);
        case 'after_encounter': return facts.encounters.some((e) => e.key === t.key && e.status === 'seen');
        case 'play_completed': return facts.plays.some((p) => p.key === t.key && p.completedAt !== null);
    }
}

// Registry order, minus anything this user already has - the first element is what
// fires this request.
export function fireableEncounters(facts: Facts, cfg: Record<string, number>): Encounter[] {
    return ENCOUNTERS.filter(
        (e) => !facts.encounters.some((r) => r.key === e.key) && e.trigger.every((t) => triggerSatisfied(t, facts, cfg)),
    );
}

export function toEncounterView(row: EncounterRow): EncounterView | null {
    const def = ENCOUNTER_BY_KEY[row.key];
    const character = def ? CHARACTERS[def.character] : undefined;
    // A row whose definition was removed from the registry can't be played; it just
    // stays 'offered' and invisible.
    if (!def || !character) return null;
    return {
        id: row.id,
        key: row.key,
        character: { key: character.key, name: character.name, title: character.title },
        dialogue: def.dialogue,
        grants: row.grants ?? {},
    };
}

// Freezes what a Play asks for at the moment it starts, so retuning the registry or
// moving a character never changes an errand in progress, and the Playbook can picture
// an item the player has never owned (no endpoint exposes an unowned catalog row).
//
// Resolved in JS rather than inside the fire statement because a delivery can be one
// part of a compound objective, and enriching a nested jsonb array in SQL was the least
// legible thing in this file. It costs one small indexed read, and only when a Play that
// hands something over actually starts.
//
// `forceable` is the find guarantee's permission slip: droppable memorabilia and the
// concession foods can be forced into a find, a shop SKU never can, because the ask
// there is to go and buy it.
async function freezeObjective(
    sql: NeonQueryFunction<false, false>,
    play: PlayDefinition,
    home: string | null,
): Promise<StoredObjective> {
    const stored: StoredObjective = { ...play.objective, title: play.title };
    const delivery = play.objective.kind === 'deliver_items'
        ? play.objective
        : play.objective.kind === 'all_of'
            ? play.objective.parts.find((p): p is Extract<Objective, { kind: 'deliver_items' }> => p.kind === 'deliver_items')
            : undefined;
    // The home rides at the TOP level even for a compound objective: the hand-over gate
    // reads it from there (plays.ts deliveryOf), and one Play has one place.
    if (delivery) stored.home = home;
    if (!delivery || delivery.items.length === 0) return stored;

    const keys = delivery.items.map((i) => i.catalogKey);
    const rows = (await sql`
        SELECT key, name, item_type,
               CASE item_type
                   WHEN 'food'        THEN 'food/' || key || '.png'
                   WHEN 'memorabilia' THEN config->>'image'
                   WHEN 'collectible' THEN config->>'cover_image'
                   ELSE NULL
               END AS art,
               ((config->>'discovery_droppable')::boolean IS TRUE
                AND COALESCE((config->>'discovery_weight')::int, 1) > 0
                AND NOT (config ? 'vendor')) AS forceable
        FROM items_catalog WHERE key = ANY(${keys}::text[])
    `) as unknown as Array<{ key: string; name: string; item_type: string; art: string | null; forceable: boolean }>;
    const byKey = new Map(rows.map((r) => [r.key, r]));

    const enriched = delivery.items.map((i) => {
        const c = byKey.get(i.catalogKey);
        return {
            ...i,
            name: c?.name,
            art: c?.art ?? null,
            itemType: (c?.item_type === 'food' ? 'food' : 'memorabilia') as 'food' | 'memorabilia',
            forceable: Boolean(c?.forceable),
        };
    });
    if (stored.kind === 'deliver_items') stored.items = enriched;
    else if (stored.kind === 'all_of') {
        stored.parts = stored.parts.map((p) => (p.kind === 'deliver_items' ? { ...p, items: enriched } : p));
    }
    return stored;
}

// Claim-and-grant in ONE statement. `ins` is the race guard (unique (user_id,
// encounter_key)); every other leg selects FROM it, so a concurrent loser writes
// nothing. Item legs are gated by the itemType param so one statement covers every
// effect shape; the play leg snapshots its baseline with subqueries so the numbers
// are the DB's at insert time, not the request's, and freezes the objective (with the
// title, the character's home, and each delivery item's name and art from the catalog). `grants` is BUILT in the INSERT from
// items_catalog and read back via RETURNING (a CTE cannot UPDATE a row a sibling CTE
// inserted): the catalog is the single resolver for the item's display name and art
// path, so the stored jsonb and the in-memory row cannot drift, and the reveal on
// stage needs no second query. The Ember gift is a separate statement
// (ledger.encounterGiftEmber) that patches the same object.
async function fireEncounter(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string; petId: string; encounter: Encounter }
): Promise<EncounterRow | null> {
    const { userId, petId, encounter } = input;
    const item = encounter.effects.find((e) => e.kind === 'grant_item');
    const start = encounter.effects.find((e) => e.kind === 'start_play');
    const gift = encounter.effects.find((e) => e.kind === 'grant_ember');

    const itemType = item?.kind === 'grant_item' ? item.itemType : 'none';
    const catalogKey = item?.kind === 'grant_item' ? item.catalogKey : '';
    const play = start?.kind === 'start_play' ? start.play : null;
    const hasPlay = play !== null;
    const playKey = play ? play.key : '';
    const stored = play ? await freezeObjective(sql, play, CHARACTERS[encounter.character]?.home ?? null) : null;
    const objective = stored ? JSON.stringify(stored) : '{}';
    const rewardKey = play ? play.rewardEncounter : '';
    const rows = await sql`
        WITH ins AS (
            INSERT INTO encounters (user_id, encounter_key, character_key, status, grants)
            VALUES (${userId}, ${encounter.key}::text, ${encounter.character}::text, 'offered',
                    -- name + art come from the catalog because no endpoint exposes an
                    -- UNOWNED catalog row: this payload is the only way the stage can
                    -- learn them. art is the notifications.art contract - a subpath
                    -- under /assets/images/, NULL for a type with no artwork (eggs are
                    -- drawn procedurally). An unknown key already fails the grant legs
                    -- below on the inventory_items FK, so this never silently blanks.
                    COALESCE((SELECT jsonb_build_object('item', jsonb_build_object(
                                  'catalogKey', c.key,
                                  'itemType',   c.item_type,
                                  'name',       c.name,
                                  'art', CASE c.item_type
                                             WHEN 'food'        THEN 'food/' || c.key || '.png'
                                             WHEN 'memorabilia' THEN c.config->>'image'
                                             WHEN 'collectible' THEN c.config->>'cover_image'
                                             ELSE NULL
                                         END))
                              FROM items_catalog c
                              WHERE ${itemType}::text <> 'none' AND c.key = ${catalogKey}::text),
                             '{}'::jsonb))
            ON CONFLICT (user_id, encounter_key) DO NOTHING
            RETURNING id, grants
        ), play AS (
            -- The objective arrives already frozen (freezeObjective above): title, home,
            -- and every delivery item's name, art, type and findability. The baseline is
            -- snapshotted HERE, from the database, inside the claim - never from the
            -- request - so a Play can never start measuring from a stale number.
            INSERT INTO plays (user_id, play_key, encounter_id, objective, baseline, reward_encounter_key)
            SELECT ${userId}, ${playKey}::text, ins.id, ${objective}::jsonb,
                   jsonb_build_object(
                       'feeds', COALESCE((SELECT feed_count FROM pets WHERE id = ${petId}), 0),
                       'finds', COALESCE((SELECT find_count FROM pets WHERE id = ${petId}), 0),
                       'picks', (SELECT COUNT(*) FROM picks WHERE waitlist_id = ${userId}),
                       'wins', (SELECT COUNT(*) FROM picks WHERE waitlist_id = ${userId} AND result = 'correct'),
                       'profit_sells', (SELECT COUNT(*) FROM share_trades
                                        WHERE user_id = ${userId}::uuid AND side = 'sell' AND realized_pnl > 0),
                       'lifetime_earned', COALESCE((SELECT lifetime_earned FROM ember_balances WHERE user_id = ${userId}), 0)),
                   ${rewardKey}::text
            FROM ins WHERE ${hasPlay}::boolean
            ON CONFLICT (user_id, play_key) DO NOTHING
        ), egg AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
            SELECT ${userId}, ${catalogKey}::text, 'egg', 1 FROM ins WHERE ${itemType}::text = 'egg'
            RETURNING id
        ), food AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
            SELECT ${userId}, ${catalogKey}::text, 'food', 1 FROM ins WHERE ${itemType}::text = 'food'
            ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                DO UPDATE SET quantity = inventory_items.quantity + 1
            RETURNING id
        ), memo AS (
            -- Memorabilia stacks like food, on its own partial unique index, so the
            -- conflict target has to name the type (a bare target cannot choose between
            -- the two). This is what lets a character hand over a keepsake - the GM
            -- Whitelist passes exist for exactly this and nothing else could reach them.
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
            SELECT ${userId}, ${catalogKey}::text, 'memorabilia', 1 FROM ins WHERE ${itemType}::text = 'memorabilia'
            ON CONFLICT (user_id, catalog_key) WHERE item_type = 'memorabilia'
                DO UPDATE SET quantity = inventory_items.quantity + 1
            RETURNING id
        ), minted AS (
            UPDATE collectible_pools SET minted_count = minted_count + 1
            WHERE catalog_key = ${catalogKey}::text AND minted_count < mint_size
              AND ${itemType}::text = 'collectible' AND EXISTS (SELECT 1 FROM ins)
            RETURNING minted_count AS serial
        ), card AS (
            INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity, serial_number)
            SELECT ${userId}, ${catalogKey}::text, 'collectible', 1, m.serial FROM minted m
            RETURNING id, serial_number
        ), itm AS (
            -- The item journal (create_item_ledger_tables.sql). ONE leg, not three: the
            -- itemType quals above make egg/food/card mutually exclusive, so this union is
            -- always zero or one rows. The NULL::int casts are mandatory - a bare NULL in a
            -- union branch is unknown-typed and there is no column to anchor it. When
            -- itemType is 'none' no leg fires, so the catalog_key FK is never reached.
            INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                     inventory_item_id, serial_number, idempotency_key, metadata)
            SELECT ${userId}::uuid, ${catalogKey}::text, ${itemType}::text, 1,
                   'encounter_grant', 'source', g.id, g.serial_number,
                   ${itemIdempotencyKey('encounter_grant', userId, `${encounter.key}:${catalogKey}`)}::text,
                   ${JSON.stringify({ encounterKey: encounter.key, character: encounter.character })}::jsonb
            FROM (          SELECT id, NULL::int       AS serial_number FROM egg
                  UNION ALL SELECT id, NULL::int                        FROM food
                  UNION ALL SELECT id, NULL::int                        FROM memo
                  UNION ALL SELECT id, serial_number                    FROM card) g
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING 1
        )
        SELECT (SELECT id FROM ins) AS id, (SELECT grants FROM ins) AS grants,
               (SELECT serial FROM minted) AS serial
    `;
    const out = rows[0] as unknown as { id: string | null; grants: EncounterGrants | null; serial: number | null };
    if (!out.id) return null; // lost the race - the winner's row is already in facts next load

    const row: EncounterRow = { id: out.id, key: encounter.key, status: 'offered', grants: out.grants ?? {} };
    if (itemType === 'collectible' && out.serial === null) {
        // Pool sold out between the registry and the mint: the visit still happens,
        // the card just isn't in it. Drop ONLY `item` - a blanket {} would also throw
        // away any sibling key (the Ember gift merges into this same object below).
        await sql`UPDATE encounters SET grants = grants - 'item' WHERE id = ${out.id} AND user_id = ${userId}`;
        const { item: _soldOut, ...rest } = row.grants;
        row.grants = rest;
    }
    if (gift?.kind === 'grant_ember') {
        const credited = await encounterGiftEmber(sql, {
            userId, encounterId: out.id, encounterKey: encounter.key, ruleKey: gift.ruleKey,
        });
        if (credited.credited) row.grants = { ...row.grants, ember: { amount: credited.amount } };
    }
    return row;
}

export interface EvaluateInput {
    userId: string;
    // null = petless: nothing in this system runs (a character talks TO the pet).
    pet: ({ id: string } & PetFacts) | null;
    // Raw ?place= from the request; normalized here via placeFromPath.
    placePath: string | null;
    // The batch row from encounterFactsStatement, or null when it returned no row.
    facts: EncounterFactsRow | null;
}

export interface EvaluateOutcome {
    fired: boolean;
    // A delivery Play took items on this request.
    delivered: boolean;
    // The oldest encounter this user has not finished watching (fired now or earlier).
    pending: EncounterView | null;
}

export async function evaluateEncounters(
    sql: NeonQueryFunction<false, false>,
    input: EvaluateInput
): Promise<EvaluateOutcome> {
    const { userId, pet, placePath } = input;
    // Petless / no facts row: before any query.
    if (!pet || !input.facts) return { fired: false, delivered: false, pending: null };

    const facts = buildFacts(input.facts, pet, placePath);

    // Thresholds only when something unfired actually needs one.
    const unfired = ENCOUNTERS.filter((e) => !facts.encounters.some((r) => r.key === e.key));
    const needsCfg = unfired.some((e) => e.trigger.some((t) => t.kind === 'lifetime_earned_at_least'));
    const cfg = needsCfg ? await getGameConfig(sql, 'encounters') : {};

    // Heal: an encounter whose Ember gift never landed (crash between the fire and
    // the gift) gets it now. Idempotent on both the grants flag and the ledger key.
    for (const row of facts.encounters) {
        const def = ENCOUNTER_BY_KEY[row.key];
        const gift = def?.effects.find((e) => e.kind === 'grant_ember');
        if (!def || gift?.kind !== 'grant_ember' || row.grants.ember) continue;
        const credited = await encounterGiftEmber(sql, {
            userId, encounterId: row.id, encounterKey: row.key, ruleKey: gift.ruleKey,
        });
        if (credited.credited) row.grants = { ...row.grants, ember: { amount: credited.amount } };
    }

    // Place progress: one small UPDATE only when this page is a place some open Play
    // actually wants and has not recorded yet. Two kinds care - visit_places wants
    // NAMED places, read_articles wants any Tank article - and both record into the
    // same `visited` array, so their progress survives a find resetting the pet's
    // footprints (which is exactly why the array exists).
    if (facts.place) {
        for (const p of facts.plays) {
            if (p.completedAt) continue;
            if (!placeWanted(p.objective, facts.place)) continue;
            if (p.visited.includes(facts.place)) continue;
            // An article place comes straight from the URL, and the SPA fallback serves
            // any path, so an invented slug would otherwise count as a Tank read and
            // read_articles could be farmed with made-up links. The same existence test
            // discovery's footprint write uses: published and app-visible, or it is not a
            // place. Named places (visit_places) need no check - they only ever match a
            // key the author wrote.
            const articleSlug = facts.place.startsWith('article:') ? facts.place.slice('article:'.length) : null;
            const rows = await sql`
                UPDATE plays SET visited = array_append(visited, ${facts.place}::text)
                WHERE id = ${p.id} AND user_id = ${userId} AND NOT (${facts.place}::text = ANY(visited))
                  AND (${articleSlug}::text IS NULL OR EXISTS (
                        SELECT 1 FROM tank_pages
                        WHERE slug = ${articleSlug}::text AND status = 'published' AND visibility = 'app'))
                RETURNING visited
            `;
            if (rows.length) p.visited = (rows[0] as unknown as { visited: string[] }).visited;
        }
    }

    // Play completion. A Play completed by an earlier request whose reward never fired
    // simply shows completedAt in facts and fires below - that's the heal.
    let delivered = false;
    for (const p of facts.plays) {
        if (!playComplete(p, facts)) continue;
        const handover = deliveryOf(p);
        if (handover) {
            // The hand-over consumes items, so it completes itself (deliver.ts). A
            // no-op here (lost race, stock moved) just retries on the next page load.
            // This covers a delivery that is one PART of a compound beat too: the other
            // parts were already checked by playComplete a line above.
            const result = await deliverPlay(sql, { userId, play: p });
            if (!result.completedAt) continue;
            p.completedAt = result.completedAt;
            delivered = true;
            // Keep the in-memory holdings honest: a second open delivery wanting the same
            // item must not complete for free against the pre-burn snapshot.
            for (const i of handover.items) {
                facts.holdings[i.catalogKey] = Number(facts.holdings[i.catalogKey] ?? 0) - i.count;
            }
            continue;
        }
        const rows = await sql`
            UPDATE plays SET completed_at = NOW()
            WHERE id = ${p.id} AND user_id = ${userId} AND completed_at IS NULL
            RETURNING completed_at
        `;
        p.completedAt = rows.length
            ? String((rows[0] as unknown as { completed_at: string }).completed_at)
            : new Date().toISOString();
    }

    // Fire at most one.
    let fired = false;
    const candidate = fireableEncounters(facts, cfg)[0];
    if (candidate) {
        const row = await fireEncounter(sql, { userId, petId: pet.id, encounter: candidate });
        if (row) {
            fired = true;
            facts.encounters.push(row);
        }
    }

    // facts.encounters is created_at-ordered with any fresh fire appended, so the
    // first 'offered' row with a live definition is the oldest unwatched one.
    let pending: EncounterView | null = null;
    for (const row of facts.encounters) {
        if (row.status !== 'offered') continue;
        pending = toEncounterView(row);
        if (pending) break;
    }
    return { fired, delivered, pending };
}
