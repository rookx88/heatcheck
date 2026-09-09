// POST /api/curate - protected, machine-to-machine only. Runs the full curation pass for
// EVERY sport group in one request. Auth is a shared secret header, not a user session -
// same convention functions/api/settle.ts established for this repo's first protected
// endpoint.
//
// PREFER /api/curate-sport. This all-groups endpoint is kept for manual testing and as a
// fallback, but the daily cron (worker-curate) now fires one request PER SPORT against
// functions/api/curate-sport.ts instead. Reason is the subrequest ceiling: a Pages
// Function invocation gets 50 outbound fetches on the Free plan, v2 adds a verification
// call per match on top of the search and generation traffic, and four sports' worth of
// that in one invocation does not fit. One request per sport gives each its own budget.
// Everything below is shared by both entry points; only the group list differs.
//
// WHAT THIS DOES
// Automates the "curator" step that otherwise only happens by hand in the TankCurator
// admin UI (index.tsx, backed by backend.ts's /api/tank/props + /api/tank/generate, which
// only run when that Express server is up locally): find live Polymarket props, search
// for what is genuinely trending, match candidates to real storylines (even loosely - a
// quarterback's off-field story justifying a prop on his team's next game), and generate
// status='draft' Tank pages. Never auto-publishes - a human still reviews and publishes
// via PUT /api/tank/pages/:id.
//
// THE v2 GATES (2026-09-07)
// v0.1 asked one open-ended "what's buzzing" question per sport and trusted the answer.
// The same reasoning pass that invented a trend also certified it. v2 makes the evidence
// explicit and checks it mechanically, in this order:
//
//   1. FABRICATION GATE (code, not model). The match call's response carries
//      web_search_tool_result blocks with the real urls/titles/page_age search returned.
//      harvestSearchSources() collects them and any match citing a source_url that never
//      appeared is dropped outright. This is the ONLY gate that can catch an invented
//      source - the verify call below cannot, because it only ever sees text the
//      generating pass authored.
//   2. RECENCY GATE (code). classifyRecency() buckets the storyline fresh/aging/stale
//      from the harvested page_age, preferring it over the model's self-reported date
//      (reconcileSourceTimestamp). Stale signals advance only when the sport produced
//      nothing fresher, and are flagged when they do.
//   3. VERIFY PASS (a separate Anthropic call). Sees ONLY {trend_claim, source_snippet,
//      angle, verified_stat} - no candidate list, no search results, no reasoning trace.
//      That isolation is the whole mechanism. It judges overreach (does the snippet
//      actually support the claim) and generic filler, and can hand back an angle_rewrite.
//
// Only matches clearing all three reach generation. A cleared verified_stat becomes the
// first non-empty `facts` array this pipeline has ever produced.
//
// WHY PER-SPORT AT ALL (predates v2, still true): a single shared match call let whichever
// sport had the loudest news cycle that day consume the whole budget and crowd out the
// others. Per-group calls give every sport its own honest shot - and its own right to
// return zero, which stays a valid outcome.
//
// The daily Exchange ticker TAG SWEEP deliberately does NOT live here: a Worker invocation
// has a hard subrequest budget and this run's traffic already sits close to it. The sweep
// runs as its own request - POST /api/ticker-sweep, fired by worker-curate right after.
//
// Kalshi (kalshi-live.ts) is DISABLED here (2026-08-25): merging its fetch into this
// request pushed the invocation over the subrequest ceiling in production. Re-enabling it
// needs its own sibling request, not a merge back into this one. The module itself
// (kalshi.ts, kalshi-live.ts, tank-providers.ts) is unaffected and still wired into the
// admin tool (backend.ts, PROP_PROVIDER=kalshi|both).
//
// (Historical note: this header used to describe a functions/api/curate-kalshi.ts reusing
// the exports below. That file was never written. curate-sport.ts is the sibling that
// actually exists, and it reuses runCuration() rather than curateSportGroup() directly.)

import type { PagesFunction } from '@cloudflare/workers-types';
import Anthropic from '@anthropic-ai/sdk';
import { getSql, jsonResponse, type Env } from '../../lib/pages-functions/db';
import { fetchLiveGames, DEFAULT_WINDOW_HOURS } from '../../tank-gamma-live';
import { filterProps, GAME_LINE_MARKETS } from '../../tank-filter';
import { generateTankArticle, extractJson, parseModelJson, type GenerationConfig } from '../../tank-generate';
import {
    TANK_CURATOR_MATCH_PROMPT,
    TANK_CURATOR_MATCH_PROMPT_VERSION,
} from '../../scripts/prompts/tank-curator-match-prompt';
import {
    TANK_CURATOR_VERIFY_PROMPT,
    TANK_CURATOR_VERIFY_SCHEMA,
} from '../../scripts/prompts/tank-curator-verify-prompt';
import { generateSlug, ensureUniqueSlug } from '../../scripts/utils/slug-generator';
import {
    classifyRecency,
    reconcileSourceTimestamp,
    partitionByRecency,
    harvestSearchSources,
    isHarvestedUrl,
    isCuratorMatchV2Response,
    isVerifyResponse,
    formatVerifiedStatFact,
    buildTimeContext,
    normalizeUrl,
    type CuratorMatchV2,
    type VerifyResponse,
    type HarvestedSearch,
    type RecencyWindow,
    type CurationRecord,
    type VerifiedStat,
} from '../../tank-curation';
import type { Prop, Game } from '../../tank-types';

export const DEFAULT_DEDUPE_DAYS = 7;
export const DEFAULT_MAX_CANDIDATES = 80;
// Lowered 6 -> 3 (2026-09-07, v2): each match now costs a verify call on top of its
// generation call, and generation can retry. Three per sport is still 12 drafts a day
// across four sports - comfortably more than gets published - and it is what keeps the
// worst-case Soccer run (5 leagues, busy news day) inside the 50-subrequest ceiling.
// Raise this only alongside the Workers Paid plan, which lifts that ceiling to 1,000.
export const DEFAULT_MAX_MATCHES_PER_RUN = 3;
// Raised 4 -> 8 (2026-09-07, v2): the prompt now mandates seven storyline categories, and
// four searches cannot cover them - the model would either ignore the instruction or hit
// max_uses_exceeded mid-run. Each search is $10/1,000 uses PLUS its result content counts
// as input tokens on every subsequent turn of the same call, so this remains the single
// biggest cost lever in the run. Tune via CURATE_WEB_SEARCH_MAX_USES.
export const DEFAULT_WEB_SEARCH_MAX_USES = 8;
export const DEFAULT_MATCH_MAX_TOKENS = 4000;
export const DEFAULT_VERIFY_MAX_TOKENS = 700;
// How many times to resume a match call that came back with stop_reason 'pause_turn'.
// The server-side search loop pauses after a bounded number of iterations and returns no
// final answer; without resuming, the last text block is prose rather than JSON, parsing
// fails, and the sport silently reports zero matches AFTER paying for every search it ran.
// Forcing seven categories makes hitting the pause routine rather than exotic.
export const DEFAULT_MAX_CONTINUATIONS = 3;
// Game lines only: moneyline, spreads, totals (2026-09-09). These are the exact market
// keys Polymarket produces for whole-game markets - see the `market` values on live
// tank_pages rows. Everything else is excluded, which in practice means:
//   - player props  ("<sport>_player_<stat>", e.g. baseball_player_home_runs)
//   - season_futures (award/season-long markets with no discrete game)
//
// WHY THIS IS A CODE DEFAULT AND NOT JUST AN ENV VAR: MARKET_WHITELIST is not set in
// either deployed Pages environment (verified 2026-09-09), so the previous empty default
// meant filterProps applied NO market filter at all in production - every player prop and
// season future was a live candidate. A whitelist that only exists in a local .dev.vars
// isn't a whitelist. Setting it here makes the restriction reviewable, version-controlled,
// and true wherever this runs; MARKET_WHITELIST still overrides it when set.
//
// Season futures were the worst of the excluded cases for this product: they resolve
// months out, so they sail past the MIN_LEAD_DAYS floor while giving a reader nothing to
// follow, and the Fishtank deck's "Resolves ..." header ends up describing a date well
// past the season.
export const DEFAULT_MARKET_WHITELIST: string[] = [...GAME_LINE_MARKETS];
export const DEFAULT_MIN_PROMINENCE = 0;
export const DEFAULT_PER_GAME_CAP = 3;
// Reader-facing minimum lead time (2026-08-23): a Tank published this morning should
// resolve at least 2 full days out. Measured against effectiveSettleDate
// (tank-deck-format.ts), the corrected editorial resolve date, not Polymarket's sometimes-
// padded raw settleDate.
//
// Knock-on worth knowing: because nothing survives with a kickoff inside 48h, the
// tightened 24h freshness threshold in classifyRecency() (which applies within 72h of
// kickoff) only ever fires in the 48-72h sliver. Lower this and that branch widens.
export const DEFAULT_MIN_LEAD_DAYS = 2;

// Rough subrequest ceiling for one Pages Function invocation on the Cloudflare Free plan.
// We stop STARTING new matches once the running estimate passes the reserve below, so a
// busy sport degrades to "fewer drafts" instead of dying mid-loop with some rows already
// written (observed live before the per-group try/catch existed).
const SUBREQUEST_CEILING = 50;
const SUBREQUEST_RESERVE = 12;

// Sport groups the curator gives an independent shot at, per Sammy's request to stop
// letting one sport's news cycle crowd out the others. Individual soccer leagues are
// grouped under one "Soccer" pass rather than run separately - the ask was sport-level
// coverage, not one guaranteed match per league.
// Champions League rides in the Soccer group rather than getting a pass of its own: the
// group is a sport-level coverage guarantee, and UCL only has fixtures on ~8 matchdays
// between September and January (see polymarket.ts's LEAGUE_TAGS), so a dedicated pass
// would sit empty most days while still costing a search. Inside the Soccer pass it
// simply competes with the domestic leagues on the days it has a slate - which, on a
// Champions League matchday, it should usually win.
export const SPORT_GROUPS: Record<string, string[]> = {
    Soccer: ['EPL', 'La Liga', 'Serie A', 'Bundesliga', 'Ligue 1', 'Champions League'],
    Basketball: ['NBA'],
    Baseball: ['MLB'],
    Football: ['NFL'],
};

// The union of every group's leagues, passed EXPLICITLY to fetchLiveGames rather than
// letting it default to polymarket.ts's SUPPORTED_LEAGUES. LEAGUE_TAGS also carries
// Discord-pick-menu-only competitions (EFL Championship, MLS, DFB-Pokal, Carabao Cup)
// this curator deliberately ignores. Note curate-sport.ts fetches only ONE group's
// leagues, which is most of why a per-sport request is cheaper rather than 4x costlier.
export const CURATE_LEAGUES = Object.values(SPORT_GROUPS).flat();

export function numEnv(value: string | undefined, fallback: number): number {
    if (!value) return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

export interface CandidateEntry {
    prop: Prop;
    game: Game;
    provider: 'polymarket' | 'kalshi';
}

// Per-run visibility into what each gate actually did. Rejected matches write no row, so
// without these counters a gate rejecting 90% of matches - or 0% - is completely
// invisible. This is the number to tune the prompts against.
export interface CurateCounters {
    proposed: number;
    rejected_unknown_candidate: number;
    rejected_bad_url: number;
    rejected_stale: number;
    rejected_unsupported: number;
    rejected_generic: number;
    // Kept SEPARATE from rejected_unsupported on purpose. A verify call that 400s or
    // returns an unparseable verdict is an infrastructure failure; a verifier that says
    // "this snippet doesn't support this claim" is a working editorial judgment. Folding
    // them together (as this did on the first live run, 2026-09-08) makes a malformed
    // request read as "the gate rejected 3 storylines" and sends you tuning prompts to
    // fix a schema bug. These counters are the only visibility into the gates, so they
    // have to distinguish "the gate said no" from "the gate never ran".
    verify_error: number;
    rejected_budget: number;
    angle_rewritten: number;
    stat_attached: number;
    stat_rejected: number;
    created: number;
}

export interface CurateGroupResult {
    sportGroup: string;
    candidatesConsidered: number;
    matchesFound: number;
    created: number;
    counters: CurateCounters;
    searchErrors: string[];
    continuations: number;
    staleFallback: boolean;
    results: Array<{ candidateId: string; status: string; slug?: string; detail?: string }>;
}

function emptyCounters(): CurateCounters {
    return {
        proposed: 0,
        rejected_unknown_candidate: 0,
        rejected_bad_url: 0,
        rejected_stale: 0,
        rejected_unsupported: 0,
        rejected_generic: 0,
        verify_error: 0,
        rejected_budget: 0,
        angle_rewritten: 0,
        stat_attached: 0,
        stat_rejected: 0,
        created: 0,
    };
}

export interface CurateRunConfig {
    windowHours: number;
    dedupeDays: number;
    maxCandidates: number;
    maxMatchesPerRun: number;
    webSearchMaxUses: number;
    matchMaxTokens: number;
    verifyMaxTokens: number;
    maxContinuations: number;
    marketWhitelist: string[];
    minProminence: number;
    perGameCap: number;
    minLeadDays: number;
    model: string;
    generationConfig: GenerationConfig;
}

export function loadCurateConfig(env: Env): CurateRunConfig {
    return {
        windowHours: numEnv(env.CURATE_WINDOW_HOURS, DEFAULT_WINDOW_HOURS),
        dedupeDays: numEnv(env.CURATE_DEDUPE_DAYS, DEFAULT_DEDUPE_DAYS),
        maxCandidates: numEnv(env.CURATE_MAX_CANDIDATES, DEFAULT_MAX_CANDIDATES),
        maxMatchesPerRun: numEnv(env.CURATE_MAX_MATCHES_PER_RUN, DEFAULT_MAX_MATCHES_PER_RUN),
        webSearchMaxUses: numEnv(env.CURATE_WEB_SEARCH_MAX_USES, DEFAULT_WEB_SEARCH_MAX_USES),
        matchMaxTokens: numEnv(env.CURATE_MATCH_MAX_TOKENS, DEFAULT_MATCH_MAX_TOKENS),
        verifyMaxTokens: numEnv(env.CURATE_VERIFY_MAX_TOKENS, DEFAULT_VERIFY_MAX_TOKENS),
        maxContinuations: numEnv(env.CURATE_MAX_CONTINUATIONS, DEFAULT_MAX_CONTINUATIONS),
        marketWhitelist: env.MARKET_WHITELIST
            ? env.MARKET_WHITELIST.split(',').map((s) => s.trim()).filter(Boolean)
            : DEFAULT_MARKET_WHITELIST,
        minProminence: numEnv(env.MIN_PROMINENCE, DEFAULT_MIN_PROMINENCE),
        perGameCap: numEnv(env.PER_GAME_CAP, DEFAULT_PER_GAME_CAP),
        minLeadDays: numEnv(env.MIN_LEAD_DAYS, DEFAULT_MIN_LEAD_DAYS),
        model: env.MODEL || 'claude-sonnet-5',
        generationConfig: {
            apiKey: env.ANTHROPIC_API_KEY,
            model: env.MODEL,
            // 1000 is not a fallback here, it is the OPERATIVE production value:
            // MAX_TOKENS is not set in either deployed Pages environment (verified
            // 2026-09-09), so every deployed generation runs on this number. Measured
            // and sufficient - 113/113 tank_pages rows generated with zero errors, and
            // the longest body on record is ~1,171 chars (~300 tokens) against the
            // narrative prompt's 120-180 word target. Raise it only if that target
            // changes; a bigger budget buys nothing the prompt asks for.
            maxTokens: numEnv(env.MAX_TOKENS, 1000),
        },
    };
}

// maxRetries: 1, not the SDK's default of 2. Each retry is another outbound fetch against
// a 50-subrequest budget, so the default quietly turns every Anthropic call into up to
// three. One retry still covers a transient 429/5xx.
export function buildAnthropicClient(env: Env): Anthropic {
    return new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 1 });
}

// Tracks the outbound fetches we're responsible for, so a group can stop starting work it
// can't finish. Approximate by design - Gamma's paging and Neon's driver spend some of the
// same budget - which is what SUBREQUEST_RESERVE covers.
export class SubrequestBudget {
    private spent: number;
    constructor(alreadySpent: number) { this.spent = alreadySpent; }
    charge(n: number): void { this.spent += n; }
    get used(): number { return this.spent; }
    canAfford(cost: number): boolean {
        return this.spent + cost <= SUBREQUEST_CEILING - SUBREQUEST_RESERVE;
    }
}

// ---------------------------------------------------------------------------------
// The match call
// ---------------------------------------------------------------------------------

interface MatchCallResult {
    matches: CuratorMatchV2[] | null;
    harvested: HarvestedSearch;
    continuations: number;
    subrequests: number;
    parseError: string | null;
}

// One match call, resuming through any 'pause_turn' stops.
//
// Resuming means re-sending the assistant content BYTE-IDENTICALLY (the search results
// carry encrypted_content the API validates), which is why response.content is pushed
// back unchanged rather than reconstructed. No "please continue" text is appended - the
// API resumes from the trailing server_tool_use on its own.
//
// Search results are harvested from EVERY round, not just the last: a source cited in the
// final answer may well have been returned two rounds earlier, and dropping it would fail
// a legitimate match at the url gate.
async function callMatchWithContinuations(
    client: Anthropic,
    sportGroup: string,
    candidatePayload: unknown,
    config: CurateRunConfig,
): Promise<MatchCallResult> {
    const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: JSON.stringify({ sport: sportGroup, now: new Date().toISOString(), candidates: candidatePayload }) },
    ];

    const request = {
        model: config.model,
        max_tokens: config.matchMaxTokens,
        thinking: { type: 'disabled' as const },
        // Cached: TANK_CURATOR_MATCH_PROMPT is byte-identical on every call - across all
        // sport groups and across days - because nothing per-request lives in it. The
        // cache prefix renders tools -> system -> messages, so the sport name and the
        // candidate list sit in `messages` on purpose; moving either up here would mint a
        // separate cache entry per sport and turn 1 write + 3 reads into 4 writes.
        system: [{ type: 'text' as const, text: TANK_CURATOR_MATCH_PROMPT, cache_control: { type: 'ephemeral' as const } }],
        // web_search_20260209 (not the older _20250305): it filters results dynamically
        // before they hit the context window, which is exactly the case a seven-category
        // search creates. Do NOT also declare code_execution - this tool provisions it,
        // and a second execution environment confuses the model.
        tools: [{ type: 'web_search_20260209' as const, name: 'web_search' as const, max_uses: config.webSearchMaxUses }],
    };

    let subrequests = 0;
    let continuations = 0;
    const allContent: unknown[] = [];

    let response = await client.messages.create({ ...request, messages });
    subrequests++;
    allContent.push(...response.content);

    while (response.stop_reason === 'pause_turn' && continuations < config.maxContinuations) {
        continuations++;
        messages.push({ role: 'assistant', content: response.content });
        response = await client.messages.create({ ...request, messages });
        subrequests++;
        allContent.push(...response.content);
    }

    const harvested = harvestSearchSources(allContent);
    if (harvested.errors.length > 0) {
        console.warn(`[curate] [${sportGroup}] web search returned errors: ${harvested.errors.join(', ')}`);
    }
    console.log(`[curate] [${sportGroup}] match usage:`, JSON.stringify(response.usage), `continuations=${continuations}`);

    if (response.stop_reason === 'pause_turn') {
        return {
            matches: null, harvested, continuations, subrequests,
            parseError: `Search loop still paused after ${continuations} continuations - no final answer.`,
        };
    }

    // Search tool-use responses interleave text and tool rounds; the answer is the LAST
    // text block of the final response, not necessarily the only one.
    const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
    const rawText = textBlocks.length ? textBlocks[textBlocks.length - 1].text : '';

    try {
        const parsed = parseModelJson(extractJson(rawText));
        if (!isCuratorMatchV2Response(parsed)) {
            throw new Error('Response did not match the expected { matches: [...] } v2 shape.');
        }
        return { matches: parsed.matches, harvested, continuations, subrequests, parseError: null };
    } catch (err: any) {
        console.error(`[curate] [${sportGroup}] Failed to parse curator match response:`, err.message, rawText.slice(0, 800));
        return { matches: null, harvested, continuations, subrequests, parseError: err.message };
    }
}

// ---------------------------------------------------------------------------------
// The verify call
// ---------------------------------------------------------------------------------

// Deliberately minimal payload - see tank-curator-verify-prompt.ts. Nothing about the
// sport, the matchup, the candidate list or how this match was chosen may be added here:
// the independence of this pass is the entire reason it exists, and a grader that can see
// what the pipeline wants can rationalize its way to approving it.
//
// Structured outputs (this call has no tools) means a schema-valid response by
// construction, so the extractJson/repairJsonControlChars failure class doesn't apply.
async function verifyMatch(
    client: Anthropic,
    match: CuratorMatchV2,
    config: CurateRunConfig,
): Promise<{ verdict: VerifyResponse | null; error: string | null }> {
    try {
        const response = await client.messages.create({
            model: config.model,
            max_tokens: config.verifyMaxTokens,
            thinking: { type: 'disabled' },
            system: [{ type: 'text', text: TANK_CURATOR_VERIFY_PROMPT, cache_control: { type: 'ephemeral' } }],
            output_config: { format: TANK_CURATOR_VERIFY_SCHEMA },
            messages: [{
                role: 'user',
                content: JSON.stringify({
                    trend_claim: match.trend_claim,
                    source_snippet: match.source_snippet,
                    angle: match.angle,
                    verified_stat: match.verified_stat ?? null,
                }),
            }],
        } as any);

        const textBlock = response.content.find((b: any) => b.type === 'text');
        const rawText = textBlock && 'text' in textBlock ? (textBlock as any).text : '';
        const parsed = parseVerify(rawText);
        return parsed ? { verdict: parsed, error: null } : { verdict: null, error: 'Verify response failed validation.' };
    } catch (err: any) {
        return { verdict: null, error: err.message };
    }
}

function parseVerify(rawText: string): VerifyResponse | null {
    try {
        const parsed = parseModelJson(extractJson(rawText));
        return isVerifyResponse(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------------
// Schema feature detection
// ---------------------------------------------------------------------------------

// The .sql migrations in this repo are hand-run and there is no runner, so this code can
// legitimately reach production before add_curation_and_resolution_to_tank_pages.sql has
// been applied. Without this check the INSERT would name a column that doesn't exist, the
// per-group try/catch would swallow it, and the result would be ZERO DRAFTS EVERY DAY,
// silently - the worst possible failure shape.
//
// Degrading here is fail-OPEN on purpose (unlike the resolution sweep, which fails
// closed): the v2 quality gates don't depend on the column, so we still curate properly
// and simply lose the metadata trail until the migration runs.
let curationColumnPresent: boolean | null = null;

async function hasCurationColumn(sql: ReturnType<typeof getSql>): Promise<boolean> {
    if (curationColumnPresent !== null) return curationColumnPresent;
    try {
        const rows = await sql`
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'tank_pages' AND column_name = 'curation'
            LIMIT 1
        `;
        curationColumnPresent = rows.length > 0;
    } catch {
        curationColumnPresent = false;
    }
    if (!curationColumnPresent) {
        console.warn(
            '[curate] tank_pages.curation is missing - curation metadata will NOT be stored for these drafts. '
            + 'Run: psql "$DATABASE_URL" -f add_curation_and_resolution_to_tank_pages.sql',
        );
    }
    return curationColumnPresent;
}

// ---------------------------------------------------------------------------------
// One sport group
// ---------------------------------------------------------------------------------

interface ScreenedMatch {
    match: CuratorMatchV2;
    candidate: CandidateEntry;
    recency: RecencyWindow;
    sourceTimestamp: string | null;
    timestampOrigin: 'page_age' | 'model' | 'none';
    sourceTitle: string | null;
}

// Runs one match-then-verify-then-generate pass against a single sport group's candidate
// list. Exported so curate-sport.ts's per-sport endpoint reuses this exact logic rather
// than duplicating it and risking drift.
export async function curateSportGroup(
    sportGroup: string,
    candidates: CandidateEntry[],
    env: Env,
    sql: ReturnType<typeof getSql>,
    existingSlugs: Set<string>,
    config: CurateRunConfig,
    budget: SubrequestBudget,
): Promise<CurateGroupResult> {
    const counters = emptyCounters();
    const results: CurateGroupResult['results'] = [];
    const now = new Date();

    const candidateById = new Map(candidates.map((c) => [c.prop.id, c]));
    const candidatePayload = candidates.map((c) => ({
        id: c.prop.id,
        player: c.prop.player,
        market: c.prop.market,
        line: c.prop.line,
        league: c.game.league,
        away: c.game.away,
        home: c.game.home,
        kickoff: c.game.kickoff,
    }));

    const client = buildAnthropicClient(env);
    const matchCall = await callMatchWithContinuations(client, sportGroup, candidatePayload, config);
    budget.charge(matchCall.subrequests);

    if (!matchCall.matches) {
        return {
            sportGroup,
            candidatesConsidered: candidates.length,
            matchesFound: 0,
            created: 0,
            counters,
            searchErrors: matchCall.harvested.errors,
            continuations: matchCall.continuations,
            staleFallback: false,
            results: [{ candidateId: '-', status: 'match_call_failed', detail: matchCall.parseError ?? undefined }],
        };
    }

    counters.proposed = matchCall.matches.length;

    // --- Gate 1 + 2: real source, then recency ---------------------------------------
    const screened: ScreenedMatch[] = [];
    for (const match of matchCall.matches) {
        const candidate = candidateById.get(match.candidateId);
        if (!candidate) {
            counters.rejected_unknown_candidate++;
            results.push({ candidateId: match.candidateId, status: 'rejected_unknown_candidate' });
            continue;
        }

        if (!isHarvestedUrl(match.source_url, matchCall.harvested)) {
            counters.rejected_bad_url++;
            results.push({
                candidateId: match.candidateId,
                status: 'rejected_bad_url',
                detail: `source_url was not among the pages search returned: ${match.source_url}`,
            });
            continue;
        }

        const harvestedSource = matchCall.harvested.byUrl.get(normalizeUrl(match.source_url)) ?? null;

        const { timestamp, origin } = reconcileSourceTimestamp(
            match.source_timestamp,
            harvestedSource?.pageAge ?? null,
            now,
        );

        screened.push({
            match,
            candidate,
            recency: classifyRecency(timestamp, candidate.game.kickoff, now),
            sourceTimestamp: timestamp,
            timestampOrigin: origin,
            sourceTitle: harvestedSource?.title ?? null,
        });
    }

    const { advance, heldBack } = partitionByRecency(
        screened.map((s) => ({ item: s, recency: s.recency })),
    );
    counters.rejected_stale = heldBack.length;
    for (const held of heldBack) {
        results.push({ candidateId: held.match.candidateId, status: 'rejected_stale', detail: `recency=${held.recency}` });
    }

    const staleFallback = advance.some((a) => a.staleFallback);
    if (staleFallback) {
        console.warn(`[curate] [${sportGroup}] no fresh or aging signal today - advancing ${advance.length} stale match(es), flagged.`);
    }

    // Freshest first before the cap bites. maxMatchesPerRun is 3, so this genuinely
    // decides what gets written: slicing the model's own ordering would keep whichever
    // matches it happened to list first, which carries no signal. A day with five real
    // storylines should spend its three slots on the three most current ones.
    const RECENCY_RANK: Record<RecencyWindow, number> = { fresh: 0, aging: 1, stale: 2, unknown: 3 };
    const selected = [...advance]
        .sort((a, b) => RECENCY_RANK[a.recency] - RECENCY_RANK[b.recency])
        .slice(0, config.maxMatchesPerRun);

    // --- Gate 3: verify, then generate -----------------------------------------------
    const pendingRows: Array<{
        slug: string | null; provider: string; league: string; angle: string;
        gameSnapshot: string; modelOutput: string | null; rawOutput: string | null;
        generationError: string | null; curation: string | null;
    }> = [];

    for (const entry of selected) {
        const { match, candidate } = entry.item;
        const { prop, game, provider } = candidate;

        // A verify call plus a generation call (which retries once internally), each
        // able to retry once at the SDK level. Stop starting new work rather than dying
        // mid-loop with rows half-written.
        if (!budget.canAfford(6)) {
            counters.rejected_budget++;
            results.push({ candidateId: match.candidateId, status: 'rejected_budget', detail: `subrequests used ~${budget.used}` });
            continue;
        }

        const { verdict, error: verifyError } = await verifyMatch(client, match, config);
        budget.charge(2);

        if (!verdict) {
            counters.verify_error++;
            console.error(`[curate] [${sportGroup}] verify call failed for ${match.candidateId}: ${verifyError}`);
            results.push({ candidateId: match.candidateId, status: 'verify_failed', detail: verifyError ?? undefined });
            continue;
        }

        if (!verdict.supports_claim) {
            counters.rejected_unsupported++;
            results.push({ candidateId: match.candidateId, status: 'rejected_unsupported', detail: verdict.supports_reason });
            continue;
        }

        // "Reject OR rewrite" - a rewrite is free in a call already made, and throwing
        // away a verified storyline over a lazily-worded line is a waste. Only when the
        // verifier had nothing specific to salvage does the match actually die.
        let angle = match.angle;
        let angleRewritten = false;
        if (verdict.generic_filler) {
            if (verdict.angle_rewrite && verdict.angle_rewrite.trim()) {
                angle = verdict.angle_rewrite.trim();
                angleRewritten = true;
                counters.angle_rewritten++;
            } else {
                counters.rejected_generic++;
                results.push({ candidateId: match.candidateId, status: 'rejected_generic', detail: verdict.filler_reason });
                continue;
            }
        }

        // The stat only survives if the independent pass confirmed its own source states
        // it. Anything less and facts stays empty, which is the documented default and
        // keeps the article number-free rather than plausibly-numbered.
        let verifiedStat: VerifiedStat | null = null;
        if (match.verified_stat) {
            if (verdict.stat_supported === true) {
                verifiedStat = match.verified_stat;
                counters.stat_attached++;
            } else {
                counters.stat_rejected++;
            }
        }

        const facts = verifiedStat ? [formatVerifiedStatFact(verifiedStat)] : [];
        const timeContext = buildTimeContext(
            game.kickoff, entry.item.sourceTimestamp, entry.item.recency, entry.staleFallback, now,
        );

        try {
            const genResult = await generateTankArticle(prop, angle, game, facts, config.generationConfig, timeContext);
            budget.charge(2);

            let slug: string | null = null;
            if (genResult.parsed) {
                const baseSlug = genResult.parsed.seo.slug
                    ? generateSlug(genResult.parsed.seo.slug)
                    : generateSlug(genResult.parsed.seo.title);
                slug = ensureUniqueSlug(baseSlug, existingSlugs);
                existingSlugs.add(slug);
            }

            const curation: CurationRecord = {
                category: match.category ?? 'unspecified',
                trend_claim: match.trend_claim,
                source_snippet: match.source_snippet,
                source_url: match.source_url,
                source_title: entry.item.sourceTitle,
                source_timestamp: entry.item.sourceTimestamp,
                source_timestamp_origin: entry.item.timestampOrigin,
                recency_window: entry.item.recency,
                stale_fallback: entry.staleFallback,
                supports_claim: verdict.supports_claim,
                supports_reason: verdict.supports_reason ?? '',
                generic_filler: verdict.generic_filler,
                filler_reason: verdict.filler_reason ?? '',
                angle_rewritten: angleRewritten,
                verified_stat: verifiedStat,
                stat_reason: verdict.stat_reason ?? null,
                prompt_version: TANK_CURATOR_MATCH_PROMPT_VERSION,
                curated_at: now.toISOString(),
            };

            pendingRows.push({
                slug,
                provider,
                league: game.league,
                angle,
                gameSnapshot: JSON.stringify({ prop, game }),
                modelOutput: genResult.parsed ? JSON.stringify(genResult.parsed) : null,
                rawOutput: genResult.parsed ? null : genResult.rawText,
                generationError: genResult.error,
                curation: JSON.stringify(curation),
            });

            counters.created++;
            results.push({
                candidateId: match.candidateId,
                status: genResult.parsed ? 'created' : 'created_with_generation_error',
                slug: slug ?? undefined,
            });
        } catch (err: any) {
            console.error(`[curate] [${sportGroup}] Generation failed for ${match.candidateId}:`, err);
            results.push({ candidateId: match.candidateId, status: 'error', detail: err.message });
        }
    }

    // One batched write instead of one INSERT per match. Neon's sql.transaction([...])
    // sends the whole array as a single HTTP request (same mechanism lib/pages-functions/
    // ledger.ts uses), which matters against the subrequest budget. Rows are built and
    // validated above, so a malformed one can't reach here and take the batch down.
    if (pendingRows.length > 0) {
        const withCuration = await hasCurationColumn(sql);
        try {
            await sql.transaction(
                pendingRows.map((row) => (withCuration
                    ? sql`
                        INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, raw_output, generation_error, status, curation)
                        VALUES (${row.slug}, ${row.provider}, ${row.league}, ${row.angle}, ${row.gameSnapshot},
                                ${row.modelOutput}, ${row.rawOutput}, ${row.generationError}, 'draft', ${row.curation})
                    `
                    : sql`
                        INSERT INTO tank_pages (slug, provider, league, angle, game_snapshot, model_output, raw_output, generation_error, status)
                        VALUES (${row.slug}, ${row.provider}, ${row.league}, ${row.angle}, ${row.gameSnapshot},
                                ${row.modelOutput}, ${row.rawOutput}, ${row.generationError}, 'draft')
                    `)),
            );
            budget.charge(1);
        } catch (err: any) {
            console.error(`[curate] [${sportGroup}] Batched insert failed:`, err);
            counters.created = 0;
            return {
                sportGroup,
                candidatesConsidered: candidates.length,
                matchesFound: matchCall.matches.length,
                created: 0,
                counters,
                searchErrors: matchCall.harvested.errors,
                continuations: matchCall.continuations,
                staleFallback,
                results: [...results, { candidateId: '-', status: 'insert_failed', detail: err.message }],
            };
        }
    }

    return {
        sportGroup,
        candidatesConsidered: candidates.length,
        matchesFound: matchCall.matches.length,
        created: counters.created,
        counters,
        searchErrors: matchCall.harvested.errors,
        continuations: matchCall.continuations,
        staleFallback,
        results,
    };
}

// ---------------------------------------------------------------------------------
// Shared run entry point
// ---------------------------------------------------------------------------------

export interface CurateRunResult {
    candidatesConsidered: number;
    matchesFound: number;
    created: number;
    groups: CurateGroupResult[];
    subrequestsUsed: number;
}

// Fetches candidates for the requested groups and curates each in turn. Both /api/curate
// (all groups) and /api/curate-sport (one) go through here, so the two can never drift.
export async function runCuration(env: Env, groupNames: string[]): Promise<CurateRunResult> {
    const config = loadCurateConfig(env);
    const sql = getSql(env);
    const budget = new SubrequestBudget(0);

    const leagues = groupNames.flatMap((name) => SPORT_GROUPS[name] ?? []);

    // Only this run's leagues, not all 8. This is what makes four per-sport requests
    // cheaper than one combined request rather than four times as expensive: Soccer
    // fetches 5 tags, everyone else fetches 1.
    const liveGames = await fetchLiveGames(leagues, config.windowHours);
    budget.charge(leagues.length * 2);

    const filtered = filterProps(liveGames, {
        marketWhitelist: config.marketWhitelist,
        minProminence: config.minProminence,
        perGameCap: config.perGameCap,
        minLeadDays: config.minLeadDays,
        now: new Date(),
    });

    let allCandidates: CandidateEntry[] = [];
    for (const game of filtered) {
        for (const prop of game.props) {
            allCandidates.push({ prop, game, provider: 'polymarket' });
        }
    }

    // Skip markets already surfaced as a Tank recently, so the same storyline doesn't get
    // re-matched (and re-cost a web search) day after day.
    const recentRows = await sql`
        SELECT DISTINCT game_snapshot->'prop'->>'id' AS market_id
        FROM tank_pages
        WHERE created_at > NOW() - (INTERVAL '1 day' * ${config.dedupeDays})
          AND game_snapshot->'prop'->>'id' IS NOT NULL
    `;
    budget.charge(1);
    const recentMarketIds = new Set(recentRows.map((r) => r.market_id as string));
    allCandidates = allCandidates.filter((c) => !recentMarketIds.has(c.prop.id));

    if (allCandidates.length === 0) {
        return { candidatesConsidered: 0, matchesFound: 0, created: 0, groups: [], subrequestsUsed: budget.used };
    }

    const slugRows = await sql`SELECT slug FROM tank_pages WHERE slug IS NOT NULL`;
    budget.charge(1);
    const existingSlugs = new Set(slugRows.map((r) => r.slug as string));

    const groupResults: CurateGroupResult[] = [];
    for (const sportGroup of groupNames) {
        const groupLeagues = SPORT_GROUPS[sportGroup] ?? [];
        const groupCandidates = allCandidates
            .filter((c) => groupLeagues.includes(c.game.league))
            .sort((a, b) => b.prop.prominence - a.prop.prominence)
            .slice(0, config.maxCandidates);

        if (groupCandidates.length === 0) {
            groupResults.push({
                sportGroup, candidatesConsidered: 0, matchesFound: 0, created: 0,
                counters: emptyCounters(), searchErrors: [], continuations: 0, staleFallback: false, results: [],
            });
            continue;
        }

        // Per-group try/catch: one group throwing (an Anthropic connection error, the
        // subrequest budget running out late in a run) must degrade to that group
        // reporting an error, not 500 the whole run and lose every other group's report -
        // observed live when the budget died mid-Football after Baseball had already
        // created drafts.
        try {
            groupResults.push(await curateSportGroup(sportGroup, groupCandidates, env, sql, existingSlugs, config, budget));
        } catch (err) {
            console.error(`[curate] [${sportGroup}] Group run failed:`, err);
            groupResults.push({
                sportGroup,
                candidatesConsidered: groupCandidates.length,
                matchesFound: 0,
                created: 0,
                counters: emptyCounters(),
                searchErrors: [],
                continuations: 0,
                staleFallback: false,
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
        { candidatesConsidered: 0, matchesFound: 0, created: 0 },
    );

    return { ...totals, groups: groupResults, subrequestsUsed: budget.used };
}

export const onRequestPost: PagesFunction<Env> = async (context) => {
    const secret = context.request.headers.get('X-Curate-Secret');
    if (!secret || secret !== context.env.CURATE_SECRET) {
        return jsonResponse({ message: 'Unauthorized' }, { status: 401 });
    }
    const result = await runCuration(context.env, Object.keys(SPORT_GROUPS));
    return jsonResponse(result);
};
