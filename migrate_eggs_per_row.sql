-- Eggs stop being fungible stacks and become one row per egg: buy INSERTs a fresh
-- quantity-1 row, hatch DELETEs that specific row by id. Two same-color eggs are two
-- rows with independent identities. Food keeps the stacking upsert, so the old
-- egg+food partial unique (idx_inventory_user_consumable) shrinks to food-only.
-- Order matters inside: the index must drop BEFORE stacked egg rows are expanded
-- into per-row duplicates, or the duplicates would violate it.
-- Safe to re-run: every step is guarded / a no-op on a second pass.
-- Run BEFORE deploying the matching code (the old buy path's ON CONFLICT arbiter
-- can't be inferred against the new food-only index; nothing calls buy yet).
-- Execute: psql "$DATABASE_URL" -f migrate_eggs_per_row.sql

BEGIN;

-- 1. Drop the egg+food stacking unique.
DROP INDEX IF EXISTS idx_inventory_user_consumable;

-- 2. Expand stacked eggs: a quantity-N row becomes N rows of quantity 1 (N-1 clones
--    here + the original normalized below). Clones keep created_at so acquisition
--    ordering stays sane.
INSERT INTO inventory_items (user_id, catalog_key, item_type, quantity, created_at)
SELECT i.user_id, i.catalog_key, i.item_type, 1, i.created_at
FROM inventory_items i, generate_series(2, i.quantity)
WHERE i.item_type = 'egg' AND i.quantity > 1;

UPDATE inventory_items SET quantity = 1 WHERE item_type = 'egg' AND quantity > 1;

-- 3. Fully-consumed egg stacks (the old hatch path left rows at quantity 0) are
--    meaningless per-row; remove them.
DELETE FROM inventory_items WHERE item_type = 'egg' AND quantity <= 0;

-- 4. Recreate the stacking unique as food-only (the new buy path's conflict target).
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_user_food
    ON inventory_items(user_id, catalog_key) WHERE item_type = 'food';

COMMIT;
