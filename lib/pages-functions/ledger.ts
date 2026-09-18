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
//
// ember_balances carries TWO cached columns: `balance` (SUM of every ledger row) and
// `lifetime_earned` (the Hall of Fame's ranking figure - see
// add_lifetime_earned_to_ember_balances.sql for the definition). Every credit path
// below that counts as "earned" folds both columns in the same statement as its ledger
// insert, so the two can never drift apart from each other or from the ledger.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export type EntryType = 'earn' | 'spend' | 'reversal' | 'adjustment';

// The ledger rules whose 'earn' rows count toward ember_balances.lifetime_earned (game
// earnings). Exported so the acceptance harness's independent recompute and this file's
// rebuildBalance() share one list. Always paired with entry_type = 'earn': the harness's
// seed rows borrow the 'participation' rule key with entry_type 'adjustment', and an
// adjustment must never put an account on the Hall of Fame. TANKDAQ profit is the other
// half of the definition and comes from share_trades.realized_pnl, not from a rule key:
// 'shares_sell' rows are proceeds (the trader's own Ember coming back), not earnings.
// 'encounter_gift' (NPC encounters, encounterGiftEmber below) is an 'earn' row that is
// intentionally NOT listed: a character's gift is not something the Captain earned. Same
// for 'welcome_gift' (Sports McLaren's starting Ember, welcomeGiftEmber below).
export const LIFETIME_EARNED_RULE_KEYS = ['correct_call', 'participation', 'discovery_find'] as const;

interface RuleRow {
    version: number;
    kind: 'source' | 'sink';
    // correct_call's config is {base, cap} (difficulty-scaled formula); every other
    // rule (participation, the shop's price rules, and whatever post() gets used for
    // later) is a flat {amount}. Left as a loose record rather than a union so post()
    // and purchaseConsumable() - which only ever handle the flat shape - don't need to
    // know about the formula shape at all; settleCall() is the only caller that narrows
    // per rule key.
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
//
// No production caller today (the acceptance fixtures' seed rows take this shape). It
// folds `balance` only - never lifetime_earned - so a seed/adjustment can't put an
// account on the Hall of Fame. A future real source that should count must fold both
// columns the way settleCall() and discoveryFindEmber() do.
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

// The debit discipline every spend below follows: the balance check and the write happen
// in the same statement (`WHERE balance >= amount`), never read-then-write in app code,
// which would race under concurrent spends. `precheck` makes a retried call see its own
// prior success as ok:true without re-decrementing; spendLock() serializes simultaneous
// same-key retries so precheck can't be raced past (see its comment). There is no
// generic bare-debit function: a spend that grants nothing had no production caller,
// and a dead entry point into the ledger reads as load-bearing when it isn't.

export interface PurchaseConsumableInput {
    userId: string;
    priceRuleKey: string;   // an ember_rules `sink` key; its config.amount is the Ember price
    catalogKey: string;     // the items_catalog SKU to grant (e.g. 'egg_slate', 'food_basic')
    itemType: string;       // 'egg' | 'food' - stamped on the inventory row
    purchaseScope: string;  // client-supplied idempotency token, so a double-submit is a safe no-op
}

export interface PurchaseResult {
    ok: boolean;              // false means insufficient balance OR sold out - nothing written either way
    reason?: 'insufficient' | 'sold_out';
    // The freshly-granted inventory row's id. null on an idempotent replay (the original
    // grant's row id isn't recoverable from the CTE, and replay callers don't need it)
    // and for food (callers report quantity, not row identity).
    grantedInventoryId: string | null;
    // Units of the site-wide run left AFTER this purchase, for a capped SKU
    // (add_egg_supply_caps.sql). null for an uncapped SKU and on an idempotent replay —
    // no unit moved, so this call has no number of its own to report; 0 on a sold-out
    // rejection. Display only: the cap is enforced in the statement, never from this.
    remaining: number | null;
}

// Atomic spend-and-grant: debit Ember AND grant a consumable inventory item in a SINGLE
// statement, so a debit can never happen without the grant (or vice versa). Runs behind
// spendLock() in one transaction so concurrent same-token submits serialize (see the
// lock's comment). Lives here, not in a shop module, because it INSERTs ember_ledger
// and this file is the one sanctioned Ember write path.
//
// The debit CTE (precheck -> bal -> led) gains a `granted` leg that selects FROM `led`
// (the ledger insert), so the grant fires ONLY on a fresh spend: a retried purchaseToken hits the idempotency
// key, `led` is empty, and neither the ledger nor the inventory moves again. Insufficient
// balance fails the `bal` guard, so `led` and `granted` both no-op and nothing is written.
//
// The grant leg differs by item type — eggs are never fungible, food stacks:
//   egg  - plain INSERT of a brand-new quantity-1 row per purchase; each egg keeps its
//          own row identity so hatch can consume exactly that row by id.
//   food - quantity upsert against idx_inventory_user_food (the partial unique on
//          (user_id, catalog_key) for food).
//
// FINITE SUPPLY (add_egg_supply_caps.sql). A SKU with a sku_supply row is capped for
// the whole user base — 500 of each egg colour exist and that is that. Two legs carry
// it, and the ORDER of the pair is the whole design:
//   supply - a LOCKING read (FOR UPDATE) of the pool row, taken BEFORE anything is
//            written, that returns nothing when the SKU is sold out. `bal` requires it
//            (or the absence of any pool row, which is what "uncapped" means), so a
//            sold-out SKU never debits. Taking the lock here and holding it to commit
//            is what makes the check and the increment one decision: a loser blocks on
//            this row, then re-evaluates sold_count < supply against the WINNER's
//            committed version, so the cap holds under any number of racing Workers.
//            (Doing it the other way round — decrement first, debit second — would
//            burn a unit of public supply every time someone's balance came up short.)
//   sold   - the increment, gated on `led` so it fires once per real spend and never on
//            a replay. It deliberately does NOT re-check sold_count < supply: we hold
//            the row lock, so the check has already been made, and a second guard could
//            only fail silently and leave a debit with no unit taken. sku_supply's
//            CHECK constraint is the backstop — an impossible over-sale aborts the
//            whole transaction rather than half-applying.
// A SKU with no pool row takes no lock and skips both legs' effects, which is every
// food SKU today.
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
            ), supply AS (
                SELECT catalog_key FROM sku_supply
                WHERE catalog_key = ${input.catalogKey} AND sold_count < supply
                FOR UPDATE
            ), bal AS (
                UPDATE ember_balances
                SET balance = balance - ${amount}, updated_at = NOW()
                WHERE user_id = ${input.userId}
                  AND balance >= ${amount}
                  AND NOT EXISTS (SELECT 1 FROM precheck)
                  AND (EXISTS (SELECT 1 FROM supply)
                       OR NOT EXISTS (SELECT 1 FROM sku_supply WHERE catalog_key = ${input.catalogKey}))
                RETURNING user_id
            ), led AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                SELECT ${input.userId}, ${-amount}, 'spend', ${input.priceRuleKey}, ${rule.version},
                       ${idempotencyKey}, ${JSON.stringify({ catalogKey: input.catalogKey })}
                FROM bal
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
            ), sold AS (
                -- One unit of the site-wide run, taken under the lock the supply CTE holds.
                UPDATE sku_supply SET sold_count = sold_count + 1
                WHERE catalog_key = ${input.catalogKey} AND EXISTS (SELECT 1 FROM led)
                RETURNING supply - sold_count AS remaining
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                SELECT ${input.userId}, ${input.catalogKey}, 'egg', 1
                FROM led
                RETURNING id
            ), itm AS (
                -- The item journal (create_item_ledger_tables.sql). Deliberately shares the
                -- Ember row's EXACT idempotency key and links back through ledger_id: a
                -- replayed purchase token can no more write a second item movement than a
                -- second debit. Both CTEs hold at most one row, so the cross join is empty
                -- on a replay and this writes nothing.
                INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                         inventory_item_id, ledger_id, idempotency_key, metadata)
                SELECT ${input.userId}::uuid, ${input.catalogKey}::text, 'egg', 1, 'purchase', 'source',
                       g.id, l.id, ${idempotencyKey}::text,
                       ${JSON.stringify({ purchaseToken: input.purchaseScope })}::jsonb
                FROM granted g, led l
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            )
            SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
                   EXISTS (SELECT 1 FROM led) AS newly_spent,
                   (SELECT id FROM granted LIMIT 1) AS granted_id,
                   -- Capped SKU whose pool is empty: the caller owes the buyer "sold
                   -- out", not "not enough Ember". Only meaningful when nothing was
                   -- written; a replay reports success regardless (see the caller).
                   (NOT EXISTS (SELECT 1 FROM supply)
                    AND EXISTS (SELECT 1 FROM sku_supply WHERE catalog_key = ${input.catalogKey})) AS sold_out,
                   (SELECT remaining FROM sold) AS remaining
        `
        : sql`
            WITH precheck AS (
                SELECT 1 FROM ember_ledger WHERE idempotency_key = ${idempotencyKey}
            ), supply AS (
                SELECT catalog_key FROM sku_supply
                WHERE catalog_key = ${input.catalogKey} AND sold_count < supply
                FOR UPDATE
            ), bal AS (
                UPDATE ember_balances
                SET balance = balance - ${amount}, updated_at = NOW()
                WHERE user_id = ${input.userId}
                  AND balance >= ${amount}
                  AND NOT EXISTS (SELECT 1 FROM precheck)
                  AND (EXISTS (SELECT 1 FROM supply)
                       OR NOT EXISTS (SELECT 1 FROM sku_supply WHERE catalog_key = ${input.catalogKey}))
                RETURNING user_id
            ), led AS (
                INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
                SELECT ${input.userId}, ${-amount}, 'spend', ${input.priceRuleKey}, ${rule.version},
                       ${idempotencyKey}, ${JSON.stringify({ catalogKey: input.catalogKey })}
                FROM bal
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING id
            ), sold AS (
                -- No food SKU is capped today; this is the same leg as the egg branch so
                -- that capping one is an INSERT into sku_supply and nothing else.
                UPDATE sku_supply SET sold_count = sold_count + 1
                WHERE catalog_key = ${input.catalogKey} AND EXISTS (SELECT 1 FROM led)
                RETURNING supply - sold_count AS remaining
            ), granted AS (
                INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity)
                SELECT ${input.userId}, ${input.catalogKey}, ${input.itemType}, 1
                FROM led
                ON CONFLICT (user_id, catalog_key) WHERE item_type = 'food'
                    DO UPDATE SET quantity = inventory_items.quantity + 1
                RETURNING id
            ), itm AS (
                -- See the egg branch: same key as the Ember row, linked by ledger_id. The
                -- upsert's DO UPDATE branch returns the row id (a DO NOTHING would not),
                -- so g.id is always present when this leg fires.
                INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                                         inventory_item_id, ledger_id, idempotency_key, metadata)
                SELECT ${input.userId}::uuid, ${input.catalogKey}::text, ${input.itemType}::text, 1,
                       'purchase', 'source', g.id, l.id, ${idempotencyKey}::text,
                       ${JSON.stringify({ purchaseToken: input.purchaseScope })}::jsonb
                FROM granted g, led l
                ON CONFLICT (idempotency_key) DO NOTHING
                RETURNING 1
            )
            SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
                   EXISTS (SELECT 1 FROM led) AS newly_spent,
                   NULL AS granted_id,
                   (NOT EXISTS (SELECT 1 FROM supply)
                    AND EXISTS (SELECT 1 FROM sku_supply WHERE catalog_key = ${input.catalogKey})) AS sold_out,
                   (SELECT remaining FROM sold) AS remaining
        `;
    // spendLock() first: serializes simultaneous same-token submits so the loser's
    // precheck sees the winner's committed spend (see spendLock's comment for the
    // double-debit failure mode this closes).
    const [, rows] = await sql.transaction([spendLock(sql, input.userId), purchaseStatement]);
    const row = rows[0] as unknown as {
        already_recorded: boolean; newly_spent: boolean; granted_id: string | null;
        sold_out: boolean; remaining: number | null;
    };
    const ok = row.already_recorded || row.newly_spent;
    // already_recorded wins over sold_out on purpose: a retry of a token that ALREADY
    // bought the last egg is that same purchase, not a new one against an empty pool,
    // and must keep reporting the success it originally got.
    if (ok) return { ok: true, grantedInventoryId: row.granted_id, remaining: row.remaining };
    return {
        ok: false,
        reason: row.sold_out ? 'sold_out' : 'insufficient',
        grantedInventoryId: null,
        remaining: row.sold_out ? 0 : row.remaining,
    };
}

// -----------------------------------------------------------------------------------
// TANKDAQ share trades. A user buys or sells whole shares of an index at its live Ember
// price (lib/pages-functions/ticker-price.ts). Both functions live HERE because they
// write ember_ledger and ember_balances, and this file is the one sanctioned path for
// that. They take integer Ember amounts the endpoint already computed (ceil on a buy,
// floor on a sell) so the ledger stays formula-agnostic: it records what happened and
// why, it does not price anything.
//
// Both run behind spendLock() in the SAME 'ember_spend' namespace the shop uses. A sell
// takes it too, even though it credits rather than debits: it mutates share_holdings,
// which a concurrent buy also mutates, and its precheck/decrement pair has exactly the
// same same-token double-apply hazard spendLock's comment describes for the balance.
//
// Unlike every earlier rule, 'shares_buy'/'shares_sell' carry no {amount} in config -
// the amount is per trade. Every ledger row still stamps rule_key + rule_version and
// records {tickerKey, shares, price, tradeToken, pricingVersion} in metadata, so it
// stays explainable: this many shares, at this quote, under this pricing formula.
//
// The paired share_trades row shares the ledger row's idempotency_key, so a replayed
// trade token can no more write a second trade than a second debit. Trading never
// writes ticker_events: prices move stories and results; a trade only consumes them.
// -----------------------------------------------------------------------------------

export interface TradeInput {
    userId: string;
    tickerKey: string;
    shares: number;       // whole shares, >= 1 (validated by the endpoint via isWholeShares)
    price: number;        // the server's 4-dp quote at the moment of the trade
    emberAmount: number;  // integer Ember: buyCost(...) on a buy, sellCredit(...) on a sell
    tradeToken: string;   // client-minted UUID; reused verbatim on retry
}

export interface BuySharesResult {
    ok: boolean;          // false ONLY means insufficient Ember - nothing written
    replay: boolean;      // true when this token was already recorded (idempotent no-op)
    // The position after this buy. null on a replay (the CTE has nothing to return) -
    // the endpoint re-reads it - and null when !ok.
    position: { shares: number; avgBuyPrice: number } | null;
}

export interface SellSharesResult {
    ok: boolean;          // false ONLY means insufficient shares - nothing written
    replay: boolean;
    remaining: number | null;     // shares left after the sale; 0 means the row was removed
    realizedPnl: number | null;   // credit - shares * avg_buy_price, at the moment of sale
}

function tradeMetadata(input: TradeInput, pricingVersion: number): string {
    return JSON.stringify({
        tickerKey: input.tickerKey,
        shares: input.shares,
        price: input.price,
        tradeToken: input.tradeToken,
        pricingVersion,
    });
}

// One statement: debit, ledger row, holdings upsert, trade row - all or nothing.
// Same skeleton as purchaseConsumable with the `granted` leg replaced by `held`:
//   precheck  - has this token already been recorded?
//   bal       - conditional debit; the balance check IS the write (`balance >= cost`)
//   led       - the ledger row, only when bal actually debited
//   held      - the position, only when led actually wrote: a fresh row, or a weighted
//               average against the EXISTING row. avg_buy_price is Ember actually paid
//               divided by shares (so it includes the ceil), which is what lets
//               unrealized P/L reconcile to real ledger flows.
//   trade     - the diary row, only when led wrote
// Every parameter that takes part in arithmetic carries an explicit cast: Neon's HTTP
// driver binds params as untyped unknowns, and `param + param` with no column to anchor
// the type is an ambiguous-operator error (see pets.ts's feed for the same rule).
export async function buyShares(sql: NeonQueryFunction<false, false>, input: TradeInput): Promise<BuySharesResult> {
    const rule = await getActiveRule(sql, 'shares_buy');
    const idempotencyKey = buildIdempotencyKey('shares_buy', input.userId, input.tradeToken);
    const meta = tradeMetadata(input, rule.config.pricingVersion ?? 1);
    const holdingId = crypto.randomUUID();
    const tradeId = crypto.randomUUID();
    const cost = input.emberAmount;

    const [, rows] = await sql.transaction([
        spendLock(sql, input.userId),
        sql`
        WITH precheck AS (
            SELECT 1 FROM ember_ledger WHERE idempotency_key = ${idempotencyKey}
        ), bal AS (
            UPDATE ember_balances
            SET balance = balance - ${cost}::int, updated_at = NOW()
            WHERE user_id = ${input.userId}
              AND balance >= ${cost}::int
              AND NOT EXISTS (SELECT 1 FROM precheck)
            RETURNING user_id
        ), led AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            SELECT ${input.userId}, ${-cost}::int, 'spend', 'shares_buy', ${rule.version},
                   ${idempotencyKey}, ${meta}::jsonb
            FROM bal
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
        ), held AS (
            INSERT INTO share_holdings (id, user_id, ticker_key, shares, avg_buy_price, updated_at, held_since)
            SELECT ${holdingId}::uuid, ${input.userId}::uuid, ${input.tickerKey},
                   ${input.shares}::numeric, ${cost}::numeric / ${input.shares}::numeric, NOW(), NOW()
            FROM led
            ON CONFLICT (user_id, ticker_key) DO UPDATE SET
                -- Every share_holdings.* reference on the right is the PRE-update row, so
                -- these two assignments are order-independent.
                avg_buy_price = (share_holdings.shares * share_holdings.avg_buy_price + ${cost}::numeric)
                                / (share_holdings.shares + EXCLUDED.shares),
                shares = share_holdings.shares + EXCLUDED.shares,
                updated_at = NOW()
                -- held_since is deliberately NOT touched here: adding to a position must
                -- not restart the clock Beaks's hold-through-a-close Play reads
                -- (add_held_since_to_share_holdings.sql). Selling to zero deletes the row,
                -- so the next buy starts a fresh position and a fresh held_since.
            RETURNING shares, avg_buy_price
        ), trade AS (
            INSERT INTO share_trades (id, user_id, ticker_key, side, shares, price, ember_amount,
                                      realized_pnl, trade_token, idempotency_key, ledger_id)
            SELECT ${tradeId}::uuid, ${input.userId}::uuid, ${input.tickerKey}, 'buy',
                   ${input.shares}::numeric, ${input.price}::numeric, ${cost}::int,
                   NULL, ${input.tradeToken}::uuid, ${idempotencyKey}, led.id
            FROM led
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id
        )
        SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
               EXISTS (SELECT 1 FROM led)      AS newly_spent,
               (SELECT shares::float8 FROM held)        AS shares,
               (SELECT avg_buy_price::float8 FROM held) AS avg_buy_price
        `,
    ]);
    const row = rows[0] as unknown as {
        already_recorded: boolean; newly_spent: boolean; shares: number | null; avg_buy_price: number | null;
    };
    const ok = row.already_recorded || row.newly_spent;
    return {
        ok,
        replay: row.already_recorded,
        position: row.newly_spent && row.shares !== null && row.avg_buy_price !== null
            ? { shares: row.shares, avgBuyPrice: row.avg_buy_price }
            : null,
    };
}

// Two statements behind the lock. The first is the mirror of buyShares with the guard
// moved from the balance to the position:
//   precheck  - token already recorded?
//   held      - conditional decrement; `shares >= n` IS the check, so a sell can never
//               drive a position negative
//   led       - the credit row, only when held actually decremented ('earn' - the
//               nearest of the ledger's four entry types)
//   bal       - post()'s balance fold, only when led wrote, plus the lifetime_earned
//               fold: the PROFIT of this sale (credit - shares * avg, rounded to the 4 dp
//               realized_pnl is stored at, floored, never below zero) - proceeds are the
//               trader's own Ember coming back and never count as earned
//   trade     - the diary row, with realized P/L against the average the row held
// The second removes the row if the sale emptied it. A separate statement on purpose:
// Postgres does not permit an UPDATE and a DELETE of the same row inside one WITH (the
// sub-statements share a snapshot and the result is documented as unpredictable). It is
// idempotent and lock-protected, so nothing is lost by splitting it. A later buy then
// takes the upsert's INSERT branch and starts a fresh average.
export async function sellShares(sql: NeonQueryFunction<false, false>, input: TradeInput): Promise<SellSharesResult> {
    const rule = await getActiveRule(sql, 'shares_sell');
    const idempotencyKey = buildIdempotencyKey('shares_sell', input.userId, input.tradeToken);
    const meta = tradeMetadata(input, rule.config.pricingVersion ?? 1);
    const tradeId = crypto.randomUUID();
    const credit = input.emberAmount;

    const [, rows] = await sql.transaction([
        spendLock(sql, input.userId),
        sql`
        WITH precheck AS (
            SELECT 1 FROM ember_ledger WHERE idempotency_key = ${idempotencyKey}
        ), held AS (
            UPDATE share_holdings
            SET shares = shares - ${input.shares}::numeric, updated_at = NOW()
            WHERE user_id = ${input.userId}
              AND ticker_key = ${input.tickerKey}
              AND shares >= ${input.shares}::numeric
              AND NOT EXISTS (SELECT 1 FROM precheck)
            RETURNING shares AS remaining, avg_buy_price
        ), led AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            SELECT ${input.userId}, ${credit}::int, 'earn', 'shares_sell', ${rule.version},
                   ${idempotencyKey}, ${meta}::jsonb
            FROM held
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING id, amount
        ), bal AS (
            INSERT INTO ember_balances (user_id, balance, lifetime_earned, updated_at)
            SELECT ${input.userId}, led.amount,
                   GREATEST(FLOOR(ROUND(${credit}::numeric - ${input.shares}::numeric * held.avg_buy_price, 4)), 0)::int,
                   NOW()
            FROM led, held
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance,
                    lifetime_earned = ember_balances.lifetime_earned + EXCLUDED.lifetime_earned,
                    updated_at = NOW()
            RETURNING user_id
        ), trade AS (
            INSERT INTO share_trades (id, user_id, ticker_key, side, shares, price, ember_amount,
                                      realized_pnl, trade_token, idempotency_key, ledger_id)
            SELECT ${tradeId}::uuid, ${input.userId}::uuid, ${input.tickerKey}, 'sell',
                   ${input.shares}::numeric, ${input.price}::numeric, ${credit}::int,
                   ${credit}::numeric - ${input.shares}::numeric * held.avg_buy_price,
                   ${input.tradeToken}::uuid, ${idempotencyKey}, led.id
            FROM held, led
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING realized_pnl
        )
        SELECT EXISTS (SELECT 1 FROM precheck) AS already_recorded,
               EXISTS (SELECT 1 FROM led)      AS newly_sold,
               (SELECT remaining::float8 FROM held)      AS remaining,
               (SELECT realized_pnl::float8 FROM trade)  AS realized_pnl
        `,
        sql`
        DELETE FROM share_holdings
        WHERE user_id = ${input.userId} AND ticker_key = ${input.tickerKey} AND shares = 0
        `,
    ]);
    const row = rows[0] as unknown as {
        already_recorded: boolean; newly_sold: boolean; remaining: number | null; realized_pnl: number | null;
    };
    return {
        ok: row.already_recorded || row.newly_sold,
        replay: row.already_recorded,
        remaining: row.newly_sold ? row.remaining : null,
        realizedPnl: row.newly_sold ? row.realized_pnl : null,
    };
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
    // Notification copy context, both optional (missing -> the terse fallback copy).
    // pickLabel = the side the user picked, verbatim (picks.side); matchup = the
    // Tank's game label ("Brewers vs Dodgers"). The message is "spoken" by the user's
    // pet in the widget bubble, hence the hype on a win.
    pickLabel?: string;
    matchup?: string;
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
// (e.g. a retried settle run) is a safe no-op, not an error. Unlike post() and the debits, this
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
    //
    // Copy is written in the pet's voice (the PetWidget bubble "speaks" it): a win gets
    // hyped, a loss gets the tank-busted-open line with the consolation amount. Falls
    // back to the original terse copy when the caller has no label/matchup context.
    const inMatchup = input.matchup ? ` in ${input.matchup}` : '';
    const notificationMessage =
        input.result === 'correct'
            ? (input.pickLabel
                ? `LET'S GO! You called "${input.pickLabel}"${inMatchup} and it HIT — the tank cracked open for +${payoutAmount} Ember!`
                : `You called it — +${payoutAmount} Ember.`)
            : (input.pickLabel
                ? `Your pick "${input.pickLabel}"${inMatchup} fell short, so the tank busted open and only ${payoutAmount} Ember came out.`
                : `Your call settled — +${payoutAmount} Ember.`);
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
            INSERT INTO ember_balances (user_id, balance, lifetime_earned, updated_at)
            SELECT ${input.userId}, amount, amount, NOW() FROM ins
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance,
                    lifetime_earned = ember_balances.lifetime_earned + EXCLUDED.lifetime_earned,
                    updated_at = NOW()
        `,
        sql`
            INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood)
            VALUES (${input.userId}, 'claimable', ${notificationMessage}, 'pick', ${input.pickId}, ${notificationKey},
                    ${input.result === 'correct' ? 'happy' : 'sad'})
            ON CONFLICT (idempotency_key) DO NOTHING
        `,
    ]);

    return { payoutAmount };
}

export interface DiscoveryFindEmberInput {
    userId: string;
    petId: string;
    // Pre-rolled by discovery.ts (sustained-aware, randomized within the config range).
    cooldownMinutes: number;
    // The footprints gate (add_pet_footprints.sql): discovery.ts pre-reads it from
    // game_config and the claim UPDATE below re-checks it atomically alongside the clock.
    minPlaces: number;
    // Epoch-ms of the pets.next_eligible_roll_at value being consumed - the identity of
    // this roll window. Makes the ledger idempotency key deterministic per window, so a
    // theoretical replay of the same window is a no-op everywhere.
    windowScope: string;
    // The notification copy needs the rolled amount, and the amount is rolled here
    // (this file owns the discovery_find rule), so the caller passes a builder.
    buildMessage: (amount: number) => string;
    // What the PetWidget bubble shows while it speaks the row (notifications.art -
    // see add_art_to_notifications.sql). The caller supplies it because presentation
    // is the caller's business, not this primitive's: discovery.ts passes the 'ember'
    // sentinel, which the widget answers with a $$$ flourish over the pet's head.
    // Omitted = NULL = a text-only bubble.
    art?: string | null;
}

export interface DiscoveryFindEmberResult {
    // false = a concurrent request consumed this window first (nothing written).
    claimed: boolean;
    amount: number;
}

// A pet's ambient Ember find (Pet Random Event Discovery - see add_pet_discovery.sql).
// Rolls a uniform amount from discovery_find's {min, max} and then, in ONE CTE-chained
// statement: consumes the roll window (the pets UPDATE below is the race guard - a
// losing concurrent request re-evaluates against the winner's pushed-out timestamp and
// matches zero rows - and also enforces + resets the footprints gate), appends the
// ledger row, folds the balance cache (post()'s shape, same double-credit-on-retry
// reasoning), and inserts the claimable notification. Every leg selects FROM the one
// before it, so a lost race writes nothing anywhere. No spendLock: this never debits,
// and the claim UPDATE serializes concurrent rolls.
export async function discoveryFindEmber(
    sql: NeonQueryFunction<false, false>,
    input: DiscoveryFindEmberInput
): Promise<DiscoveryFindEmberResult> {
    const rule = await getActiveRule(sql, 'discovery_find');
    const amount = rule.config.min + Math.floor(Math.random() * (rule.config.max - rule.config.min + 1));
    const idempotencyKey = buildIdempotencyKey('discovery_find', input.userId, input.windowScope);
    const notificationKey = `discovery:${input.petId}:${input.windowScope}`;
    const message = input.buildMessage(amount);
    const rows = await sql`
        WITH claimed AS (
            UPDATE pets
            SET next_eligible_roll_at = NOW() + (${input.cooldownMinutes}::float8 * INTERVAL '1 minute'),
                -- find_count: the Plays find guarantee counts every won window
                -- (rename_quests_to_plays.sql; same increment as discovery.ts's claims).
                places_since_find = '{}', find_count = find_count + 1
            WHERE id = ${input.petId} AND user_id = ${input.userId}
              AND next_eligible_roll_at IS NOT NULL AND next_eligible_roll_at <= NOW()
              AND cardinality(places_since_find) >= ${input.minPlaces}::int
            RETURNING id
        ), led AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            SELECT ${input.userId}, ${amount}::int, 'earn', 'discovery_find', ${rule.version},
                   ${idempotencyKey}, ${JSON.stringify({ petId: input.petId, window: input.windowScope, cooldownMinutes: input.cooldownMinutes })}
            FROM claimed
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING amount
        ), bal AS (
            INSERT INTO ember_balances (user_id, balance, lifetime_earned, updated_at)
            SELECT ${input.userId}, amount, amount, NOW() FROM led
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance,
                    lifetime_earned = ember_balances.lifetime_earned + EXCLUDED.lifetime_earned,
                    updated_at = NOW()
            RETURNING user_id
        ), note AS (
            INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key, mood, art)
            SELECT ${input.userId}, 'claimable', ${message}, 'pet', ${input.petId}::text, ${notificationKey}, 'happy', ${input.art ?? null}
            FROM led
            ON CONFLICT (idempotency_key) DO NOTHING
        )
        SELECT EXISTS (SELECT 1 FROM claimed) AS claimed
    `;
    return { claimed: Boolean((rows[0] as unknown as { claimed: boolean }).claimed), amount };
}

export interface EncounterGiftEmberInput {
    userId: string;
    encounterId: string;
    // Scope of the idempotency key - one gift per (rule, user, encounter).
    encounterKey: string;
    // An ember_rules 'source' key whose config.amount is the gift (e.g. 'encounter_gift').
    ruleKey: string;
}

export interface EncounterGiftEmberResult {
    // false = this encounter's gift was already credited (nothing written).
    credited: boolean;
    amount: number;
}

// A character's Ember gift (NPC encounters - create_encounters.sql). A GIFT, not game
// earnings: written as an 'earn' row so the rule kind stays honest, but the rule key is
// deliberately NOT in LIFETIME_EARNED_RULE_KEYS, so this folds `balance` only (post()'s
// shape) and never moves the Hall of Fame. One statement: the encounters UPDATE is the
// guard (its `NOT (grants ? 'ember')` qual re-evaluates against the winner's version
// under the row lock, so a concurrent heal matches nothing), the ledger insert selects
// FROM it and carries its own idempotency key as the backstop, and the balance fold
// selects FROM the ledger insert. Called right after the encounter is created and again
// by evaluate.ts's heal loop for any encounter whose grants lack `ember`.
export async function encounterGiftEmber(
    sql: NeonQueryFunction<false, false>,
    input: EncounterGiftEmberInput
): Promise<EncounterGiftEmberResult> {
    const rule = await getActiveRule(sql, input.ruleKey);
    const amount = Number(rule.config.amount);
    const idempotencyKey = buildIdempotencyKey(input.ruleKey, input.userId, input.encounterKey);
    const rows = await sql`
        WITH enc AS (
            UPDATE encounters
            SET grants = grants || jsonb_build_object('ember', jsonb_build_object('amount', ${amount}::int))
            WHERE id = ${input.encounterId} AND user_id = ${input.userId} AND NOT (grants ? 'ember')
            RETURNING id
        ), led AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            SELECT ${input.userId}, ${amount}::int, 'earn', ${input.ruleKey}, ${rule.version},
                   ${idempotencyKey}, ${JSON.stringify({ encounterId: input.encounterId, encounterKey: input.encounterKey })}::jsonb
            FROM enc
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING amount
        ), bal AS (
            INSERT INTO ember_balances (user_id, balance, updated_at)
            SELECT ${input.userId}, amount, NOW() FROM led
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()
            RETURNING user_id
        )
        SELECT EXISTS (SELECT 1 FROM led) AS credited
    `;
    return { credited: Boolean((rows[0] as unknown as { credited: boolean }).credited), amount };
}

export interface WelcomeGiftEmberResult {
    // false = this account's welcome gift was already credited (nothing written).
    credited: boolean;
    amount: number;
}

// Sports McLaren's welcome gift - the starting Ember credited once per account when the
// welcome letter is signed (functions/api/onboarding/complete.ts, add_terms_acceptance_and_welcome_gift.sql).
// A GIFT, not game earnings: an 'earn' row whose rule key is NOT in
// LIFETIME_EARNED_RULE_KEYS, so it folds `balance` only and never moves the Hall of
// Fame. The per-account idempotency key is the whole once-only guarantee - a retried or
// racing call inserts nothing and the balance CTE sees no row.
export async function welcomeGiftEmber(
    sql: NeonQueryFunction<false, false>,
    input: { userId: string }
): Promise<WelcomeGiftEmberResult> {
    const rule = await getActiveRule(sql, 'welcome_gift');
    const amount = Number(rule.config.amount);
    const idempotencyKey = buildIdempotencyKey('welcome_gift', input.userId, 'onboarding');
    const rows = await sql`
        WITH led AS (
            INSERT INTO ember_ledger (user_id, amount, entry_type, rule_key, rule_version, idempotency_key, metadata)
            VALUES (${input.userId}, ${amount}::int, 'earn', 'welcome_gift', ${rule.version},
                    ${idempotencyKey}, '{}'::jsonb)
            ON CONFLICT (idempotency_key) DO NOTHING
            RETURNING amount
        ), bal AS (
            INSERT INTO ember_balances (user_id, balance, updated_at)
            SELECT ${input.userId}, amount, NOW() FROM led
            ON CONFLICT (user_id) DO UPDATE
                SET balance = ember_balances.balance + EXCLUDED.balance, updated_at = NOW()
            RETURNING user_id
        )
        SELECT EXISTS (SELECT 1 FROM led) AS credited
    `;
    return { credited: Boolean((rows[0] as unknown as { credited: boolean }).credited), amount };
}

// The welcome gift's current amount for display (the letter, the inbox line) - 0 when
// the rule is missing or inactive, which the letter reads as "no gift paragraph".
export async function welcomeGiftAmount(sql: NeonQueryFunction<false, false>): Promise<number> {
    const rows = await sql`
        SELECT config FROM ember_rules WHERE key = 'welcome_gift' AND active = true LIMIT 1
    `;
    if (rows.length === 0) return 0;
    const amount = Number((rows[0] as unknown as RuleRow).config.amount);
    return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

// Fast-path read of the cached balance.
export async function balance(sql: NeonQueryFunction<false, false>, userId: string): Promise<number> {
    const rows = await sql`SELECT balance FROM ember_balances WHERE user_id = ${userId} LIMIT 1`;
    return rows.length ? (rows[0] as unknown as { balance: number }).balance : 0;
}

// Recomputes the true balance from the ledger and resets the cache to match — used for
// reconciliation and after any incident. Always agrees with balance() in steady state.
// Rebuilds lifetime_earned from the same definition the incremental writes and the
// migration's backfill use (add_lifetime_earned_to_ember_balances.sql), so a rebuilt
// row is indistinguishable from one that was maintained step by step.
export async function rebuildBalance(sql: NeonQueryFunction<false, false>, userId: string): Promise<number> {
    const rows = await sql`
        SELECT
            (SELECT COALESCE(SUM(amount), 0) FROM ember_ledger WHERE user_id = ${userId}) AS total,
            (SELECT COALESCE(SUM(amount), 0) FROM ember_ledger
              WHERE user_id = ${userId} AND entry_type = 'earn'
                AND rule_key = ANY(${[...LIFETIME_EARNED_RULE_KEYS]}::text[])) AS game_earned,
            (SELECT COALESCE(SUM(GREATEST(FLOOR(realized_pnl), 0)), 0) FROM share_trades
              WHERE user_id = ${userId} AND side = 'sell') AS trade_profit
    `;
    const row = rows[0] as unknown as { total: number; game_earned: number; trade_profit: number };
    const total = Number(row.total);
    const lifetimeEarned = Number(row.game_earned) + Number(row.trade_profit);
    await sql`
        INSERT INTO ember_balances (user_id, balance, lifetime_earned, updated_at)
        VALUES (${userId}, ${total}, ${lifetimeEarned}, NOW())
        ON CONFLICT (user_id) DO UPDATE
            SET balance = EXCLUDED.balance, lifetime_earned = EXCLUDED.lifetime_earned, updated_at = NOW()
    `;
    return total;
}
