-- Starter catalog: price sink-rules (ember_rules) + item SKUs (items_catalog). Prices
-- and hue values are starting balance/render placeholders - retune by inserting a new
-- ember_rules version (never mutate config in place) or updating catalog config; no
-- schema change needed. Standard eggs share one price rule; the founder egg has its own
-- price and a launch-window available_until (scarce by history, not by rarity roll).
-- Depends on: create_items_catalog_table.sql, create_ember_ledger_tables.sql.
-- Execute: psql "$DATABASE_URL" -f seed_catalog_and_prices.sql

-- Sink price rules (spend() reads config.amount for the SKU's price_rule_key).
INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('spend_egg_standard', 1, 'sink', true, '{"amount": 100}'),
    ('spend_egg_founder',  1, 'sink', true, '{"amount": 250}'),
    ('spend_food_basic',   1, 'sink', true, '{"amount": 15}'),
    ('spend_food_premium', 1, 'sink', true, '{"amount": 50}')   -- > 2.5x basic (37.5)
ON CONFLICT (key, version) DO NOTHING;

-- SKUs. filter mode = hue-rotate the shared green base body (mud_puppy_base_axol.png);
-- `hue` is the degrees the render layer applies (placeholders). custom_asset = a separate
-- skin keyed by asset_key (founder egg).
INSERT INTO items_catalog (key, item_type, name, price_rule_key, config, available_until) VALUES
    ('egg_slate',         'egg',  'Slate Egg',         'spend_egg_standard', '{"color":"slate","render_mode":"filter","hue":180}', NULL),
    ('egg_ember',         'egg',  'Ember Egg',         'spend_egg_standard', '{"color":"ember","render_mode":"filter","hue":250}', NULL),
    ('egg_moss',          'egg',  'Moss Egg',          'spend_egg_standard', '{"color":"moss","render_mode":"filter","hue":40}',  NULL),
    ('egg_berry',         'egg',  'Berry Egg',         'spend_egg_standard', '{"color":"berry","render_mode":"filter","hue":140}', NULL),
    ('egg_founder_ivory', 'egg',  'Founder Ivory Egg', 'spend_egg_founder',  '{"color":"founder_ivory","render_mode":"custom_asset","asset_key":"founder_ivory"}', '2026-12-31T00:00:00Z'),
    ('food_basic',        'food', 'Basic Food',        'spend_food_basic',   '{"satisfaction_points":40}',  NULL),
    ('food_premium',      'food', 'Premium Food',      'spend_food_premium', '{"satisfaction_points":100}', NULL)
ON CONFLICT (key) DO NOTHING;
