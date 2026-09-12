-- $FOOTY and $SOCDOGS widened from "Europe's top leagues + the Champions League" to
-- EVERY soccer competition the prop sync ingests (2026-09-12): the soccer group in
-- lib/pages-functions/league-rules.ts gained EFL Championship, MLS, DFB-Pokal and
-- Carabao Cup, so the two indexes now score domestic cups and MLS as well.
--
-- WHY: the global indexes ($CHALK, $DOGS, $OVERS, ...) have no league gate and were
-- already scoring those four - ~25% of $CHALK's lifetime contribution magnitude - while
-- no league-scoped child claimed them. The families are supposed to partition their
-- parents exactly; this restores that.
--
-- Their tickers.description column - the terse one-liner the homepage Market Movers chip
-- renders - still named Europe and the Champions League, which stopped being true the
-- moment MLS and the EFL Championship joined. Previous forward-only correction was
-- update_soccer_ticker_descriptions_for_champions_league.sql; this supersedes it.
--
-- The longer reader-facing blurbs on the TANKDAQ index pages live in code
-- (lib/pages-functions/ticker-copy.ts) and were updated in the same change. The league
-- CHIPS on those pages need no edit at all any more - they derive from the rule's own
-- league set, so they picked up the four new competitions automatically.
--
-- Idempotent: re-running rewrites the same strings. Copy only, gates nothing, so it is
-- safe to run before or after the code deploy.
--
-- Execute: psql -v ON_ERROR_STOP=1 -d "$DATABASE_URL" -f update_soccer_ticker_descriptions_for_full_soccer_slate.sql

UPDATE tickers
SET description = 'Soccer storylines - the market-favored side across every soccer competition on the board.'
WHERE key = 'footy';

UPDATE tickers
SET description = 'The soccer slice of the underdogs, across every soccer competition on the board.'
WHERE key = 'socdogs';

-- Verification:
--   SELECT key, rule_type, description FROM tickers WHERE key IN ('footy','socdogs');
--
-- Rollback (restores the Champions-League-era strings):
--   UPDATE tickers SET description = 'Soccer storylines - the market-favored side across Europe''s top leagues and the Champions League.' WHERE key = 'footy';
--   UPDATE tickers SET description = 'The soccer slice of the underdogs, across Europe''s top leagues and the Champions League.' WHERE key = 'socdogs';
