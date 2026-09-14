-- Canonical team identity on the slate ledger: which CLUBS a locked position involves,
-- and which club (if any) the position's own side is about. Resolved at LOCK time by
-- lib/pages-functions/team-identity.ts and frozen here, exactly like entry_prob - the
-- same reasoning as create_index_positions_table.sql's header applies, one level up.
--
-- WHY RESOLVE AT WRITE AND NOT AT READ. The alternative is a read-time
-- `LEFT JOIN polymarket_props ON market_id` plus a regex over `question`, which is what
-- getTickerResults already does to compose one sentence. That is fine for a sentence and
-- wrong for an aggregate:
--   * The join has no FK and polymarket_props is upserted in place, so it is an
--     unenforced assumption that a historical market's row is still there.
--   * A name nobody has mapped yet would vanish silently from a team's totals at read
--     time. Resolved at write, canonicalTeam returning null is counted by the lock job
--     and reported in its response, where a cron report can show it.
--   * index-lock already SELECTs `question` into SlateMarketRow, so the soccer subject
--     team costs no extra query here.
--
-- WHY subject_team_id IS NULLABLE AND OFTEN NULL. It carries the club the position's
-- HELD SIDE is a statement about, and for most rows there isn't one:
--   * totals ('Over'/'Under') are a property of the game, not of either club;
--   * a soccer 'No' side is "opponent win OR draw" - a three-way leg, not a team.
--     market-movers.ts:186-189 already refuses to attribute it, and so does this column.
-- Only a named moneyline side, or a 'Yes' whose question parses, gets a value. Team
-- aggregates read this column and therefore inherit that refusal by construction.
--
-- away_team_id/home_team_id describe the FIXTURE and are set whenever the names map,
-- independent of which side the index held - so a game can be listed on both clubs'
-- pages even when only one of them has a directional position.
--
-- Backfill for rows written before this migration: scripts/backfill-team-identity.ts
-- (re-runnable; joins polymarket_props for the historical question).
--
-- Execute: psql "$DATABASE_URL" -f add_team_identity_to_index_positions.sql

ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS away_team_id    TEXT;
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS home_team_id    TEXT;
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS subject_team_id TEXT;

-- WHY A REASON CODE AND NOT JUST A NULL. Four completely different things produce "no
-- club on this side", three correct and one a bug, and a bare NULL cannot tell them
-- apart:
--     totals / three_way_no / draw_market      - honest refusals, nothing to fix
--     unmapped_team / unreadable_question /
--     label_matches_neither / missing_teams    - BUGS
-- Measured over the live slate (2026-09-12): 254 totals, 180 side_label, 74 question,
-- 74 three_way_no, 4 side_label_nickname, 4 draw_market, and ZERO of the bug classes.
-- That zero is the invariant the acceptance suite asserts; without this column it is
-- not expressible, and an unmapped club just quietly shrinks a team's record.
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS subject_src     TEXT;

-- The RESOLUTION INPUTS, kept so a registry correction can re-resolve from this table
-- alone. event_teams[].abbreviation is present on 100% of 183,696 team entries measured
-- 2026-09-12 and is a strict bijection with name inside a league (236 names, 236
-- abbreviations). It also survives a rename, which has already happened once in this
-- data: Polymarket now publishes the Oakland Athletics as the bare word 'Athletics'.
-- Without these, a re-resolve needs polymarket_props - and that table is a CACHE of open
-- markets, upserted in place, with no retention guarantee for a market whose game is
-- long finished. A permanent table must not depend on a cache for its meaning.
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS away_abbr       TEXT;
ALTER TABLE index_positions ADD COLUMN IF NOT EXISTS home_abbr       TEXT;

-- subject_src is left NULLABLE and unconstrained by THIS file on purpose: the 996 rows
-- already in the table have no value yet, so a NOT NULL here fails the migration, and a
-- DEFAULT would stamp them with a lie. The backfill applies the constraints below once
-- every row is stamped. Kept here, commented, as the statement of intent - the same
-- two-step discipline seed_ticker_config_v3.sql uses for a config flip.
--
-- ALTER TABLE index_positions
--   ADD CONSTRAINT index_positions_subject_src_check CHECK (subject_src IN (
--     'side_label','side_label_nickname','question',
--     'totals','game_property','three_way_no','draw_market',
--     'unmapped_team','unreadable_question','label_matches_neither','missing_teams'));
-- ALTER TABLE index_positions ALTER COLUMN subject_src SET NOT NULL;

-- The team-page read: settled, directional rows for one club, newest first. Partial
-- because the majority of rows have no subject (see above), and those must never be
-- scanned for a team aggregate.
CREATE INDEX IF NOT EXISTS idx_index_positions_subject
    ON index_positions(subject_team_id, settled_at DESC)
    WHERE subject_team_id IS NOT NULL;

-- The unmapped-club audit, and the hub's "which clubs have enough games" roll-up.
CREATE INDEX IF NOT EXISTS idx_index_positions_subject_src
    ON index_positions(subject_src);

-- The fixture lookup behind "every game this club appeared in", which is a union over
-- the two sides and wants each side indexed separately.
CREATE INDEX IF NOT EXISTS idx_index_positions_away_team
    ON index_positions(away_team_id) WHERE away_team_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_index_positions_home_team
    ON index_positions(home_team_id) WHERE home_team_id IS NOT NULL;
