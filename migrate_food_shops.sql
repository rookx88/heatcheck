-- Two food vendors open on Tank Land, each with its own menu of four SKUs:
--   Quickboost Delicacies (vendor 'quickboost') - light, cheap boosts.
--   Champion's Lakeside Terrace (vendor 'champions') - hearty plates.
-- Each SKU gets its own ember_rules sink (price) and an items_catalog row whose
-- config carries {satisfaction_points, vendor}; the shop modals filter by vendor
-- client-side and feeding reads satisfaction_points per SKU, so no code special-cases
-- any item. Pricing is scaled against feeding config (max satisfaction 100).
-- The placeholder food_basic/food_premium SKUs are retired by deactivation (same
-- treatment as the placeholder eggs): owned stacks stay feedable, the shop just no
-- longer sells them.
-- Safe to re-run: inserts are ON CONFLICT DO NOTHING, updates are idempotent.
-- Execute: psql "$DATABASE_URL" -f migrate_food_shops.sql

BEGIN;

INSERT INTO ember_rules (key, version, kind, config, active) VALUES
    ('spend_food_yogurt_parfait', 1, 'sink', '{"amount": 10}', true),
    ('spend_food_banana_shake',   1, 'sink', '{"amount": 15}', true),
    ('spend_food_fresh_salad',    1, 'sink', '{"amount": 20}', true),
    ('spend_food_protein_shake',  1, 'sink', '{"amount": 30}', true),
    ('spend_food_stadium_dog',    1, 'sink', '{"amount": 20}', true),
    ('spend_food_breakfast',      1, 'sink', '{"amount": 35}', true),
    ('spend_food_worm_delicacy',  1, 'sink', '{"amount": 45}', true),
    ('spend_food_ribeye',         1, 'sink', '{"amount": 60}', true)
ON CONFLICT (key, version) DO NOTHING;

INSERT INTO items_catalog (key, item_type, name, price_rule_key, config) VALUES
    ('food_yogurt_parfait', 'food', 'Yogurt Parfait',     'spend_food_yogurt_parfait', '{"satisfaction_points": 25,  "vendor": "quickboost"}'),
    ('food_banana_shake',   'food', 'Banana Shake',       'spend_food_banana_shake',   '{"satisfaction_points": 40,  "vendor": "quickboost"}'),
    ('food_fresh_salad',    'food', 'Fresh Salad',        'spend_food_fresh_salad',    '{"satisfaction_points": 50,  "vendor": "quickboost"}'),
    ('food_protein_shake',  'food', 'Protein Shake',      'spend_food_protein_shake',  '{"satisfaction_points": 70,  "vendor": "quickboost"}'),
    ('food_stadium_dog',    'food', 'Stadium Dog',        'spend_food_stadium_dog',    '{"satisfaction_points": 50,  "vendor": "champions"}'),
    ('food_breakfast',      'food', 'Balanced Breakfast', 'spend_food_breakfast',      '{"satisfaction_points": 75,  "vendor": "champions"}'),
    ('food_worm_delicacy',  'food', 'Worm Delicacy',      'spend_food_worm_delicacy',  '{"satisfaction_points": 90,  "vendor": "champions"}'),
    ('food_ribeye',         'food', 'Ribeye Steak',       'spend_food_ribeye',         '{"satisfaction_points": 100, "vendor": "champions"}')
ON CONFLICT (key) DO NOTHING;

UPDATE items_catalog SET active = true WHERE key LIKE 'food\_%' AND key NOT IN ('food_basic', 'food_premium');
UPDATE items_catalog SET active = false WHERE key IN ('food_basic', 'food_premium');

COMMIT;
