-- The two GM whitelist passes: catalogued, art shipped, and DELIBERATELY UNOBTAINABLE.
--
-- discovery_weight 0 is the off switch. They sit in the memorabilia drop pool with
-- everything else, but discovery.ts filters `discovery_weight > 0` in the pre-roll
-- query, so a 0-weight SKU is excluded before the roll rather than merely improbable -
-- an exact off, not a very small chance. That filter placement matters: the weighted
-- walk falls back to its last row when floating-point summation leaves the accumulator
-- non-negative, so a 0-weight row left in the list COULD be picked, rarely and
-- unrepeatably. It is not in the list.
--
-- Turning them on is a weight change and nothing else - no deploy, no migration:
--
--     UPDATE items_catalog SET config = config || '{"discovery_weight": 2}'::jsonb
--     WHERE key = 'memorabilia_gm_whitelist_silver';
--
-- For scale when that day comes: the memorabilia band is 5% of finds and its live
-- weights total 115 (commons 12-14, the Broken Trophy 4 = 0.17% of all finds). A
-- weight of 2 would put a pass at roughly 0.09% per find; 1 at 0.04%. Pick against
-- that table, not in the abstract - and decide whether a pass should be capped like a
-- Genesis card (collectible_pools) rather than uncapped like a trinket, because
-- item_type 'memorabilia' has NO supply ceiling: at a non-zero weight these mint
-- forever.
--
-- On the item_type: 'memorabilia' is a convenience, not a claim that a whitelist pass
-- is sports memorabilia. It buys the whole pipeline for free (drop pool, stacking
-- upsert, inventory tab, tooltip) with no schema change. If passes become a real
-- product surface they likely want their own type and their own tab; that is a
-- migration for the day they turn on, and nothing here blocks it.
--
-- Safe to re-run: ON CONFLICT DO NOTHING.
-- Depends on: add_memorabilia_items.sql (the memorabilia_not_for_sale sink).
-- Execute: psql "$DATABASE_URL" -1 -f add_whitelist_items.sql

INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('memorabilia_gm_whitelist_gold', 'memorabilia', 'GM Whitelist — Gold', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/gm_whitelist_gold.png", "discovery_weight": 0, "discovery_droppable": true,
        "description": "A gold pass with a name line nobody has filled in yet. Whatever it opens has not opened."
     }$j$),
    ('memorabilia_gm_whitelist_silver', 'memorabilia', 'GM Whitelist — Silver', 'memorabilia_not_for_sale', $j${
        "image": "memorabilia/gm_whitelist_silver.png", "discovery_weight": 0, "discovery_droppable": true,
        "description": "The silver tier of a list that is not taking names yet. Worth holding onto on the chance that it starts."
     }$j$)
ON CONFLICT (key) DO NOTHING;
