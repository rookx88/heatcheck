// ===================================================================================
// HEATCHECKS TANK — STAGE 2 PRE-FILTER (tank-filter.ts)
// ===================================================================================
// Pure function: no I/O, no provider knowledge. Keeps "not too many props" a simple,
// testable transform independent of where the Games came from (mock or Polymarket).
// ===================================================================================

import type { Game, FilterParams } from './tank-types';

// Order of operations: whitelist -> prominence floor -> sort desc by prominence -> slice to cap.
export function filterProps(games: Game[], params: FilterParams): Game[] {
    const { marketWhitelist, minProminence, perGameCap } = params;
    const whitelistSet = marketWhitelist.length > 0 ? new Set(marketWhitelist) : null;

    return games.map(game => {
        let props = game.props;

        if (whitelistSet) {
            props = props.filter(p => whitelistSet.has(p.market));
        }

        props = props.filter(p => p.prominence >= minProminence);

        props = [...props].sort((a, b) => b.prominence - a.prominence);

        props = props.slice(0, perGameCap);

        return { ...game, props };
    }).filter(game => game.props.length > 0);
}
