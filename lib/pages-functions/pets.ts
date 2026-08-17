// Pets + feeding. No Ember writes live here (that's ledger.ts) - feeding consumes a
// held food item, it doesn't spend Ember. Satisfaction is derive-on-read: stored as two
// facts per pet (satisfaction_at_last_feed + last_fed_at) and computed on demand, the
// same stored-facts approach as the Ember balance and session sliding expiry - no decay
// cron. The 0-100 value is INTERNAL: petState() collapses it to the only thing any
// response is allowed to show, 'hungry' | 'satisfied'.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface FeedingConfig {
    decay_rate_per_hour: number;
    hungry_threshold: number;
    hatch_start_satisfaction: number;
    max_satisfaction: number;
}

// Active row for a game_config key (mirrors ledger.getActiveRule's shape/contract).
export async function getGameConfig(sql: NeonQueryFunction<false, false>, key: string): Promise<Record<string, number>> {
    const rows = await sql`SELECT config FROM game_config WHERE key = ${key} AND active = true LIMIT 1`;
    if (rows.length === 0) throw new Error(`No active game_config row for key "${key}"`);
    return (rows[0] as unknown as { config: Record<string, number> }).config;
}

// A pet row as the feed/hatch CTEs return it. satisfaction_at_last_feed/last_fed_at are
// internal fuel for computeSatisfaction and never surface in a response.
export interface PetRow {
    id: string;
    color: string;
    render_mode: string;
    render_config: Record<string, unknown>;
    name: string | null;
    is_captain: boolean;
    satisfaction_at_last_feed: number;
    last_fed_at: string;
}

export type PetState = 'hungry' | 'satisfied';

function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

// current = clamp(satisfaction_at_last_feed - decay_rate * hours_since(last_fed_at), 0, max)
export function computeSatisfaction(pet: Pick<PetRow, 'satisfaction_at_last_feed' | 'last_fed_at'>, cfg: FeedingConfig): number {
    const hours = (Date.now() - new Date(pet.last_fed_at).getTime()) / 3_600_000;
    return clamp(pet.satisfaction_at_last_feed - cfg.decay_rate_per_hour * hours, 0, cfg.max_satisfaction);
}

export function petState(value: number, cfg: FeedingConfig): PetState {
    return value >= cfg.hungry_threshold ? 'satisfied' : 'hungry';
}

// The ONLY pet shape that leaves the server: identity + render inputs + the two-state
// label. Never the numeric satisfaction.
export function petPublic(pet: PetRow, cfg: FeedingConfig): {
    id: string; color: string; render_mode: string; render_config: Record<string, unknown>;
    name: string | null; is_captain: boolean; state: PetState;
} {
    return {
        id: pet.id,
        color: pet.color,
        render_mode: pet.render_mode,
        render_config: pet.render_config,
        name: pet.name,
        is_captain: pet.is_captain,
        state: petState(computeSatisfaction(pet, cfg), cfg),
    };
}

export interface HatchInput {
    userId: string;
    eggCatalogKey: string;
    color: string;
    renderMode: string;
    renderConfig: Record<string, unknown>;
    startSatisfaction: number;
}

// Consume one egg AND create the pet in ONE statement. The pet INSERT selects FROM the
// egg-consuming UPDATE, so a pet is created only if an egg was actually consumed; and if
// the captain partial-unique index rejects a second pet, the whole statement rolls back,
// so the egg is NOT consumed. Returns the new pet row, or null when no egg was available
// to consume. A captain-uniqueness violation surfaces as a 23505 the caller maps to
// "already have a pet".
export async function hatch(sql: NeonQueryFunction<false, false>, input: HatchInput): Promise<PetRow | null> {
    const rows = await sql`
        WITH consumed AS (
            UPDATE inventory_items SET quantity = quantity - 1
            WHERE user_id = ${input.userId} AND catalog_key = ${input.eggCatalogKey}
              AND item_type = 'egg' AND quantity >= 1
            RETURNING id
        )
        INSERT INTO pets (user_id, base_body, color, render_mode, render_config, satisfaction_at_last_feed, last_fed_at)
        SELECT ${input.userId}, 'mudpuppy', ${input.color}, ${input.renderMode},
               ${JSON.stringify(input.renderConfig)}, ${input.startSatisfaction}, NOW()
        FROM consumed
        RETURNING id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at
    `;
    return rows.length ? (rows[0] as unknown as PetRow) : null;
}

export interface FeedInput {
    userId: string;
    foodCatalogKey: string;
    points: number;             // the food SKU's satisfaction_points
    currentSatisfaction: number;// computed by the caller from the pet's stored facts
    max: number;
    feedToken: string;          // client idempotency token
}

// Consume one food item AND top up the pet in ONE statement. Food is consumed only if
// (a) the pet is available and this feedToken wasn't the pet's last (idempotency gate)
// and (b) a unit is in stock; the pet is topped up only if the food was consumed. A
// sequential double-submit with the same feedToken finds the pet's last_feed_token
// already set and no-ops. (Feeding is cosmetic and fully recoverable - unlike the Ember
// path - so we don't take a heavier lock to also cover the rare truly-simultaneous
// same-token collision.) Returns the updated pet row, or null when nothing was consumed.
export async function feed(sql: NeonQueryFunction<false, false>, input: FeedInput): Promise<PetRow | null> {
    const rows = await sql`
        WITH consumed AS (
            UPDATE inventory_items SET quantity = quantity - 1
            WHERE user_id = ${input.userId} AND catalog_key = ${input.foodCatalogKey}
              AND item_type = 'food' AND quantity >= 1
              AND EXISTS (
                  SELECT 1 FROM pets WHERE user_id = ${input.userId}
                    AND last_feed_token IS DISTINCT FROM ${input.feedToken}
              )
            RETURNING id
        )
        UPDATE pets SET
            satisfaction_at_last_feed = LEAST(${input.max}, GREATEST(0, ${input.currentSatisfaction} + ${input.points})),
            last_fed_at = NOW(),
            last_feed_token = ${input.feedToken}
        WHERE user_id = ${input.userId} AND EXISTS (SELECT 1 FROM consumed)
        RETURNING id, color, render_mode, render_config, name, is_captain, satisfaction_at_last_feed, last_fed_at
    `;
    return rows.length ? (rows[0] as unknown as PetRow) : null;
}
