-- The shop's egg lineup becomes exactly four color eggs: Red, Blue, Green, Purple.
-- The original placeholder SKUs (slate/ember/moss/berry, whose names never matched
-- their placeholder hues) and the founder ivory egg are retired by deactivation, NOT
-- deletion: inventory_items.catalog_key references them, and already-owned eggs of a
-- retired SKU must stay hatchable (hatch reads config through the owned row's
-- catalog_key and never checks `active`). Deactivated SKUs simply drop out of
-- GET /api/shop, which filters active = true.
-- Safe to re-run: the UPDATE is idempotent (new SKUs are re-activated by key) and the
-- INSERT is ON CONFLICT DO NOTHING.
-- Execute: psql "$DATABASE_URL" -f migrate_egg_catalog_colors.sql

BEGIN;

-- 1. Retire every existing egg SKU...
UPDATE items_catalog SET active = false WHERE item_type = 'egg';

-- 2. ...then add (or re-activate, on re-run) the four color eggs.
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('egg_red',    'egg', 'Red Egg',    'spend_egg_standard', '{"color": "red",    "render_mode": "filter", "hue": 0}'),
    ('egg_blue',   'egg', 'Blue Egg',   'spend_egg_standard', '{"color": "blue",   "render_mode": "filter", "hue": 220}'),
    ('egg_green',  'egg', 'Green Egg',  'spend_egg_standard', '{"color": "green",  "render_mode": "filter", "hue": 120}'),
    ('egg_purple', 'egg', 'Purple Egg', 'spend_egg_standard', '{"color": "purple", "render_mode": "filter", "hue": 275}')
ON CONFLICT (key) DO NOTHING;

UPDATE items_catalog SET active = true WHERE key IN ('egg_red', 'egg_blue', 'egg_green', 'egg_purple');

COMMIT;
