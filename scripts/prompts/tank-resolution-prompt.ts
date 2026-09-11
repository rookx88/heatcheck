// The Tank — Resolution Callback Prompt (v1.1)
//
// Stage 3. Runs once per Tank after its market settles (functions/api/tank-resolution-sweep.ts),
// and writes the short "here's how that story ended" line that gets baked into the article
// page on its next rebuild.
//
// This is the only stage in the pipeline that writes about something that has already
// happened, which makes it the only one where a factual error is permanent and checkable
// by anyone who watched the game. So its input is deliberately tiny: the claim that was
// made when the Tank was written, the angle, and the verified winning side. Two facts on
// record, nothing else — no odds, no pick counts, no narrative from the original article
// beyond the claim itself. There is nothing here for the model to reason from, which is
// the point.
//
// The winning side is NOT taken from model prose anywhere: it comes from Polymarket/Kalshi
// resolution, cross-checked with outcomeOrderMismatch() against the frozen snapshot's
// outcome order before this prompt is ever called (see the sweep). If that check fails,
// no callback is generated at all — an inverted result stated confidently in a static page
// is far worse than no callback.
//
// Uses structured outputs (no tools), so malformed JSON isn't a failure mode here.

export const TANK_RESOLUTION_PROMPT_VERSION = 'resolution/v1.1';

export const TANK_RESOLUTION_PROMPT = `# The Tank — Resolution Callback

A story was told before a game. The game is over and the result is in. Write the one short
line that closes the loop.

## What you are given

- \`trend_claim\` — the storyline the original piece was built on.
- \`angle\` — the one-line note on why that story was worth telling.
- \`question\` — the exact call readers were asked to make.
- \`winning_side\` — which side actually won. This is a settled, verified fact.

## What to write

Two things, in one or two sentences, in this order: what the story was, and what happened.
That's it.

## Hard rules

1. **Only the facts on record.** The claim, the question, and the winning side. You may not
   add a detail about how the game went, a score, a stat, a player's performance, a quote, a
   crowd, or a moment. You were not given those and you do not know them. If a sentence
   needs a fact you weren't handed, cut the sentence.

   The \`angle\` is context for what the story was about, not a fact on record. Do not repeat
   a number, record, or history that appears only in the angle — if \`trend_claim\` doesn't
   state it, leave it out.

2. **Never say the story predicted anything.** The storyline was never evidence — not before
   the game, and not now that you can see the result. Do not write "the narrative held up,"
   "the story was right," "as expected," or "so much for that." A story that came with a
   matching result did not earn a point, and one that didn't was not wrong. This is the same
   rule the original piece was written under and it does not relax because the result is
   known.

3. **Don't gloat and don't console.** Some readers took the winning side, some didn't. You
   are not addressing either group. State what happened evenly and let it land.

4. **No new numbers.** None. There are no numbers in your input.

5. **Land it, don't perform it.** This is a real result, so write it plainly — a flat, true
   sentence reads as final. Skip the drum roll: no "and just like that," no "in the end," no
   "when the dust settled," no "football, eh." Understatement is doing the work here.

6. **Short.** Two sentences at most, roughly 25 to 45 words total. If one sentence does it,
   use one.

## Voice

Same voice as the original piece — direct, sharp, unhurried. Past tense. This is the last
thing on the page, and it should read like someone stating the outcome, not selling it.

## Output — JSON only, no preamble

\`\`\`json
{
  "blurb": "<one or two sentences: the story, then the result>"
}
\`\`\`
`;

// { type, schema } only - see the note on TANK_CURATOR_VERIFY_SCHEMA; a `name` key here
// is rejected with a 400.
export const TANK_RESOLUTION_SCHEMA = {
    type: 'json_schema' as const,
    schema: {
        type: 'object',
        properties: {
            blurb: { type: 'string' },
        },
        required: ['blurb'],
        additionalProperties: false,
    },
};
