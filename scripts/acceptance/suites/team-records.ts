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

import { BASE_URL, check, near, section, warn, EPS, type Suite } from '../harness';
import { sqlViaPool } from '../fixtures';
import { canonicalTeam, resolvePositionTeams, teamSlug, type SubjectSource, type TeamId } from '../../../lib/pages-functions/team-identity';
import {
    buildLeagueBoardModel, buildTeamPageModel, getTeamFixtures, getTeamSides, knownLeagues,
    leagueFromSlug, leagueSlug, rosterOrder, type TeamFixture,
} from '../../../lib/pages-functions/team-pages';
import {
    BANNED_WORDS, HUB_BLURB, gameSentence, leagueBlurb, teamBlurb, teamHeadline, teamReadLine, tileQuote, tileTitle,
} from '../../../lib/pages-functions/team-copy';
import { renderTeamChartSvg } from '../../../lib/pages-functions/team-chart';
import { signOf } from '../../../lib/pages-functions/ticker-format';
import {
    DEFAULT_TEAM_PRICE_BASELINE, DEFAULT_TEAM_PRICE_SCALE, buildTeamPricing, getTeamCloseEvents, getTeamTagEvents,
    type TeamEvent,
} from '../../../lib/pages-functions/team-price';
import { priceFromValue, PRICE_NOTE } from '../../../lib/pages-functions/ticker-price';
import { closeDelta } from '../../../lib/pages-functions/index-slate';
import {
    DEFAULT_MIN_GAMES,
    assertDeduped,
    buildTeamRecord,
    buildTeamRecords,
    rankByResidual,
    type TeamSideRow,
} from '../../../lib/pages-functions/team-records';
import { contributionFor } from '../../../lib/pages-functions/index-slate';

// PRICE_NOTE carries an apostrophe ("each index's"), which escapeHtml renders as an
// entity - so a raw slice of the constant never matches the page. This tail has nothing
// escapeHtml touches, and still fails if the note is dropped entirely.
const PRICE_NOTE_FRAGMENT = 'Ember is play currency';

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
    section('Team pages - models, copy and chart');
    // -------------------------------------------------------------------------------
    const leagues = knownLeagues();
    check('every known league has a slug that round-trips',
        leagues.every((l) => leagueFromSlug(leagueSlug(l)) === l),
        leagues.filter((l) => leagueFromSlug(leagueSlug(l)) !== l).join(','));
    check('league slugs are URL-safe', leagues.every((l) => /^[a-z0-9-]+$/.test(leagueSlug(l))));

    // Two clubs: one past the gate in MLB, one under it in MLS (three-way sides) with a
    // cup appearance on the side. Fixture counts differ from directional counts on
    // purpose - that is the distinction the board and the page both have to keep.
    const rec5 = buildTeamRecord('athletics', Array.from({ length: 5 }, (_, i) =>
        side({ eventId: `a${i}`, teamId: 'athletics', league: 'MLB', entryProb: 0.36, won: i < 4, kickoff: `2026-09-0${i + 1}T00:00:00.000Z` })));
    const rec2 = buildTeamRecord('nashville-sc', Array.from({ length: 2 }, (_, i) =>
        side({ eventId: `n${i}`, teamId: 'nashville-sc', league: 'MLS', entryProb: 0.5, won: true, threeWay: true })));
    const fx = (teamId: string, league: string, n: number, extraLeague?: string): TeamFixture[] => [
        ...Array.from({ length: n }, (_, i) => ({
            eventId: `${teamId}-${i}`, league, kickoff: `2026-09-0${i + 1}T00:00:00.000Z`, settledAt: null,
            away: 'Away Club', home: 'Home Club', awayTeamId: teamId, homeTeamId: 'home-club', side: null,
        })),
        ...(extraLeague ? [{
            eventId: `${teamId}-cup`, league: extraLeague, kickoff: '2026-09-09T00:00:00.000Z', settledAt: null,
            away: 'Away Club', home: 'Home Club', awayTeamId: teamId, homeTeamId: 'home-club', side: null,
        }] : []),
    ];
    const fixtures = new Map<string, TeamFixture[]>([
        ['athletics', fx('athletics', 'MLB', 7)],
        ['nashville-sc', fx('nashville-sc', 'MLS', 3, 'Carabao Cup')],
    ]);
    const records = new Map([['athletics', rec5], ['nashville-sc', rec2]]);
    const display = new Map<string, TeamId>([
        ['athletics', { id: 'athletics', display: 'Athletics' }],
        ['nashville-sc', { id: 'nashville-sc', display: 'Nashville SC' }],
    ]);
    const mlbBoard = buildLeagueBoardModel('MLB', records, fixtures, DEFAULT_MIN_GAMES, display);
    const mlsBoard = buildLeagueBoardModel('MLS', records, fixtures, DEFAULT_MIN_GAMES, display);
    check('a league board lists only clubs with a fixture in that league',
        mlbBoard.tiles.map((t) => t.slug).join() === 'athletics' && mlsBoard.tiles.map((t) => t.slug).join() === 'nashville-sc');
    check('tile area is fixtures in THIS league, not club-wide', mlsBoard.tiles[0].fixtures === 3, String(mlsBoard.tiles[0].fixtures));
    check('a club past the gate carries its residual and its sign',
        mlbBoard.tiles[0].residual === rec5.residual && mlbBoard.tiles[0].sign === signOf(rec5.residual));
    check('a club below the gate is grey with no residual', mlsBoard.tiles[0].residual === null && mlsBoard.tiles[0].sign === 'zero');
    check('maxAbsResidual ignores grey tiles', mlsBoard.maxAbsResidual === 0 && near(mlbBoard.maxAbsResidual, Math.abs(rec5.residual), EPS));
    check('rosterOrder ranks qualifying clubs first', rosterOrder([mlsBoard.tiles[0], mlbBoard.tiles[0]])[0].slug === 'athletics');

    const pm5 = buildTeamPageModel(display.get('athletics')!, rec5, fixtures.get('athletics')!, DEFAULT_MIN_GAMES);
    const pm2 = buildTeamPageModel(display.get('nashville-sc')!, rec2, fixtures.get('nashville-sc')!, DEFAULT_MIN_GAMES);
    check('the series is cumulative and ends on the residual', pm5.series.length === 5 && near(pm5.series[4].cumulative, rec5.residual, EPS));
    check('leagues list every competition the club appeared in, most fixtures first', pm2.leagues.join() === 'MLS,Carabao Cup', pm2.leagues.join());
    check('a qualifying club gets a headline; a sub-gate club does not', teamHeadline(pm5) !== null && teamHeadline(pm2) === null);
    check('the chart renders for a club with games and not without',
        renderTeamChartSvg(pm5.series, 'Athletics').startsWith('<svg') && renderTeamChartSvg([], 'x') === '');

    // Every sentence the copy layer can produce, at every branch, against the grep.
    const won = { entryProb: 0.35, won: true, threeWay: false, contrib: 0.65 };
    const dnw = { entryProb: 0.64, won: false, threeWay: true, contrib: -0.64 };
    const lost = { entryProb: 0.6, won: false, threeWay: false, contrib: -0.6 };
    const f0 = pm5.fixtures[0];
    const sentences = [
        teamReadLine(pm5), teamReadLine(pm2), teamBlurb(pm5), teamBlurb(pm2), leagueBlurb('MLB', 5), HUB_BLURB,
        teamHeadline(pm5)?.label ?? '',
        ...pm5.fixtures.map((f) => gameSentence(f, 'athletics')),
        gameSentence({ ...f0, side: won }, 'athletics'),
        gameSentence({ ...f0, side: dnw }, 'athletics'),
        gameSentence({ ...f0, side: lost }, 'athletics'),
        ...mlsBoard.tiles.map(tileTitle), ...mlbBoard.tiles.map(tileTitle), ...mlbBoard.tiles.map(tileQuote), ...mlsBoard.tiles.map(tileQuote),
    ];
    const banned = sentences.filter((s) => BANNED_WORDS.test(s));
    check('no team sentence uses forecasting or rating language', banned.length === 0, banned.slice(0, 3).join(' | '));
    const threeWayLine = teamReadLine(buildTeamPageModel(display.get('nashville-sc')!,
        buildTeamRecord('nashville-sc', Array.from({ length: 5 }, (_, i) =>
            side({ eventId: `q${i}`, teamId: 'nashville-sc', league: 'MLS', entryProb: 0.5, won: i < 2, threeWay: true }))), [], 5));
    check('a three-way club reads "won N of M" and never a loss count', /won 2 of 5/.test(threeWayLine) && !/\blost\b/.test(threeWayLine), threeWayLine);
    check('a three-way non-win row says "did not win"', /^Did not win/.test(gameSentence({ ...f0, side: dnw }, 'athletics')));

    // -------------------------------------------------------------------------------
    section('Team price - the index transform over a club\'s own events');
    // -------------------------------------------------------------------------------
    const params = { baseline: DEFAULT_TEAM_PRICE_BASELINE, scale: DEFAULT_TEAM_PRICE_SCALE };
    const now = Date.parse('2026-09-13T12:00:00.000Z');
    const ev = (over: Partial<TeamEvent>): TeamEvent => ({
        teamId: 'athletics', eventType: 'close', occurredAt: '2026-09-04T02:00:00.000Z', delta: 1.31,
        closeDate: '2026-09-04', tankSlug: null, ...over,
    });
    // Out of order on purpose: the series must sort by time, and a tag between two closes
    // must land between them.
    const priced = buildTeamPricing('athletics', [
        ev({ occurredAt: '2026-09-10T02:00:00.000Z', delta: 1.29, closeDate: '2026-09-10' }),
        ev({ occurredAt: '2026-09-01T02:00:00.000Z', delta: -0.67, closeDate: '2026-09-01' }),
        ev({ eventType: 'tag', occurredAt: '2026-09-06T15:00:00.000Z', delta: 0.12, closeDate: null, tankSlug: 'some-tank' }),
        ev({ teamId: 'someone-else', delta: 9 }),
    ], params, now);
    check('a club\'s events are filtered to it and sorted by time',
        priced.eventCount === 3 && priced.series.map((e) => e.eventType).join() === 'close,tag,close');
    check('value is the running sum of deltas', near(priced.value, -0.67 + 0.12 + 1.29, EPS), String(priced.value));
    check('price is priceFromValue(value) - the index transform, nothing else',
        priced.price === priceFromValue(priced.value, params) && near(priced.price, 100 * Math.exp(priced.value / 20), 0.001), String(priced.price));
    check('close and tag counts are kept apart', priced.closeCount === 2 && priced.tagCount === 1);
    check('window sums cover the right events (7d holds the tag and the last close; 24h nothing)',
        near(priced.sums.d7, 0.12 + 1.29, EPS) && priced.sums.h24 === 0 && near(priced.sums.d30, priced.value, EPS),
        JSON.stringify(priced.sums));
    // A club below the gate gets no price on its page, and none on the board.
    const pmPriced = buildTeamPageModel(display.get('athletics')!, rec5, fixtures.get('athletics')!, DEFAULT_MIN_GAMES, priced);
    const pmGated = buildTeamPageModel(display.get('nashville-sc')!, rec2, fixtures.get('nashville-sc')!, DEFAULT_MIN_GAMES,
        buildTeamPricing('nashville-sc', [ev({ teamId: 'nashville-sc' })], params, now));
    check('a qualifying club carries its pricing; a sub-gate club does not', pmPriced.pricing !== null && pmGated.pricing === null);
    const pricedBoard = buildLeagueBoardModel('MLB', records, fixtures, DEFAULT_MIN_GAMES, display, new Map([['athletics', priced]]), params);
    check('a board tile past the gate carries price, value and window sums; a grey tile carries none',
        pricedBoard.tiles[0].price === priced.price && pricedBoard.tiles[0].sums !== null
        && buildLeagueBoardModel('MLS', records, fixtures, DEFAULT_MIN_GAMES, display, new Map(), params).tiles[0].price === null);
    check('the board carries the price params the island needs', pricedBoard.priceScale === 20 && pricedBoard.priceBaseline === 100);

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

    // Build every record through the REAL aggregator over the REAL reader - the same one
    // the static build uses (team-pages.ts), so a page can never aggregate differently
    // from what this suite proves.
    const sides: TeamSideRow[] = await getTeamSides(sqlViaPool);
    const fixturesByTeam = await getTeamFixtures(sqlViaPool);
    const clubIds = [...new Set(sides.map((s) => s.teamId))];
    check('the fixtures reader covers at least every directional game per club',
        clubIds.every((id) => (fixturesByTeam.get(id)?.length ?? 0) >= sides.filter((s) => s.teamId === id).length),
        clubIds.filter((id) => (fixturesByTeam.get(id)?.length ?? 0) < sides.filter((s) => s.teamId === id).length).slice(0, 3).join(','));
    check('every fixture side carries the contribution the aggregator would compute',
        [...fixturesByTeam.values()].flat().every((f) => !f.side || near(f.side.contrib, contributionFor(f.side.won, f.side.entryProb), EPS)));
    check('a fixture with no directional side claims no outcome',
        [...fixturesByTeam.values()].flat().every((f) => f.side !== null || gameSentence(f, 'x').startsWith('Appeared')));

    // The derived closes: every one must be reproducible from a REAL index close of the same
    // date - that is the whole point of reading the day's smoothing/scale from the linked
    // close rather than from live config.
    const closes = await getTeamCloseEvents(sqlViaPool);
    check('derived team closes exist', closes.length > 0, `closes=${closes.length}`);
    const closeDates = new Set(closes.map((c) => c.closeDate));
    const indexCloseDates = new Set((await sqlViaPool`SELECT DISTINCT close_date::text AS d FROM ticker_events WHERE source = 'slate'`).map((r: any) => r.d));
    check('every derived close lands on a date an index actually closed', [...closeDates].every((d) => indexCloseDates.has(d as string)));
    // Spot-recompute one club against the raw rows with the day's own config.
    const sample = closes.find((c) => (c.positionsCounted ?? 0) >= 2) ?? closes[0];
    if (sample) {
        const raw = await sqlViaPool`
            SELECT DISTINCT ON (ip.event_id, ip.market_type, ip.side_index)
                   ip.entry_prob::float8 AS p, (ip.result = 'win') AS won,
                   (te.metadata->>'smoothing')::float8 AS k, (te.metadata->>'scalePct')::float8 AS s
            FROM index_positions ip JOIN ticker_events te ON te.id = ip.close_id
            WHERE ip.subject_team_id = ${sample.teamId} AND te.close_date = ${sample.closeDate}::date
              AND ip.market_type = 'moneyline' AND ip.result IN ('win','loss')
            ORDER BY ip.event_id, ip.market_type, ip.side_index, ip.locked_at, ip.id`;
        const recomputed = closeDelta((raw as any[]).map((r) => contributionFor(r.won, r.p)), { smoothing: raw[0].k as number, scalePct: raw[0].s as number });
        check(`a derived close recomputes from its raw rows (${sample.teamId} ${sample.closeDate})`, recomputed !== null && near(recomputed, sample.delta, EPS), `${recomputed} vs ${sample.delta}`);
    }
    const tags = await getTeamTagEvents(sqlViaPool);
    check('Tank tags resolve to clubs', tags.events.length > 0 && tags.considered > 0, `${tags.events.length}/${tags.considered}`);
    // Every soccer 'No' side is an honest refusal, so some are always unresolved; what must
    // not happen is the majority going unresolved - that would mean a broken resolver path.
    check('most moneyline tag sides resolve to a club', tags.unresolved <= tags.considered / 2, `${tags.unresolved} unresolved of ${tags.considered}`);
    check('every tag event carries a Tank slug and a finite delta', tags.events.every((e) => !!e.tankSlug && Number.isFinite(e.delta)));

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

    // -------------------------------------------------------------------------------
    section('Team pages - built pages served from dist');
    // -------------------------------------------------------------------------------
    // These read what the LAST build wrote (npm run build:static). Static files, so a
    // 404 means "not built yet" rather than a code failure - a warning, not a fail.
    // harness.api() only surfaces JSON, so pages are fetched directly.
    const page = async (p: string): Promise<{ status: number; html: string }> => {
        const res = await fetch(`${BASE_URL}${p}`);
        return { status: res.status, html: res.status === 200 ? await res.text() : '' };
    };
    const hub = await page('/teams/');
    if (hub.status !== 200) {
        warn(`/teams/ is not built (status ${hub.status}) - run npm run build:static, then re-run for the page checks`);
    } else {
        check('/teams/ carries a BreadcrumbList and the retrospective note',
            hub.html.includes('"BreadcrumbList"') && hub.html.includes('not a forecast'));
        const leagueHrefs = [...new Set([...hub.html.matchAll(/href="\/leagues\/([a-z0-9-]+)\/"/g)].map((m) => m[1]))];
        check('/teams/ links at least one league board', leagueHrefs.length > 0, leagueHrefs.join(','));

        // Walk the first few boards until both a qualifying club and a sub-gate club
        // are in hand - MLB (first, by games) qualifies every club, the weekly leagues none.
        let qualifying: { slug: string } | null = null;
        let subGate: { slug: string } | null = null;
        let boardsChecked = 0;
        for (const slug of leagueHrefs.slice(0, 4)) {
            const lp = await page(`/leagues/${slug}/`);
            boardsChecked++;
            const ok = lp.status === 200 && lp.html.includes('id="league-page-data"') && lp.html.includes('class="hc-lgb-fallback"');
            check(`/leagues/${slug}/ serves with its baked board model and a crawlable roster`, ok, String(lp.status));
            if (!ok) continue;
            let baked: any = null;
            try {
                baked = JSON.parse((lp.html.match(/id="league-page-data">([\s\S]*?)<\/script>/) ?? [])[1] ?? 'null');
            } catch {
                baked = null;
            }
            check(`/leagues/${slug}/ baked model parses with tiles`, !!baked && Array.isArray(baked.tiles) && baked.tiles.length > 0);
            if (!baked) continue;
            check(`/leagues/${slug}/ links every tile to a team page`,
                baked.tiles.every((t: any) => lp.html.includes(`href="/teams/${t.slug}/"`)));
            check(`/leagues/${slug}/ colours only tiles past the gate`,
                baked.tiles.every((t: any) => (t.residual === null) === (t.sign === 'zero') && (t.residual === null || t.games >= baked.minGames)));
            check(`/leagues/${slug}/ prices exactly the tiles past the gate`,
                baked.tiles.every((t: any) => (t.price === null) === (t.residual === null) && (t.price === null || (t.sums && typeof t.sums.d7 === 'number'))));
            check(`/leagues/${slug}/ carries the price note and params`, lp.html.includes(PRICE_NOTE_FRAGMENT) && baked.priceScale > 0);
            qualifying ??= baked.tiles.find((t: any) => t.residual !== null) ?? null;
            subGate ??= baked.tiles.find((t: any) => t.residual === null) ?? null;
            if (qualifying && subGate) break;
        }
        check('at least one league board was served', boardsChecked > 0);

        if (qualifying) {
            const tp = await page(`/teams/${qualifying.slug}/`);
            check('a qualifying club page posts a headline figure and a chart',
                tp.status === 200 && tp.html.includes('class="hc-tq-price') && tp.html.includes('<svg class="hc-tq-svg"'),
                `${qualifying.slug}: ${tp.status}`);
            const readLine = tp.html.match(/class="hc-tq-read">([^<]*)</)?.[1] ?? '';
            check('a qualifying club page reads without forecasting language', readLine.length > 0 && !BANNED_WORDS.test(readLine), readLine);
            check('a qualifying club page carries a BreadcrumbList through its league', tp.html.includes('"BreadcrumbList"') && /\/leagues\/[a-z0-9-]+\//.test(tp.html));
            // The price surface: baked model present, price is exactly the transform of its own
            // value, and the price note ships alongside like every index surface.
            let bakedTeam: any = null;
            try {
                bakedTeam = JSON.parse((tp.html.match(/id="team-page-data">([\s\S]*?)<\/script>/) ?? [])[1] ?? 'null');
            } catch {
                bakedTeam = null;
            }
            check('a qualifying club page bakes its pricing and an island root',
                !!bakedTeam?.pricing && tp.html.includes('id="team-price-root"'));
            if (bakedTeam?.pricing) {
                const p = bakedTeam.pricing;
                check('the baked price is priceFromValue of the baked value',
                    p.price === priceFromValue(p.value, { baseline: p.priceBaseline, scale: p.priceScale }), `${p.price} vs value ${p.value}`);
                check('the baked series is cumulative and ends on the value',
                    Array.isArray(p.series) && p.series.length > 0 && near(p.series[p.series.length - 1].cumulative, p.value, EPS));
                check('the page shows the price as its headline', tp.html.includes('class="hc-tq-price"') && tp.html.includes(`${p.price.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`));
            }
            check('a qualifying club page carries the price note', tp.html.includes(PRICE_NOTE_FRAGMENT));
        } else {
            warn('no qualifying club found on the first boards - headline page check skipped');
        }
        if (subGate) {
            const tp = await page(`/teams/${subGate.slug}/`);
            check('a sub-gate club page lists its games but posts NO headline figure',
                tp.status === 200 && !tp.html.includes('class="hc-tq-price') && tp.html.includes('hc-tq-results-list'),
                `${subGate.slug}: ${tp.status}`);
            const readLine = tp.html.match(/class="hc-tq-read">([^<]*)</)?.[1] ?? '';
            check('a sub-gate club page says why there is no residual', /not enough to post a market residual/.test(readLine), readLine);
        } else {
            warn('no sub-gate club found on the first boards - gate page check skipped');
        }
    }
}

export const suite: Suite = {
    name: 'team-records',
    requiredEnv: [],
    run,
};
