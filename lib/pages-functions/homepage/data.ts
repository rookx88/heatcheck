// ===================================================================================
// HOMEPAGE DATA — queries + pure row→viewmodel mappers (lib/pages-functions/homepage)
// ===================================================================================
// fetchHomepageData() is the request-time path (functions/index.ts, Neon HTTP driver).
// The mappers and filterAndSortLiveRows() are pure and exported separately so
// scripts/generate-static-site.ts can push its own pg rows through the identical
// mapping when it writes the build-time logged-out fallback of the homepage - one
// mapping, two fetch paths.
// ===================================================================================

import type { NeonQueryFunction } from '@neondatabase/serverless';
import type { Prop, Game, TankArticle, DeckPayload } from '../../../tank-types';
import { SPORT_BY_LEAGUE, SPORT_ORDER, type Sport } from '../../../sport-map';
import {
    formatPropTag,
    formatSettleDate,
    formatGameTime,
    effectiveSettleDate,
    truncateHeaderLabel,
    deriveTaglineFallback,
    deriveSidesImpliedProb,
} from '../../../tank-deck-format';
import { getTickerNews, getTickerResults, getTickerSeries, getTickerValues } from '../tickers';
import { emptyMarketMovers, toMarketMovers, type MarketMoversData } from '../market-movers';

export interface HomepageTankRow {
    slug: string;
    league: string;
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle;
    published_at: string | Date | null;
    created_at: string | Date;
}

export interface SportCardViewModel {
    sport: Sport;
    slug: string;
    href: string;
    hook: string;
    firstBeat: string; // cards[0] verbatim; '' when the model returned no cards
    propTag: string;   // "O 268.5 Passing Yards" / market label alone for yes-no markets
    league: string;
    matchup: string;   // "Away @ Home" - names a tank in the showcase's sibling pager
    deck: DeckPayload; // full 4-wall deck; the client drops a card wall when it swaps in the logged-out promo wall
}

// Every sport in SPORT_ORDER always gets a slot; card === null renders the visible
// "nothing live today" placeholder, never a collapsed/missing slot.
export interface SportSlot {
    sport: Sport;
    card: SportCardViewModel | null;
    // Every live tank in this sport, soonest kickoff first - cards[0] IS card. The
    // showcase pages through these; the sport row and the no-JS fallback read only
    // `card`, so both are unaffected by the list.
    cards: SportCardViewModel[];
}

export interface HomepageData {
    sportSlots: SportSlot[];
    marketMovers: MarketMoversData;
}

export function emptyHomepageData(): HomepageData {
    return { sportSlots: SPORT_ORDER.map(sport => ({ sport, card: null, cards: [] })), marketMovers: emptyMarketMovers() };
}

// Same JS-side liveness rule as generate-static-site.ts's activeTankPages filter,
// plus the explicit soonest-first sort that query forgot (arbitrary row order is a
// bug there, not a precedent).
export function filterAndSortLiveRows(rows: HomepageTankRow[], nowMs: number = Date.now()): HomepageTankRow[] {
    return rows
        .map(row => ({ row, kickoff: new Date(row.game_snapshot?.game?.kickoff || '').getTime() }))
        .filter(({ kickoff }) => !isNaN(kickoff) && kickoff > nowMs)
        .sort((a, b) => a.kickoff - b.kickoff)
        .map(({ row }) => row);
}

export function toSportCardViewModel(row: HomepageTankRow, sport: Sport): SportCardViewModel {
    const { prop, game } = row.game_snapshot;
    const propTag = formatPropTag(prop);
    return {
        sport,
        slug: row.slug,
        href: `/the-tank/articles/${row.slug}/`,
        hook: row.model_output.hook,
        firstBeat: row.model_output.cards?.[0] ?? '',
        propTag,
        league: row.league,
        matchup: `${game.away} @ ${game.home}`,
        // Same DeckPayload construction as generate-static-site.ts's tankEntries
        // mapping (two card walls - the Fishtank cube's geometry needs exactly 4
        // walls to close), except the first card wall's header carries the prop tag
        // instead of live odds. For logged-out visitors the client passes a promo
        // wall, which displaces the second card client-side.
        deck: {
            hook: row.model_output.hook,
            cards: row.model_output.cards?.slice(0, 2) ?? [],
            call: {
                ...row.model_output.call,
                sidesImpliedProb: deriveSidesImpliedProb(prop.odds, row.model_output.call.sides.length, prop.book),
            },
            tagline: truncateHeaderLabel(row.model_output.tagline || deriveTaglineFallback(row.model_output.hook)),
            contextLabel: truncateHeaderLabel(propTag),
            oddsOrMarketLabel: truncateHeaderLabel(`${game.league} · ${prop.player}`),
            settleDateLabel: truncateHeaderLabel(formatSettleDate(effectiveSettleDate(prop, game) ?? '')),
            gameTimeLabel: truncateHeaderLabel(formatGameTime(game.kickoff)),
            kickoff: game.kickoff,
        },
    };
}

// Bounds the homepage payload. Every tank is roughly a kilobyte of JSON inlined in
// the HTML - which is edge-cached for anonymous visitors - and nobody pages through
// more than a handful. The live corpus runs to about eight in the busiest sport.
const MAX_TANKS_PER_SPORT = 5;

// rows must already be live-filtered and kickoff-ASC sorted. Each sport keeps its
// live tanks in that order, so cards[0] - the soonest game - is the one the showcase
// opens on and the sport row describes. Sports with none keep card: null, the
// placeholder. This used to stop at the first tank per sport; the rest were thrown
// away, which is why browsing siblings needs no new query.
export function pickLiveTankPerSport(rows: HomepageTankRow[]): SportSlot[] {
    const bySport = new Map<Sport, SportCardViewModel[]>();
    for (const row of rows) {
        const sport = SPORT_BY_LEAGUE[row.league];
        if (!sport) continue;
        const claimed = bySport.get(sport) ?? [];
        if (claimed.length >= MAX_TANKS_PER_SPORT) continue;
        claimed.push(toSportCardViewModel(row, sport));
        bySport.set(sport, claimed);
    }
    return SPORT_ORDER.map(sport => {
        const cards = bySport.get(sport) ?? [];
        return { sport, card: cards[0] ?? null, cards };
    });
}

// The live query shares the public-surface predicate (the one from
// generate-static-site.ts - NOT backend.ts's ?active=true feed, which skips the
// visibility filter and would leak newsletter_only tanks). The kickoff IS NOT NULL
// guard is load-bearing: without it one malformed row makes the ::timestamptz cast
// throw and 500s the page.
//
// Market Movers (the recent-content/SEO section that replaced the old feed) fetches
// through the shared ticker read helpers - the same statements /api/tickers and
// /api/tickers/chart run, so the marquee, the cards, and the JSON API can never
// disagree. It has its OWN fail-open catch: a ticker query failure empties only the
// Market Movers section, while a tank query failure still trips functions/index.ts's
// outer catch exactly as before.
export async function fetchHomepageData(sql: NeonQueryFunction<false, false>): Promise<HomepageData> {
    const [liveRows, marketMovers] = await Promise.all([
        sql`
            SELECT slug, league, game_snapshot, model_output, published_at, created_at
            FROM tank_pages
            WHERE status = 'published' AND visibility = 'app'
              AND slug IS NOT NULL AND model_output IS NOT NULL
              AND game_snapshot->'game'->>'kickoff' IS NOT NULL
              AND (game_snapshot->'game'->>'kickoff')::timestamptz > NOW()
            ORDER BY (game_snapshot->'game'->>'kickoff')::timestamptz ASC
            LIMIT 100
        `,
        Promise.all([getTickerValues(sql), getTickerSeries(sql), getTickerNews(sql, 2), getTickerResults(sql, 3)])
            .then(([values, series, news, results]) => toMarketMovers(values, series, news, results))
            .catch((err) => {
                console.error('[homepage] Ticker data fetch failed; rendering empty Market Movers:', err);
                return emptyMarketMovers();
            }),
    ]);
    return {
        sportSlots: pickLiveTankPerSport(liveRows as unknown as HomepageTankRow[]),
        marketMovers,
    };
}
