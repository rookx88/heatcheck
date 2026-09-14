// Reader-facing copy for the team pages and league boards. Pure and dependency-free, so
// the static build, the island and the acceptance suite print byte-identical sentences.
//
// The framing contract is the ticker layer's, inherited whole: retrospective only -
// what HAS happened, never a lean on what comes next - and no take on any club. A team
// page is the sharpest place that contract gets tested, because a per-club number reads
// as a rating even when it isn't one, so the vocabulary here is narrower than the index
// copy's. BANNED_WORDS below is the suite's grep and includes the words that turn a
// record into a forecast without saying "will": hot, cold, streak, due, trend, momentum,
// form, pace. Every sentence this module can produce is asserted against it.
//
// What the residual IS, in one line the copy repeats in different clothes: the sum, over
// a club's directional games, of (1 - p) on a win and -p on a non-win, with p the price
// the market froze before kickoff. So "+3.1" reads as "reality ran 3.1 wins ahead of
// the market's price" - a statement about the pricing, not about the club.

import type { TeamFixture, TeamPageModel, LeagueTile } from './team-pages';

export const BANNED_WORDS =
    /\b(will|expect|likely|should|predict|forecast|probab|hot|cold|streak|due|trend(ing)?|momentum|form|pace|on track|poised|underrated|overrated|regress)\b/i;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Sep 4". UTC on purpose so the build prints the same day everywhere. */
export function shortDate(isoOrNull: string | null | undefined): string {
    if (!isoOrNull) return '';
    const d = new Date(isoOrNull);
    if (Number.isNaN(d.getTime())) return '';
    return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** "+3.13" / "−1.94" with a real minus; -0 normalizes to "+0.00". */
export function signedResidual(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(2)}`;
}

/** "36%" */
export function pct(p: number): string {
    return `${Math.round(p * 100)}%`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
    return `${n} ${n === 1 ? one : many}`;
}

/** "Athletics'" / "Chelsea's" - a plural-form club name takes the bare apostrophe. */
export function possessive(name: string): string {
    return /s$/i.test(name) ? `${name}'` : `${name}'s`;
}

// -----------------------------------------------------------------------------------
// Team page
// -----------------------------------------------------------------------------------

/** The headline figure, or null when the page withholds it. */
export function teamHeadline(m: TeamPageModel): { value: string; label: string } | null {
    if (!m.qualifies || !m.record) return null;
    const since = shortDate(m.record.firstKickoff);
    return {
        value: signedResidual(m.record.residual),
        label: `Market residual · ${plural(m.record.games, 'game')}${since ? ` since ${since}` : ''}`,
    };
}

/** One sentence under the headline saying what the number beside it means. */
export function teamReadLine(m: TeamPageModel): string {
    const name = m.team.display;
    const r = m.record;
    if (!r || r.games === 0) {
        const since = shortDate(m.fixtures[m.fixtures.length - 1]?.kickoff);
        return `${name} appeared in ${plural(m.fixtureCount, 'settled game')}${since ? ` since ${since}` : ''}; the slate held no directional position on them, so there is no market residual to show.`;
    }
    if (!m.qualifies) {
        const since = shortDate(r.firstKickoff);
        return `${plural(r.games, 'settled game')}${since ? ` since ${since}` : ''} — not enough to post a market residual yet (the page posts one at ${m.minGames}).`;
    }
    const winsClause = r.didNotWin > 0 ? `they won ${r.wins} of ${r.games}` : `they won ${r.wins} and lost ${r.losses}`;
    const abs = Math.abs(r.residual).toFixed(1);
    const relation = r.residual > 0 ? `ran ${abs} wins ahead of` : r.residual < 0 ? `ran ${abs} wins behind` : 'landed level with';
    return `Over ${plural(r.games, 'game')} the market priced ${name} at ${pct(r.avgEntryProb)} on average; ${winsClause}, and reality ${relation} that price.`;
}

/** "won" | "did not win" | "lost" | "appeared" - the chip on a game row. */
export type GameOutcome = 'won' | 'did not win' | 'lost' | 'appeared';

export function gameOutcome(f: TeamFixture): GameOutcome {
    if (!f.side) return 'appeared';
    if (f.side.won) return 'won';
    return f.side.threeWay ? 'did not win' : 'lost';
}

function venueOf(f: TeamFixture, teamId: string): string {
    if (f.awayTeamId === teamId && f.home) return `at ${f.home}`;
    if (f.homeTeamId === teamId && f.away) return `against ${f.away}`;
    if (f.away && f.home) return `in ${f.away} vs. ${f.home}`;
    return '';
}

/** One game, as a row on the team page and as a bullet in the crawlable fallback. */
export function gameSentence(f: TeamFixture, teamId: string): string {
    const venue = venueOf(f, teamId);
    const when = shortDate(f.kickoff);
    const tail = when ? ` (${when})` : '';
    if (!f.side) {
        const matchup = f.away && f.home ? `${f.away} vs. ${f.home}` : 'a settled game';
        return `Appeared in ${matchup}${tail} — no directional position was held on this club.`;
    }
    const priced = `priced ${pct(f.side.entryProb)}`;
    if (f.side.won) return `Won ${venue}${tail} — ${priced}, ${signedResidual(f.side.contrib)}.`;
    if (f.side.threeWay) return `Did not win ${venue}${tail} — ${priced}, ${signedResidual(f.side.contrib)}.`;
    return `Lost ${venue}${tail} — ${priced}, ${signedResidual(f.side.contrib)}.`;
}

/** The one-line description under the club name. */
export function teamBlurb(m: TeamPageModel): string {
    const comps = m.leagues.length > 1 ? `across ${m.leagues.join(', ')}` : m.leagues[0] ? `in ${m.leagues[0]}` : 'on the Exchange slate';
    return `How ${possessive(m.team.display)} settled results have run against the price the market put on them ${comps}. Every figure is a look back at games already played.`;
}

// -----------------------------------------------------------------------------------
// League board
// -----------------------------------------------------------------------------------

export function leagueBlurb(league: string, minGames: number): string {
    return `Every club that appeared in a settled ${league} game on the Exchange slate, sized by games played. A tile takes a colour once the club has ${minGames} directional games behind it: green where its results have run ahead of the market's price, red where they have run behind.`;
}

/** Tile tooltip / aria label. */
export function tileTitle(t: LeagueTile): string {
    const games = plural(t.fixtures, 'game');
    if (t.residual === null) return `${t.display}: ${games} — not enough directional games to post a market residual yet`;
    return `${t.display}: market residual ${signedResidual(t.residual)} over ${plural(t.games, 'directional game')}, ${games} in this competition`;
}

/** The short line under a tile's name. */
export function tileQuote(t: LeagueTile): string {
    return t.residual === null ? plural(t.fixtures, 'game') : `${signedResidual(t.residual)} · ${plural(t.fixtures, 'game')}`;
}

export const HUB_BLURB =
    'One page per league, each a board of its clubs sized by games played and coloured by how their settled results have run against the price the market froze before kickoff. Every number is retrospective.';

export const NO_FIXTURES_YET = 'no settled games yet';
