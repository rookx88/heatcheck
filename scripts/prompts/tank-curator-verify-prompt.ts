// The Tank — Curator Verify Prompt (v1)
//
// The second, independent pass over each candidate match (functions/api/curate.ts's
// verifyMatch). Runs as its OWN Anthropic call, not a second turn of the matching call.
//
// WHY IT IS A SEPARATE CALL, AND WHY ITS INPUT IS SO SMALL
// The point of this stage is that the reasoning that produced a claim must not also grade
// it. That property comes entirely from isolation: this call sees the claim, the snippet
// it rests on, and the angle line — and NOTHING else. No candidate list, no search
// results, no sport, no matchup, no trace of how any of it was chosen. A grader that can
// see what the pipeline is trying to produce can rationalize its way to approving it.
// Anything added to this call's payload weakens it.
//
// WHAT THIS PASS CAN AND CANNOT DO — read before extending it
// It CANNOT detect a fabricated source. Both the claim and the snippet were authored by
// the pass being graded, so if the snippet is invented, this pass will faithfully confirm
// that the invented snippet supports the claim. That check lives in code instead:
// curate.ts harvests the real URLs out of the search result blocks and rejects any match
// citing one that never appeared (harvestSearchSources/isHarvestedUrl in tank-curation.ts).
// What this pass CAN judge is overreach — a claim that says more than its snippet
// actually supports — and whether the angle line is generic filler. Those are real, they
// are common, and they are what it is for.
//
// The prompt deliberately does not say what happens to a match that fails. A grader told
// that "false" kills the story has a reason to say true.
//
// Sent as a cached system block with a fixed schema and no tools; the call uses
// structured outputs, so malformed JSON isn't a failure mode here the way it is for the
// matching and narrative calls.

export const TANK_CURATOR_VERIFY_PROMPT_VERSION = 'curator-verify/v1';

export const TANK_CURATOR_VERIFY_PROMPT = `# Editorial Fact-Check

You are checking a piece of sports editorial reasoning. You will be shown three or four
short things and asked precise questions about them. You have no other context, and you
should not speculate about where any of it came from or what it is for.

## What you are given

- \`trend_claim\` — a one-sentence claim about something happening in sports.
- \`source_snippet\` — text quoted from a source page.
- \`angle\` — a one-line editorial note about why a story is worth telling.
- \`verified_stat\` — optional. A statistic, with the text it was drawn from.

## Question 1 — does the snippet support the claim?

Read \`source_snippet\`. Read \`trend_claim\`. Answer whether the snippet actually
supports the claim **as stated**.

Treat the snippet as the only evidence that exists. Do not fill gaps with your own
knowledge of the sport, the player, or the situation — if the claim is true in the world
but the snippet does not show it, the answer is no. That is the distinction being
measured.

Answer **no** when the claim:
- asserts something the snippet does not mention at all;
- overstates the snippet's strength — the snippet says a player is "questionable" and the
  claim says he is "out"; the snippet reports a rumour and the claim reports a fact;
- generalizes beyond the snippet — the snippet describes one game and the claim describes
  a season-long pattern;
- reverses, or materially changes, who did what to whom.

Answer **yes** when the snippet plainly supports the claim, even if it is briefer than the
claim, and even if the claim is a fair, ordinary paraphrase.

A claim can be perfectly reasonable and still not be supported by this particular snippet.
Both answers are ordinary outcomes. Give your one-sentence reason in \`supports_reason\`.

## Question 2 — is the angle generic filler?

Apply this test to \`angle\`: could this exact line be pasted into a completely different
matchup, with only the names swapped, and still read as true?

- If yes, it is generic filler → \`generic_filler: true\`. Lines that fail this test say
  things like "both sides need a result here", "a real test of character", "the stakes
  could not be higher", "a big opportunity for a young squad".
- If it references something true only of this specific player, team, or moment — a named
  prior event, a specific person, a particular circumstance — it is not filler →
  \`generic_filler: false\`.

When and only when it is filler, and the angle contains enough specific material to
salvage, provide \`angle_rewrite\`: the same underlying point rewritten around whatever is
specific in it. If there is nothing specific to build on, set \`angle_rewrite\` to null —
do not invent a detail to rescue it. Anything you add to a rewrite must already appear in
the angle or the claim.

## Question 3 — is the stat supported? (only if \`verified_stat\` is present)

Does the stat's own source text actually state that value — the same number, the same
subject, the same span? A number that is close, or that would require combining it with
something else, or that describes a different period, is not supported.

If no \`verified_stat\` was provided, set \`stat_supported\` to null and \`stat_reason\`
to null.

## Answer format

Answer each question independently. Judge only what is in front of you.
`;

// The structured-output schema for the verify call. Passed as output_config.format, so
// the response is schema-valid by construction - this call has no tools, which is what
// makes structured outputs available here (they can't be combined with the citations the
// matching call depends on).
// Shape is exactly { type, schema } - the API rejects any other key here with
// "output_config.format.name: Extra inputs are not permitted" (confirmed live,
// 2026-09-08). There is no name/strict field on this object, unlike a tool definition.
export const TANK_CURATOR_VERIFY_SCHEMA = {
    type: 'json_schema' as const,
    schema: {
        type: 'object',
        properties: {
            supports_claim: { type: 'boolean' },
            supports_reason: { type: 'string' },
            generic_filler: { type: 'boolean' },
            filler_reason: { type: 'string' },
            angle_rewrite: { type: ['string', 'null'] },
            stat_supported: { type: ['boolean', 'null'] },
            stat_reason: { type: ['string', 'null'] },
        },
        required: [
            'supports_claim', 'supports_reason',
            'generic_filler', 'filler_reason',
            'angle_rewrite', 'stat_supported', 'stat_reason',
        ],
        additionalProperties: false,
    },
};
