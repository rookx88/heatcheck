-- Sports memorabilia: a fourth item_type, and the second thing the pet can dig up
-- that isn't food or currency.
--
-- Shape, and why it is NOT a collectible. Genesis cards are serialized: one
-- inventory row per unit, a serial allocated out of collectible_pools, a hard mint
-- cap. Memorabilia is the opposite end - a worn football is a trinket, not an asset.
-- It STACKS like food (quantity on one row), has no serial, and has no cap; rarity
-- comes entirely from the drop weights below. That means no supply bookkeeping, no
-- exhaustion race, and no migration when a thirteenth item shows up.
--
-- config keys:
--   image               subpath under /assets/images/, exactly the contract
--                       config.cover_image already uses for collectibles - the
--                       catalog owns the path so every renderer stays dumb. Built
--                       from new_items/ by scripts/import-item-art.ts and listed in
--                       NEW_SITE_IMAGES (scripts/generate-static-site.ts).
--   discovery_weight    relative pick weight WITHIN the memorabilia category. An
--                       explicit integer because, unlike food, there is no price to
--                       invert. Higher = more common.
--   discovery_droppable gate independent of `active`, per the doctrine in
--                       add_genesis_collectibles.sql: activating a SKU for some other
--                       channel later must not silently start dropping it here.
--   description         hover copy, same key name as every other item type.
--
-- Weights: the common kit (balls, cards) sits at 12-14, the story pieces (a homerun
-- ball, a snapped stick, a busted trophy) at 4-6. Roughly 3:1 between the ends, which
-- keeps the good ones feeling like an event without making them unreachable.
--
-- PRICE RULE. items_catalog.price_rule_key is NOT NULL and the discovery/shop queries
-- join ember_rules, so every SKU needs a live rule even when nothing is for sale.
-- memorabilia_not_for_sale is an amount-0 sink, mirroring collectible_not_for_sale.
-- Note the column has no FK (create_items_catalog_table.sql) - the sink row is
-- convention, not enforcement, so it has to actually exist.
--
-- Buyability: functions/api/shop.ts and shop/buy.ts both gate on
-- item_type IN ('egg','food'), so memorabilia is structurally unpurchasable with no
-- change to either - the same way equipment and collectibles already are.
--
-- Safe to re-run: inserts are ON CONFLICT DO NOTHING, the index is IF NOT EXISTS.
-- Depends on: create_items_catalog_table.sql, create_inventory_items_table.sql.
-- Execute: psql "$DATABASE_URL" -f add_memorabilia_items.sql

BEGIN;

-- Stacking, mirroring idx_inventory_user_food (create_inventory_items_table.sql):
-- a partial unique index is what makes the grant an upsert instead of a duplicate row.
--
-- READ THIS BEFORE WRITING AN UPSERT. There are now TWO partial unique indexes over
-- (user_id, catalog_key) on this table - one for food, one for memorabilia. That makes
-- a bare `ON CONFLICT (user_id, catalog_key)` AMBIGUOUS: Postgres cannot choose an
-- arbiter and the statement errors. Every insert into inventory_items must spell the
-- predicate out - `ON CONFLICT (user_id, catalog_key) WHERE item_type = '<type>'` -
-- which the existing food upserts (ledger.ts, discovery.ts) already do, and which is
-- why adding this index doesn't break them.
CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_user_memorabilia
    ON inventory_items (user_id, catalog_key) WHERE item_type = 'memorabilia';

INSERT INTO ember_rules (key, version, kind, config, active) VALUES
    ('memorabilia_not_for_sale', 1, 'sink', '{"amount": 0}', true)
ON CONFLICT (key, version) DO NOTHING;

-- Dollar-quoted config so the copy can carry apostrophes without doubling them.
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('memorabilia_worn_soccer_ball', 'memorabilia', 'Worn Soccer Ball', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/worn_soccer_ball.png", "discovery_weight": 14, "discovery_droppable": true,
        "description": "The panels have gone soft and the logo wore off years ago. It has been kicked against the same wall roughly ten thousand times."
     }$j$),
    ('memorabilia_worn_football', 'memorabilia', 'Worn Football', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/worn_football.png", "discovery_weight": 14, "discovery_droppable": true,
        "description": "Leather scuffed pale at both points, laces frayed but holding. Still spirals if you know how to hold it."
     }$j$),
    ('memorabilia_worn_basketball', 'memorabilia', 'Worn Basketball', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/worn_basketball.png", "discovery_weight": 14, "discovery_droppable": true,
        "description": "The pebbling is rubbed smooth in the two places the hands always land. Grips better than it has any right to."
     }$j$),
    ('memorabilia_yellow_card', 'memorabilia', 'Yellow Card', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/yellow_card.png", "discovery_weight": 13, "discovery_droppable": true,
        "description": "Held up just long enough for the name to go in the book. A warning the whole stadium gets to see."
     }$j$),
    ('memorabilia_used_whistle', 'memorabilia', 'Used Whistle', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/used_whistle.png", "discovery_weight": 12, "discovery_droppable": true,
        "description": "Metal, dented, and still faintly sharp on the lip. Blown hard enough to stop a match and start an argument."
     }$j$),
    ('memorabilia_red_card', 'memorabilia', 'Red Card', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/red_card.png", "discovery_weight": 9, "discovery_droppable": true,
        "description": "Pulled from a breast pocket and held up without a word. Somebody's night ended right here."
     }$j$),
    ('memorabilia_game_worn_soccer_cleats', 'memorabilia', 'Game-Worn Soccer Cleats', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/game_worn_soccer_cleats.png", "discovery_weight": 8, "discovery_droppable": true,
        "description": "Creased across the instep from a few thousand touches. The left one has a lace that has been knotted back together twice."
     }$j$),
    ('memorabilia_away_kit_soccer_cleats', 'memorabilia', 'Away-Kit Soccer Cleats', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/away_kit_soccer_cleats.png", "discovery_weight": 8, "discovery_droppable": true,
        "description": "The bright pair, kept for the away strip and never quite broken in. Cleaner than they have any right to be."
     }$j$),
    ('memorabilia_game_worn_football_cleats', 'memorabilia', 'Game-Worn Football Cleats', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/game_worn_football_cleats.png", "discovery_weight": 8, "discovery_droppable": true,
        "description": "Studs worn to nubs along the inside edge, grass still packed into the seams. Somebody's whole season is in the wear pattern."
     }$j$),
    ('memorabilia_homerun_baseball', 'memorabilia', 'Homerun Baseball', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/homerun_baseball.png", "discovery_weight": 6, "discovery_droppable": true,
        "description": "Left the park and came back in somebody's jacket pocket. A date is written on it in ballpoint, already fading."
     }$j$),
    ('memorabilia_broken_hockey_stick', 'memorabilia', 'Broken Hockey Stick', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/broken_hockey_stick.png", "discovery_weight": 5, "discovery_droppable": true,
        "description": "Snapped clean through the shaft on a shot nobody saw go in. The tape is still wrapped tight around what is left of the blade."
     }$j$),
    ('memorabilia_broken_trophy', 'memorabilia', 'Broken Trophy', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/broken_trophy.png", "discovery_weight": 4, "discovery_droppable": true,
        "description": "The figure on top lost an arm somewhere between the podium and the bus. The base still says champion, which is the part that counts."
     }$j$)
ON CONFLICT (key) DO NOTHING;

COMMIT;
