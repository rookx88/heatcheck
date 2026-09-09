// Acceptance suite for the v2 curation gates (tank-curation.ts) and the model-response
// parsers in tank-generate.ts.
//
// No DB, no HTTP, no API key - every assertion here is a pure function against a
// hand-built fixture, which makes this the cheapest suite in the repo and the right one
// to run first when anything about curation misbehaves. It is also the FIRST test of any
// curate-path code: before v2 nothing covered the match-response shape, the parsers, or
// any of the gates.
//
// The negative cases matter more than the positive ones here. Every gate exists to reject
// something, and a gate that silently stops rejecting is invisible in production - drafts
// keep appearing, they're just no longer checked.

import { check, section, type Suite } from '../harness';
import {
    classifyRecency,
    parsePageAge,
    reconcileSourceTimestamp,
    partitionByRecency,
    harvestSearchSources,
    isHarvestedUrl,
    isCuratorMatchV2Response,
    isVerifyResponse,
    normalizeUrl,
    buildTimeContext,
    formatVerifiedStatFact,
} from '../../../tank-curation';
import { extractJson, parseModelJson } from '../../../tank-generate';
import { filterProps, GAME_LINE_MARKETS } from '../../../tank-filter';
import { effectiveSettleDate } from '../../../tank-deck-format';

const NOW = new Date('2026-09-07T12:00:00.000Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString();
const ahead = (ms: number) => new Date(NOW.getTime() + ms).toISOString();

async function run() {
    // -----------------------------------------------------------------------------
    section('classifyRecency - the recency gate boundaries');

    const farKickoff = ahead(5 * DAY);
    check('47h old with a distant kickoff is fresh', classifyRecency(ago(47 * HOUR), farKickoff, NOW) === 'fresh');
    check('49h old with a distant kickoff is aging', classifyRecency(ago(49 * HOUR), farKickoff, NOW) === 'aging');
    check('exactly 48h is fresh (inclusive boundary, and stable across refactors)',
        classifyRecency(ago(48 * HOUR), farKickoff, NOW) === 'fresh');

    // The tightened threshold. Note this band is narrow in practice - see the
    // MIN_LEAD_DAYS assertion at the end of this suite for why.
    const nearKickoff = ahead(71 * HOUR);
    check('kickoff 71h out: 23h old is fresh', classifyRecency(ago(23 * HOUR), nearKickoff, NOW) === 'fresh');
    check('kickoff 71h out: 25h old is aging (24h rule applied)',
        classifyRecency(ago(25 * HOUR), nearKickoff, NOW) === 'aging');
    check('kickoff 73h out: 25h old is still fresh (48h rule, threshold not tightened)',
        classifyRecency(ago(25 * HOUR), ahead(73 * HOUR), NOW) === 'fresh');

    check('6 days old is aging', classifyRecency(ago(6 * DAY), farKickoff, NOW) === 'aging');
    check('8 days old is stale', classifyRecency(ago(8 * DAY), farKickoff, NOW) === 'stale');
    check('exactly 7 days is aging, not stale', classifyRecency(ago(7 * DAY), farKickoff, NOW) === 'aging');

    // The conservative-failure contract: anything unreadable must never be treated as
    // current. A model that wants a match has every incentive to produce these.
    check('null timestamp is unknown, never fresh', classifyRecency(null, farKickoff, NOW) === 'unknown');
    check('empty string is unknown', classifyRecency('', farKickoff, NOW) === 'unknown');
    check('unparseable string is unknown', classifyRecency('sometime last week', farKickoff, NOW) === 'unknown');
    check('a FUTURE timestamp is unknown, not fresh',
        classifyRecency(ahead(3 * DAY), farKickoff, NOW) === 'unknown');
    check('small clock skew (2 min ahead) still counts as fresh, not unknown',
        classifyRecency(ahead(2 * 60_000), farKickoff, NOW) === 'fresh');
    check('a missing kickoff falls back to the 48h threshold rather than throwing',
        classifyRecency(ago(30 * HOUR), null, NOW) === 'fresh');

    // -----------------------------------------------------------------------------
    section('parsePageAge - free-form page_age, never assumed to be ISO');

    check('parses an absolute date', parsePageAge('April 30, 2025', NOW)?.startsWith('2025-04-30') === true);
    check('parses "3 days ago" relative to now',
        parsePageAge('3 days ago', NOW) === new Date(NOW.getTime() - 3 * DAY).toISOString());
    check('parses "about 2 hours ago"',
        parsePageAge('about 2 hours ago', NOW) === new Date(NOW.getTime() - 2 * HOUR).toISOString());
    check('unparseable page_age returns null (-> unknown -> treated stale)',
        parsePageAge('recently', NOW) === null);
    check('null/empty page_age returns null', parsePageAge(null, NOW) === null && parsePageAge('   ', NOW) === null);

    // -----------------------------------------------------------------------------
    section('reconcileSourceTimestamp - page_age beats the model, disagreement takes the older');

    const r1 = reconcileSourceTimestamp(ago(2 * HOUR), '3 days ago', NOW);
    check('when both exist and disagree by >48h, the OLDER wins (cannot buy a false fresh)',
        r1.origin === 'page_age' && new Date(r1.timestamp!).getTime() === NOW.getTime() - 3 * DAY,
        JSON.stringify(r1));

    const r2 = reconcileSourceTimestamp(ago(26 * HOUR), '1 day ago', NOW);
    check('when both agree within 48h, page_age is used', r2.origin === 'page_age');

    const r3 = reconcileSourceTimestamp(ago(5 * HOUR), null, NOW);
    check('model-only timestamp is used but flagged as origin "model"',
        r3.origin === 'model' && r3.timestamp !== null);

    const r4 = reconcileSourceTimestamp(null, null, NOW);
    check('neither available -> null timestamp, origin "none"', r4.origin === 'none' && r4.timestamp === null);

    const r5 = reconcileSourceTimestamp('not a date', 'also not a date', NOW);
    check('two unparseable inputs degrade to none rather than throwing', r5.origin === 'none' && r5.timestamp === null);

    // -----------------------------------------------------------------------------
    section('partitionByRecency - stale advances only as a last resort, and is flagged');

    const mixed = partitionByRecency([
        { item: 'a', recency: 'fresh' as const },
        { item: 'b', recency: 'stale' as const },
        { item: 'c', recency: 'aging' as const },
    ]);
    check('mixed: only fresh+aging advance', mixed.advance.map((a) => a.item).join(',') === 'a,c');
    check('mixed: stale is held back', mixed.heldBack.join(',') === 'b');
    check('mixed: advanced items are NOT flagged as stale fallback',
        mixed.advance.every((a) => a.staleFallback === false));

    const allStale = partitionByRecency([
        { item: 'x', recency: 'stale' as const },
        { item: 'y', recency: 'unknown' as const },
    ]);
    check('all stale: they advance (nothing fresher exists for this sport)', allStale.advance.length === 2);
    check('all stale: every advanced item IS flagged as stale fallback',
        allStale.advance.every((a) => a.staleFallback === true));
    check('all stale: nothing held back', allStale.heldBack.length === 0);
    check("'unknown' is grouped with stale, never with fresh",
        partitionByRecency([{ item: 'u', recency: 'unknown' as const }, { item: 'f', recency: 'fresh' as const }])
            .advance.map((a) => a.item).join(',') === 'f');

    check('empty input is handled', partitionByRecency([]).advance.length === 0);

    // -----------------------------------------------------------------------------
    section('harvestSearchSources - the fabrication gate, including the error-shape trap');

    const successBlocks = [
        {
            type: 'web_search_tool_result',
            content: [
                { type: 'web_search_result', url: 'https://www.example.com/story/', title: 'A Story', page_age: '2 days ago' },
                { type: 'web_search_result', url: 'https://other.com/x?id=9', title: 'Other', page_age: null },
            ],
        },
        {
            type: 'text',
            text: 'answer',
            citations: [{ type: 'web_search_result_location', url: 'https://cited.com/a', title: 'Cited', cited_text: 'He said he was done waiting.' }],
        },
    ];
    const harvested = harvestSearchSources(successBlocks);
    check('collects urls from web_search_result blocks', harvested.urls.size === 3, JSON.stringify([...harvested.urls]));
    check('collects page_age alongside the url',
        harvested.byUrl.get(normalizeUrl('https://www.example.com/story/'))?.pageAge === '2 days ago');
    // The citation branch survives only to widen the harvested URL set - the cited_text
    // side was removed 2026-09-09 (see tank-curation.ts). Widening can admit a real page,
    // never a fabricated one, so this stays safe for isHarvestedUrl.
    check('a citation url counts as harvested too', harvested.urls.has(normalizeUrl('https://cited.com/a')));

    // THE trap: a search error returns content as an OBJECT where success returns a LIST,
    // at HTTP 200. Code that maps over .content unconditionally throws the moment the
    // search budget runs out - which raising max_uses to 8 makes a live possibility.
    let threw = false;
    let errorHarvest;
    try {
        errorHarvest = harvestSearchSources([
            { type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
        ]);
    } catch {
        threw = true;
    }
    check('an error-shaped web_search_tool_result does NOT throw', !threw);
    check('the error code is surfaced rather than swallowed',
        errorHarvest?.errors.join(',') === 'max_uses_exceeded', JSON.stringify(errorHarvest?.errors));
    check('an errored search harvests zero urls', errorHarvest?.urls.size === 0);

    check('an empty result list is handled', harvestSearchSources([{ type: 'web_search_tool_result', content: [] }]).urls.size === 0);
    check('non-array content (a bare string, a null) is handled', harvestSearchSources(null as any).urls.size === 0);
    check('unrelated block types are ignored', harvestSearchSources([{ type: 'thinking', thinking: 'x' }]).urls.size === 0);

    // -----------------------------------------------------------------------------
    section('isHarvestedUrl - url matching tolerates shape, rejects fabrication');

    check('exact url matches', isHarvestedUrl('https://www.example.com/story/', harvested));
    check('missing trailing slash still matches', isHarvestedUrl('https://www.example.com/story', harvested));
    check('missing www still matches', isHarvestedUrl('https://example.com/story', harvested));
    check('http vs https still matches', isHarvestedUrl('http://example.com/story', harvested));
    check('a url search never returned is REJECTED',
        !isHarvestedUrl('https://example.com/fabricated-article', harvested));
    check('a plausible-looking homepage stand-in is REJECTED',
        !isHarvestedUrl('https://www.example.com/', harvested));
    check('empty/garbage url is rejected', !isHarvestedUrl('', harvested) && !isHarvestedUrl('not a url', harvested));
    check('query strings are significant (not stripped)',
        isHarvestedUrl('https://other.com/x?id=9', harvested) && !isHarvestedUrl('https://other.com/x?id=10', harvested));

    // -----------------------------------------------------------------------------
    section('isCuratorMatchV2Response - match shape validation');

    const validMatch = {
        candidateId: 'abc',
        category: 'Injury',
        trend_claim: 'X is out.',
        source_snippet: 'X will miss the game.',
        source_url: 'https://example.com/a',
        source_timestamp: ago(HOUR),
        angle: 'First game without X since the injury.',
        verified_stat: null,
    };
    check('a well-formed response validates', isCuratorMatchV2Response({ matches: [validMatch] }));
    check('an EMPTY matches array is valid (zero matches is a correct outcome)',
        isCuratorMatchV2Response({ matches: [] }));
    check('a missing matches key is invalid', !isCuratorMatchV2Response({}));
    check('a non-array matches is invalid', !isCuratorMatchV2Response({ matches: 'none' }));
    check('a missing source_url is invalid (the fabrication gate needs it)',
        !isCuratorMatchV2Response({ matches: [{ ...validMatch, source_url: undefined }] }));
    check('an empty-string angle is invalid',
        !isCuratorMatchV2Response({ matches: [{ ...validMatch, angle: '   ' }] }));
    check('a missing trend_claim is invalid',
        !isCuratorMatchV2Response({ matches: [{ ...validMatch, trend_claim: undefined }] }));
    check('null source_timestamp is allowed (an honest "I could not date this")',
        isCuratorMatchV2Response({ matches: [{ ...validMatch, source_timestamp: null }] }));
    check('a verified_stat missing its source_url is invalid',
        !isCuratorMatchV2Response({ matches: [{ ...validMatch, verified_stat: { value: '5 straight' } }] }));
    check('a well-formed verified_stat validates',
        isCuratorMatchV2Response({ matches: [{ ...validMatch, verified_stat: { value: '5 straight', source_url: 'https://e.com/s' } }] }));

    // -----------------------------------------------------------------------------
    section('isVerifyResponse - booleans must be real booleans');

    check('a well-formed verdict validates', isVerifyResponse({
        supports_claim: true, supports_reason: 'ok', generic_filler: false, filler_reason: 'specific',
        angle_rewrite: null, stat_supported: null, stat_reason: null,
    }));
    check('the STRING "true" is rejected, not coerced (a formatting failure must not become a publish decision)',
        !isVerifyResponse({ supports_claim: 'true', generic_filler: false }));
    check('a missing supports_claim is invalid', !isVerifyResponse({ generic_filler: false }));
    check('a missing generic_filler is invalid', !isVerifyResponse({ supports_claim: true }));
    check('a non-object is invalid', !isVerifyResponse(null) && !isVerifyResponse('yes'));
    check('optional fields may be omitted entirely',
        isVerifyResponse({ supports_claim: true, generic_filler: false }));

    // -----------------------------------------------------------------------------
    section('Handoff to the narrative stage');

    const tc = buildTimeContext(ahead(3 * DAY), ago(20 * HOUR), 'fresh', false, NOW);
    check('buildTimeContext computes hours_to_kickoff', tc.hours_to_kickoff === 72, String(tc.hours_to_kickoff));
    check('buildTimeContext computes hours_since_trend', tc.hours_since_trend === 20, String(tc.hours_since_trend));
    check('a null source timestamp yields a null hours_since_trend rather than a bogus number',
        buildTimeContext(ahead(DAY), null, 'unknown', true, NOW).hours_since_trend === null);
    check('formatVerifiedStatFact carries the source through to the facts array',
        formatVerifiedStatFact({ value: '5 straight', source_url: 'https://e.com/s' }) === '5 straight (source: https://e.com/s)');

    // -----------------------------------------------------------------------------
    section('Model-output parsers (previously untested, and load-bearing)');

    check('extractJson handles a fenced block', JSON.parse(extractJson('```json\n{"a":1}\n```')).a === 1);
    check('extractJson handles a bare object', JSON.parse(extractJson('{"a":1}')).a === 1);
    check('extractJson handles prose around an object',
        JSON.parse(extractJson('Here you go:\n{"a":1}\nHope that helps.')).a === 1);
    // The repair path: models writing a multi-paragraph `body` emit literal newlines
    // inside a JSON string, which strict JSON.parse rejects.
    check('parseModelJson repairs raw newlines inside a string value',
        parseModelJson('{"body":"line one\nline two"}').body === 'line one\nline two');
    check('parseModelJson still parses valid JSON untouched', parseModelJson('{"a":[1,2]}').a.length === 2);

    // -----------------------------------------------------------------------------
    section('Cross-check: how wide the tightened-freshness window actually is');

    // Documents a real, easy-to-miss interaction rather than testing new code:
    // MIN_LEAD_DAYS=2 filters out everything kicking off inside 48h, so
    // classifyRecency's 72h branch (the 24h freshness rule) can only ever apply in the
    // 48-72h sliver. If this assertion ever fails, MIN_LEAD_DAYS changed and that window
    // widened - which is fine, but it should be a deliberate decision, not a surprise.
    const game = {
        id: 'g1', league: 'NBA', away: 'A', home: 'H',
        kickoff: ahead(30 * HOUR), settleDate: ahead(30 * HOUR),
        props: [{ id: 'p1', player: 'P', team: null, market: 'basketball_player_points', line: 20, prominence: 50, odds: null, settleDate: ahead(30 * HOUR) }],
    };
    const survivors = filterProps([game], {
        marketWhitelist: [], minProminence: 0, perGameCap: 3, minLeadDays: 2, now: NOW,
    });
    check('MIN_LEAD_DAYS=2 excludes a game kicking off in 30h, so nothing reaches the tightened branch below 48h',
        survivors.length === 0);
    check('effectiveSettleDate is what the lead-time filter measures (not the padded raw settleDate)',
        effectiveSettleDate({ settleDate: ahead(9 * DAY) }, { settleDate: ahead(9 * DAY), kickoff: ahead(2 * DAY) }) === ahead(2 * DAY));

    // -----------------------------------------------------------------------------
    section('Market whitelist - game lines only');

    // Regression guard for a live incident (2026-09-09): MARKET_WHITELIST was unset in
    // both deployed Pages environments, and curate.ts's DEFAULT_MARKET_WHITELIST was []
    // - which filterProps treats as "no filtering", not "use a default". Production
    // curation therefore ran with no market restriction at all and produced player-prop
    // and season-futures Tanks (Aaron Donald's return, two starting-QB futures, an RB
    // points-leader market).
    //
    // These assertions pin both halves: GAME_LINE_MARKETS (which the default is now built
    // from) names exactly the three game-line keys, and an empty list still means no
    // filter - so nobody re-introduces the bug by "tidying" the default back to [].
    check('GAME_LINE_MARKETS is exactly the three game-line markets (curate.ts builds its default from this)',
        JSON.stringify([...GAME_LINE_MARKETS].sort()) === JSON.stringify(['moneyline', 'spreads', 'totals']),
        JSON.stringify(GAME_LINE_MARKETS));

    const mixedGame = {
        id: 'g2', league: 'NFL', away: 'A', home: 'H',
        kickoff: ahead(5 * DAY), settleDate: ahead(5 * DAY),
        props: [
            mkProp('p-ml', 'moneyline'),
            mkProp('p-sp', 'spreads'),
            mkProp('p-to', 'totals'),
            mkProp('p-pp', 'football_player_passing_yards'),
            mkProp('p-sf', 'season_futures'),
        ],
    };
    const kept = filterProps([mixedGame], {
        marketWhitelist: [...GAME_LINE_MARKETS], minProminence: 0,
        // perGameCap high enough that the cap can't be mistaken for the whitelist working
        perGameCap: 10, minLeadDays: 2, now: NOW,
    })[0]?.props.map((p) => p.market).sort() ?? [];
    check('the default keeps moneyline/spreads/totals',
        JSON.stringify(kept) === JSON.stringify(['moneyline', 'spreads', 'totals']), JSON.stringify(kept));
    check('the default drops player props', !kept.includes('football_player_passing_yards'));
    check('the default drops season_futures', !kept.includes('season_futures'));

    const unfiltered = filterProps([mixedGame], {
        marketWhitelist: [], minProminence: 0, perGameCap: 10, minLeadDays: 2, now: NOW,
    })[0]?.props.length ?? 0;
    check('an EMPTY whitelist still means no filtering (the trap that caused the incident)',
        unfiltered === 5, `kept ${unfiltered} of 5`);
}

function mkProp(id: string, market: string) {
    return { id, player: 'P', team: null, market, line: 1, prominence: 50, odds: null, settleDate: ahead(5 * DAY) };
}

export const suite: Suite = {
    name: 'curation',
    requiredEnv: [],
    run,
};
