-- Pets. One pet per account for this build, but the schema is roster-ready: instead of
-- a hard one-row-per-user constraint, the partial unique index idx_pets_one_captain
-- enforces exactly one is_captain=true pet per user. Every hatched pet this build is a
-- Captain, so that index doubles as the one-pet guarantee AND makes racing hatches safe
-- (a second insert trips the index and rolls back, so no egg is consumed without a pet
-- and no two pets come from one egg). Later roster pets are simply is_captain=false and
-- don't trip it.
--
-- A pet is created ONLY by hatching an egg (functions/api/pets/hatch.ts) - never
-- auto-provisioned. color/render_mode/render_config are copied from the consumed egg's
-- catalog config at hatch: filter mode carries {hue} (hue-rotate the shared green base
-- body), custom_asset carries {asset_key} (a separate skin, e.g. founder).
--
-- Feeding is derive-on-read (no decay cron): current satisfaction is computed from
-- satisfaction_at_last_feed and last_fed_at (see lib/pages-functions/pets.ts), the same
-- stored-facts approach as the Ember balance and session sliding expiry. The 0-100 value
-- is INTERNAL - only the Hungry/Satisfied threshold label is ever exposed.
-- Execute: psql "$DATABASE_URL" -f create_pets_table.sql

CREATE TABLE IF NOT EXISTS pets (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id       UUID NOT NULL REFERENCES waitlist(id) ON DELETE CASCADE,
    base_body     TEXT NOT NULL DEFAULT 'mudpuppy',
    color         TEXT NOT NULL,                 -- copied from egg catalog config at hatch
    render_mode   TEXT NOT NULL DEFAULT 'filter',-- 'filter' | 'custom_asset'
    render_config JSONB NOT NULL DEFAULT '{}',   -- {hue} for filter, {asset_key} for custom_asset
    name          TEXT,
    is_captain    BOOLEAN NOT NULL DEFAULT true,
    satisfaction_at_last_feed REAL NOT NULL DEFAULT 100,  -- internal 0..100; NEVER exposed as a number
    last_fed_at   TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    last_feed_token TEXT,                        -- feed idempotency: dedups a double-submit
    created_at    TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
);

-- Exactly one Captain per user, enforced atomically. Also the one-pet-per-user guard
-- for this build (every pet is is_captain=true).
CREATE UNIQUE INDEX IF NOT EXISTS idx_pets_one_captain ON pets(user_id) WHERE is_captain;

CREATE INDEX IF NOT EXISTS idx_pets_user_id ON pets(user_id);
