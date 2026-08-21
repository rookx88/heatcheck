-- Pet Random Event Discovery - the "luck channel": while the app is used normally, a
-- pet may find Ember or food (collectibles once that backend exists). The server owns
-- the clock: pets.next_eligible_roll_at is the single scheduling fact, checked as a
-- side effect of GET /api/toolbar-state (lib/pages-functions/discovery.ts). NULL means
-- never scheduled (every pre-feature pet and every fresh hatch); the first check
-- initializes it WITHOUT granting, using the long-cooldown range, so deploy day
-- produces no instant-find burst. A due roll ALWAYS grants (the cooldown is the
-- scarcity mechanism - no stacked "found nothing" outcome), then pushes the timestamp
-- out by a randomized cooldown: short only for pets continuously Satisfied for
-- sustained_hours (satisfied now AND >= sustained_hours since last feed - decay is
-- monotonic between feeds, so satisfied-now implies satisfied the whole way back;
-- feeding restarts the sustained clock by construction, which is what kills
-- last-second pre-check feeding), long otherwise.
--
-- Config split, same discipline as feeding vs correct_call:
--   game_config['discovery'] - weights/cooldowns/sustained window (not an Ember
--     source/sink, so not ember_rules). weight_collectible is seeded at its product
--     value but collectibles have no SKUs yet: roll time detects that and renormalizes
--     over ember+food (equivalent to proportional redistribution) - activating
--     collectible SKUs later makes the weight live with no schema change.
--     food_weight_price_exponent: food SKU weight = (1/price)^exponent, normalized over
--     the active catalog at roll time, so finds skew cheap and catalog changes
--     re-weight automatically with no per-SKU map to maintain.
--   ember_rules['discovery_find'] - the Ember source the ledger rows FK to; config
--     carries the amount range (uniform min..max, rolled in code - knobs in DB,
--     formula in code, same split as correct_call). Pocket-change by design.
-- Retune by inserting (key, version+1) and flipping active - never mutate config.
-- Execute: psql "$DATABASE_URL" -f add_pet_discovery.sql

ALTER TABLE pets ADD COLUMN IF NOT EXISTS next_eligible_roll_at TIMESTAMPTZ; -- nullable, no default: NULL = not yet scheduled

INSERT INTO game_config (key, version, active, config) VALUES
    ('discovery', 1, true, '{
        "weight_ember": 70, "weight_food": 25, "weight_collectible": 5,
        "short_cooldown_minutes_min": 45, "short_cooldown_minutes_max": 60,
        "long_cooldown_minutes_min": 90, "long_cooldown_minutes_max": 120,
        "sustained_hours": 2,
        "food_weight_price_exponent": 1
    }')
ON CONFLICT (key, version) DO NOTHING;

INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('discovery_find', 1, 'source', true, '{"min": 1, "max": 5}')
ON CONFLICT (key, version) DO NOTHING;
