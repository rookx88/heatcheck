-- Item SKU catalog: the source of truth for every purchasable thing (eggs, food, and
-- forward-compat equipment). "Known outcome only" lives here - an egg SKU's exact
-- resulting color/render is in `config` and shown at listing time; there is no rarity
-- roll and no hidden-until-hatch result anywhere. Price is NOT stored here directly:
-- each SKU points at an ember_rules `sink` row via price_rule_key so prices stay in the
-- same versioned, auditable knob the rest of the economy uses (spend() reads it).
-- render_mode splits standard `filter` (hue-rotate the shared base body,
-- mud_puppy_base_axol.png) from `custom_asset` (a separate skin, e.g. the founder egg).
-- available_from/until make founder colors scarce by history (a launch window), not by
-- a rarity tier. Non-tradeable is enforced by the absence of any transfer endpoint.
-- Execute: psql "$DATABASE_URL" -f create_items_catalog_table.sql

CREATE TABLE IF NOT EXISTS items_catalog (
    key             TEXT PRIMARY KEY,            -- 'egg_slate', 'egg_founder_ivory', 'food_basic', ...
    item_type       TEXT NOT NULL,              -- 'egg' | 'food' | 'equipment'
    name            TEXT NOT NULL,
    price_rule_key  TEXT NOT NULL,              -- ember_rules sink key holding this SKU's Ember price
    config          JSONB NOT NULL DEFAULT '{}',-- egg filter: {color, render_mode:'filter', hue}
                                                -- egg custom: {color, render_mode:'custom_asset', asset_key}
                                                -- food: {satisfaction_points}; equipment: {slot}
    available_from  TIMESTAMP WITH TIME ZONE,    -- NULL = always available
    available_until TIMESTAMP WITH TIME ZONE,    -- NULL = no expiry; set for founder egg's launch window
    active          BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);
