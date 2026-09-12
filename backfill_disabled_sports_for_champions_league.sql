-- Backfill discord_guild_configs.disabled_sports for the Champions League, added to the
-- soccer slate on 2026-09-09 (see polymarket.ts's LEAGUE_TAGS entry 'Champions League'
-- -> ['ucl'], lib/pages-functions/discord-commands.ts's SUPPORTED_SPORTS, and the setup
-- wizard's SPORT_GROUPS.soccer).
--
-- Same mechanic as backfill_disabled_sports_for_new_soccer_leagues.sql, which added EFL
-- Championship / MLS / DFB-Pokal / Carabao Cup - read that file's header for the full
-- reasoning. In short: disabled_sports is a COMPLEMENT snapshot storing the leagues a
-- guild turned OFF, frozen when the admin chose. A newly added league is therefore
-- enabled-by-default for every existing guild until named here, including guilds that
-- deliberately deselected Soccer, who would otherwise start seeing Champions League
-- fixtures in /pvp without asking.
--
-- The predicate is "EPL is disabled" because both writers of this column (the wizard's
-- wz:sports step and the settings panel's st:setsports) write the sports selection
-- all-or-nothing per group, so for every guild configured through either, "EPL disabled"
-- is identical to "soccer disabled". The one edge remains an admin who used
-- `/heatchecks settings sport:EPL enabled:false` to kill ONLY EPL - they also match and
-- get Champions League disabled. One click in the settings panel to undo.
--
-- Guilds with disabled_sports = '[]' (everything on) and guilds with an unrelated partial
-- selection (e.g. ["NBA"]) are deliberately NOT touched: they have soccer on, so they get
-- the Champions League on, which is the intended default.
--
-- Idempotent: a no-op once the league is present, so re-running is safe. Run BEFORE
-- deploying the code - writing an entry for a league nothing reads yet is inert, whereas
-- the reverse order leaves a window where a soccer-off guild sees UCL in /pvp.
--
-- Execute: psql "$DATABASE_URL" -f backfill_disabled_sports_for_champions_league.sql

UPDATE discord_guild_configs
SET disabled_sports = disabled_sports || '["Champions League"]'::jsonb
WHERE disabled_sports @> '["EPL"]'::jsonb
  AND NOT disabled_sports @> '["Champions League"]'::jsonb;

-- Verification - every row returned should contain "Champions League":
--   SELECT guild_id, disabled_sports FROM discord_guild_configs
--    WHERE disabled_sports @> '["EPL"]'::jsonb;
--
-- Rollback:
--   UPDATE discord_guild_configs
--   SET disabled_sports = COALESCE(
--       (SELECT jsonb_agg(v) FROM jsonb_array_elements_text(disabled_sports) AS t(v)
--         WHERE v <> 'Champions League'), '[]'::jsonb)
--   WHERE disabled_sports @> '["Champions League"]'::jsonb;
