// ===================================================================================
// HEATCHECKS TANK — CURATION v2 GATES (tank-curation.ts)
// ===================================================================================
// Every deterministic check the v2 curator applies, as pure functions with no I/O.
// Same posture as tank-filter.ts and tank-deck-format.ts (no pg, no Anthropic SDK, no
// fs) so this is importable from functions/api/ (Cloudflare Workers), backend.ts and
// scripts/ (Node), and scripts/acceptance/ (tests with hand-built fixtures).
//
// WHY THESE LIVE IN CODE RATHER THAN IN THE PROMPT
// The v1 curator asked the model not to fabricate and trusted the answer. v2's premise
// is that the checks a storyline has to pass must not be graded by the same pass that
// produced it - so each function here is a gate the model cannot talk its way through:
//
//   1. harvestSearchSources() + isHarvestedUrl() - the FABRICATION gate. Search result
//      blocks carry real urls/titles/page_age straight from Anthropic's index; a match
//      naming a source_url that never appeared in them is rejected outright, with no
//      model judgment involved. This is the only gate that can catch an invented source,
//      which is why the separate verify call is NOT the fabrication check (it only ever
//      sees text the generating pass authored - it can confirm an invented snippet
//      supports an invented claim perfectly well).
//   2. classifyRecency() - the RECENCY gate. Deterministic given a timestamp, and the
//      timestamp itself is preferentially taken from the harvested page_age rather than
//      from what the model says the date was.
//   3. partitionByRecency() - the "stale only as a last resort, and flagged" rule.
//
// The verify call still matters, but for what it can actually judge: does the snippet
// support the claim (overreach), and is the angle generic filler.
// ===================================================================================

// ---------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------

// 'unknown' is not in the original spec's three-way split, but a self-reported date that
// won't parse, or a search result with no page_age at all, is a real and common case. It
// is deliberately treated exactly like 'stale' everywhere downstream (see
// partitionByRecency) rather than being quietly rounded down to 'fresh' - an unknown
// date is precisely the situation where present-tense urgency would be unearned.
export type RecencyWindow = 'fresh' | 'aging' | 'stale' | 'unknown';

export interface VerifiedStat {
    // The stat as it should read in prose, e.g. "Haaland has scored in 5 straight against Brighton".
    value: string;
    source_url: string;
}

export interface CuratorMatchV2 {
    candidateId: string;
    // Which of the 7 forced search categories this came from - kept for the per-run
    // counters, so a category that never produces a match is visible rather than
    // silently unproductive.
    category: string;
    trend_claim: string;
    source_snippet: string;
    source_url: string;
    // What the MODEL says the underlying news is dated to. Cross-checked against the
    // harvested page_age rather than trusted - see reconcileSourceTimestamp.
    source_timestamp?: string | null;
    angle: string;
    verified_stat?: VerifiedStat | null;
}

export interface CuratorMatchV2Response {
    matches: CuratorMatchV2[];
}

export interface VerifyResponse {
    supports_claim: boolean;
    supports_reason: string;
    generic_filler: boolean;
    filler_reason: string;
    // Whether every FACTUAL statement in the angle (an event, a status, a record, a
    // rivalry history, a number) is supported by the snippet. Added 2026-09-10 after a
    // live angle carried "ended the Chiefs' nine-year division reign" - in neither the
    // snippet nor the claim - straight into an article's hook and body. The claim was
    // checked; the angle's facts never were, and the writer treats the angle as given.
    angle_facts_supported: boolean;
    angle_facts_reason?: string;
    // Present when the verifier could salvage an angle that failed either the facts check
    // or the filler check. The spec says "reject OR rewrite" - a rewrite costs nothing in
    // a call already being made, and throwing away a real storyline over one unsupported
    // clause or one lazy line is a waste.
    angle_rewrite?: string | null;
    // null when the match carried no verified_stat to check.
    stat_supported?: boolean | null;
    stat_reason?: string | null;
}

// One harvested web_search_result, reduced to the fields that are model-independent.
export interface HarvestedSource {
    url: string;
    title: string | null;
    // Raw page_age string exactly as returned (free-form: "April 30, 2025", "2 days ago",
    // sometimes absent). Parsed by parsePageAge, never trusted to be ISO.
    pageAge: string | null;
}

export interface HarvestedSearch {
    // Normalized urls, for membership testing.
    urls: Set<string>;
    byUrl: Map<string, HarvestedSource>;
    // Error codes from any web_search_tool_result whose content came back as an error
    // object rather than a result list (e.g. 'max_uses_exceeded'). Surfaced so the run
    // can log that its search budget ran out instead of silently reporting no matches.
    errors: string[];
}

export interface CurationRecord {
    category: string;
    trend_claim: string;
    source_snippet: string;
    source_url: string;
    source_title: string | null;
    source_timestamp: string | null;
    source_timestamp_origin: 'page_age' | 'model' | 'none';
    recency_window: RecencyWindow;
    // True when this match only advanced because its sport had nothing fresher. The
    // narrative stage reads this to write an honest "a week later" anchor instead of
    // borrowed present-tense urgency.
    stale_fallback: boolean;
    supports_claim: boolean;
    supports_reason: string;
    generic_filler: boolean;
    filler_reason: string;
    angle_facts_supported: boolean;
    angle_facts_reason: string;
    angle_rewritten: boolean;
    // The curator's angle as proposed, kept whenever the verifier rewrote it, so a
    // reviewer can see exactly what was removed or reworded - the rewrite is accepted
    // without a second verify call, so this is where it gets checked.
    original_angle: string | null;
    verified_stat: VerifiedStat | null;
    stat_reason: string | null;
    prompt_version: string;
    verify_prompt_version: string;
    // Market movement (market-movement.ts): the MarketContext handed to the writer, or
    // why there wasn't one. Typed loosely here on purpose - the shape lives in
    // market-movement.ts - so this module keeps importing nothing. Optional: absent on
    // rows curated before 2026-09-10.
    market_movement?: { context: object } | { unavailable: string };
    // The after-generation code check on the written prose (checkMovementProse). A flag
    // for the human reviewer, not a gate.
    movement_check?: { ok: boolean; problems: string[] };
    // Which narrative prompt wrote the article. Without it, drafts written under
    // different writer rules can't be told apart when reviewing or tuning.
    narrative_prompt_version?: string;
    curated_at: string;
}

// ---------------------------------------------------------------------------------
// Recency
// ---------------------------------------------------------------------------------

export const FRESH_MS = 48 * 60 * 60 * 1000;
// The tightened threshold, applied when the game is imminent - a news cycle moves faster
// the closer kickoff gets, so a two-day-old story is no longer "current" by then.
export const FRESH_MS_NEAR_KICKOFF = 24 * 60 * 60 * 1000;
export const AGING_MS = 7 * 24 * 60 * 60 * 1000;
// "Inside game week" per the spec, resolved to a concrete number: the tighter freshness
// rule applies when kickoff is within 72h.
//
// WORTH KNOWING: DEFAULT_MIN_LEAD_DAYS = 2 in curate.ts means nothing reaches this
// function with a kickoff inside 48h, so the tightened branch only ever fires in the
// 48-72h sliver. That is narrower than "inside game week" sounds, and it is asserted in
// the acceptance suite so the narrowness stays visible rather than being rediscovered.
export const NEAR_KICKOFF_MS = 72 * 60 * 60 * 1000;

function parseMs(iso: string | null | undefined): number | null {
    if (!iso || typeof iso !== 'string' || !iso.trim()) return null;
    const ms = new Date(iso).getTime();
    return Number.isNaN(ms) ? null : ms;
}

// How old the underlying news is, relative to `now`, bucketed. `kickoff` only selects
// which freshness threshold applies; it never makes a signal older or newer.
//
// A timestamp in the FUTURE returns 'unknown', not 'fresh': news that hasn't happened
// yet is a parsing or fabrication artifact, and treating it as maximally fresh would
// reward exactly the failure mode this gate exists to catch.
export function classifyRecency(
    sourceTimestamp: string | null | undefined,
    kickoff: string | null | undefined,
    now: Date = new Date(),
): RecencyWindow {
    const sourceMs = parseMs(sourceTimestamp);
    if (sourceMs === null) return 'unknown';

    const nowMs = now.getTime();
    const age = nowMs - sourceMs;
    // Allow a little clock skew (search indexes and our clock disagree by minutes, not
    // hours) before calling a timestamp future-dated.
    if (age < -5 * 60 * 1000) return 'unknown';

    const kickoffMs = parseMs(kickoff);
    const nearKickoff = kickoffMs !== null && kickoffMs - nowMs <= NEAR_KICKOFF_MS;
    const freshCutoff = nearKickoff ? FRESH_MS_NEAR_KICKOFF : FRESH_MS;

    if (age <= freshCutoff) return 'fresh';
    // The spec writes the aging band as "48h-7d"; when the fresh cutoff tightens to 24h
    // the band simply starts earlier, rather than leaving 24-48h in a gap with no bucket.
    if (age <= AGING_MS) return 'aging';
    return 'stale';
}

// page_age is free-form, not ISO - Anthropic returns whatever the page advertised
// ("April 30, 2025", "2 days ago", sometimes nothing). It is also COARSE: "2 days ago"
// means anywhere from 48h to just under 72h, and "April 30, 2025" means anywhere in that
// day. So it parses to a RANGE, not an instant.
//
// Returns null rather than guessing when the text won't parse: null flows to 'unknown',
// which is handled like 'stale', so a parse failure is always the conservative outcome.
export function parsePageAgeRange(
    pageAge: string | null | undefined,
    now: Date = new Date(),
): { oldest: string; newest: string } | null {
    if (!pageAge || typeof pageAge !== 'string') return null;
    const text = pageAge.trim();
    if (!text) return null;

    // "3 days ago", "about 2 hours ago", "1 month ago". A relative age of N units covers
    // [N, N+1) units - "2 days ago" is anything from 48h up to, not including, 72h.
    const relative = text.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
    if (relative) {
        const n = Number(relative[1]);
        const unitMs: Record<string, number> = {
            minute: 60_000,
            hour: 3_600_000,
            day: 86_400_000,
            week: 604_800_000,
            month: 2_592_000_000,  // 30d, close enough for a bucket boundary at 7d
            year: 31_536_000_000,
        };
        const ms = unitMs[relative[2].toLowerCase()];
        if (!ms || !Number.isFinite(n)) return null;
        const nowMs = now.getTime();
        return {
            newest: new Date(nowMs - n * ms).toISOString(),
            oldest: new Date(nowMs - (n + 1) * ms + 1).toISOString(),
        };
    }

    const parsed = new Date(text).getTime();
    if (Number.isNaN(parsed)) return null;
    // A bare date ("April 30, 2025", "2026-09-08") names a whole day; anything carrying a
    // time of day is taken as the instant it states.
    const hasTimeOfDay = /\d:\d/.test(text) || /T\d/.test(text);
    return {
        oldest: new Date(parsed).toISOString(),
        newest: new Date(hasTimeOfDay ? parsed : parsed + 86_400_000 - 1).toISOString(),
    };
}

// The conservative single reading of a page_age: the OLDEST instant it could mean.
//
// This used to return the NEWEST instant - "2 days ago" became exactly now-48h, which
// sits on classifyRecency's inclusive fresh boundary, so every "2 days ago" source was
// classified fresh even though almost all of that range is older than 48h. Caught on a
// live draft (2026-09-10) whose source timestamp sat exactly 48h before the run started,
// to the millisecond. The oldest end is the reading that can only ever cost a match,
// never buy a false 'fresh' - the same rule reconcileSourceTimestamp applies.
export function parsePageAge(pageAge: string | null | undefined, now: Date = new Date()): string | null {
    return parsePageAgeRange(pageAge, now)?.oldest ?? null;
}

// The model's self-reported date and the harvested page_age each fail differently: the
// model's can be wishful, and page_age describes - coarsely - when the PAGE was
// published, which is not always when the EVENT happened (a page published today can
// recap a trade from three weeks ago).
//
// Resolution order:
//   1. both, model's date INSIDE the page's range -> the model's date, origin 'page_age'.
//      The page independently brackets it, and the model's reading is the more precise
//      one. This matters beyond classification: the timestamp becomes hours_since_trend
//      for the writer's time anchor, and snapping a "2 days ago" story to its 72h edge
//      would have an article say "three days" about something two days old.
//   2. both, model OUTSIDE the range -> the older of the model's date and the range's
//      oldest end, origin 'page_age'. Disagreement means one of them is wrong and we
//      can't tell which, so take the reading that can only cost us a match.
//   3. page_age alone -> the range's oldest end, origin 'page_age'
//   4. model only     -> the model's date, origin 'model'
//   5. neither        -> null, origin 'none' (-> 'unknown' -> treated stale)
export function reconcileSourceTimestamp(
    modelTimestamp: string | null | undefined,
    harvestedPageAge: string | null | undefined,
    now: Date = new Date(),
): { timestamp: string | null; origin: 'page_age' | 'model' | 'none' } {
    const range = parsePageAgeRange(harvestedPageAge, now);
    const modelMs = parseMs(modelTimestamp);

    if (range && modelMs !== null) {
        const oldestMs = new Date(range.oldest).getTime();
        const newestMs = new Date(range.newest).getTime();
        if (modelMs >= oldestMs && modelMs <= newestMs) {
            return { timestamp: new Date(modelMs).toISOString(), origin: 'page_age' };
        }
        return { timestamp: new Date(Math.min(modelMs, oldestMs)).toISOString(), origin: 'page_age' };
    }
    if (range) return { timestamp: range.oldest, origin: 'page_age' };
    if (modelMs !== null) return { timestamp: new Date(modelMs).toISOString(), origin: 'model' };
    return { timestamp: null, origin: 'none' };
}

// "Stale signals don't advance unless there is nothing fresher for this sport today, and
// when they do they're flagged." Applied per sport group, which is the unit the spec
// scopes it to. 'unknown' rides with 'stale' - see the RecencyWindow comment.
export function partitionByRecency<T>(
    items: Array<{ item: T; recency: RecencyWindow }>,
): { advance: Array<{ item: T; recency: RecencyWindow; staleFallback: boolean }>; heldBack: T[] } {
    const usable = items.filter((m) => m.recency === 'fresh' || m.recency === 'aging');
    const stale = items.filter((m) => m.recency === 'stale' || m.recency === 'unknown');

    if (usable.length > 0) {
        return {
            advance: usable.map((m) => ({ item: m.item, recency: m.recency, staleFallback: false })),
            heldBack: stale.map((m) => m.item),
        };
    }
    return {
        advance: stale.map((m) => ({ item: m.item, recency: m.recency, staleFallback: true })),
        heldBack: [],
    };
}

// ---------------------------------------------------------------------------------
// Search-source harvesting (the fabrication gate)
// ---------------------------------------------------------------------------------

// Compare urls by shape, not byte-for-byte: the model echoes back a url it read, and a
// trailing slash or a dropped "www." shouldn't fail a legitimate match. Deliberately
// does NOT strip query strings - for a lot of news sites the query IS the article.
export function normalizeUrl(url: string): string {
    if (typeof url !== 'string') return '';
    let text = url.trim();
    if (!text) return '';
    try {
        const parsed = new URL(text);
        const host = parsed.host.toLowerCase().replace(/^www\./, '');
        const path = parsed.pathname.replace(/\/+$/, '');
        return `${host}${path}${parsed.search}`.toLowerCase();
    } catch {
        // Not a parseable absolute url - fall back to a loose normalization so a
        // fabricated bare string still compares unequal to real harvested urls.
        return text.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '');
    }
}

// Walks a message's content blocks and pulls out every url search actually returned.
// This is what isHarvestedUrl() tests against, which makes it the fabrication gate.
//
// THE SHAPE TRAP: a web_search_tool_result's `content` is a LIST on success and an
// OBJECT on error ({ type: 'web_search_tool_result_error', error_code: '...' }), and the
// HTTP status is 200 either way - server tool errors don't raise. Code that maps over
// `.content` unconditionally throws the moment a search budget is exhausted, which is
// exactly the scenario raising max_uses makes likely. Hence the Array.isArray branch.
export function harvestSearchSources(content: unknown): HarvestedSearch {
    const urls = new Set<string>();
    const byUrl = new Map<string, HarvestedSource>();
    const errors: string[] = [];

    if (!Array.isArray(content)) return { urls, byUrl, errors };

    for (const block of content as any[]) {
        if (!block || typeof block !== 'object') continue;

        if (block.type === 'web_search_tool_result') {
            const inner = block.content;
            if (Array.isArray(inner)) {
                for (const result of inner) {
                    if (!result || typeof result !== 'object') continue;
                    if (result.type !== 'web_search_result' || typeof result.url !== 'string') continue;
                    const key = normalizeUrl(result.url);
                    if (!key) continue;
                    urls.add(key);
                    if (!byUrl.has(key)) {
                        byUrl.set(key, {
                            url: result.url,
                            title: typeof result.title === 'string' ? result.title : null,
                            pageAge: typeof result.page_age === 'string' ? result.page_age : null,
                        });
                    }
                }
            } else if (inner && typeof inner === 'object') {
                errors.push(typeof inner.error_code === 'string' ? inner.error_code : 'unknown_search_error');
            }
            continue;
        }

        // Citation urls count as harvested too - a page Claude quoted is a page search
        // actually returned. In practice this branch rarely fires: web-search citations
        // attach only to PROSE the model authors, and TANK_CURATOR_MATCH_PROMPT demands
        // JSON and nothing else, so the match call produces no cited text blocks. Kept
        // anyway - it costs nothing, it is correct if a future prompt ever emits prose,
        // and widening the harvested set can only ever admit a real page, never a
        // fabricated one.
        if (block.type === 'text' && Array.isArray(block.citations)) {
            for (const citation of block.citations) {
                if (!citation || typeof citation !== 'object') continue;
                if (typeof citation.url === 'string') {
                    const key = normalizeUrl(citation.url);
                    if (key && !byUrl.has(key)) {
                        urls.add(key);
                        byUrl.set(key, {
                            url: citation.url,
                            title: typeof citation.title === 'string' ? citation.title : null,
                            pageAge: null,
                        });
                    }
                }
            }
        }
    }

    return { urls, byUrl, errors };
}

export function isHarvestedUrl(url: string, harvested: HarvestedSearch): boolean {
    const key = normalizeUrl(url);
    return key !== '' && harvested.urls.has(key);
}

// REMOVED 2026-09-09: snippetMatchesCitation() / snippet_corroborated.
//
// It cross-checked a match's source_snippet against cited_text from the response's
// citations, as an advisory "did the model quote something real" signal. It reported
// false on 100% of live rows and was therefore pure noise - the admin UI showed a
// "snippet not in citations" warning on every article.
//
// The cause was not a bug in the check. Web-search citations attach only to PROSE the
// model authors, and TANK_CURATOR_MATCH_PROMPT requires JSON and nothing else (it says
// so in three places), so no cited text blocks are ever produced and the function
// returned false at its empty-input guard every time. Unlike web_fetch, the web_search
// tool exposes no citations option, so there was nothing to switch on.
//
// If snippet-level corroboration is ever wanted, the only reliable route is a
// web_fetch_20260209 tool with citations: { enabled: true } over the harvested urls -
// web fetch does have that knob. Until then isHarvestedUrl() remains the fabrication
// gate: it proves the cited page is one search really returned, which is the property
// that actually matters.

// ---------------------------------------------------------------------------------
// Response validation
// ---------------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
}

// Note an empty `matches` array is VALID - "zero matches is a correct outcome for a sport
// today" is a rule of the curator, not an error. A missing or non-array `matches` is not.
export function isCuratorMatchV2Response(value: any): value is CuratorMatchV2Response {
    if (!value || typeof value !== 'object' || !Array.isArray(value.matches)) return false;
    return value.matches.every((m: any) =>
        m && typeof m === 'object'
        && isNonEmptyString(m.candidateId)
        && isNonEmptyString(m.trend_claim)
        && isNonEmptyString(m.source_snippet)
        && isNonEmptyString(m.source_url)
        && isNonEmptyString(m.angle)
        && (m.category === undefined || typeof m.category === 'string')
        && (m.source_timestamp === undefined || m.source_timestamp === null || typeof m.source_timestamp === 'string')
        && (m.verified_stat === undefined || m.verified_stat === null || (
            typeof m.verified_stat === 'object'
            && isNonEmptyString(m.verified_stat.value)
            && isNonEmptyString(m.verified_stat.source_url)
        )),
    );
}

// Booleans must be actual booleans - a model that answers the string "true" has not been
// held to the schema, and coercing it here would quietly turn a formatting failure into
// a publish decision.
export function isVerifyResponse(value: any): value is VerifyResponse {
    if (!value || typeof value !== 'object') return false;
    if (typeof value.supports_claim !== 'boolean') return false;
    if (typeof value.generic_filler !== 'boolean') return false;
    if (typeof value.angle_facts_supported !== 'boolean') return false;
    if (value.angle_facts_reason !== undefined && typeof value.angle_facts_reason !== 'string') return false;
    if (value.supports_reason !== undefined && typeof value.supports_reason !== 'string') return false;
    if (value.filler_reason !== undefined && typeof value.filler_reason !== 'string') return false;
    if (value.angle_rewrite !== undefined && value.angle_rewrite !== null && typeof value.angle_rewrite !== 'string') return false;
    if (value.stat_supported !== undefined && value.stat_supported !== null && typeof value.stat_supported !== 'boolean') return false;
    if (value.stat_reason !== undefined && value.stat_reason !== null && typeof value.stat_reason !== 'string') return false;
    return true;
}

// ---------------------------------------------------------------------------------
// Handoff to the narrative stage
// ---------------------------------------------------------------------------------

// The single entry of the `facts` array generateTankArticle() receives. That parameter
// has existed since the pipeline was written and been passed [] by every caller, which
// is why every Tank article to date contains no numbers at all: the narrative prompt's
// rule is "you may use a number ONLY if it appears in facts". This is the first thing
// that ever puts one there, so it only ever carries a stat that cleared BOTH the
// harvested-url check and the independent verifier.
export function formatVerifiedStatFact(stat: VerifiedStat): string {
    return `${stat.value.trim()} (source: ${stat.source_url.trim()})`;
}

export interface TimeContext {
    hours_to_kickoff: number;
    kickoff_label: string;
    source_timestamp: string | null;
    hours_since_trend: number | null;
    recency_window: RecencyWindow;
    stale_fallback: boolean;
}

// The narrative stage has no clock of its own - its payload is {prop, angle,
// game_context, facts} and contains no "now". Requiring a time anchor without supplying
// computed numbers would be instructing the model to invent one, so this is what makes
// the Stage 2 anchor rule safe to enforce.
export function buildTimeContext(
    kickoff: string,
    sourceTimestamp: string | null,
    recency: RecencyWindow,
    staleFallback: boolean,
    now: Date = new Date(),
): TimeContext {
    const kickoffMs = parseMs(kickoff);
    const sourceMs = parseMs(sourceTimestamp);
    const nowMs = now.getTime();
    return {
        hours_to_kickoff: kickoffMs === null ? -1 : Math.round((kickoffMs - nowMs) / 3_600_000),
        kickoff_label: kickoffMs === null ? 'unknown' : new Date(kickoffMs).toISOString(),
        source_timestamp: sourceTimestamp,
        hours_since_trend: sourceMs === null ? null : Math.round((nowMs - sourceMs) / 3_600_000),
        recency_window: recency,
        stale_fallback: staleFallback,
    };
}
