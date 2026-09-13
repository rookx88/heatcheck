-- The encounter cast: four more characters join Beaks, so the thresholds they read
-- from game_config need a version bump, and the one who pays out more than Beaks
-- needs a gift rule of his own.
--
-- Ladder (lib/pages-functions/encounters/characters/):
--   Blobby      - first pick ever            (picks_at_least, literal in the registry)
--   Puffington  - three feeds                (feeds_at_least, literal)
--   Beaks       - beaks_intro_ember          LOWERED 500 -> 200
--   Charles     - charles_intro_ember + 10 picks
--   Vic Marlow  - no threshold at all: he fires once Charles's goodbye has been
--                 watched, so the tease paces itself off that arc (~650 earned) and
--                 there is no number on him to retune.
-- Only the two Ember gates live here. Pick and feed counts stay literal in the
-- registry: they are shaped by the daily pick cap, not by economy tuning.
--
-- v2 REPLACES the whole config object, so beaks_intro_ember has to be carried
-- forward. A dropped key does not error - evaluate.ts treats a non-finite threshold
-- as "never fires" - so the character would just silently stop appearing. The
-- encounters acceptance suite asserts every configKey in the registry resolves here,
-- which is the guard against exactly that.
--
-- encounter_gift_large is a NEW rule rather than a retune of encounter_gift: the
-- amount is read off the rule row (ledger.encounterGiftEmber) and the grant_ember
-- effect carries only a key, so two payout sizes need two keys. It is a source rule
-- but deliberately absent from LIFETIME_EARNED_RULE_KEYS (ledger.ts), so like the
-- small gift it moves the balance and never the Hall of Fame. A brand new key needs
-- no active-flip dance - only an existing key does.
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f seed_encounters_config_v2.sql -d "$DATABASE_URL"

INSERT INTO game_config (key, version, active, config) VALUES
    ('encounters', 2, false, '{
        "beaks_intro_ember": 200,
        "charles_intro_ember": 500
    }')
ON CONFLICT (key, version) DO NOTHING;

UPDATE game_config SET active = false WHERE key = 'encounters' AND active AND version < 2;
UPDATE game_config SET active = true
WHERE key = 'encounters' AND version = 2
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'encounters' AND g.active);

INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('encounter_gift_large', 1, 'source', true, '{"amount": 100}')
ON CONFLICT (key, version) DO NOTHING;
