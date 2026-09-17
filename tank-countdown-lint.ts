// Post-generation guard against kickoff countdown language in a TankArticle.
//
// The narrative prompt (scripts/prompts/tank-narrative-prompt.ts, "Time anchoring")
// already forbids "tonight", "tomorrow night", "later today" and any other countdown to
// kickoff: a Tank is generated days before its game and then sits unchanged, so those
// words are false for almost everyone who reads them. The model ignores that rule often
// enough to matter - the White Sox/Cardinals moneyline Tank generated 2026-09-07 for a
// Saturday game said "tonight" three times, and a reader on Friday evening reasonably
// took it for the game on TV and made a pick they thought was in-play. The pick gate
// (lib/pages-functions/picks.ts) was right; the copy was wrong.
//
// Two pure functions, no I/O, so the acceptance harness can pin them down without an
// API key:
//   - findKickoffCountdowns  - every offending phrase, with the field it sits in.
//   - replaceKickoffCountdowns - the last-resort rewrite: swap each simple countdown
//     word for the game's weekday (ET), which stays true forever. Phrases that can't be
//     swapped into grammatical prose ("hours away") are reported back as unresolved.
//
// tank-generate.ts runs the finder after every model response, sends the hits back to
// the model for one corrected draft, and only falls through to the substitution if the
// retry still contains countdowns.

import type { TankArticle } from './tank-types';

export interface CountdownHit {
    field: string;   // 'body', 'hook', 'tagline', 'cards[2]', 'call.question', 'seo.title', 'seo.meta_description'
    phrase: string;  // the matched text as written
}

// Order matters inside the alternation: the longer phrase must come before the word it
// contains ("later today" before "today", "tomorrow night" before "tomorrow"), or the
// short form wins and the leftover word survives into the rewrite.
//
// "hours away"-style phrases are caught for detection only. The rewrite map below
// deliberately has no entry for them: there is no single word that turns "with first
// pitch hours away" into a sentence that reads well, so those go back to the model or
// fail the generation rather than being patched blind.
const COUNTDOWN_RE = /\b(?:later tonight|tonight|later today|earlier today|today|tomorrow night|tomorrow|this evening|this afternoon|this morning|(?:just |only |mere )?(?:a few |\d+ )?(?:hours?|minutes?) (?:away|from now|out)|in a few hours)\b/gi;

type ArticleField = { field: string; get: () => string | undefined; set: (v: string) => void };

function fields(article: TankArticle): ArticleField[] {
    const list: ArticleField[] = [
        { field: 'seo.title', get: () => article.seo?.title, set: (v) => { article.seo.title = v; } },
        { field: 'seo.meta_description', get: () => article.seo?.meta_description, set: (v) => { article.seo.meta_description = v; } },
        { field: 'tagline', get: () => article.tagline, set: (v) => { article.tagline = v; } },
        { field: 'hook', get: () => article.hook, set: (v) => { article.hook = v; } },
        { field: 'body', get: () => article.body, set: (v) => { article.body = v; } },
        { field: 'call.question', get: () => article.call?.question, set: (v) => { article.call.question = v; } },
    ];
    (article.cards ?? []).forEach((_, i) => {
        list.push({ field: `cards[${i}]`, get: () => article.cards[i], set: (v) => { article.cards[i] = v; } });
    });
    return list;
}

export function findKickoffCountdowns(article: TankArticle): CountdownHit[] {
    const hits: CountdownHit[] = [];
    for (const f of fields(article)) {
        const text = f.get();
        if (typeof text !== 'string' || !text) continue;
        for (const m of text.matchAll(COUNTDOWN_RE)) {
            hits.push({ field: f.field, phrase: m[0] });
        }
    }
    return hits;
}

// "Saturday" for a kickoff ISO string, in Eastern time - the same zone every
// reader-facing game time on the site is formatted in (tank-deck-format.ts
// formatGameTime), so the weekday in the prose matches the one in the call wall header.
// Null when the kickoff is missing or unparseable: the caller then has nothing safe to
// substitute and must treat every hit as unresolved.
export function kickoffWeekday(kickoff: string | undefined | null): string | null {
    if (!kickoff) return null;
    const ms = new Date(kickoff).getTime();
    if (Number.isNaN(ms)) return null;
    return new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: 'America/New_York' }).format(new Date(ms));
}

// Lower-cased matched phrase -> replacement template. `%W` is the weekday.
const REWRITES: Record<string, string> = {
    'later tonight': '%W night',
    'tonight': '%W night',
    'later today': '%W',
    'earlier today': '%W',
    'today': '%W',
    'tomorrow night': '%W night',
    'tomorrow': '%W',
    'this evening': '%W evening',
    'this afternoon': '%W afternoon',
    'this morning': '%W morning',
};

export interface CountdownRewrite {
    article: TankArticle;
    replaced: CountdownHit[];    // hits that were swapped for the weekday
    unresolved: CountdownHit[];  // hits with no safe rewrite - still present in `article`
}

// Returns a rewritten copy; the input is not mutated. When `kickoff` yields no weekday,
// nothing is replaced and every hit comes back unresolved.
export function replaceKickoffCountdowns(article: TankArticle, kickoff: string | undefined | null): CountdownRewrite {
    const copy: TankArticle = JSON.parse(JSON.stringify(article));
    const weekday = kickoffWeekday(kickoff);
    const replaced: CountdownHit[] = [];
    const unresolved: CountdownHit[] = [];

    for (const f of fields(copy)) {
        const text = f.get();
        if (typeof text !== 'string' || !text) continue;
        const next = text.replace(COUNTDOWN_RE, (match) => {
            const template = weekday ? REWRITES[match.toLowerCase()] : undefined;
            if (!template) {
                unresolved.push({ field: f.field, phrase: match });
                return match;
            }
            replaced.push({ field: f.field, phrase: match });
            // Every template starts with the weekday, a proper noun, so the result reads
            // correctly whether the match opened a sentence ("Tonight they" -> "Saturday
            // night they") or sat mid-sentence ("straight up, tonight only" -> "straight
            // up, Saturday night only").
            return template.replace('%W', weekday!);
        });
        if (next !== text) f.set(next);
    }
    return { article: copy, replaced, unresolved };
}

// The corrective user turn sent back to the model with its own draft, when the first
// draft contained countdowns. Names every hit so the model fixes all of them, not just
// the first one it notices, and hands it the weekday so it has a true anchor to reach
// for instead of inventing a new relative one.
export function buildCountdownFeedback(hits: CountdownHit[], kickoff: string | undefined | null): string {
    const weekday = kickoffWeekday(kickoff);
    const listed = hits.map((h) => `"${h.phrase}" in ${h.field}`).join('; ');
    return [
        `Your draft contains kickoff countdown language, which the system prompt forbids: ${listed}.`,
        'This page is read for days after it is written, so each of those is false for most readers.',
        'Rewrite the affected text with no reference to how soon the game is - no "tonight", "today", "tomorrow", "this evening", or "hours away".',
        weekday ? `The game is on ${weekday}; if you need to name the day, use the weekday.` : 'If you need to name the day, use its weekday.',
        'Return the complete JSON object again with every field present, changing nothing else.',
    ].join(' ');
}
