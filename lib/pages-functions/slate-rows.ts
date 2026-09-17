// A polymarket_props row -> the SlateMarketRow index-slate.ts scores. Shared by the
// lock cron (functions/api/index-lock.ts) and the admin matchup picker (backend.ts) so
// both hand pickCanonicalMarket the same shape and can never disagree on a game's line.
// Pure: no DB, no fetch.

import type { SlateMarketRow } from './index-slate';

// One side of a fixture as Gamma publishes it. The abbreviation is read as well as the
// name because it is the stable half: present on 100% of 183,696 team entries measured
// 2026-09-12, a strict bijection with name inside a league, and unaffected by a rename
// (Polymarket already shortened 'Oakland Athletics' to 'Athletics').
//
// The positional fallback matches tank-providers.ts's buildGamesFromFlatProps. Without
// it an event where Gamma omits `ordering` writes away/home as NULL with no counter and
// no guard - a silent failure by construction.
export function teamAt(teams: unknown, ordering: 'away' | 'home'): { name: string | null; abbr: string | null } {
    if (!Array.isArray(teams)) return { name: null, abbr: null };
    const positional = ordering === 'away' ? teams[0] : teams[1];
    const match = teams.find((t: any) => t?.ordering === ordering) ?? positional;
    const name = typeof match?.name === 'string' ? match.name : null;
    const abbr = typeof match?.abbreviation === 'string' ? match.abbreviation.toLowerCase() : null;
    return { name, abbr };
}

// Accepts a raw driver row (neon and pg both hand back loosely typed records) carrying
// polymarket_props' event_id, league, market_id, condition_id, market_type, market_line,
// outcomes, outcome_prices, volume, liquidity, event_start_time, event_teams, question.
export function toSlateMarketRow(r: Record<string, unknown>): SlateMarketRow {
    const num = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    };
    return {
        event_id: String(r.event_id),
        league: typeof r.league === 'string' ? r.league : '',
        market_id: String(r.market_id),
        condition_id: typeof r.condition_id === 'string' ? r.condition_id : null,
        market_type: typeof r.market_type === 'string' ? r.market_type : '',
        market_line: num(r.market_line),
        outcomes: Array.isArray(r.outcomes) ? (r.outcomes as unknown[]).map(String) : null,
        outcome_prices: Array.isArray(r.outcome_prices) ? (r.outcome_prices as unknown[]).map(Number) : null,
        volume: num(r.volume),
        liquidity: num(r.liquidity),
        // Neon and pg both hand timestamps back as Date objects, and String(date) yields
        // "... GMT-0700 (Pacific Daylight Time)" which Postgres rejects on the way back
        // in. Always round-trip through ISO.
        kickoff: r.event_start_time ? new Date(r.event_start_time as string | Date).toISOString() : null,
        away: teamAt(r.event_teams, 'away').name,
        home: teamAt(r.event_teams, 'home').name,
        question: typeof r.question === 'string' ? r.question : null,
    };
}
