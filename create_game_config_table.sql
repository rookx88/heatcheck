-- Versioned tunables for game systems that aren't Ember sources/sinks (so they don't
-- belong in ember_rules), following the exact same discipline: one active version per
-- key (partial unique index), never mutate config in place - insert (key, version+1)
-- and flip active. Feeding lives here so decay rate and the Hungry/Satisfied threshold
-- are retunable without a schema change or redeploy.
--   decay_rate_per_hour: points lost per hour since last feed (3 -> ~20h full to Hungry)
--   hungry_threshold: computed satisfaction < this reads as Hungry, else Satisfied (40)
--   hatch_start_satisfaction: a freshly hatched pet's satisfaction (100 = starts Satisfied)
--   max_satisfaction: hard ceiling; feeding at this value is rejected outright
-- Execute: psql "$DATABASE_URL" -f create_game_config_table.sql

CREATE TABLE IF NOT EXISTS game_config (
    key        TEXT NOT NULL,
    version    INT NOT NULL,
    active     BOOLEAN NOT NULL DEFAULT true,
    config     JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, version)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_game_config_one_active_per_key ON game_config(key) WHERE active;

INSERT INTO game_config (key, version, active, config) VALUES
    ('feeding', 1, true, '{"decay_rate_per_hour": 3, "hungry_threshold": 40, "hatch_start_satisfaction": 100, "max_satisfaction": 100}')
ON CONFLICT (key, version) DO NOTHING;
