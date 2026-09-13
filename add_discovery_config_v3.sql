-- discovery config v3: makes room in the find roll for sports memorabilia.
--
--            v2    v3
--   ember    70    68
--   food     25    24
--   sports    -     5     <- new category (item_type='memorabilia')
--   card      5     3
--
-- Weights are raw integers normalized at roll time, not percentages, so the column
-- above is proportional rather than exact. Sports lands on roughly 1 in 20 finds;
-- Ember and food keep close to the feel they already had.
--
-- INSERTED INACTIVE ON PURPOSE. This row is the feature's on-switch and it is thrown
-- SEPARATELY, by activate_discovery_config_v3.sql, AFTER the code is deployed. The
-- order matters in both directions:
--
--   flip before deploy - v3 names a category the running code has no branch for.
--   deploy before flip - the new code reads cfg.weight_memorabilia ?? 0 (see
--                        DiscoveryConfig in lib/pages-functions/discovery.ts, where
--                        the key is declared OPTIONAL for exactly this reason), so
--                        under v2 the memorabilia weight is 0, the category is never
--                        selected, and discovery behaves precisely as it did before.
--                        The deploy is inert. That is the safe order.
--
-- The ?? 0 is load-bearing, not defensive: the roll does raw arithmetic across the
-- weights, and an undefined term would make the sum NaN, every band comparison false,
-- and the whole feature collapse into one arbitrary category.
--
-- Retune doctrine: never mutate an existing config in place - insert (key, version+1)
-- and flip. The one-active-per-key partial unique index rejects a single-statement
-- swap, which is why activation is three statements and lives in its own file.
-- Depends on: add_pet_footprints.sql (v2), add_memorabilia_items.sql.
-- Execute: psql "$DATABASE_URL" -f add_discovery_config_v3.sql

INSERT INTO game_config (key, version, active, config) VALUES
    ('discovery', 3, false, '{
        "weight_ember": 68, "weight_food": 24, "weight_memorabilia": 5, "weight_collectible": 3,
        "short_cooldown_minutes_min": 45, "short_cooldown_minutes_max": 60,
        "long_cooldown_minutes_min": 90, "long_cooldown_minutes_max": 120,
        "sustained_hours": 2,
        "food_weight_price_exponent": 1,
        "min_new_places": 3
    }')
ON CONFLICT (key, version) DO NOTHING;
