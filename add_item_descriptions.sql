-- items_catalog.config.description: a couple of sentences about the object, shown as
-- a hover tooltip wherever an item is listed (the Inventory modal's four tabs, both
-- food shops, and the Feed modal - components/ItemTooltip.tsx).
--
-- This file backfills every SKU that existed BEFORE the memorabilia work. The seven
-- discovery-only foods and the twelve memorabilia carry their copy inline in
-- add_discovery_foods.sql / add_memorabilia_items.sql, so after all three have run,
-- nothing in the catalog is missing one:
--
--     SELECT key, item_type FROM items_catalog WHERE active AND NOT (config ? 'description');
--     -- expect zero rows
--
-- `config || jsonb_build_object(...)` merges the single key and leaves everything else
-- (satisfaction_points, vendor, hue, cover_image, mint_size) untouched, the same idiom
-- the droppable flip uses. Dollar-quoted bodies so apostrophes need no doubling.
-- Re-running overwrites with the same text, so this is idempotent by construction.
--
-- The two retired foods are included deliberately: food_basic / food_premium are
-- inactive and unsellable, but owned stacks stay feedable (migrate_food_shops.sql), so
-- they can still show up in a long-standing account's Food tab and shouldn't be the
-- one row with nothing to say.
--
-- Editing copy later is an UPDATE, not a migration - there is no schema here.
-- Depends on: migrate_food_shops.sql, migrate_egg_catalog_colors.sql,
--             add_genesis_collectibles.sql.
-- Execute: psql "$DATABASE_URL" -1 -f add_item_descriptions.sql

-- Shop foods (Quickboost Delicacies).
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Layered the night before and somehow still crunchy on top. The kind of breakfast that makes you feel organized for about twenty minutes.$d$) WHERE key = 'food_yogurt_parfait';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Three bananas, too much ice, blended well past the point of reason. Goes down cold and sits warm.$d$) WHERE key = 'food_banana_shake';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Crisp, green, and aggressively virtuous. Every leaf was washed by someone who believed in you.$d$) WHERE key = 'food_fresh_salad';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Chalk, vanilla, and ambition in a shaker bottle. Drink it fast enough and it almost tastes like a milkshake.$d$) WHERE key = 'food_protein_shake';

-- Shop foods (Champion's Lakeside Terrace).
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Boiled into submission and wrapped in a bun that gave up hours ago. Tastes like a decent seat and a long inning.$d$) WHERE key = 'food_stadium_dog';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Eggs, toast and fruit, every food group represented and none of them arguing. Often the last complete meal of the day.$d$) WHERE key = 'food_breakfast';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Sourced from the finest mud in the Tank and served without apology. Your pet's eyes go very wide.$d$) WHERE key = 'food_worm_delicacy';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Thick cut, seared hard, rested properly. The good stuff, and somebody else is paying.$d$) WHERE key = 'food_ribeye';

-- Retired foods: inactive and unsellable, but still feedable from owned stacks.
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Standard pellets from before the shops opened. Retired from sale, but perfectly edible.$d$) WHERE key = 'food_basic';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$The old top-shelf tin, retired when the shops reorganized. Whatever is left in your pantry still counts.$d$) WHERE key = 'food_premium';

-- Eggs currently stocked by the Hatchery.
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$A shell the colour of a warning light, warm to the touch on one side. Whatever is inside seems to be in a hurry.$d$) WHERE key = 'egg_red';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Cool, smooth, and heavier than it looks. It holds so still that you start checking on it.$d$) WHERE key = 'egg_blue';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Mottled like river stone and faintly damp no matter where you keep it. Smells very slightly of moss.$d$) WHERE key = 'egg_green';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Deep violet, with a shimmer that moves when you are not looking straight at it. Rocks once in a while, on its own schedule.$d$) WHERE key = 'egg_purple';

-- Retired eggs: deactivated, but hatching reads catalog_key and never checks `active`,
-- so an egg bought during an earlier window still sits in somebody's incubator.
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Pale as bone, from the first clutch the Tank ever recorded. Only ever offered during the founding window.$d$) WHERE key = 'egg_founder_ivory';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Grey and unremarkable, from the first run of eggs the Hatchery ever stocked. Retired when the colours arrived.$d$) WHERE key = 'egg_slate';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Warm-toned and named for the currency, back when that seemed like enough of an idea. Retired when the colours arrived.$d$) WHERE key = 'egg_ember';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Deep green and faintly furred with something that is probably moss. Retired when the colours arrived.$d$) WHERE key = 'egg_moss';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Dusky pink and slightly translucent at the narrow end. Retired when the colours arrived.$d$) WHERE key = 'egg_berry';

-- Genesis Collection cards.
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Gold-plated and numbered to fifty, struck for the Tank's first collection. The heaviest card in the vault.$d$) WHERE key = 'collectible_genesis_gold';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Neon-edged and numbered to two hundred and fifty, the wide release of the Genesis run. The one most likely to turn up in the mud.$d$) WHERE key = 'collectible_genesis_neon';
