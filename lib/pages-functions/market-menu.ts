// The one place a "pick a market" Discord select row is built, shared by /pvp's search
// (lib/pages-functions/pvp.ts) and the admin Community Pick search
// (lib/pages-functions/discord-commands.ts). Both used to walk a game's props flat and
// emit EVERY two-sided market, which meant one MLB fixture - 1 moneyline, 4 spread rungs,
// 3 totals - ate 8 of the 25 rows, all rendering as the same truncated
// "Toronto Blue Jays @ Cleveland Guardians · …" because the matchup led the label and
// Discord cuts the tail.
//
// Two rules fix that, and they live here so the two menus can't drift:
//   1. pickGameLines - a game contributes at most ONE moneyline, ONE spread and ONE total.
//   2. buildMarketOption - the BET leads the label, the matchup is a short team code, and
//      the full matchup moves to the description, which has its own 100 characters.
//
// describeMarket and formatKickoff live here (rather than in discord-commands.ts, where
// they started) so that this module has no import back into the command layer - both
// command files import this one, never the reverse.

import type { Game, Prop } from '../../tank-types';

// Discord's per-option limits.
const MAX_LABEL = 100;
const MAX_DESCRIPTION = 100;
const MAX_VALUE = 100;

// "moneyline" -> "Moneyline", "spreads" -1.5 -> "Spread -1.5",
// "baseball_player_home_runs" 0.5 -> "home runs o/u 0.5", etc.
export function describeMarket(market: string | null | undefined, line: number | string | null | undefined): string {
    const lineNum = line === null || line === undefined || line === '' ? null : Number(line);
    const withLine = (base: string, prefix = 'o/u ') => (lineNum !== null && Number.isFinite(lineNum) ? `${base} ${prefix}${lineNum}` : base);
    switch (market) {
        case 'moneyline': return 'Moneyline';
        // Number.isFinite guard here as well as in withLine: a non-numeric line would
        // otherwise render the literal "Spread NaN".
        case 'spreads': return lineNum !== null && Number.isFinite(lineNum) ? `Spread ${lineNum > 0 ? '+' : ''}${lineNum}` : 'Spread';
        case 'totals': return withLine('Total');
        case 'team_totals': return withLine('Team total');
        case 'season_futures': return 'Season future';
        default: {
            if (!market) return 'Prop';
            // Player-prop keys: "<sport>_player_<stat>" -> the stat, humanized.
            const stat = market.includes('_player_') ? market.split('_player_')[1] : market;
            return withLine(stat.replace(/_/g, ' '));
        }
    }
}

// "Fri Aug 21 · 9:00 PM ET" - US/Eastern because that's how sports schedules read.
export function formatKickoff(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
    }).format(d) + ' ET';
}

/** "TOR @ CLE" - the label-safe form of a matchup. Falls back to the full names when a
 *  Game predates team codes (Kalshi-sourced games, or an event with no teams). */
export function shortMatchup(game: Game): string {
    if (game.awayCode && game.homeCode) return `${game.awayCode} @ ${game.homeCode}`;
    return `${game.away} @ ${game.home}`;
}

// A game line is one of these four; everything else on a game is a player prop or the
// season-futures catch-all. Mirrors tank-providers.ts's GAME_LINE_MARKET_TYPES, kept as a
// local literal so this module stays importable from the Workers bundle without pulling in
// the provider graph.
const MONEYLINE = 'moneyline';
const SPREAD = 'spreads';
const TOTAL = 'totals';
const TEAM_TOTAL = 'team_totals';

function twoSided(prop: Prop): boolean {
    return Boolean(prop.odds && prop.odds.outcomes.length === 2 && prop.odds.outcomePrices.length === 2);
}

// Highest prominence wins - it's the percentile of (volume + liquidity) among that game's
// own props, so within one game it ranks exactly the way index-slate.ts's
// pickCanonicalMarket ranks candidate markets. On the Blue Jays/Guardians slate this picks
// Spread -2.5 (vol 5387) over the other three rungs, and Total o/u 8.5 (vol 3513) over
// o7.5 and o9.5.
function mostProminent(props: Prop[]): Prop | null {
    if (props.length === 0) return null;
    return props.reduce((best, p) => (p.prominence > best.prominence ? p : best), props[0]);
}

/**
 * The (at most) three rows a matchup is allowed to contribute: its moneyline, its main
 * spread, its main total - in that order, so the most legible bet leads.
 *
 * Player props and season_futures are excluded by design. The futures exclusion also
 * removes a class of junk: Polymarket questions like "Will there be a run scored in the
 * first inning?" fall through tank-providers.ts's classifier into season_futures with the
 * subject "there", which rendered as the row "there Season future".
 *
 * `isUsed` lets a caller drop markets already picked in this battle.
 */
export function pickGameLines(game: Game, isUsed: (marketId: string) => boolean = () => false): Prop[] {
    const eligible = game.props.filter((p) => twoSided(p) && !isUsed(p.id));
    const of = (type: string) => eligible.filter((p) => p.market === type);

    const picks: Prop[] = [];
    const moneyline = mostProminent(of(MONEYLINE));
    if (moneyline) picks.push(moneyline);
    const spread = mostProminent(of(SPREAD));
    if (spread) picks.push(spread);
    // Plain totals first; a team total only stands in when the game has no game total.
    const total = mostProminent(of(TOTAL)) ?? mostProminent(of(TEAM_TOTAL));
    if (total) picks.push(total);

    if (picks.length > 0) return picks;

    // Fallback so a thin league isn't simply absent: a game whose only two-sided markets
    // are corners, bookings or similar still offers its most-traded one. Never a
    // season_futures row - that's the junk this function exists to keep out.
    const fallback = mostProminent(eligible.filter((p) => p.market !== 'season_futures'));
    return fallback ? [fallback] : [];
}

export interface MarketOption {
    label: string;
    value: string;
    description: string;
}

export interface MarketOptionOptions {
    /** Appended to the value after a '|' so a menu mixing leagues can still record which
     *  competition a pick came from (see pvp.ts's mkt handler). Omitted = bare market id. */
    valueSuffix?: string;
    /** Lead the description with the league - for the any-sport menu, where rows come from
     *  different competitions. */
    league?: string;
}

/**
 * One select row. The BET leads the label so it is never what Discord truncates; the
 * matchup is a ~9-character team code. The description carries the identity that no
 * longer fits above it - league (when mixed), full matchup, kickoff, implied odds - in
 * that order, so the 100-char clamp eats the odds rather than the matchup.
 */
export function buildMarketOption(game: Game, prop: Prop, opts: MarketOptionOptions = {}): MarketOption | null {
    if (!twoSided(prop)) return null;
    const marketLabel = describeMarket(prop.market, prop.line);
    // Game lines carry the matchup itself as `player` ("Away vs. Home"); only a real
    // player prop should have its subject prefixed onto the bet.
    const isPlayerProp = prop.player && !prop.player.includes(' vs') && prop.player !== game.away && prop.player !== game.home;
    const bet = isPlayerProp ? `${prop.player} ${marketLabel}` : marketLabel;
    const [pA, pB] = prop.odds!.outcomePrices;
    const oddsPart = Number.isFinite(pA) && Number.isFinite(pB) ? `${Math.round(pA * 100)}% / ${Math.round(pB * 100)}%` : '';

    return {
        label: `${bet} · ${shortMatchup(game)}`.slice(0, MAX_LABEL),
        value: (opts.valueSuffix ? `${prop.id}|${opts.valueSuffix}` : prop.id).slice(0, MAX_VALUE),
        description: [opts.league ?? '', `${game.away} @ ${game.home}`, formatKickoff(game.kickoff), oddsPart]
            .filter(Boolean)
            .join(' · ')
            .slice(0, MAX_DESCRIPTION),
    };
}
