// ===================================================================================
// HEATCHECKS TANK — STAGE 2 PRE-FILTER (tank-filter.ts)
// ===================================================================================
// Pure function: no I/O, no provider knowledge. Keeps "not too many props" a simple,
// testable transform independent of where the Games came from (mock or Polymarket).
// ===================================================================================

import type { Game, FilterParams } from './tank-types';
import { effectiveSettleDate } from './tank-deck-format';

// Order of operations: whitelist -> lead-time floor -> prominence floor -> sort desc by
// prominence -> slice to cap.
export function filterProps(games: Game[], params: FilterParams): Game[] {
    const { marketWhitelist, minProminence, perGameCap, minLeadDays, now } = params;
    const whitelistSet = marketWhitelist.length > 0 ? new Set(marketWhitelist) : null;
    // effectiveSettleDate (not the raw prop/game settleDate) is what's compared: game
    // markets carry Gamma's endDate padded ~a week past the actual game, so filtering on
    // the raw field would wrongly admit tomorrow's game just because its market
    // technically stays open a week - the corrected editorial date is what a reader
    // actually sees as "resolves".
    const earliestAllowedMs = minLeadDays > 0 ? now.getTime() + minLeadDays * 86_400_000 : null;

    return games.map(game => {
        let props = game.props;

        if (whitelistSet) {
            props = props.filter(p => whitelistSet.has(p.market));
        }

        if (earliestAllowedMs !== null) {
            props = props.filter(p => {
                const resolveDate = effectiveSettleDate(p, game);
                if (!resolveDate) return true; // no date to judge - fail open, same posture as effectiveSettleDate itself
                const resolveMs = new Date(resolveDate).getTime();
                return isNaN(resolveMs) || resolveMs >= earliestAllowedMs;
            });
        }

        props = props.filter(p => p.prominence >= minProminence);

        props = [...props].sort((a, b) => b.prominence - a.prominence);

        props = props.slice(0, perGameCap);

        return { ...game, props };
    }).filter(game => game.props.length > 0);
}
