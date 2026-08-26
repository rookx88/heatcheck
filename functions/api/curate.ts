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
// The daily Exchange ticker TAG SWEEP deliberately does NOT live in this handler: a
// Worker invocation has a hard subrequest budget ("Too many subrequests"), and this
// run's Gamma + Anthropic + Neon traffic already sits close to it. The sweep runs as
// its own request with its own budget - POST /api/ticker-sweep, fired by
// worker-curate/ immediately after this endpoint.
//
// Kalshi (kalshi-live.ts) is DISABLED here for now (2026-08-25): merging its fetch into
// this same request pushed the whole invocation over Cloudflare's subrequest ceiling in
// production - this endpoint's Polymarket + Anthropic + Neon traffic alone already sits
// close to the limit (see the per-group try/catch below, which predates Kalshi and
// exists for exactly this scenario). Re-enabling Kalshi needs its own sibling request
// (matching the ticker-sweep split above), not a merge back into this one - the
// SPORT_GROUPS/curateSportGroup/numEnv/isCuratorMatchResponse machinery below is
// already exported in anticipation of that. The Kalshi module itself (kalshi.ts,
// kalshi-live.ts, tank-providers.ts's buildGamesFromKalshiFlatProps) is unaffected and
// still fully wired into the admin tool (backend.ts, PROP_PROVIDER=kalshi|both).

import type { PagesFunction } from '@cloudflare/workers-types';
import Anthropic from '@anthropic-ai/sdk';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchLiveGames, DEFAULT_WINDOW_HOURS } from '../../tank-gamma-live';
import { filterProps } from '../../tank-filter';
import { generateTankArticle, extractJson, parseModelJson, type GenerationConfig } from '../../tank-generate';
import { TANK_CURATOR_MATCH_PROMPT } from '../../scripts/prompts/tank-curator-match-prompt';
import { generateSlug, ensureUniqueSlug } from '../../scripts/utils/slug-generator';
import type { Prop, Game } from '../../tank-types';

export const DEFAULT_DEDUPE_DAYS = 7;
export const DEFAULT_MAX_CANDIDATES = 80;
export const DEFAULT_MAX_MATCHES_PER_RUN = 6;
export const DEFAULT_WEB_SEARCH_MAX_USES = 8;
export const DEFAULT_MATCH_MAX_TOKENS = 4000;
export const DEFAULT_MARKET_WHITELIST: string[] = [];
export const DEFAULT_MIN_PROMINENCE = 0;
export const DEFAULT_PER_GAME_CAP = 3;
// Reader-facing minimum lead time (2026-08-23): a Tank published this morning should
// resolve at least 2 full days out, not the same day or tomorrow - by the time a reader
// sees it and makes a call, a same-day resolve leaves no runway to actually follow the
// story. Measured against effectiveSettleDate (tank-deck-format.ts), the corrected
// editorial resolve date, not Polymarket's sometimes-padded raw settleDate.
export const DEFAULT_MIN_LEAD_DAYS = 2;

// Sport groups the curator gives an independent shot at, per Sammy's request to stop
// letting one sport's news cycle crowd out the others. Individual soccer leagues are
// grouped under one "Soccer" pass rather than run separately - the ask was sport-level
// coverage (Soccer/Basketball/Baseball/Football), not one guaranteed match per league.
// A league absent here (or with no live candidates that run) simply isn't grouped/run -
// not an error, just nothing to curate for it right now. Shared with curate-kalshi.ts
// so both endpoints group leagues identically.
export const SPORT_GROUPS: Record<string, string[]> = {
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

export function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function isCuratorMatchResponse(value: any): value is CuratorMatchResponse {
    return value && Array.isArray(value.matches) && value.matches.every(
        (m: any) => m && typeof m.candidateId === 'string' && typeof m.angle === 'string' && m.angle.trim()
    );
}

export interface CandidateEntry {
    prop: Prop;
    game: Game;
    provider: 'polymarket' | 'kalshi';
}

export interface CurateGroupResult {
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
// Exported so curate-kalshi.ts's sibling endpoint reuses this exact logic rather than
// duplicating it and risking drift between the two providers' match/generate behavior.
export async function curateSportGroup(
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
        const { prop, game, provider } = candidate;

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
                    ${slug}, ${provider}, ${game.league}, ${match.angle},
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
    const minLeadDays = numEnv(env.MIN_LEAD_DAYS, DEFAULT_MIN_LEAD_DAYS);

    const generationConfig: GenerationConfig = {
        apiKey: env.ANTHROPIC_API_KEY,
        model: env.MODEL,
        maxTokens: numEnv(env.MAX_TOKENS, 1000),
    };

    const sql = getSql(env);

    // 1. Live candidates. Polymarket only for now - see the file header for why Kalshi
    // (kalshi-live.ts) is disabled here rather than merged into this same request.
    const liveGames = await fetchLiveGames(undefined, windowHours);
    const filtered = filterProps(liveGames, { marketWhitelist, minProminence, perGameCap, minLeadDays, now: new Date() });

    let allCandidates: CandidateEntry[] = [];
    for (const game of filtered) {
        for (const prop of game.props) {
            allCandidates.push({ prop, game, provider: 'polymarket' });
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
        return jsonResponse({ candidatesConsidered: 0, matchesFound: 0, created: 0, groups: [] });
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

        // Per-group try/catch: one group throwing (an Anthropic connection error, the
        // subrequest budget running out late in the run) must degrade to that group
        // reporting an error, not 500 the whole run and lose every group's report -
        // observed live when the budget died mid-Football after Baseball had already
        // created drafts.
        try {
            const groupResult = await curateSportGroup(sportGroup, groupCandidates, env, sql, existingSlugs, runConfig);
            groupResults.push(groupResult);
        } catch (err) {
            console.error(`[POST /api/curate] [${sportGroup}] Group run failed:`, err);
            groupResults.push({
                sportGroup,
                candidatesConsidered: groupCandidates.length,
                matchesFound: 0,
                created: 0,
                results: [{ candidateId: '-', status: `group_error: ${err instanceof Error ? err.message : String(err)}` }],
            });
        }
    }

    const totals = groupResults.reduce(
        (acc, g) => ({
            candidatesConsidered: acc.candidatesConsidered + g.candidatesConsidered,
            matchesFound: acc.matchesFound + g.matchesFound,
            created: acc.created + g.created,
        }),
        { candidatesConsidered: 0, matchesFound: 0, created: 0 }
    );

    return jsonResponse({ ...totals, groups: groupResults });
};
