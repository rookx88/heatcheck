-- The pet's food find pool stops being the shop menu and becomes its own menu.
--
-- Before this, a find handed you the same Yogurt Parfait you could buy for 10 Ember
-- two clicks away, which made the reward feel like a coupon. After it, the seven
-- SKUs below are the ENTIRE food drop pool and none of them is for sale: concession
-- food you can only get by having your pet wander off and come back with it.
--
-- Two mechanisms, both catalog-only:
--
--   config.vendor ABSENT  - the shop modals filter by vendor client-side
--                           (egg-shop-client.ts getShopFood), so a vendorless food
--                           appears in neither Quickboost nor Champion's Terrace.
--                           The server now enforces the same thing (functions/api/
--                           shop.ts + shop/buy.ts) so the exclusion isn't cosmetic.
--   config.discovery_droppable - the gate discovery.ts rolls against, mirroring the
--                           collectible branch. Set true here, and set FALSE on the
--                           eight shop foods below, which is what retires them from
--                           the pool without touching their shelf listing.
--
-- ON THE PRICES. Every food needs a live ember_rules sink (items_catalog.price_rule_key
-- is NOT NULL and both the shop and discovery queries join it), but these seven are
-- never sold, so the amount is NOT a shelf price - it is the DROP WEIGHT. The food
-- branch weights each SKU by (1/price)^food_weight_price_exponent, so a lower number
-- means a more common find. Read the column as rarity, not cost:
--
--     10  Caramel Popcorn    ~28%      30  Craft Beer         ~9%
--     12  Cotton Candy       ~23%      40  Mint Julep         ~7%
--     18  Loaded Nachos      ~16%      55  Sampler Platter    ~5%
--     25  Chicken Wings      ~11%
--
-- satisfaction_points stays a real feeding value and tracks the same ladder the shop
-- menu uses (10 Ember -> 25 points ... 60 -> 100), so a rare find is also a better meal.
--
-- ONE TRANSACTION, deliberately: between the INSERT and the droppable flip the
-- droppable pool would be EMPTY, and discovery.ts degrades an empty food pool to an
-- Ember find silently rather than erroring - a window that would cost real drops and
-- leave nothing in the logs.
-- Safe to re-run: inserts are ON CONFLICT DO NOTHING, the flip is idempotent.
-- Depends on: create_items_catalog_table.sql, create_ember_ledger_tables.sql,
--             migrate_food_shops.sql.
-- Execute: psql "$DATABASE_URL" -f add_discovery_foods.sql

BEGIN;

INSERT INTO ember_rules (key, version, kind, config, active) VALUES
    ('spend_food_caramel_popcorn', 1, 'sink', '{"amount": 10}', true),
    ('spend_food_cotton_candy',    1, 'sink', '{"amount": 12}', true),
    ('spend_food_loaded_nachos',   1, 'sink', '{"amount": 18}', true),
    ('spend_food_chicken_wings',   1, 'sink', '{"amount": 25}', true),
    ('spend_food_craft_beer',      1, 'sink', '{"amount": 30}', true),
    ('spend_food_mint_julep',      1, 'sink', '{"amount": 40}', true),
    ('spend_food_sampler_platter', 1, 'sink', '{"amount": 55}', true)
ON CONFLICT (key, version) DO NOTHING;

-- Dollar-quoted config so the copy can carry apostrophes without doubling them.
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('food_caramel_popcorn', 'food', 'Caramel Popcorn', 'spend_food_caramel_popcorn', $j${
        "satisfaction_points": 25, "discovery_droppable": true,
        "description": "Found at the bottom of a bag wedged under a seat in row K. Half the kernels are welded together, and that is the good half."
     }$j$),
    ('food_cotton_candy', 'food', 'Cotton Candy', 'spend_food_cotton_candy', $j${
        "satisfaction_points": 30, "discovery_droppable": true,
        "description": "Spun pink, handed over on a paper cone, gone in four bites. Most of it ends up on your hands."
     }$j$),
    ('food_loaded_nachos', 'food', 'Loaded Nachos', 'spend_food_loaded_nachos', $j${
        "satisfaction_points": 45, "discovery_droppable": true,
        "description": "Chips, cheese that has never been near a cow, and jalapeños placed with real intent. The bottom layer is soup by the second half."
     }$j$),
    ('food_chicken_wings', 'food', 'Chicken Wings', 'spend_food_chicken_wings', $j${
        "satisfaction_points": 60, "discovery_droppable": true,
        "description": "Ten of them, sauce already going tacky, celery untouched as tradition demands. Napkins were not included and never are."
     }$j$),
    ('food_craft_beer', 'food', 'Craft Beer', 'spend_food_craft_beer', $j${
        "satisfaction_points": 65, "discovery_droppable": true,
        "description": "Something hazy with a long name and a hop count nobody asked for. Poured at a tailgate by a man with strong opinions about it."
     }$j$),
    ('food_mint_julep', 'food', 'Mint Julep', 'spend_food_mint_julep', $j${
        "satisfaction_points": 80, "discovery_droppable": true,
        "description": "Bourbon over crushed ice with the mint bruised just enough. Comes in a metal cup that frosts over in the sun."
     }$j$),
    ('food_sampler_platter', 'food', 'Sampler Platter', 'spend_food_sampler_platter', $j${
        "satisfaction_points": 95, "discovery_droppable": true,
        "description": "A bit of everything and enough of nothing. Built for a table of four, found by one pet."
     }$j$)
ON CONFLICT (key) DO NOTHING;

-- Retire the eight shop foods from the drop pool. Keyed on "has a vendor" rather than
-- a hand-listed set of keys, so a food added to a shop later is excluded by default
-- and can never quietly rejoin the pool. `||` merges the one key and leaves
-- satisfaction_points / vendor / description untouched.
UPDATE items_catalog
SET config = config || '{"discovery_droppable": false}'::jsonb
WHERE item_type = 'food' AND config ? 'vendor';

COMMIT;
