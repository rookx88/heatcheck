-- Pet naming: names are unique across ALL pets (case-insensitive), enforced at the
-- DB level so two racing name submissions can't both win - the app maps the 23505 to
-- "name taken". Cross-table uniqueness against waitlist.username is checked in the
-- endpoint's UPDATE gate (a partial race there is acceptable: usernames and pet names
-- only collide cosmetically, and both sides are themselves DB-unique).
-- Safe to re-run: IF NOT EXISTS.
-- Execute: psql "$DATABASE_URL" -f migrate_pet_names.sql

CREATE UNIQUE INDEX IF NOT EXISTS idx_pets_name_lower
    ON pets(LOWER(name)) WHERE name IS NOT NULL;
