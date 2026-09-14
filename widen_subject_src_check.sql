-- Admits 'game_property' to index_positions.subject_src.
--
-- WHY THIS EXISTS. add_team_identity_to_index_positions.sql defined the reason codes a
-- locked side can carry, and the backfill made the column NOT NULL with a CHECK over
-- those ten values (2026-09-13 morning). The same afternoon, team-identity.ts gained an
-- eleventh: 'game_property', for both-teams-to-score - a fact about the game that names
-- no club, so it is an honest refusal like 'totals', not a bug. index-lock.ts now locks
-- that market type.
--
-- The hazard is not one bad row. index-lock writes every position of a run in ONE bulk
-- INSERT (a subrequest-budget decision, see its header), so a single CHECK violation
-- fails the whole statement and NOTHING locks that run - and a game that kicks off
-- unlocked is lost to every index permanently, because its pre-game price lives only in
-- a cache. Run this BEFORE the code that writes 'game_property' deploys.
--
-- Re-runnable. Execute: psql "$DATABASE_URL" -f widen_subject_src_check.sql

ALTER TABLE index_positions DROP CONSTRAINT IF EXISTS index_positions_subject_src_check;
ALTER TABLE index_positions ADD CONSTRAINT index_positions_subject_src_check CHECK (subject_src IN (
    'side_label', 'side_label_nickname', 'question',
    'totals', 'game_property', 'three_way_no', 'draw_market',
    'unmapped_team', 'unreadable_question', 'label_matches_neither', 'missing_teams'));
