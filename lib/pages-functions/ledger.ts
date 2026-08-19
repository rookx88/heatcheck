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
    // correct_call's config is {base, cap} (difficulty-scaled formula); every other
    // rule (participation, and whatever post()/spend() get used for later) is a flat
    // {amount}. Left as a loose record rather than a union so post()/spend() - which
    // only ever handle the flat shape - don't need to know about the formula shape at
    // all; settleCall() is the only caller that narrows per rule key.
    config: Record<string, number>;
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

// Serializes all Ember spends for one user inside the calling transaction. Without it,
// two truly-simultaneous spends with the SAME idempotency key double-debit the balance
// cache: in READ COMMITTED the loser's `precheck` CTE is materialized against its
// statement-start snapshot (the winner's ledger row isn't visible yet), while its `bal`
// UPDATE blocks on the winner's row lock and then re-evaluates only the row's own quals
// — `balance >= amount` passes on the new version, the stale NOT EXISTS stays true, and
// the balance drops again with no ledger row to show for it (the ledger insert then
// no-ops on the idempotency conflict). Taking this lock as the transaction's FIRST
// statement means the spend statement's snapshot is only taken after any concurrent
// winner has committed, so `precheck` genuinely sees prior spends. (Observed live under
// two concurrent /api/shop/buy calls before this guard existed.)
function spendLock(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`SELECT pg_advisory_xact_lock(hashtext('ember_spend'), hashtext(${userId}))`;
}

// Atomic conditional decrement — the balance check and the write happen in the same
// statement (`WHERE balance >= amount`), never read-then-write in app code, which would
// race under concurrent spends. `precheck` makes a retried call see its own prior
// success as ok:true without re-decrementing; the spendLock() serializes simultaneous
// same-key retries so precheck can't be raced past (see its comment).
export async function spend(sql: NeonQueryFunction<false, false>, input: SpendInput): Promise<SpendResult> {
    const rule = await getActiveRule(sql, input.ruleKey);
    const amount = rule.config.amount;
    const [, rows] = await sql.transaction([
        spendLock(sql, input.userId),
        sql`
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
    `,
    ]);
    const row = rows[0] as unknown as { already_recorded: boolean; newly_spent: boolean };
    return { ok: row.already_recorded || row.newly_spent };
}

export interface PurchaseConsumableInput {
    userId: string;
    priceRuleKey: string;   // an ember_rules `sink` key; its config.amount is the Ember price
    catalogKey: string;     // the items_catalog SKU to grant (e.g. 'egg_slate', 'food_basic')
    itemType: string;       // 'egg' | 'food' - stamped on the inventory row
    purchaseScope: string;  // client-supplied idempotency token, so a double-submit is a safe no-op
}

export interface PurchaseResult {
    ok: boolean;              // false only means insufficient balance (nothing written)
    reason?: 'insufficient';
    // The freshly-granted inventory row's id. null on an idempotent replay (the original
    // grant's row id isn't recoverable from the CTE, and replay callers don't need it)
    // and for food (callers report quantity, not row identity).
    grantedInventoryId: string | null;
}

// Atomic spend-and-grant: debit Ember AND grant a consumable inventory item in a SINGLE
// statement, so a debit can never happen without the grant (or vice versa). Runs behind
// spendLock() in one transaction so concurrent same-token submits serialize (see the
// lock's comment). Lives here, not in a shop module, because it INSERTs ember_ledger
// and this file is the one sanctioned Ember write path.
//
// Extends spend()'s CTE with a `granted` leg that selects FROM `led` (the ledger insert),
// so the grant fires ONLY on a fresh spend: a retried purchaseToken hits the idempotency
// key, `led` is empty, and neither the ledger nor the inventory moves again. Insufficient
// balance fails the `bal` guard, so `led` and `granted` both no-op and nothing is written.
//
// The grant leg differs by item type — eggs are never fungible, food stacks:
//   egg  - plain INSERT of a brand-new quantity-1 row per purchase; each egg keeps its
//          own row identity so hatch can consume exactly that row by id.
//   food - quantity upsert against idx_inventory_user_food (the partial unique on
//          (user_id, catalog_key) for food).
export async function purchaseConsumable(
    sql: NeonQueryFunction<false, false>,
    input: PurchaseConsumableInput
): Promise<PurchaseResult> {
    const rule = await getActiveRule(sql, input.priceRuleKey);
    const amount = rule.config.amount;
    const idempotencyKey = buildIdempotencyKey(input.priceRuleKey, input.userId, input.purchaseScope);
    const purchaseStatement = input.itemType === 'egg'
        ? sql`
            WITH precheck AS (
                SELECT 1 FROM ember_ledger WHERE idempotency_key = ${idempotencyKey}
            ), bal AS (
                UPDATE ember_balances
                SET balance = balance - ${amount}, updated_at = NOW()
                WHERE user_id = ${input.userId}
                  AND balance >= ${amount}
                  AND NOT EXISTS (SELECT 1 FROM precheck)
                RETURNING user_id
            ), led AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                SELECT ${input.userId}, ${-amount}, 'spend', ${input.priceRuleKey}, ${rule.version},
                       ${idempotencyKey}, ${JSON.stringify({ catalogKey: input.catalogKey })}
                FROM bal
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                SELECT ${input.userId}, ${input.catalogKey}, 'egg', 1
                FROM led
                RETURNING id
            )
            SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
                   EXISTS (SELECT 1 FROM led) AS newly_spent,
                   (SELECT id FROM granted LIMIT 1) AS granted_id
        `
        : sql`
            WITH precheck AS (
                SELECT 1 FROM ember_ledger WHERE idempotency_key = ${idempotencyKey}
            ), bal AS (
                UPDATE ember_balances
                SET balance = balance - ${amount}, updated_at = NOW()
                WHERE user_id = ${input.userId}
                  AND balance >= ${amount}
                  AND NOT EXISTS (SELECT 1 FROM precheck)
                RETURNING user_id
            ), led AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                SELECT ${input.userId}, ${-amount}, 'spend', ${input.priceRuleKey}, ${rule.version},
                       ${idempotencyKey}, ${JSON.stringify({ catalogKey: input.catalogKey })}
                FROM bal
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                SELECT ${input.userId}, ${input.catalogKey}, ${input.itemType}, 1
                FROM led
                ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                    DO UPDATE SET quantity = inventory_items.quantity + 1
                RETURNING id
            )
            SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
                   EXISTS (SELECT 1 FROM led) AS newly_spent,
                   NULL AS granted_id
        `;
    // spendLock() first: serializes simultaneous same-token submits so the loser's
    // precheck sees the winner's committed spend (see spendLock's comment for the
    // double-debit failure mode this closes).
    const [, rows] = await sql.transaction([spendLock(sql, input.userId), purchaseStatement]);
    const row = rows[0] as unknown as { already_recorded: boolean; newly_spent: boolean; granted_id: string | null };
    const ok = row.already_recorded || row.newly_spent;
    return ok
        ? { ok: true, grantedInventoryId: row.granted_id }
        : { ok: false, reason: 'insufficient', grantedInventoryId: null };
}

export type CallResult = 'correct' | 'incorrect';

export interface SettleCallInput {
    pickId: string;
    userId: string;
    result: CallResult;
    // The pick's difficulty stamp, frozen at submission time (functions/api/picks.ts) -
    // settlement reads it, never recomputes it. Only actually used on a 'correct'
    // result (see correctCallPayout below); still required either way so a caller
    // can't accidentally settle a win without it.
    impliedProbAtLock: number;
}

export interface SettleCallResult {
    payoutAmount: number;
}

// correct_call's payout scales with how unlikely the pick was: round(base * min(1/p, cap)).
// A 50% favorite pays base; a longshot pays proportionally more, capped at base*cap so an
// extreme longshot doesn't pay absurdly more (see update_ember_rules_payout_formula.sql for
// why cap is tuned to 2.5, not the spec's original 6 - the stress simulation showed 6 lets
// longshot-chasing beat honest play).
function correctCallPayout(config: Record<string, number>, impliedProbAtLock: number): number {
    const base = config.base;
    const cap = config.cap;
    if (!Number.isFinite(impliedProbAtLock) || impliedProbAtLock <= 0 || impliedProbAtLock > 1) {
        // Defensive only - the settle.ts query casts ::float8 and picks.ts already
        // guarantees a valid (0,1] probability at write time, this should never
        // actually trip. Fall back to `base` (the formula's true minimum, at p=1) -
        // not base*cap (the true maximum) - so a malformed value degrades to the
        // smallest legitimate payout rather than the largest.
        return Math.round(base);
    }
    return Math.round(base * Math.min(1 / impliedProbAtLock, cap));
}

// Settles one pick: sets picks.result/settled_at and pays out correct_call (win) or
// participation (loss — losses still pay, never zero, per the ledger's non-negotiables).
// Idempotent: the picks UPDATE is guarded by `result IS NULL`, and the payout is guarded
// by its own idempotency key, independently — so calling this twice for the same pick
// (e.g. a retried settle run) is a safe no-op, not an error. Unlike post()/spend(), this
// genuinely is two independently-idempotent statements, so Neon's sql.transaction([...])
// array form is the right (and safe) tool here.
export async function settleCall(sql: NeonQueryFunction<false, false>, input: SettleCallInput): Promise<SettleCallResult> {
    const ruleKey = input.result === 'correct' ? 'correct_call' : 'participation';
    const idempotencyKey = buildIdempotencyKey(ruleKey, input.userId, `call:${input.pickId}`);
    const rule = await getActiveRule(sql, ruleKey);

    const payoutAmount = input.result === 'correct'
        ? correctCallPayout(rule.config, input.impliedProbAtLock)
        : rule.config.amount;

    // Written into ember_ledger.metadata (below) so a payout is auditable after the
    // fact without re-deriving it from the formula + whatever rule_version was active
    // at the time.
    const metadata =
        input.result === 'correct'
            ? {
                  pickId: input.pickId,
                  implied_prob_at_lock: input.impliedProbAtLock,
                  cap_applied: 1 / input.impliedProbAtLock > rule.config.cap,
              }
            : { pickId: input.pickId };

    // Toolbar notification for this settlement - a 'claimable' row so the reader can tap
    // to reveal the payoff. The Ember is already paid here; claiming (claimed_at) is
    // presentational only. Idempotent on 'settle:call:<pickId>', so a re-run no-ops it
    // alongside the picks UPDATE and the payout - all three guarded independently.
    const notificationMessage =
        input.result === 'correct'
            ? `You called it — +${payoutAmount} Ember.`
            : `Your call settled — +${payoutAmount} Ember.`;
    const notificationKey = `settle:call:${input.pickId}`;

    await sql.transaction([
        sql`UPDATE picks SET result = ${input.result}, settled_at = NOW() WHERE id = ${input.pickId} AND result IS NULL`,
        sql`
            WITH ins AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                VALUES (${input.userId}, ${payoutAmount}, 'earn', ${ruleKey}, ${rule.version},
                        ${idempotencyKey}, ${JSON.stringify(metadata)})
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING amount
            )
            INSERT INTO ember_balances (user_id, balance, updated_at)
            SELECT ${input.userId}, amount, NOW() FROM ins
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()
        `,
        sql`
            INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
            VALUES (${input.userId}, 'claimable', ${notificationMessage}, 'pick', ${input.pickId}, ${notificationKey})
            ON CONFLICT (idempotency_key) DO NOTHING
        `,
    ]);

    return { payoutAmount };
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
