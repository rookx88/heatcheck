// ===================================================================================
// HEATCHECKS — SHARED LEAGUE → SPORT MAPPING (sport-map.ts)
// ===================================================================================
// tank_pages has no sport column; sport is always derived from `league` through this
// map. Kept dependency-free like tank-types.ts / tank-deck-format.ts so it's importable
// from client islands, scripts/, AND lib/pages-functions (the Workers runtime), which
// can't import components/TankScreen.tsx (it pulls in CSS/SVG assets).
// ===================================================================================

export type Sport = 'Baseball' | 'Basketball' | 'Football' | 'Soccer';

// League → sport category. A league not listed here simply gets no slot/chip of its
// own - surfaces built from this map only ever show the sports that can actually
// carry content.
export const SPORT_BY_LEAGUE: Record<string, Sport> = {
    MLB: 'Baseball',
    NBA: 'Basketball',
    NCAAB: 'Basketball',
    WNBA: 'Basketball',
    NFL: 'Football',
    NCAAF: 'Football',
    EPL: 'Soccer',
    'Premier League': 'Soccer',
    'La Liga': 'Soccer',
    'Serie A': 'Soccer',
    'Ligue 1': 'Soccer',
    Bundesliga: 'Soccer',
    MLS: 'Soccer',
    Soccer: 'Soccer',
};

export const SPORT_ORDER: Sport[] = ['Baseball', 'Basketball', 'Football', 'Soccer'];
