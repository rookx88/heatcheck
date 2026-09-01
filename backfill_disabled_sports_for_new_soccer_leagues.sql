-- Backfill discord_guild_configs.disabled_sports for the four soccer competitions added
-- to the Discord pick menus (EFL Championship, MLS, DFB-Pokal, Carabao Cup - see
-- polymarket.ts's LEAGUE_TAGS, lib/pages-functions/discord-commands.ts's
-- SUPPORTED_SPORTS, and the setup wizard's SPORT_GROUPS.soccer).
--
-- disabled_sports is a COMPLEMENT snapshot: it stores the leagues a guild turned OFF,
-- frozen at the moment the admin chose. So a newly added league is enabled-by-default
-- for every existing guild until it is named here - including guilds that explicitly
-- deselected Soccer in setup, who would otherwise start seeing Championship fixtures in
-- /pvp without asking. This names the four for exactly those guilds.
--
-- The predicate is "EPL is disabled" because both writers of this column (the wizard's
-- wz:sports step and the settings panel's st:setsports) write the sports selection
-- all-or-nothing per group - for every guild configured through either, "EPL disabled"
-- is identical to "soccer disabled". The one edge: an admin who used the power-user
-- flag `/heatchecks settings sport:EPL enabled:false` to kill ONLY EPL also matches and
-- gets all four disabled. Rare, and one click in the settings panel to undo.
--
-- Guilds with disabled_sports = '[]' (everything on) and guilds with an unrelated
-- partial selection (e.g. ["NBA"]) are deliberately NOT touched: they have soccer on,
-- so they get the new competitions on, which is the intended default.
--
-- Idempotent: each statement is a no-op once the league is present, so re-running is
-- safe. Run BEFORE deploying the code - writing entries for leagues nothing reads yet
-- is inert, whereas the reverse order leaves a window where a soccer-off guild sees the
-- new leagues in /pvp.
--
-- Execute: psql "$DATABASE_URL" -f backfill_disabled_sports_for_new_soccer_leagues.sql

UPDATE discord_guild_configs
SET disabled_sports = disabled_sports || '["EFL Championship"]'::jsonb
WHERE disabled_sports @> '["EPL"]'::jsonb
  AND NOT disabled_sports @> '["EFL Championship"]'::jsonb;

UPDATE discord_guild_configs
SET disabled_sports = disabled_sports || '["MLS"]'::jsonb
WHERE disabled_sports @> '["EPL"]'::jsonb
  AND NOT disabled_sports @> '["MLS"]'::jsonb;

UPDATE discord_guild_configs
SET disabled_sports = disabled_sports || '["DFB-Pokal"]'::jsonb
WHERE disabled_sports @> '["EPL"]'::jsonb
  AND NOT disabled_sports @> '["DFB-Pokal"]'::jsonb;

UPDATE discord_guild_configs
SET disabled_sports = disabled_sports || '["Carabao Cup"]'::jsonb
WHERE disabled_sports @> '["EPL"]'::jsonb
  AND NOT disabled_sports @> '["Carabao Cup"]'::jsonb;

-- Verification - every row returned should contain all four:
--   SELECT guild_id, disabled_sports FROM discord_guild_configs
--    WHERE disabled_sports @> '["EPL"]'::jsonb;
--
-- Rollback:
--   UPDATE discord_guild_configs
--   SET disabled_sports = COALESCE(
--       (SELECT jsonb_agg(v) FROM jsonb_array_elements_text(disabled_sports) AS t(v)
--         WHERE v NOT IN ('EFL Championship','MLS','DFB-Pokal','Carabao Cup')), '[]'::jsonb)
--   WHERE disabled_sports ?| array['EFL Championship','MLS','DFB-Pokal','Carabao Cup'];
