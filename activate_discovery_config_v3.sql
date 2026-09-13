-- Throws the switch on sports memorabilia drops.
--
-- RUN THIS LAST - after add_discovery_config_v3.sql has inserted the row AND the code
-- that understands weight_memorabilia is deployed. Until this runs, the deployed code
-- is inert: v2 carries no weight_memorabilia, discovery.ts reads it as 0, and the
-- category is never rolled.
--
-- Reverting is this file with 3 and 2 swapped: no redeploy, no data to undo. Items
-- already found stay in their owners' inventories, which is correct - the switch
-- controls whether NEW drops happen, not whether the category exists.
--
-- Three statements because the one-active-per-key partial unique index rejects a
-- single-statement swap (deactivate-then-activate, never both at once). The NOT EXISTS
-- guard on the second makes the pair safe to re-run and safe against a half-applied
-- previous attempt: if something is already active it declines rather than creating a
-- second active row.
--
-- Verify afterwards - exactly one row, version 3:
--     SELECT version, active FROM game_config WHERE key = 'discovery' ORDER BY version;
-- Execute: psql "$DATABASE_URL" -1 -f activate_discovery_config_v3.sql

UPDATE game_config SET active = false WHERE key = 'discovery' AND active AND version < 3;
UPDATE game_config SET active = true
WHERE key = 'discovery' AND version = 3
  AND NOT EXISTS (SELECT 1 FROM game_config g WHERE g.key = 'discovery' AND g.active);
