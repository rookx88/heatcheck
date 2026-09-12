-- $FOOTY and $SOCDOGS now score the Champions League alongside the domestic big five
-- (lib/pages-functions/league-rules.ts's LEAGUE_GROUPS.soccer, 2026-09-09). Their
-- tickers.description column - the terse one-liner the homepage Market Movers chip
-- renders - still enumerated only the five domestic leagues, which became false the
-- moment the rule widened.
--
-- Seeded originally by add_tickers_batch2.sql ($FOOTY) and add_tickers_batch3.sql
-- ($SOCDOGS). Those are applied one-shot migrations and are deliberately NOT edited;
-- this is the forward-only correction.
--
-- The longer reader-facing blurbs on the TANKDAQ index pages live in code, not here
-- (lib/pages-functions/ticker-copy.ts), and were updated in the same change.
--
-- Idempotent: re-running rewrites the same strings. Safe to run before or after the
-- code deploy - it is copy only and gates nothing.
--
-- Execute: psql -d "$DATABASE_URL" -f update_soccer_ticker_descriptions_for_champions_league.sql

UPDATE tickers
SET description = 'Soccer storylines - the market-favored side across Europe''s top leagues and the Champions League.'
WHERE key = 'footy';

UPDATE tickers
SET description = 'The soccer slice of the underdogs, across Europe''s top leagues and the Champions League.'
WHERE key = 'socdogs';

-- Verification:
--   SELECT key, rule_type, description FROM tickers WHERE key IN ('footy','socdogs');
--
-- Rollback (restores the original seeded strings):
--   UPDATE tickers SET description = 'Soccer storylines - the market-favored side across EPL, La Liga, Serie A, Bundesliga, Ligue 1.' WHERE key = 'footy';
--   UPDATE tickers SET description = 'The soccer slice of the underdogs, across the big five.' WHERE key = 'socdogs';
