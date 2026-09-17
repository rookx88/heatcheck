-- Plays: quests are renamed, deliveries get a sink reason, finds get a counter, and
-- discovery learns how often a requested item is guaranteed.
--
-- 1. quests -> plays, with a COMPATIBILITY VIEW named quests.
--    The code deployed before this change reads quests on every toolbar-state call, for
--    every logged-in pet owner, so a bare rename would break the header on the preview
--    site until the new code lands. A single-table view is auto-updatable, and on
--    2026-09-17 all of the old code's statements were dry-run through it inside a
--    rolled-back transaction: the INSERT ... ON CONFLICT (user_id, quest_key) DO NOTHING
--    (including a second, deduplicated insert), both UPDATEs, and the facts SELECT.
--    Once the new code is live, drop_quests_compat_view.sql removes the view.
--    Encounter KEYS (beaks_quest_done etc.) are deliberately not renamed: the unique
--    (user_id, encounter_key) index is the once-only guard, so renaming a key would
--    replay that scene for everyone who already watched it.
--
-- 2. pets.find_count - lifetime successful discovery finds, incremented inside each
--    find's own claim UPDATE (discovery.ts, ledger.discoveryFindEmber). A delivery Play
--    snapshots it as its baseline, and the forced-find rule is arithmetic over the two.
--    No backfill: the rule only ever uses the difference since a Play started.
--
-- 3. item_reasons 'play_delivery' - the sink written when a delivery Play takes items
--    (encounters/deliver.ts).
--
-- 4. discovery config v4 = v3 + forced_find_every_nth. The code reads the key as
--    optional, so activating it immediately is safe for the code already deployed.
--    v4 REPLACES the whole object, so every v3 key is carried forward verbatim.
--
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f rename_quests_to_plays.sql -d "$DATABASE_URL"
-- Rerunnable: every step checks whether it has already happened.

DO $$
BEGIN
    IF to_regclass('public.plays') IS NULL THEN
        ALTER TABLE quests RENAME TO plays;
        ALTER TABLE plays RENAME COLUMN quest_key TO play_key;
        ALTER INDEX idx_quests_user_key RENAME TO idx_plays_user_key;
        ALTER INDEX quests_pkey RENAME TO plays_pkey;
    END IF;
END $$;

CREATE OR REPLACE VIEW quests AS
    SELECT id, user_id, play_key AS quest_key, encounter_id, objective, baseline,
           visited, reward_encounter_key, started_at, completed_at
    FROM plays;

ALTER TABLE pets ADD COLUMN IF NOT EXISTS find_count INT NOT NULL DEFAULT 0;

INSERT INTO item_reasons (key, kind, description) VALUES
    ('play_delivery', 'sink', 'Handed to a character to finish a delivery Play (encounters/deliver.ts). One row per SKU; the Play id is in the idempotency key and metadata.')
ON CONFLICT (key) DO NOTHING;

INSERT INTO game_config (key, version, active, config) VALUES
    ('discovery', 4, false, '{
        "weight_food": 24,
        "weight_ember": 68,
        "min_new_places": 3,
        "sustained_hours": 2,
        "weight_collectible": 3,
        "weight_memorabilia": 5,
        "long_cooldown_minutes_max": 120,
        "long_cooldown_minutes_min": 90,
        "food_weight_price_exponent": 1,
        "short_cooldown_minutes_max": 60,
        "short_cooldown_minutes_min": 45,
        "forced_find_every_nth": 3
    }')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'discovery' AND active AND version < 4;
UPDATE game_config SET active = true
WHERE key = 'discovery' AND version = 4
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'discovery' AND g.active);
