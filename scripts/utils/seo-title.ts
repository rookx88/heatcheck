/**
 * Repair an SEO title the model cut off mid-word.
 *
 * The narrative prompt asks for "<= 60 chars" and the model enforces that by simply
 * stopping when it gets there - so a title can arrive already truncated, e.g.
 * "Green Bay Packers vs Pittsburgh Steelers: Celebrity Suite Cu" (exactly 60). Nothing
 * in the build truncates titles, so a length-based trim can't help: the string is
 * already under the cap by the time we see it. That broken string then propagates to
 * <title>, og:title, twitter:title and the <h1>.
 *
 * The slug is the signal. The model emits `seo.slug` separately and does NOT truncate
 * it, so the full word survives there ("...celebrity-suite-cutaways"). If the title's
 * final word is a STRICT prefix of a slug word, it was cut short. An intact title's
 * final word matches its slug word exactly, so it is left alone.
 *
 * We drop the partial word rather than restoring it from the slug: slugs are
 * lowercased and stripped of punctuation, so reconstructing would turn "McDaniel" into
 * "Mcdaniel" and trade one visible defect for another. Dropping is always correct.
 *
 * Verified against all 64 published articles: flags exactly the one broken title, no
 * false positives.
 */
export function repairTruncatedTitle(title: string, slug: string): string {
    const trimmed = (title ?? '').trim();
    if (!trimmed || !slug) return trimmed;

    const words = trimmed.match(/[A-Za-z']+/g);
    if (!words || words.length < 2) return trimmed;

    const last = words[words.length - 1].toLowerCase().replace(/'/g, '');
    if (!last) return trimmed;

    const slugWords = slug.split('-');
    const wasCut = slugWords.some(w => w !== last && w.startsWith(last));
    if (!wasCut) return trimmed;

    // Drop the trailing partial word, then any punctuation it was hanging off of
    // (a dangling ":" or "-" reads worse than the stub did).
    const cutAt = trimmed.toLowerCase().lastIndexOf(last);
    const repaired = trimmed.slice(0, cutAt).replace(/[\s—–:;,\-]+$/, '').trim();

    // A title so short it stops being useful is worse than an odd-looking one.
    return repaired.length >= 20 ? repaired : trimmed;
}
