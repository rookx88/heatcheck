-- Footprints gate for Pet Random Event Discovery (lib/pages-functions/discovery.ts).
-- The time gate alone let a script farm one URL: polling /api/toolbar-state until the
-- clock came due granted forever (Ember, food, and Genesis Neon serials, with the Ember
-- counting toward the Hall of Fame). Product intent is that the pet finds things because
-- its owner is EXPLORING the site, so a due roll now ALSO needs the pet to have visited
-- at least min_new_places DISTINCT places since its last find. The cooldown is unchanged;
-- both gates are quals on the same atomic claim UPDATE that consumes a window.
--
-- Places are derived server-side from the page path the header chrome reports on its
-- toolbar-state call (discovery.ts placeFromPath - an allowlist: home, the venues, each
-- TANKDAQ floor, and every Tank article by slug). Article and ticker places are checked
-- against tank_pages / tickers inside the footprint write, so made-up slugs never count.
--   pets.places_since_find - the distinct place keys visited since the last find. Capped
--     at 64 entries in code (the write's WHERE); reset to '{}' by the claim UPDATE.
--   game_config['discovery'].min_new_places - the gate (3). Seeded as version 2 carrying
--     every v1 key unchanged. Never mutate config: insert version+1 and flip active - the
--     three-step shape from seed_ticker_config_v3.sql, because the one-active-per-key
--     partial unique index rejects a single-statement swap. Run in ONE transaction (-1)
--     so a mid-file failure can never leave the key with no active row (which would 500
--     every toolbar-state call for pet owners).
-- Execute: psql "$DATABASE_URL" -1 -f add_pet_footprints.sql

ALTER TABLE pets ADD COLUMN IF NOT EXISTS places_since_find TEXT[] NOT NULL DEFAULT '{}';

INSERT INTO game_config (key, version, active, config) VALUES
    ('discovery', 2, false, '{
        "weight_ember": 70, "weight_food": 25, "weight_collectible": 5,
        "short_cooldown_minutes_min": 45, "short_cooldown_minutes_max": 60,
        "long_cooldown_minutes_min": 90, "long_cooldown_minutes_max": 120,
        "sustained_hours": 2,
        "food_weight_price_exponent": 1,
        "min_new_places": 3
    }')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'discovery' AND active AND version < 2;
UPDATE game_config SET active = true
WHERE key = 'discovery' AND version = 2
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'discovery' AND g.active);
