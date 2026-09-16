-- Item movements - the journal inventory_items never had. inventory_items is a BALANCE
-- table (how many of each SKU an account holds right now); item_ledger is the diary of
-- every movement that produced it, in BOTH directions, so SUM(delta) reconciles against
-- it the way SUM(ember_ledger.amount) reconciles against ember_balances.balance.
--
-- Same discipline as ember_ledger (create_ember_ledger_tables.sql): append-only, never
-- UPDATEd or DELETEd; a correction is a future reversal row, not an edit. Every row
-- carries idempotency_key UNIQUE, so the statement that grants or burns is retry-safe by
-- construction instead of each feature inventing its own guard.
--
-- WHY item_reasons IS NOT VERSIONED, unlike ember_rules. ember_rules carries a version
-- because its config carries an AMOUNT that is not on the ledger row: a historical row is
-- only explainable if the payout it was stamped under is frozen. An item movement has no
-- config at all - the amount IS the delta, written on the row. A (key, version) pair here
-- would be a column nobody could ever bump for a reason, plus a getActiveRule() round trip
-- on discovery's and encounters' hot path (their zero-extra-queries budget) to read a
-- config that is empty. item_reasons is a flat vocabulary: an FK target so a typo is a
-- loud error rather than a silent new category, and a place to write down what each means.
--
-- kind is DENORMALIZED onto item_ledger.reason_kind and FK'd back as a PAIR, which is what
-- lets a plain row-level CHECK enforce the sign with no trigger: a 'source' reason can
-- never write a negative delta, a 'sink' never a positive one. 'adjustment' is the escape
-- hatch for rows that are neither (the opening balances below, acceptance fixtures) -
-- exactly the role entry_type='adjustment' plays in ember_ledger.
--
-- inventory_item_id has NO foreign key, deliberately. Eggs and collectibles are one row
-- per unit, and hatching DELETEs the egg row it consumed (pets.ts hatch()) in the SAME
-- statement as the -1 that records the burn. ON DELETE SET NULL would make the cascade
-- UPDATE an append-only row - the one thing this table forbids - and RESTRICT would make
-- hatching impossible without converting eggs to soft-delete. It is a historical fact
-- ("the row this movement touched"), like share_trades.trade_token, not a live pointer.
-- serial_number is stored for the same reason: a card's public identity outlives its row.
--
-- ledger_id pairs a purchase to the debit that paid for it, following share_trades.ledger_id.
-- Purchases go further and share the ember_ledger row's EXACT idempotency_key, so a replayed
-- purchase token can no more write a second item movement than a second debit. NULL on every
-- reason that moves no Ember.
--
-- OPENING BALANCES, and what this table does NOT claim. Feeds and hatches before this
-- migration are unrecoverable: pets.feed_count is a lifetime scalar with no SKU and no
-- timestamp, and a hatched egg's row was DELETEd with no tombstone. Reconstructing only the
-- recoverable half (shop purchases from ember_ledger, encounter grants from encounters.grants,
-- collectibles from serial_number) would therefore NOT sum to any account's current quantity
-- and would need invented balancing rows anyway - which makes the whole reconstruction a
-- fiction dressed as a diary. So the backfill states one true thing instead: as of this
-- migration, this account held N of this SKU. Pre-cutover provenance is not lost; it stays
-- where it already lives (ember_ledger for purchases, encounters.grants for gifts,
-- notifications for finds), joinable by user + catalog key + time. History begins here,
-- and says so.
--
-- DEPLOY ORDER: apply BEFORE deploying the code, and on its own. item_ledger is written
-- inside the same statements that grant items during GET /api/toolbar-state (discovery,
-- encounters), so a missing table or a missing item_reasons row 500s the header chrome for
-- any pet owner whose roll lands a grant. Safe under OLD code (nothing reads it; the opening
-- rows are inert) and safe to re-run. Forward-only: rolling the code back is fine, rolling
-- this back would orphan journal rows and make the reconcile permanently unprovable.
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f create_item_ledger_tables.sql -d "$DATABASE_URL"

BEGIN;

CREATE TABLE IF NOT EXISTS item_reasons (
    key         TEXT PRIMARY KEY,
    kind        TEXT NOT NULL CHECK (kind IN ('source', 'sink', 'adjustment')),
    description TEXT NOT NULL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- Redundant against the PK, but a composite FK needs a matching unique constraint to
    -- point at; this is what carries the sign rule into item_ledger's CHECK.
    UNIQUE (key, kind)
);

INSERT INTO item_reasons (key, kind, description) VALUES
    ('purchase',        'source',     'Bought with Ember in the shop (ledger.purchaseConsumable). Pairs with an ember_ledger spend row via ledger_id and a shared idempotency_key.'),
    ('discovery_find',  'source',     'The pet dug it up while exploring (discovery.ts). item_type says which branch fired: food, memorabilia, or a serialized collectible.'),
    ('encounter_grant', 'source',     'An NPC handed it over when their encounter fired (encounters/evaluate.ts fireEncounter).'),
    ('hatch',           'sink',       'An egg was consumed to create a pet (pets.ts hatch()). The inventory row is DELETEd in the same statement; inventory_item_id records which one.'),
    ('feed',            'sink',       'A food unit was consumed to top up a pet (pets.ts feed()).'),
    ('opening_balance', 'adjustment', 'The pre-journal holding this table starts from. One row per inventory_items row that existed at migration time. Not a movement - a statement of what was already held.'),
    ('acceptance_seed', 'adjustment', 'Acceptance-harness fixture stock (scripts/acceptance/fixtures.ts). Never written by product code. Named rather than borrowed (the way seedBalance borrows participation) because item_ledger has no entry_type column - reason IS the marker, so borrowing would make fixture stock indistinguishable from a real opening balance.')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE IF NOT EXISTS item_ledger (
    id                BIGSERIAL PRIMARY KEY,
    user_id           UUID NOT NULL REFERENCES waitlist(id),
    catalog_key       TEXT NOT NULL REFERENCES items_catalog(key),
    -- Denormalized from the catalog exactly as inventory_items.item_type is, so a movement
    -- row is readable without a join and stays readable if a SKU is retired.
    item_type         TEXT NOT NULL,
    delta             INT  NOT NULL CHECK (delta <> 0),   -- signed; SUM(delta) per (user, SKU) == held
    reason            TEXT NOT NULL,
    reason_kind       TEXT NOT NULL,
    inventory_item_id UUID,          -- NOT a foreign key - see header
    serial_number     INT,           -- collectibles only
    ledger_id         BIGINT REFERENCES ember_ledger(id),
    idempotency_key   TEXT NOT NULL UNIQUE,
    metadata          JSONB NOT NULL DEFAULT '{}',
    created_at        TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    FOREIGN KEY (reason, reason_kind) REFERENCES item_reasons(key, kind),
    CONSTRAINT item_ledger_sign_matches_kind CHECK (
        (reason_kind = 'source' AND delta > 0)
     OR (reason_kind = 'sink'   AND delta < 0)
     OR (reason_kind = 'adjustment')
    )
);

CREATE INDEX IF NOT EXISTS idx_item_ledger_user_catalog ON item_ledger(user_id, catalog_key);
CREATE INDEX IF NOT EXISTS idx_item_ledger_user_created ON item_ledger(user_id, created_at);

-- Never previously enforced. Every consume path already quals on quantity >= 1, so this
-- holds for all existing rows (including the drained-to-zero food stacks). As a constraint
-- it turns any future divergence between a -1 journal row and the decrement it describes
-- into a loud rollback instead of a silent reconcile break.
ALTER TABLE inventory_items DROP CONSTRAINT IF EXISTS inventory_items_quantity_non_negative;
ALTER TABLE inventory_items ADD  CONSTRAINT inventory_items_quantity_non_negative CHECK (quantity >= 0);

-- Opening balances. One row per CURRENTLY HELD inventory row, stating what was already
-- held - not a reconstructed movement. See the header for why nothing is reconstructed.
--
-- WHERE quantity > 0 skips the drained-to-zero food stacks. They contribute 0 to both sides
-- of the reconcile (COALESCE(SUM(delta),0) = 0 = SUM(quantity)), and CHECK (delta <> 0)
-- would reject a zero row anyway. They are LEFT IN PLACE, not deleted: inventory_items
-- .created_at on a stacked row means "first ever acquired and never deleted since" and is
-- exactly what functions/api/inventory.ts renders as acquiredAt; deleting them would
-- silently reset that date on the next purchase. inventory.ts already filters them on read.
--
-- created_at is copied from the inventory row for the same reason: the honest date.
-- idempotency_key derives from the inventory row's own id, so re-running this file writes
-- nothing, and a row created AFTER the cutover (which already has real movements of its
-- own) can never pick up a second opening balance.
INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                         inventory_item_id, serial_number, idempotency_key, metadata, created_at)
SELECT i.user_id, i.catalog_key, i.item_type, i.quantity, 'opening_balance', 'adjustment',
       i.id, i.serial_number,
       'opening_balance:' || i.id::text,
       jsonb_build_object(
           'note', 'pre-journal holding; provenance lives in ember_ledger / encounters.grants / notifications'),
       i.created_at
FROM inventory_items i
WHERE i.quantity > 0
ON CONFLICT (idempotency_key) DO NOTHING;

COMMIT;
