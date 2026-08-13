// The Ember ledger — the one write path for every way to earn or spend Ember. Nothing
// outside this file should INSERT into ember_ledger or write ember_balances directly:
// centralizing it here is what keeps every future source (settlement today; feeding,
// mini games, shop spends later) idempotent and auditable by construction instead of
// each feature inventing its own retry-safety logic. See create_ember_ledger_tables.sql
// and add_ember_columns_to_picks.sql for the schema this reads/writes.
//
// The ledger is a diary, not a bank balance: ember_ledger rows are append-only, never
// UPDATEd or DELETEd. ember_balances is a derived cache — always reconstructable from
// ember_ledger via rebuildBalance() — never the source of truth.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export type EntryType = 'earn' | 'spend' | 'reversal' | 'adjustment';

interface RuleRow {
    version: number;
    kind: 'source' | 'sink';
    config: { amount: number };
}

async function getActiveRule(sql: NeonQueryFunction<false, false>, ruleKey: string): Promise<RuleRow> {
    const rows = await sql`
        SELECT version, kind, config FROM ember_rules WHERE key = ${ruleKey} AND active = true LIMIT 1
    `;
    if (rows.length === 0) throw new Error(`No active ember_rules row for key "${ruleKey}"`);
    return rows[0] as unknown as RuleRow;
}

// The one idempotency-key convention every Ember source uses, so a second write for the
// same thing is always a safe no-op instead of a double payout. `scope` is either an
// entity id (e.g. `call:<pickId>`) or an ISO date for sources with no entity table of
// their own (e.g. a future day-capped `feed:<userId>:<date>`).
export function buildIdempotencyKey(ruleKey: string, userId: string, scope: string): string {
    return `${ruleKey}:${userId}:${scope}`;
}

export interface PostInput {
    userId: string;
    ruleKey: string;
    idempotencyKey: string;
    metadata?: unknown;
}

// Generic earn append: looks up the active rule's payout, then writes the ledger row and
// folds the amount into ember_balances as ONE CTE-chained statement (not a two-step
// sql.transaction([...]) array). A two-statement array can't make the balance UPDATE
// conditional on whether the INSERT actually happened versus no-op'd on a retried
// idempotency key — that gap would double-credit the balance on retry even though the
// ledger correctly wrote nothing. A single statement is atomic by construction and
// closes it: the balance CTE only ever sees a row from `ins` when the insert was real.
export async function post(sql: NeonQueryFunction<false, false>, input: PostInput): Promise<void> {
    const rule = await getActiveRule(sql, input.ruleKey);
    const entryType: EntryType = rule.kind === 'source' ? 'earn' : 'adjustment';
    await sql`
        WITH ins AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            VALUES (${input.userId}, ${rule.config.amount}, ${entryType}, ${input.ruleKey}, ${rule.version},
                    ${input.idempotencyKey}, ${JSON.stringify(input.metadata ?? {})})
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING amount
        )
        INSERT INTO ember_balances (user_id, balance, updated_at)
        SELECT ${input.userId}, amount, NOW() FROM ins
        ON CONFLICT (user_id) DO UPDATE
            SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()
    `;
}

export interface SpendInput {
    userId: string;
    ruleKey: string;
    idempotencyKey: string;
    metadata?: unknown;
}

export interface SpendResult {
    ok: boolean; // false = insufficient balance, nothing written. true covers both a fresh spend and a retried-but-already-recorded one.
}

// Atomic conditional decrement — the balance check and the write happen in the same
// statement (`WHERE balance >= amount`), never read-then-write in app code, which would
// race under concurrent spends. `precheck` makes a retried call see its own prior
// success as ok:true without re-decrementing.
export async function spend(sql: NeonQueryFunction<false, false>, input: SpendInput): Promise<SpendResult> {
    const rule = await getActiveRule(sql, input.ruleKey);
    const amount = rule.config.amount;
    const rows = await sql`
        WITH precheck AS (
            SELECT 1 FROM ember_ledger WHERE idempotency_key = ${input.idempotencyKey}
        ), bal AS (
            UPDATE ember_balances
            SET balance = balance - ${amount}, updated_at = NOW()
            WHERE user_id = ${input.userId}
              AND balance >= ${amount}
              AND NOT EXISTS (SELECT 1 FROM precheck)
            RETURNING user_id
        ), ins AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            SELECT ${input.userId}, ${-amount}, 'spend', ${input.ruleKey}, ${rule.version},
                   ${input.idempotencyKey}, ${JSON.stringify(input.metadata ?? {})}
            FROM bal
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING 1
        )
        SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
               EXISTS (SELECT 1 FROM ins) AS newly_spent
    `;
    const row = rows[0] as unknown as { already_recorded: boolean; newly_spent: boolean };
    return { ok: row.already_recorded || row.newly_spent };
}

export type CallResult = 'correct' | 'incorrect';

export interface SettleCallInput {
    pickId: string;
    userId: string;
    result: CallResult;
}

// Settles one pick: sets picks.result/settled_at and pays out correct_call (win) or
// participation (loss — losses still pay, never zero, per the ledger's non-negotiables).
// Idempotent: the picks UPDATE is guarded by `result IS NULL`, and the payout is guarded
// by its own idempotency key, independently — so calling this twice for the same pick
// (e.g. a retried settle run) is a safe no-op, not an error. Unlike post()/spend(), this
// genuinely is two independently-idempotent statements, so Neon's sql.transaction([...])
// array form is the right (and safe) tool here.
export async function settleCall(sql: NeonQueryFunction<false, false>, input: SettleCallInput): Promise<void> {
    const ruleKey = input.result === 'correct' ? 'correct_call' : 'participation';
    const idempotencyKey = buildIdempotencyKey(ruleKey, input.userId, `call:${input.pickId}`);
    const rule = await getActiveRule(sql, ruleKey);

    await sql.transaction([
        sql`UPDATE picks SET result = ${input.result}, settled_at = NOW() WHERE id = ${input.pickId} AND result IS NULL`,
        sql`
            WITH ins AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                VALUES (${input.userId}, ${rule.config.amount}, 'earn', ${ruleKey}, ${rule.version},
                        ${idempotencyKey}, ${JSON.stringify({ pickId: input.pickId })})
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING amount
            )
            INSERT INTO ember_balances (user_id, balance, updated_at)
            SELECT ${input.userId}, amount, NOW() FROM ins
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()
        `,
    ]);
}

// Fast-path read of the cached balance.
export async function balance(sql: NeonQueryFunction<false, false>, userId: string): Promise<number> {
    const rows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${userId} LIMIT 1`;
    return rows.length ? (rows[0] as unknown as { balance: number }).balance : 0;
}

// Recomputes the true balance from the ledger and resets the cache to match — used for
// reconciliation and after any incident. Always agrees with balance() in steady state.
export async function rebuildBalance(sql: NeonQueryFunction<false, false>, userId: string): Promise<number> {
    const rows = await sql`SELECT COALESCE(SUM(amount), 0) AS total FROM ember_ledger WHERE user_id = ${userId}`;
    const total = Number((rows[0] as unknown as { total: number }).total);
    await sql`
        INSERT INTO ember_balances (user_id, balance, updated_at) VALUES (${userId}, ${total}, NOW())
        ON CONFLICT (user_id) DO UPDATE SET balance = EXCLUDED.balance, updated_at = NOW()
    `;
    return total;
}
