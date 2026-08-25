// Acceptance suite for the Kalshi live-fetch path (kalshi-live.ts's fetchLiveKalshiGames,
// backed by tank-providers.ts's buildGamesFromKalshiFlatProps). No DB writes, no HTTP
// endpoints under test - this hits Kalshi's real API directly and asserts the shape
// invariants everything downstream (tank-filter.ts, curate.ts, tank-deck-format.ts)
// depends on, so a Kalshi API drift (a new series shape, a stat renamed) is caught here
// before it reaches production curation rather than surfacing as a mangled Tank article.
//
// Cheapest possible regression check for this integration - run it first when
// diagnosing anything Kalshi-related, before the heavier settlement/ticker suites.

import { check, section, type Suite } from '../harness';
import { fetchLiveKalshiGames } from '../../../kalshi-live';
import { KALSHI_SERIES_MAP } from '../../../kalshi';

const MARKET_KEY_RE = /^(?:basketball|football|baseball|soccer)_player_[a-z_]+$/;

async function run() {
    section('Live fetch - shape invariants across every configured league/series');
    const games = await fetchLiveKalshiGames();
    console.log(`fetchLiveKalshiGames() returned ${games.length} game(s), ${games.reduce((n, g) => n + g.props.length, 0)} prop(s) total (window: no live games is a valid outcome outside season, not a failure).`);

    check('every game has a non-empty league/away/home/kickoff/settleDate', games.every((g) =>
        g.league && g.away && g.home && g.kickoff && g.settleDate));

    const allProps = games.flatMap((g) => g.props);
    check('every prop.market matches the <sport>_player_<stat> whitelist-key convention',
        allProps.every((p) => MARKET_KEY_RE.test(p.market)),
        JSON.stringify(allProps.filter((p) => !MARKET_KEY_RE.test(p.market)).map((p) => p.market)));

    check('every prop.market is a value KALSHI_SERIES_MAP actually produces (no orphan keys)',
        allProps.every((p) => Object.values(KALSHI_SERIES_MAP).some((info) => info.marketKey === p.market)));

    const ladderKeys = new Set(Object.values(KALSHI_SERIES_MAP).filter((i) => i.shape === 'ladder').map((i) => i.marketKey));
    const binaryKeys = new Set(Object.values(KALSHI_SERIES_MAP).filter((i) => i.shape === 'binary').map((i) => i.marketKey));

    const ladderProps = allProps.filter((p) => ladderKeys.has(p.market));
    check('ladder-shaped props: line is a number, odds.outcomes is exactly [Over, Under]',
        ladderProps.every((p) => typeof p.line === 'number' && p.odds && JSON.stringify(p.odds.outcomes) === JSON.stringify(['Over', 'Under'])),
        JSON.stringify(ladderProps.filter((p) => !(typeof p.line === 'number' && p.odds && JSON.stringify(p.odds.outcomes) === JSON.stringify(['Over', 'Under']))).slice(0, 3)));

    const binaryProps = allProps.filter((p) => binaryKeys.has(p.market));
    check('binary-shaped props: line is null, odds.outcomes is exactly [Yes, No]',
        binaryProps.every((p) => p.line === null && p.odds && JSON.stringify(p.odds.outcomes) === JSON.stringify(['Yes', 'No'])),
        JSON.stringify(binaryProps.filter((p) => !(p.line === null && p.odds && JSON.stringify(p.odds.outcomes) === JSON.stringify(['Yes', 'No']))).slice(0, 3)));

    check('every prop.odds.outcomePrices are two finite numbers summing to ~1 (Yes/No complementarity)',
        allProps.every((p) => {
            if (!p.odds) return false;
            const [a, b] = p.odds.outcomePrices;
            return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a + b - 1) < 0.01;
        }));

    check('every prop.id starts with "KX" (the isKalshiPropId invariant backend.ts relies on)',
        allProps.every((p) => p.id.startsWith('KX')), JSON.stringify(allProps.filter((p) => !p.id.startsWith('KX')).map((p) => p.id).slice(0, 5)));

    check('prominence is within 0-99 for every prop', allProps.every((p) => p.prominence >= 0 && p.prominence <= 99));
}

export const suite: Suite = {
    name: 'kalshi-live',
    requiredEnv: [],
    run,
};
