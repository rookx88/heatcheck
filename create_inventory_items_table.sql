-- Per-account owned items. Two behaviors share one table, distinguished by item_type:
--   consumables (egg, food) - tracked by `quantity`, one row per (user, catalog_key),
--     incremented on buy, decremented on use (hatch/feed). The partial unique index
--     idx_inventory_user_consumable is what makes the buy path an idempotent quantity
--     upsert (ON CONFLICT (user_id, catalog_key) DO UPDATE SET quantity = quantity + 1).
--   equipment (hats/gear) - persistent, is_equipped + slot, one equipped item per slot
--     (idx_inventory_one_equipped_per_slot, same partial-unique atomicity as the pet
--     captain invariant). Equipment columns exist now for forward-compatibility; NO
--     equipment SKUs or endpoints ship this build.
-- Non-tradeable is structural: nothing anywhere moves a row's user_id.
-- Execute: psql "$DATABASE_URL" -f create_inventory_items_table.sql

CREATE TABLE IF NOT EXISTS inventory_items (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    catalog_key TEXT NOT NULL REFERENCES items_catalog(key),
    item_type   TEXT NOT NULL,                  -- denormalized from catalog: 'egg' | 'food' | 'equipment'
    quantity    INT NOT NULL DEFAULT 0,          -- consumables (egg/food)
    is_equipped BOOLEAN NOT NULL DEFAULT false,  -- equipment only (schema-only this build)
    slot        TEXT,                            -- equipment: 'head' | 'body' | 'tail'
    offset_x    REAL,                            -- equipment layering, set once by the fitting tool (future)
    offset_y    REAL,
    scale       REAL,
    rotation    REAL,
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Consumables: one stacking row per (user, catalog_key). Powers the idempotent buy upsert.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_user_consumable
    ON inventory_items(user_id, catalog_key) WHERE item_type IN ('egg', 'food');

-- Equipment: at most one equipped item per slot per user (schema-only this build).
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_one_equipped_per_slot
    ON inventory_items(user_id, slot) WHERE is_equipped;

CREATE INDEX IF NOT EXISTS idx_inventory_user_id ON inventory_items(user_id);
