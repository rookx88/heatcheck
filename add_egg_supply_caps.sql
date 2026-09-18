-- Finite egg supply, shared across the whole user base, plus two new colours.
--
-- Two things, because they are one product decision: the Hatchery's egg lineup becomes
-- SIX colours (Red, Blue, Green, Purple + Orange, Pink), and every colour is capped at
-- 500 units for the site as a whole. The 501st buyer of a colour cannot have it - not
-- "not today", not "not at this price": the colour is done.
--
-- WHERE THE CAP LIVES
--   sku_supply, a pool row per capped SKU, exactly the collectible_pools model
--   (add_genesis_collectibles.sql) with the serial-allocation half removed - eggs are
--   not serialized, so the counter only counts. The ENFORCED cap is this row, never the
--   catalog config: lib/pages-functions/ledger.ts's purchaseConsumable() takes the pool
--   row's lock (SELECT ... FOR UPDATE) in the same statement as the Ember debit, so all
--   buyers of a colour serialize on it globally and the 501st sale cannot happen no
--   matter how many Workers race. GET /api/shop reads supply - sold_count for display.
--
--   Deliberately a GENERAL table keyed by catalog_key rather than an eggs-only one: a
--   capped food or equipment SKU later is an INSERT here and needs no new code. A SKU
--   with NO row is uncapped, which is why every food SKU keeps working untouched.
--
-- WHAT COUNTS AGAINST THE 500
--   Shop purchases, and only shop purchases - sold_count is written in exactly one
--   place, the purchase statement. An egg handed out by an NPC, a fixture seed, or any
--   future airdrop does not consume public supply, because none of those are someone
--   buying one of the 500.
--
-- sold_count is NOT monotone, unlike collectible_pools.minted_count. That table's
-- counter doubles as a serial allocator, so a freed number would be re-issued and
-- collide; this one allocates nothing, so the acceptance harness releases the supply it
-- consumed when it deletes its fixture users (scripts/acceptance/fixtures.ts), and the
-- public counter stays a count of eggs real people actually hold. The CHECK below is
-- what makes any allocator bug loud instead of silent.
--
-- Safe to re-run: every write is ON CONFLICT DO NOTHING or an idempotent UPDATE. A
-- re-run will NOT reset a sold_count or re-open a sold-out colour.
-- Execute: psql "$DATABASE_URL" -f add_egg_supply_caps.sql

BEGIN;

-- ---------------------------------------------------------------------------------
-- 1. The pool table.
-- ---------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sku_supply (
    catalog_key TEXT PRIMARY KEY REFERENCES items_catalog(key),
    supply      INT NOT NULL,           -- total units that will EVER be sold
    sold_count  INT NOT NULL DEFAULT 0, -- sold so far, site-wide. Sold out = sold_count >= supply
    created_at  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    -- The purchase statement drops the "< supply" qual on its increment on purpose: it
    -- already holds this row's lock, so the check has been made and a second one would
    -- only turn an impossible state into a silent debit-without-grant. This constraint
    -- is the backstop instead - an over-sale aborts the whole transaction loudly and
    -- nothing is written.
    CONSTRAINT sku_supply_bounds CHECK (supply > 0 AND sold_count >= 0 AND sold_count <= supply)
);

-- ---------------------------------------------------------------------------------
-- 2. Two more colours. Same mechanism as every other colourway: a catalog row and a
--    hue, never a new art file (components/eggRender.ts, petRender.ts - the shared art
--    is hue-rotated by the difference from its own base hue). Hues are ABSOLUTE colour
--    targets, chosen to sit clear of the four already in the lineup:
--      red 0 · orange 35 · green 120 · blue 220 · purple 275 · pink 330
--    A hatched pet inherits colour + hue straight from these rows (pets/hatch.ts), so
--    nothing else needs to learn the two new names.
-- ---------------------------------------------------------------------------------
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('egg_orange', 'egg', 'Orange Egg', 'spend_egg_standard', '{"color": "orange", "render_mode": "filter", "hue": 35}'),
    ('egg_pink',   'egg', 'Pink Egg',   'spend_egg_standard', '{"color": "pink",   "render_mode": "filter", "hue": 330}')
ON CONFLICT (key) DO NOTHING;

UPDATE items_catalog SET active = true WHERE key IN ('egg_orange', 'egg_pink');

-- Hover/tap tooltip copy, in the voice of the four in add_item_descriptions.sql.
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Sunset-coloured and faintly striped, like something left out in the light too long. Warm all the way through, not just on the sunny side.$d$) WHERE key = 'egg_orange';
UPDATE items_catalog SET config = config || jsonb_build_object('description', $d$Soft pink and almost translucent, with a slow flutter somewhere under the shell that you will absolutely mistake for your own pulse.$d$) WHERE key = 'egg_pink';

-- ---------------------------------------------------------------------------------
-- 3. 500 of every colour, for everyone, forever.
--
--    sold_count starts at the number ALREADY bought rather than at zero: the four
--    original colours have been on sale, and "500 of this colour exist" has to include
--    the ones people are already holding, or the run would quietly be 500 + however
--    many sold before today. The count comes from ember_ledger, NOT item_ledger: the
--    early sales predate the item journal (they sit in item_ledger only as
--    'opening_balance' rows, which also cover eggs that have since hatched away), while
--    every shop sale ever made wrote exactly one entry_type='spend' row stamped with
--    metadata.catalogKey (ledger.purchaseConsumable). Encounter gifts and fixture seeds
--    write no spend row and correctly do not count. The two new colours have no
--    history and start at 0 by the same expression.
--    LEAST() guards the CHECK in the (unexpected) case that a colour already sold more
--    than 500; it would simply start sold out.
-- ---------------------------------------------------------------------------------
INSERT INTO sku_supply (catalog_key, supply, sold_count)
SELECT c.key,
       500,
       LEAST(500, (SELECT COUNT(*) FROM ember_ledger e
                   WHERE e.entry_type = 'spend' AND e.metadata->>'catalogKey' = c.key))
FROM items_catalog c
WHERE c.key IN ('egg_red', 'egg_blue', 'egg_green', 'egg_purple', 'egg_orange', 'egg_pink')
ON CONFLICT (catalog_key) DO NOTHING;

COMMIT;

-- Post-migration read-out (run separately; not part of the transaction):
--   SELECT catalog_key, supply, sold_count, supply - sold_count AS remaining
--   FROM sku_supply ORDER BY catalog_key;
