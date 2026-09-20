-- A spread's side label is an ABBREVIATION, and that is now an attribution (2026-09-20).
--
-- Found live: an NFL spread position with side_label 'BAL' against away 'New Orleans
-- Saints' / home 'Baltimore Ravens' resolved to 'label_matches_neither'. The resolver had
-- no abbreviation arm at all - its nickname rule is a SUFFIX test ('baltimore ravens'
-- ends with ' ravens', never with ' bal') - so every NFL spread label failed to name a
-- club. team-price.ts's header had already recorded the real shape ("a spread tank's
-- outcomes are abbreviations ('TEN', 'SEA')") while team-identity.ts's comment claimed
-- the opposite, verified on SOCCER spreads; both were right about their own sport.
--
-- The abbreviations were already on this table (away_abbr/home_abbr, added by
-- add_team_identity_to_index_positions.sql for exactly this "re-resolve from this table
-- alone" case) - they were simply never passed to the resolver.
--
-- Worse, and fixed in the same change: a spread on the New Orleans Saints has the side
-- label 'NO', which matched the Yes/No arm BEFORE any team matching and returned
-- 'three_way_no' - an honest-refusal code, absent from every BUG_SOURCES list. That row
-- was silently mis-attributed and invisible to the acceptance invariant, to index-lock's
-- attributionBugs counter, and to the backfill's safety gate. The Yes/No arm is now
-- scoped to moneyline, which is the only market shape it was ever written for.
--
-- Execute: psql "$DATABASE_URL" -f add_side_label_abbr_subject_src.sql
-- Then re-resolve every row: npx tsx scripts/backfill-team-identity.ts --dry-run, then for real.

BEGIN;

ALTER TABLE index_positions DROP CONSTRAINT IF EXISTS index_positions_subject_src_check;

ALTER TABLE index_positions ADD CONSTRAINT index_positions_subject_src_check
    CHECK (subject_src = ANY (ARRAY[
        -- attributions
        'side_label', 'side_label_nickname', 'side_label_abbr', 'question',
        -- honest refusals
        'totals', 'game_property', 'three_way_no', 'draw_market',
        -- bugs (the acceptance suite asserts zero of these)
        'unmapped_team', 'unreadable_question', 'label_matches_neither', 'missing_teams'
    ]));

COMMIT;
