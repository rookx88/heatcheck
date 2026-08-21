-- Genesis Collection trading cards - the first collectible SKUs, and with them the
-- serialized-mint machinery the item_type was declared for (create_inventory_items_table.sql).
-- Two editions of the HEATCHECKS tri-fold card (art: heatchecks-cards/):
--   collectible_genesis_neon - mint 250, active NOW. Distributed EXCLUSIVELY through
--     pet discovery (the weight_collectible mass that has renormalized away since day
--     one goes live - see add_pet_discovery.sql). Never sold.
--   collectible_genesis_gold - mint 50, seeded fully but active=false: held back for a
--     later phase whose distribution channel is not yet decided. Flipping it on later
--     is `SET active = true`; it only enters discovery if config.discovery_droppable
--     is ALSO set true, so activation for a shop/airdrop can never silently start drops.
--
-- Serialization model:
--   - Cards are one-row-per-unit in inventory_items (the egg model, not the food
--     stack), plus serial_number for "#N of M" display.
--   - The ENFORCED cap lives in collectible_pools.minted_count, not in the catalog:
--     the grant does a guarded UPDATE (minted_count = minted_count + 1 WHERE
--     minted_count < mint_size) - spend()'s check-and-decrement idiom - so the row
--     lock serializes all mints of a SKU globally and RETURNING minted_count IS the
--     freshly allocated serial. config.mint_size on the catalog row is display copy.
--   - minted_count is MONOTONE. Never decrement it - not even when deleting test
--     grants. A freed serial would be re-issued and collide on
--     idx_inventory_collectible_serial with any real mint issued in between. Gaps in
--     the issued sequence are the accepted cost of cleanup.
-- Execute: psql "$DATABASE_URL" -f add_genesis_collectibles.sql

-- Display + audit identity of a card copy. The pool counter allocates; this index
-- makes any future allocator bug a loud constraint error, never a silent duplicate.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS serial_number INT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_inventory_collectible_serial
    ON inventory_items(catalog_key, serial_number) WHERE item_type = 'collectible';

CREATE TABLE IF NOT EXISTS collectible_pools (
    catalog_key  TEXT PRIMARY KEY REFERENCES items_catalog(key),
    mint_size    INT NOT NULL,
    minted_count INT NOT NULL DEFAULT 0,  -- monotone: see header. Sold out = minted_count >= mint_size.
    created_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- items_catalog.price_rule_key is NOT NULL by schema, but cards are never sold: one
-- shared zero-amount sink satisfies the reference and nothing ever reads it (the shop
-- surfaces hardcode item_type IN ('egg','food'), and discovery's price join is
-- food-only). A placeholder by convention, not a price.
INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('collectible_not_for_sale', 1, 'sink', true, '{"amount": 0}')
ON CONFLICT (key, version) DO NOTHING;

-- config keys the code reads:
--   edition/series      - theming + grouping ('gold' | 'neon', 'genesis')
--   mint_size           - display copy for "#N of M" (enforced cap is the pool row)
--   discovery_droppable - discovery prober gate, independent of active (see header)
--   cover_image         - subpath under /assets/images/
--   match_title/caption - the holo-sphere faces inside the unfolded card
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, active) VALUES
    ('collectible_genesis_gold', 'collectible', 'Genesis Collection — Gold Edition',
     'collectible_not_for_sale',
     '{
        "edition": "gold", "series": "genesis", "mint_size": 50,
        "discovery_droppable": false,
        "cover_image": "collectibles/gold_plated_card.jpg",
        "match_title": "2026 World Cup Final: Spain vs Argentina",
        "match_caption": "Ferran Torres scored the winning goal in the 106th minute to win the World Cup"
     }', false),
    ('collectible_genesis_neon', 'collectible', 'Genesis Collection — Neon Edition',
     'collectible_not_for_sale',
     '{
        "edition": "neon", "series": "genesis", "mint_size": 250,
        "discovery_droppable": true,
        "cover_image": "collectibles/neon_og_card.jpg",
        "match_title": "2026 World Cup Final: Spain vs Argentina",
        "match_caption": "Ferran Torres scored the winning goal in the 106th minute to win the World Cup"
     }', true)
ON CONFLICT (key) DO NOTHING;

INSERT INTO collectible_pools (catalog_key, mint_size) VALUES
    ('collectible_genesis_gold', 50),
    ('collectible_genesis_neon', 250)
ON CONFLICT (catalog_key) DO NOTHING;
