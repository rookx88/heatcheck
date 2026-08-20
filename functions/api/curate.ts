// POST /api/curate - protected, machine-to-machine only (called by worker-curate/'s daily
// cron, or by hand while testing). Auth is a shared secret header, not a user session -
// same convention functions/api/settle.ts already established for this repo's first
// protected endpoint.
//
// Automates the "curator" step that today only happens by hand in the TankCurator admin
// UI (index.tsx, backed by backend.ts's /api/tank/props + /api/tank/generate, which only
// run when that Express server is up locally): find live Polymarket props, use web
// search to find what's genuinely trending in sports right now, match candidates to real
// storylines (even loosely - a Joe Burrow relationship story justifying a next-Bengals-
// game prop), and generate status='draft' Tank pages via the exact same generation logic
// the manual flow uses. Never auto-publishes - a human still reviews and publishes via
// the existing PUT /api/tank/pages/:id route.
//
// Matching runs once PER SPORT GROUP (see SPORT_GROUPS), not once globally across every
// league's candidates. A single shared call let whichever sport had the most compelling
// storylines that day (MLB, say) consume the whole match budget and crowd out everything
// else - not a deliberate bias, just what happens when 6 slots are shared across every
// league's candidates in one pool. Per-group calls give every sport its own honest shot
// at finding a real story - and its own right to come back with zero, which stays a
// valid, correct outcome per-group exactly as it was globally before. This does multiply
// the Anthropic web-search cost by however many sport groups have live candidates (up to
// 4x) - tune CURATE_WEB_SEARCH_MAX_USES / CURATE_MAX_MATCHES_PER_RUN down if that's a
// problem, since both now apply per-group rather than once overall.
//
// If the search step genuinely can't find real connections for a given sport, that
// sport contributes zero drafts this run - it never pads with a generic high-prominence
// prop just to hit a quota.
//
// This endpoint also runs the daily Exchange ticker TAG SWEEP (sweepUntaggedTanks in
// lib/pages-functions/tickers.ts): published, app-visible Tanks that somehow have no
// ticker tags get both sides tagged onto every eligible ticker. It's the catch-all
// behind backend.ts's publish-time tag hook - anything that publishes without being
// tagged (hook misconfigured, CLOB hiccup at publish time) is picked up here within a
// day. Runs even when there are zero curation candidates, and its failure never fails
// the curation response.

import type { PagesFunction } from '@cloudflare/workers-types';
import Anthropic from '@anthropic-ai/sdk';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { sweepUntaggedTanks, type SweepReport } from '../../lib/pages-functions/tickers';
import { fetchLiveGames, DEFAULT_WINDOW_HOURS } from '../../tank-gamma-live';
import { filterProps } from '../../tank-filter';
import { generateTankArticle, extractJson, parseModelJson, type GenerationConfig } from '../../tank-generate';
import { TANK_CURATOR_MATCH_PROMPT } from '../../scripts/prompts/tank-curator-match-prompt';
import { generateSlug, ensureUniqueSlug } from '../../scripts/utils/slug-generator';
import type { Prop, Game } from '../../tank-types';

const DEFAULT_DEDUPE_DAYS = 7;
const DEFAULT_TAG_SWEEP_DAYS = 14;
const DEFAULT_MAX_CANDIDATES = 80;
const DEFAULT_MAX_MATCHES_PER_RUN = 6;
const DEFAULT_WEB_SEARCH_MAX_USES = 8;
const DEFAULT_MATCH_MAX_TOKENS = 4000;
const DEFAULT_MARKET_WHITELIST: string[] = [];
const DEFAULT_MIN_PROMINENCE = 0;
const DEFAULT_PER_GAME_CAP = 3;

// Sport groups the curator gives an independent shot at, per Sammy's request to stop
// letting one sport's news cycle crowd out the others. Individual soccer leagues are
// grouped under one "Soccer" pass rather than run separately - the ask was sport-level
// coverage (Soccer/Basketball/Baseball/Football), not one guaranteed match per league.
// A league absent here (or with no live candidates that run) simply isn't grouped/run -
// not an error, just nothing to curate for it right now.
const SPORT_GROUPS: Record<string, string[]> = {
    Soccer: ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1'],
    Basketball: ['NBA'],
    Baseball: ['MLB'],
    Football: ['NFL'],
};

interface CuratorMatch {
    candidateId: string;
    angle: string;
}

interface CuratorMatchResponse {
    matches: CuratorMatch[];
}

function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function isCuratorMatchResponse(value: any): value is CuratorMatchResponse {
    return value && Array.isArray(value.matches) && value.matches.every(
        (m: any) => m && typeof m.candidateId === 'string' && typeof m.angle === 'string' && m.angle.trim()
    );
}

interface CandidateEntry {
    prop: Prop;
    game: Game;
}

interface CurateGroupResult {
    sportGroup: string;
    candidatesConsidered: number;
    matchesFound: number;
    created: number;
    results: Array<{ candidateId: string; status: string; slug?: string }>;
}

// Runs one match-then-generate pass (one Anthropic web-search call, then one generation
// call per genuine match) against a single sport group's candidate list. Pulled out of
// the request handler so each sport group gets its own isolated call/budget instead of
// sharing one pool - see the file header for why that's the point of this refactor.
async function curateSportGroup(
    sportGroup: string,
    candidates: CandidateEntry[],
    env: Env,
    sql: ReturnType<typeof getSql>,
    existingSlugs: Set<string>,
    config: { maxMatchesPerRun: number; webSearchMaxUses: number; matchMaxTokens: number; generationConfig: GenerationConfig }
): Promise<CurateGroupResult> {
    const candidateById = new Map(candidates.map(c => [c.prop.id, c]));
    const candidatePayload = candidates.map(c => ({
        id: c.prop.id,
        player: c.prop.player,
        market: c.prop.market,
        line: c.prop.line,
        league: c.game.league,
        away: c.game.away,
        home: c.game.home,
        kickoff: c.game.kickoff,
    }));

    const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await client.messages.create({
        model: env.MODEL || 'claude-sonnet-5',
        max_tokens: config.matchMaxTokens,
        thinking: { type: 'disabled' },
        system: TANK_CURATOR_MATCH_PROMPT,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: config.webSearchMaxUses }],
        messages: [{ role: 'user', content: JSON.stringify({ candidates: candidatePayload }) }],
    });

    // Search tool-use responses can interleave multiple text/tool rounds - the final
    // answer is the last text block, not necessarily the only one (unlike the single-shot
    // narrative generation call in tank-generate.ts).
    const textBlocks = response.content.filter((block): block is Anthropic.TextBlock => block.type === 'text');
    const rawText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';

    let matchResponse: CuratorMatchResponse;
    try {
        const parsed = parseModelJson(extractJson(rawText));
        if (!isCuratorMatchResponse(parsed)) {
            throw new Error('Response did not match the expected { matches: [...] } shape.');
        }
        matchResponse = parsed;
    } catch (err: any) {
        console.error(`[POST /api/curate] [${sportGroup}] Failed to parse curator match response:`, err.message, rawText);
        return { sportGroup, candidatesConsidered: candidates.length, matchesFound: 0, created: 0, results: [] };
    }

    const matches = matchResponse.matches.slice(0, config.maxMatchesPerRun);
    const results: Array<{ candidateId: string; status: string; slug?: string }> = [];
    let created = 0;

    // Sequential, not parallel - matches settle.ts's precedent (predictable cost/rate,
    // respects Anthropic's rate limits).
    for (const match of matches) {
        const candidate = candidateById.get(match.candidateId);
        if (!candidate) {
            results.push({ candidateId: match.candidateId, status: 'unknown_candidate_id' });
            continue;
        }
        const { prop, game } = candidate;

        try {
            const genResult = await generateTankArticle(prop, match.angle, game, [], config.generationConfig);

            let slug: string | null = null;
            if (genResult.parsed) {
                const baseSlug = genResult.parsed.seo.slug ? generateSlug(genResult.parsed.seo.slug) : generateSlug(genResult.parsed.seo.title);
                slug = ensureUniqueSlug(baseSlug, existingSlugs);
                existingSlugs.add(slug);
            }

            await sql`
                INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, raw_output, generation_error, status)
                VALUES (
                    ${slug}, 'polymarket', ${game.league}, ${match.angle},
                    ${JSON.stringify({ prop, game })},
                    ${genResult.parsed ? JSON.stringify(genResult.parsed) : null},
                    ${genResult.parsed ? null : genResult.rawText},
                    ${genResult.error},
                    'draft'
                )
            `;

            created++;
            results.push({ candidateId: match.candidateId, status: genResult.parsed ? 'created' : 'created_with_generation_error', slug: slug ?? undefined });
        } catch (err: any) {
            console.error(`[POST /api/curate] [${sportGroup}] Failed to create draft for candidate ${match.candidateId}:`, err);
            results.push({ candidateId: match.candidateId, status: 'error' });
        }
    }

    return { sportGroup, candidatesConsidered: candidates.length, matchesFound: matches.length, created, results };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }

    const env = context.env;
    const windowHours = numEnv(env.CURATE_WINDOW_HOURS, DEFAULT_WINDOW_HOURS);
    const dedupeDays = numEnv(env.CURATE_DEDUPE_DAYS, DEFAULT_DEDUPE_DAYS);
    const maxCandidates = numEnv(env.CURATE_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES);
    const maxMatchesPerRun = numEnv(env.CURATE_MAX_MATCHES_PER_RUN, DEFAULT_MAX_MATCHES_PER_RUN);
    const webSearchMaxUses = numEnv(env.CURATE_WEB_SEARCH_MAX_USES, DEFAULT_WEB_SEARCH_MAX_USES);
    const matchMaxTokens = numEnv(env.CURATE_MATCH_MAX_TOKENS, DEFAULT_MATCH_MAX_TOKENS);
    const marketWhitelist = env.MARKET_WHITELIST
        ? env.MARKET_WHITELIST.split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULT_MARKET_WHITELIST;
    const minProminence = numEnv(env.MIN_PROMINENCE, DEFAULT_MIN_PROMINENCE);
    const perGameCap = numEnv(env.PER_GAME_CAP, DEFAULT_PER_GAME_CAP);

    const generationConfig: GenerationConfig = {
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.MODEL,
        maxTokens: numEnv(env.MAX_TOKENS, 1000),
    };

    const sql = getSql(env);

    // 0. Exchange ticker tag sweep - runs FIRST so the zero-candidates early return
    // below can't skip it, and in its own try/catch so a sweep failure degrades to an
    // error note in the response rather than failing curation.
    let tickerTagging: SweepReport | { error: string };
    try {
        tickerTagging = await sweepUntaggedTanks(sql, {
            maxAgeDays: numEnv(env.CURATE_TAG_SWEEP_DAYS, DEFAULT_TAG_SWEEP_DAYS),
        });
    } catch (err) {
        console.error('[POST /api/curate] Ticker tag sweep failed:', err);
        tickerTagging = { error: err instanceof Error ? err.message : String(err) };
    }

    // 1. Live candidates, filtered the same way the manual admin flow filters them.
    const liveGames = await fetchLiveGames(undefined, windowHours);
    const filtered = filterProps(liveGames, { marketWhitelist, minProminence, perGameCap });

    let allCandidates: CandidateEntry[] = [];
    for (const game of filtered) {
        for (const prop of game.props) {
            allCandidates.push({ prop, game });
        }
    }

    // 2. Dedupe: skip markets already surfaced as a Tank page recently, so the same
    // storyline doesn't get re-matched (and re-cost a web search) day after day.
    const recentRows = await sql`
        SELECT DISTINCT game_snapshot->'prop'->>'id' AS market_id
        FROM tank_pages
        WHERE created_at > NOW() - (INTERVAL '1 day' * ${dedupeDays})
          AND game_snapshot->'prop'->>'id' IS NOT NULL
    `;
    const recentMarketIds = new Set(recentRows.map(r => r.market_id as string));
    allCandidates = allCandidates.filter(c => !recentMarketIds.has(c.prop.id));

    if (allCandidates.length === 0) {
        return jsonResponse({ candidatesConsidered: 0, matchesFound: 0, created: 0, groups: [], tickerTagging });
    }

    const slugRows = await sql`SELECT slug FROM tank_pages WHERE slug IS NOT NULL`;
    const existingSlugs = new Set(slugRows.map(r => r.slug as string));

    const runConfig = { maxMatchesPerRun, webSearchMaxUses, matchMaxTokens, generationConfig };

    // 3. One match-then-generate pass per sport group, each scoped to only that group's
    // candidates (top maxCandidates by prominence within the group) - see file header.
    const groupResults: CurateGroupResult[] = [];
    for (const [sportGroup, leagues] of Object.entries(SPORT_GROUPS)) {
        const groupCandidates = allCandidates
            .filter(c => leagues.includes(c.game.league))
            .sort((a, b) => b.prop.prominence - a.prop.prominence)
            .slice(0, maxCandidates);

        if (groupCandidates.length === 0) {
            groupResults.push({ sportGroup, candidatesConsidered: 0, matchesFound: 0, created: 0, results: [] });
            continue;
        }

        const groupResult = await curateSportGroup(sportGroup, groupCandidates, env, sql, existingSlugs, runConfig);
        groupResults.push(groupResult);
    }

    const totals = groupResults.reduce(
        (acc, g) => ({
            candidatesConsidered: acc.candidatesConsidered + g.candidatesConsidered,
            matchesFound: acc.matchesFound + g.matchesFound,
            created: acc.created + g.created,
        }),
        { candidatesConsidered: 0, matchesFound: 0, created: 0 }
    );

    return jsonResponse({ ...totals, groups: groupResults, tickerTagging });
};
