// One-off script: seeds the Tank feed with 3 starting pages. Run manually via:
//   npx tsx scripts/seed-tank-starter-pages.ts
// Not added to package.json "scripts" - this is not part of the regular pipeline.
//
// Page 1 ("Celebrity Suite") is a custom/novelty prop that doesn't exist on
// Polymarket - its hook/cards/call are fixed (curator-supplied, used verbatim),
// but its game_snapshot.game is a real upcoming game pulled from the polymarket_props
// cache. Pages 2 and 3 go through the real pipeline: real props from the cache, a
// written angle, one real generateTankArticle() Anthropic call each.
//
// Does NOT shell out to `npm run build:static` itself - run that once, manually,
// after this script finishes.

import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

import { createPolymarketPropProvider } from '../tank-providers';
import { filterProps } from '../tank-filter';
import { generateTankArticle, ensureTankPagesTable } from '../tank-generate';
import { generateSlug, ensureUniqueSlug } from './utils/slug-generator';
import type { Prop, Game, TankArticle } from '../tank-types';

// Kept in sync with DEFAULT_MARKET_WHITELIST in index.tsx (TankCurator) - duplicated
// here because that constant lives in a browser-bundled file not reachable from a
// plain Node script, and isn't worth extracting into shared config for a one-off.
const MARKET_WHITELIST = [
    'basketball_player_points', 'basketball_player_rebounds', 'basketball_player_assists', 'basketball_player_triple_double',
    'football_player_passing_yards', 'football_player_rushing_yards', 'football_player_anytime_td',
    'baseball_player_home_runs', 'baseball_player_hits',
    'soccer_player_anytime_scorer', 'soccer_player_shots_on_target',
];

interface SeedRow {
    slug: string;
    provider: string;
    league: string;
    angle: string;
    game_snapshot: { prop: Prop; game: Game };
    model_output: TankArticle | null;
    raw_output: string | null;
    generation_error: string | null;
    status: 'draft' | 'published';
}

async function insertRow(pool: Pool, row: SeedRow): Promise<void> {
    const publishedAt = row.status === 'published' ? new Date().toISOString() : null;
    await pool.query(
        `INSERT INTO tank_pages (
            slug, provider, league, angle, game_snapshot, model_output, raw_output,
            generation_error, status, published_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
            row.slug, row.provider, row.league, row.angle,
            JSON.stringify(row.game_snapshot),
            row.model_output ? JSON.stringify(row.model_output) : null,
            row.raw_output, row.generation_error, row.status, publishedAt,
        ]
    );
}

async function buildCelebritySuitePage(pool: Pool, existingSlugs: Set<string>): Promise<SeedRow> {
    const provider = createPolymarketPropProvider(pool);
    const games = await provider.fetchProps();

    // Prefer a real, marquee-ish NFL game with enough lead time to stay "active"
    // for a while; fall back to the soonest upcoming game in any league.
    const nflGames = games.filter(g => g.league === 'NFL').sort(
        (a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime()
    );
    const game = nflGames[0] || games.sort((a, b) => new Date(a.kickoff).getTime() - new Date(b.kickoff).getTime())[0];
    if (!game) throw new Error('No upcoming games found in polymarket_props cache to anchor the Celebrity Suite page.');

    const prop: Prop = {
        id: 'custom-celebrity-suite-cutaways',
        player: 'Broadcast',
        team: null,
        market: 'broadcast_celebrity_cutaway_count',
        line: 4.5,
        prominence: 99,
        odds: null, // no real market exists for this on Polymarket
    };

    const gameSnapshot: Game = {
        id: game.id,
        league: game.league,
        away: game.away,
        home: game.home,
        kickoff: game.kickoff,
        settleDate: game.settleDate,
        props: [], // this synthetic prop isn't actually among the game's real props
    };

    const eventName = `${game.away} vs ${game.home}`;
    const modelOutput: TankArticle = {
        seo: {
            title: `${eventName}: Celebrity Suite Cutaways Over 4.5?`.slice(0, 60),
            meta_description: `When ${game.away} meet ${game.home} on the broadcast, will cameras find the celebrity suite five times or more? Heatchecks calls the number on live TV cutaways.`.slice(0, 155),
            slug: `${game.away}-${game.home}-celebrity-suite-cutaways`,
        },
        body: `${game.away} and ${game.home} kick off a full broadcast window, and the story upstairs might get as much airtime as the game itself. Every primetime slot means producers hunting for reaction shots, and a loaded suite is the easiest cutaway on the board.\n\nProduction crews already lean on this move constantly. They track high profile guests all game long to hold casual viewers who tuned in for more than football, and a table full of familiar faces gives them exactly that.\n\nSo does the broadcast keep finding its way back to that suite, or does the crew stay locked on the field tonight? ${game.away} and ${game.home} will settle plenty on the scoreboard. This one gets settled by the camera truck.`,
        tagline: "Celebrity Suite Cutaway Watch",
        hook: "When mega-stars show up to luxury suites, TV directors spend as much time on the boxes as the field. Will the broadcast team cut away to the celebrity suite 5 or more times during live play?",
        cards: [
            "Production crews are heavily incentivized to track high-profile suite guests throughout primetime broadcasts to hold casual viewership.",
            "Sharp viewers note camera directors often average 3 to 4 cutaways per half alone when high-profile celebrities are in attendance.",
        ],
        call: {
            question: "Celebrity Suite Shown Live on Broadcast: OVER / UNDER 4.5 Times?",
            sides: ["OVER 4.5 (+50 Embers)", "UNDER 4.5 (+50 Embers)"],
        },
    };

    const baseSlug = generateSlug(modelOutput.seo.slug);
    const slug = ensureUniqueSlug(baseSlug, existingSlugs);
    existingSlugs.add(slug);

    return {
        slug,
        provider: 'custom',
        league: game.league,
        angle: 'Curator-authored novelty prop: broadcast crews cutting to celebrity suites during primetime coverage.',
        game_snapshot: { prop, game: gameSnapshot },
        model_output: modelOutput,
        raw_output: null,
        generation_error: null,
        status: 'published',
    };
}

async function buildGeneratedPages(pool: Pool, existingSlugs: Set<string>, count: number): Promise<SeedRow[]> {
    const provider = createPolymarketPropProvider(pool);
    const games = await provider.fetchProps();
    // The polymarket_props cache can hold rows for games that already happened
    // (not yet pruned/closed upstream) - exclude those before ranking, otherwise a
    // stale high-prominence row for a past game can outrank a real upcoming one.
    const now = Date.now();
    const upcomingGames = games.filter(g => new Date(g.kickoff).getTime() > now);
    const filtered = filterProps(upcomingGames, { marketWhitelist: MARKET_WHITELIST, minProminence: 70, perGameCap: 3 });

    const candidates: { prop: Prop; game: Game }[] = [];
    for (const game of filtered) {
        for (const prop of game.props) {
            candidates.push({ prop, game });
        }
    }
    candidates.sort((a, b) => b.prop.prominence - a.prop.prominence);

    // Prefer distinct games so the feed doesn't seed 2 pages on the same matchup.
    const picked: { prop: Prop; game: Game }[] = [];
    const usedGameIds = new Set<string>();
    for (const c of candidates) {
        if (picked.length >= count) break;
        if (usedGameIds.has(c.game.id)) continue;
        picked.push(c);
        usedGameIds.add(c.game.id);
    }
    // Fall back to filling remaining slots even if it means repeating a game.
    for (const c of candidates) {
        if (picked.length >= count) break;
        if (!picked.includes(c)) picked.push(c);
    }

    const rows: SeedRow[] = [];
    for (const { prop, game } of picked.slice(0, count)) {
        const angle = `High-prominence market signal on ${prop.player}'s ${prop.market.replace(/_/g, ' ')} line ahead of ${game.away} @ ${game.home} - worth a closer look at why the market is leaning this way.`;

        try {
            const result = await generateTankArticle(prop, angle, game, [], {
                apiKey: process.env.ANTHROPIC_API_KEY!,
                model: process.env.MODEL,
                maxTokens: process.env.MAX_TOKENS ? Number(process.env.MAX_TOKENS) : undefined,
            });
            if (result.parsed) {
                const baseSlug = generateSlug(result.parsed.seo.slug || result.parsed.seo.title);
                const slug = ensureUniqueSlug(baseSlug, existingSlugs);
                existingSlugs.add(slug);
                rows.push({
                    slug, provider: 'polymarket', league: game.league, angle,
                    game_snapshot: { prop, game },
                    model_output: result.parsed,
                    raw_output: null, generation_error: null,
                    status: 'published',
                });
                console.log(`✓ Generated and will publish: ${slug}`);
            } else {
                // Don't drop a failed generation silently - insert as draft with the
                // error populated, same as the real /api/tank/generate route does,
                // so it's visible and retryable from the dashboard's Drafts view.
                const fallbackSlug = ensureUniqueSlug(generateSlug(`${prop.player}-${prop.market}`), existingSlugs);
                existingSlugs.add(fallbackSlug);
                rows.push({
                    slug: fallbackSlug, provider: 'polymarket', league: game.league, angle,
                    game_snapshot: { prop, game },
                    model_output: null,
                    raw_output: result.rawText || null, generation_error: result.error,
                    status: 'draft',
                });
                console.warn(`⚠ Generation failed for ${prop.player} (${prop.market}), inserted as draft: ${result.error}`);
            }
        } catch (err: any) {
            console.error(`✗ Error generating page for ${prop.player} (${prop.market}):`, err.message);
        }
    }
    return rows;
}

async function main() {
    const pool = new Pool({ connectionString: process.env.DATABASE_URL });
    try {
        await ensureTankPagesTable(pool);

        const existingSlugsResult = await pool.query('SELECT slug FROM tank_pages WHERE slug IS NOT NULL');
        const existingSlugs = new Set<string>(existingSlugsResult.rows.map(r => r.slug));

        const allRows: SeedRow[] = [];

        const existingCustom = await pool.query(`SELECT slug FROM tank_pages WHERE provider = 'custom' LIMIT 1`);
        if (existingCustom.rowCount === 0) {
            console.log('Building Celebrity Suite page (custom prop, real game)...');
            allRows.push(await buildCelebritySuitePage(pool, existingSlugs));
        } else {
            console.log(`Celebrity Suite page already exists (${existingCustom.rows[0].slug}), skipping.`);
        }

        console.log('Generating 2 more pages from real props via the real pipeline...');
        allRows.push(...await buildGeneratedPages(pool, existingSlugs, 2));

        for (const row of allRows) {
            await insertRow(pool, row);
        }

        console.log('\n=== Seed summary ===');
        for (const row of allRows) {
            console.log(`  [${row.status}] ${row.slug}${row.generation_error ? ` (error: ${row.generation_error})` : ''}`);
        }
        console.log('\nRun `npm run build:static` to publish these to the static site.');
    } finally {
        await pool.end();
    }
}

main().catch(error => {
    console.error('Fatal error seeding Tank starter pages:', error);
    process.exit(1);
});
