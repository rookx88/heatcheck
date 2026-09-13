// Acceptance suite for team attribution and market residuals (2026-09-12). Run after any
// change to lib/pages-functions/team-identity.ts, lib/pages-functions/team-records.ts,
// functions/api/index-lock.ts's resolver wiring, or scripts/backfill-team-identity.ts.
//
// Two tiers:
//   1. Pure - the resolver's four market shapes and its refusals, plus the aggregation,
//      on hand-built rows shaped like live index_positions data sampled 2026-09-12.
//   2. DB - the REAL dedupe SQL over the REAL table via a pg adapter, asserting the
//      invariants that silently produce plausible-but-wrong numbers when broken.
//
// Writes nothing. Every DB check is a read, so there are no fixtures and no teardown.
//
// THE TWO CHECKS THAT MATTER MOST, because both failure modes are silent:
//   * every settled moneyline side resolves to a club or a NAMED refusal - a club nobody
//     mapped otherwise just shrinks a team's record with no error;
//   * the two sides of a two-way game have contributions summing to zero - if that drifts,
//     contributionFor is being fed the wrong probability and every residual is wrong.

import { check, near, section, warn, EPS, type Suite } from '../harness';
import { sqlViaPool } from '../fixtures';
import { canonicalTeam, resolvePositionTeams, teamSlug, type SubjectSource } from '../../../lib/pages-functions/team-identity';
import {
    DEFAULT_MIN_GAMES,
    assertDeduped,
    buildTeamRecord,
    buildTeamRecords,
    rankByResidual,
    type TeamSideRow,
} from '../../../lib/pages-functions/team-records';
import { contributionFor } from '../../../lib/pages-functions/index-slate';

const BUG_SOURCES: SubjectSource[] = [
    'unmapped_team',
    'unreadable_question',
    'label_matches_neither',
    'missing_teams',
];

// Live shapes, sampled 2026-09-12.
const MLB = { league: 'MLB', away: 'Detroit Tigers', home: 'Cleveland Guardians' };
const NFL = { league: 'NFL', away: 'San Francisco 49ers', home: 'Los Angeles Rams' };
const EPL = { league: 'EPL', away: 'Liverpool FC', home: 'Ipswich Town FC' };
const MLS_DRAW = { league: 'MLS', away: 'Philadelphia Union', home: 'CF Montréal' };

function side(over: Partial<TeamSideRow>): TeamSideRow {
    return {
        eventId: 'e1',
        league: 'MLB',
        teamId: 'detroit-tigers',
        opponentTeamId: 'cleveland-guardians',
        entryProb: 0.5,
        won: true,
        settledAt: '2026-09-01T00:00:00.000Z',
        kickoff: '2026-09-01T00:00:00.000Z',
        away: 'Detroit Tigers',
        home: 'Cleveland Guardians',
        threeWay: false,
        ...over,
    };
}

async function run(): Promise<void> {
    // -------------------------------------------------------------------------------
    section('Team identity - slugs and the registry');
    // -------------------------------------------------------------------------------
    check('diacritics fold rather than vanish', teamSlug('CF Montréal') === 'cf-montreal', teamSlug('CF Montréal'));
    check('accented Spanish folds', teamSlug('Deportivo Alavés') === 'alaves' || canonicalTeam('La Liga', 'Deportivo Alavés')?.id === 'alaves');
    check('punctuation collapses', teamSlug('St. Louis City SC') === 'st-louis-city-sc', teamSlug('St. Louis City SC'));
    check('leading numerals survive', teamSlug('Mainz 05') === 'mainz-05', teamSlug('Mainz 05'));

    check('a club is ONE id across competitions',
        canonicalTeam('EPL', 'Chelsea FC')?.id === canonicalTeam('Carabao Cup', 'Chelsea FC')?.id
        && canonicalTeam('EPL', 'Chelsea FC')?.id === 'chelsea');
    check('an unmapped club resolves to null, never a guess', canonicalTeam('EPL', 'Totally Fake FC') === null);
    check('a null name resolves to null', canonicalTeam('EPL', null) === null);

    // -------------------------------------------------------------------------------
    section('Team identity - the four market shapes');
    // -------------------------------------------------------------------------------
    const mlb = resolvePositionTeams({ ...MLB, marketType: 'moneyline', sideLabel: 'Cleveland Guardians', question: null });
    check('a named moneyline side IS the club',
        mlb.subjectTeamId === 'cleveland-guardians' && mlb.subjectSource === 'side_label', JSON.stringify(mlb));

    // NFL labels its sides with the bare nickname - measured on all 8 live NFL rows.
    // An exact-name rule drops the whole league and looks exactly like an honest refusal.
    const nfl = resolvePositionTeams({ ...NFL, marketType: 'moneyline', sideLabel: '49ers', question: null });
    check('an NFL nickname resolves inside the game\'s two clubs',
        nfl.subjectTeamId === 'san-francisco-49ers' && nfl.subjectSource === 'side_label_nickname', JSON.stringify(nfl));

    const yes = resolvePositionTeams({
        ...EPL, marketType: 'moneyline', sideLabel: 'Yes',
        question: 'Will Liverpool FC win on 2026-09-13?',
    });
    check('a soccer Yes resolves to the club in the question',
        yes.subjectTeamId === 'liverpool' && yes.subjectSource === 'question', JSON.stringify(yes));

    const no = resolvePositionTeams({
        ...EPL, marketType: 'moneyline', sideLabel: 'No',
        question: 'Will Liverpool FC win on 2026-09-13?',
    });
    check('a soccer No names NO club - it is opponent-win-OR-draw',
        no.subjectTeamId === null && no.subjectSource === 'three_way_no', JSON.stringify(no));
    check('a soccer No still describes the fixture',
        no.awayTeamId === 'liverpool' && no.homeTeamId === 'ipswich-town');

    const draw = resolvePositionTeams({
        ...MLS_DRAW, marketType: 'moneyline', sideLabel: 'Yes',
        question: 'Will Philadelphia Union vs. CF Montréal end in a draw?',
    });
    check('a legacy draw market belongs to neither club',
        draw.subjectTeamId === null && draw.subjectSource === 'draw_market', JSON.stringify(draw));

    const totals = resolvePositionTeams({ ...MLB, marketType: 'totals', sideLabel: 'Over', question: null });
    check('a total is a property of the game, not of a club',
        totals.subjectTeamId === null && totals.subjectSource === 'totals', JSON.stringify(totals));

    // A question naming a club that is NEITHER side of the fixture means Polymarket
    // changed a format. It must fail loudly, not silently attach to someone.
    const drift = resolvePositionTeams({
        ...EPL, marketType: 'moneyline', sideLabel: 'Yes',
        question: 'Will Arsenal FC win on 2026-09-13?',
    });
    check('a question naming neither club is a BUG, not an attribution',
        drift.subjectTeamId === null && drift.subjectSource === 'unreadable_question', JSON.stringify(drift));

    const ambiguous = resolvePositionTeams({
        league: 'MLB', away: 'Chicago Cubs', home: 'Chicago White Sox',
        marketType: 'moneyline', sideLabel: 'Chicago', question: null,
    });
    check('a label matching neither club exactly is refused, not guessed',
        ambiguous.subjectTeamId === null && ambiguous.subjectSource === 'label_matches_neither', JSON.stringify(ambiguous));

    // -------------------------------------------------------------------------------
    section('Team records - the residual');
    // -------------------------------------------------------------------------------
    // An 8% longshot winning is worth +0.92; an 85% favourite winning is worth +0.15.
    // The stat measures surprise against the frozen price, never win rate.
    check('a longshot win pays nearly the whole point', near(contributionFor(true, 0.08), 0.92, 0.001));
    check('a heavy favourite winning barely registers', near(contributionFor(true, 0.85), 0.15, 0.001));

    const rec = buildTeamRecord('detroit-tigers', [
        side({ eventId: 'a', entryProb: 0.3, won: true }),
        side({ eventId: 'b', entryProb: 0.6, won: false }),
        side({ eventId: 'c', entryProb: 0.5, won: true }),
    ]);
    check('residual sums contributionFor over every game',
        near(rec.residual, 0.7 - 0.6 + 0.5, EPS), `residual=${rec.residual}`);
    check('expectedWins sums the frozen prices', near(rec.expectedWins, 1.4, EPS), `${rec.expectedWins}`);
    check('record counts wins and losses', rec.wins === 2 && rec.losses === 1 && rec.didNotWin === 0);
    check('biggest picks the largest |contrib|', rec.biggest?.eventId === 'a', rec.biggest?.eventId);

    // A three-way non-win may be a draw. Calling it a loss is the same class of false
    // claim the neutrality grep exists to stop.
    const soccer = buildTeamRecord('liverpool', [
        side({ eventId: 'd', teamId: 'liverpool', league: 'EPL', threeWay: true, won: false, entryProb: 0.64 }),
    ]);
    check('a three-way non-win is "did not win", never a loss',
        soccer.losses === 0 && soccer.didNotWin === 1, JSON.stringify({ l: soccer.losses, d: soccer.didNotWin }));

    check('a club below the threshold does not rank',
        rankByResidual([rec], DEFAULT_MIN_GAMES).length === 0);
    check('a club at the threshold ranks',
        rankByResidual([buildTeamRecord('x', Array.from({ length: DEFAULT_MIN_GAMES }, (_, i) => side({ eventId: `g${i}` })))], DEFAULT_MIN_GAMES).length === 1);

    let threw = false;
    try {
        assertDeduped([side({ eventId: 'z' }), side({ eventId: 'z' })]);
    } catch {
        threw = true;
    }
    check('the same club twice in one game throws rather than double-counting', threw);

    // -------------------------------------------------------------------------------
    section('Team records - live data invariants');
    // -------------------------------------------------------------------------------
    const migrated = (await sqlViaPool`
        SELECT COUNT(*)::int AS n FROM information_schema.columns
        WHERE table_name = 'index_positions' AND column_name = 'subject_team_id'
    `)[0].n === 1;

    if (!migrated) {
        warn('add_team_identity_to_index_positions.sql has not been applied - live attribution checks skipped');
        return;
    }

    const [{ bugs }] = await sqlViaPool`
        SELECT COUNT(*)::int AS bugs FROM index_positions
        WHERE subject_src = ANY(${BUG_SOURCES as unknown as string[]})
    `;
    check('no settled side fails to resolve to a club or a NAMED refusal', bugs === 0, `bug rows=${bugs}`);

    const [{ stamped, total }] = await sqlViaPool`
        SELECT COUNT(*) FILTER (WHERE subject_src IS NOT NULL)::int AS stamped,
               COUNT(*)::int AS total
        FROM index_positions
    `;
    check('every row carries a reason for its attribution', stamped === total, `${stamped}/${total} - run scripts/backfill-team-identity.ts`);

    // The dedupe key MUST include market_type: a game's moneyline and its totals market
    // both number their sides from 0, so keying on (event_id, side_index) alone collapses
    // one into the other and drops ~15% of attributable sides - silently.
    const [{ with_type, without_type }] = await sqlViaPool`
        SELECT COUNT(DISTINCT (event_id, market_type, side_index))::int AS with_type,
               COUNT(DISTINCT (event_id, side_index))::int AS without_type
        FROM index_positions
        WHERE result IN ('win', 'loss')
    `;
    check('market_type is load-bearing in the dedupe key', with_type > without_type,
        `with=${with_type} without=${without_type} - if equal, the suite can no longer detect this regression`);

    // EV-neutrality on a two-way market. If this drifts, contributionFor is being fed the
    // wrong side's probability and every residual on the board is wrong.
    const pairRows = await sqlViaPool`
        SELECT event_id, SUM(CASE WHEN result = 'win' THEN 1 - entry_prob ELSE -entry_prob END)::float8 AS s
        FROM (
            SELECT DISTINCT ON (event_id, market_type, side_index)
                   event_id, result, entry_prob, subject_src
            FROM index_positions
            WHERE market_type = 'moneyline' AND result IN ('win', 'loss') AND subject_team_id IS NOT NULL
            ORDER BY event_id, market_type, side_index, locked_at, id
        ) d
        WHERE subject_src IN ('side_label', 'side_label_nickname')
        GROUP BY event_id HAVING COUNT(*) = 2
    `;
    const worst = pairRows.reduce((m: number, r: any) => Math.max(m, Math.abs(r.s)), 0);
    check('both sides of a two-way game cancel to zero', pairRows.length > 0 && worst < 0.02,
        `pairs=${pairRows.length} worst=${worst.toFixed(6)}`);

    // A soccer 'No' must never be counted for the opponent.
    const [{ leaked }] = await sqlViaPool`
        SELECT COUNT(*)::int AS leaked FROM index_positions
        WHERE subject_src = 'three_way_no' AND subject_team_id IS NOT NULL
    `;
    check('a three-way No never carries a club', leaked === 0, `leaked=${leaked}`);

    const [{ totals_leaked }] = await sqlViaPool`
        SELECT COUNT(*)::int AS totals_leaked FROM index_positions
        WHERE market_type = 'totals' AND subject_team_id IS NOT NULL
    `;
    check('a totals row never carries a club', totals_leaked === 0, `leaked=${totals_leaked}`);

    // Build every record through the REAL aggregator over the REAL dedupe.
    const sideRows = await sqlViaPool`
        SELECT DISTINCT ON (event_id, market_type, side_index)
               event_id, league, subject_team_id, subject_src,
               entry_prob::float8 AS entry_prob, (result = 'win') AS won,
               settled_at, kickoff, away, home, away_team_id, home_team_id
        FROM index_positions
        WHERE market_type = 'moneyline' AND result IN ('win', 'loss') AND subject_team_id IS NOT NULL
        ORDER BY event_id, market_type, side_index, locked_at, id
    `;
    const sides: TeamSideRow[] = (sideRows as any[]).map((r) => ({
        eventId: r.event_id,
        league: r.league,
        teamId: r.subject_team_id,
        opponentTeamId: r.subject_team_id === r.away_team_id ? r.home_team_id : r.away_team_id,
        entryProb: r.entry_prob,
        won: r.won,
        settledAt: r.settled_at ? new Date(r.settled_at).toISOString() : null,
        kickoff: r.kickoff ? new Date(r.kickoff).toISOString() : null,
        away: r.away,
        home: r.home,
        threeWay: r.subject_src === 'question',
    }));

    let built = true;
    try {
        const records = buildTeamRecords(sides);
        check('every live side aggregates without a dedupe collision', records.size > 0, `clubs=${records.size}`);
        const leaking = [...records.values()].filter((r) => r.games_.some((g) => g.threeWay) && r.losses > 0);
        check('no three-way club reports a loss count', leaking.length === 0,
            leaking.slice(0, 3).map((r) => r.teamId).join(', '));
    } catch (err: any) {
        built = false;
        check('every live side aggregates without a dedupe collision', false, err.message);
    }
    if (built && sides.length === 0) warn('no attributed sides in the live table yet - aggregation assertions are vacuous');
}

export const suite: Suite = {
    name: 'team-records',
    requiredEnv: [],
    run,
};
