-- NPC encounters - a character shows up on screen and talks to the pet
-- (lib/pages-functions/encounters/). Definitions (characters, triggers, effects,
-- dialogue) live in a typed TS registry, one file per character; this schema holds only
-- the per-user STATE: which encounters fired, what they granted, and quest progress.
--
--   encounters - one row per (user, encounter) ever fired. The unique index is both the
--     once-per-user rule and the race guard: the fire statement INSERTs ON CONFLICT DO
--     NOTHING and every grant leg selects FROM that insert, so concurrent page loads
--     grant exactly once. status: 'offered' = created, dialogue not yet watched;
--     'seen' = the player finished (or closed) the dialogue - closing by any means
--     counts, an abandoned tab replays it next load. grants records what was actually
--     handed over ({item:{catalogKey,itemType}, ember:{amount}}) so the dialogue can
--     name it and a crash between the fire and the Ember gift is healable (the gift
--     statement re-checks `grants ? 'ember'`).
--   quests - an objective a character set, tracked FROM the encounter moment: baseline
--     snapshots the user's counts at start (taken inside the fire statement, so it is
--     consistent with the DB at insert time) and progress is derived as current fact
--     minus baseline - no per-event increments anywhere. visited is the quest-local
--     progress for visit_places objectives (pets.places_since_find resets on every
--     find, so it cannot be reused). objective is a snapshot of the registry entry so
--     a later registry edit never retro-changes a quest already in flight.
--   pets.feed_count - the only trigger/objective fact that had no cheap derivation
--     (feeding wrote no counter, no ledger row, no event). Incremented inside the
--     existing feed UPDATE (lib/pages-functions/pets.ts feed()). Pre-existing pets
--     start at 0: objectives are relative to a baseline so that is harmless, and a
--     feeds_at_least trigger simply counts post-deploy feeds.
--   ember_rules['encounter_gift'] - the Ember a character hands over. A GIFT, not game
--     earnings: written as an 'earn' row by ledger.encounterGiftEmber() but deliberately
--     absent from ledger.ts LIFETIME_EARNED_RULE_KEYS, so it folds `balance` only and
--     never moves an account on the Hall of Fame (add_lifetime_earned_to_ember_balances.sql
--     defines lifetime_earned by that key list; the harness recompute uses the same list).
--   game_config['encounters'] - the retunable thresholds the registry's triggers name
--     by configKey (e.g. lifetime_earned_at_least 'beaks_intro_ember'). Never mutate:
--     insert (key, version+1) and flip active.
--
-- DEPLOY ORDER: apply BEFORE deploying the code. The facts statement runs inside the
-- GET /api/toolbar-state batch for every pet owner - missing tables would 500 the
-- header chrome on every page.
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f create_encounters.sql -d "$DATABASE_URL"

CREATE TABLE IF NOT EXISTS encounters (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    encounter_key TEXT NOT NULL,
    character_key TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered', 'seen')),
    grants        JSONB NOT NULL DEFAULT '{}',
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    seen_at       TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_encounters_user_key ON encounters(user_id, encounter_key);
CREATE INDEX IF NOT EXISTS idx_encounters_user_offered ON encounters(user_id, created_at) WHERE status = 'offered';

CREATE TABLE IF NOT EXISTS quests (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    quest_key            TEXT NOT NULL,
    encounter_id         UUID NOT NULL REFERENCES encounters(id) ON DELETE CASCADE,
    objective            JSONB NOT NULL,
    baseline             JSONB NOT NULL,
    visited              TEXT[] NOT NULL DEFAULT '{}',
    reward_encounter_key TEXT NOT NULL,
    started_at           TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    completed_at         TIMESTAMP WITH TIME ZONE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_quests_user_key ON quests(user_id, quest_key);

ALTER TABLE pets ADD COLUMN IF NOT EXISTS feed_count INT NOT NULL DEFAULT 0;

INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('encounter_gift', 1, 'source', true, '{"amount": 25}')
ON CONFLICT (key, version) DO NOTHING;

INSERT INTO game_config (key, version, active, config) VALUES
    ('encounters', 1, true, '{"beaks_intro_ember": 500}')
ON CONFLICT (key, version) DO NOTHING;
