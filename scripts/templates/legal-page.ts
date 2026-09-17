import { renderHead, topbar, footer } from './waitlist-landing-template';
import { escapeHtml } from '../utils/html-escape';

/**
 * The shared "document page": the teal-bordered reading card that /terms/ and
 * /privacy/ are set in, and whose stylesheet /faq/ and /contact/ borrow so the four
 * footer pages read as one family.
 *
 * A legal document is held as data (parts -> numbered sections -> blocks) rather than
 * hand-written HTML, so a round of attorney edits is a text change. Strings are the
 * legal copy verbatim, plus the inline marks inline() understands.
 */

export type Block =
    | string                       // an ordinary paragraph
    | { caps: string }             // the conspicuous ALL-CAPS legal paragraphs
    | { list: string[] }           // a bulleted list
    | { note: string };            // a drafting note for counsel - draft-only

export interface Section { num: number; title: string; blocks: Block[] }
export interface Part { id: string; label: string; title: string; sections: Section[] }

export interface LegalDocument {
    path: string;                  // '/terms/'
    title: string;                 // <title>
    description: string;
    heading: string;               // the h1
    effectiveDate: string;
    lastUpdated: string;
    // While true: a "pending legal review" banner, highlighted [placeholders], visible
    // drafting notes, and noindex. The page is final when this is false.
    isDraft: boolean;
    draftNoun: string;             // "These Terms are" / "This policy is" - for the banner
    intro: string[];
    callout?: string;              // the gold conspicuous notice under the intro
    afterCallout?: string[];
    parts: Part[];
    contact: string;
}

/**
 * Escape first, then apply the inline marks. Order matters: [text](/url) links before
 * the bare-[placeholder] pass (which would otherwise claim their brackets), bold before
 * italic (so ** never reads as two empty italics), and the "Section N" / email links
 * last so they can't land inside a tag an earlier pass wrote.
 */
export function inline(text: string): string {
    return escapeHtml(text)
        .replace(/\[([^\[\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/\[([^\[\]]+)\]/g, '<span class="hc-doc-blank">[$1]</span>')
        .replace(/\bSection (\d+)\b/g, '<a href="#section-$1">Section $1</a>')
        .replace(/\b([a-z]+@heatchecks\.io)\b/g, '<a href="mailto:$1">$1</a>');
}

function renderBlock(block: Block, isDraft: boolean): string {
    if (typeof block === 'string') return `<p>${inline(block)}</p>`;
    if ('caps' in block) return `<p class="hc-doc-caps">${inline(block.caps)}</p>`;
    if ('list' in block) return `<ul>${block.list.map((item) => `<li>${inline(item)}</li>`).join('')}</ul>`;
    // A drafting note is a message to counsel, not a term - it never ships.
    return isDraft ? `<p class="hc-doc-note"><span>Drafting note</span>${inline(block.note)}</p>` : '';
}

function renderSection(section: Section, isDraft: boolean): string {
    return `
            <section class="hc-doc-section" id="section-${section.num}">
                <h3><span class="hc-doc-num">${section.num}.</span> ${escapeHtml(section.title)}</h3>
                ${section.blocks.map((b) => renderBlock(b, isDraft)).join('\n                ')}
            </section>`;
}

function renderToc(parts: Part[], multiPart: boolean): string {
    return parts.map((part) => `
                <div class="hc-doc-toc-part">${multiPart ? `
                    <a class="hc-doc-toc-label" href="#${part.id}">${escapeHtml(part.label)} — ${escapeHtml(part.title)}</a>` : ''}
                    <ol start="${part.sections[0].num}">
                        ${part.sections.map((s) => `<li><a href="#section-${s.num}">${escapeHtml(s.title)}</a></li>`).join('\n                        ')}
                    </ol>
                </div>`).join('');
}

/** The card, type and link styles every footer page shares. */
export function documentStyles(): string {
    return `
        /* A document wants a longer measure than the 560px funnel column. */
        .hc-page.hc-page--doc { max-width: 780px; }
        html { scroll-behavior: smooth; }
        @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }

        .hc-doc {
            margin-top: 1.5rem;
            padding: 2rem 1.75rem 2.25rem;
            background: rgba(11, 7, 19, 0.72);
            border: 2px solid rgba(47, 230, 217, 0.4);
            border-radius: 20px;
            box-shadow: 0 0 40px rgba(47, 230, 217, 0.12), 0 20px 50px rgba(0, 0, 0, 0.45);
        }
        .hc-doc-eyebrow {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.72rem;
            letter-spacing: 0.14em; text-transform: uppercase; color: var(--hc-teal);
            text-shadow: 0 0 10px rgba(47, 230, 217, 0.45); margin: 0;
        }
        .hc-doc h1 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.7rem, 6vw, 2.4rem); line-height: 1.1;
            color: #ffffff; margin: 0.35rem 0 0;
        }
        .hc-doc-dates {
            display: flex; flex-wrap: wrap; gap: 0.35rem 1.25rem;
            margin: 0.6rem 0 0; font-size: 0.82rem; color: rgba(255, 255, 255, 0.6);
        }
        .hc-doc-dates strong { color: rgba(255, 255, 255, 0.85); font-weight: 800; }

        .hc-doc p, .hc-doc li {
            font-size: 0.95rem; line-height: 1.65; color: rgba(255, 255, 255, 0.82);
        }
        .hc-doc p { margin: 0.85rem 0 0; overflow-wrap: anywhere; }
        .hc-doc ul { margin: 0.6rem 0 0; padding-left: 1.3rem; }
        .hc-doc ul li { margin-top: 0.4rem; overflow-wrap: anywhere; }
        .hc-doc ul li::marker { color: var(--hc-teal); }
        .hc-doc strong { color: #ffffff; font-weight: 800; }
        .hc-doc a { color: var(--hc-teal); text-decoration: underline; text-underline-offset: 2px; }
        .hc-doc a:hover { color: #ffffff; }

        .hc-doc-draft {
            margin: 1.25rem 0 0; padding: 0.75rem 1rem;
            border: 1px dashed rgba(255, 199, 44, 0.6); border-radius: 12px;
            background: rgba(255, 199, 44, 0.08);
            font-size: 0.85rem; line-height: 1.5; color: rgba(255, 255, 255, 0.85);
        }
        .hc-doc-draft strong { color: var(--hc-gold); }

        /* A conspicuous notice - gold, the site's CTA colour. */
        .hc-doc-callout {
            margin: 1.25rem 0 0; padding: 0.9rem 1.1rem;
            border-left: 4px solid var(--hc-gold); border-radius: 0 12px 12px 0;
            background: rgba(255, 199, 44, 0.1);
        }
        .hc-doc-callout p { margin: 0; color: #ffffff; font-weight: 800; }
        .hc-doc-callout a { color: var(--hc-gold); }

        .hc-doc-toc {
            margin: 1.5rem 0 0; padding: 1rem 1.15rem 1.15rem;
            background: rgba(255, 255, 255, 0.04);
            border: 1px solid rgba(255, 255, 255, 0.12); border-radius: 14px;
        }
        .hc-doc-toc > summary {
            cursor: pointer; list-style: none;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.78rem;
            letter-spacing: 0.1em; text-transform: uppercase; color: var(--hc-teal);
        }
        .hc-doc-toc > summary::-webkit-details-marker { display: none; }
        .hc-doc-toc > summary::after { content: ' +'; }
        .hc-doc-toc[open] > summary::after { content: ' \\2212'; }
        .hc-doc-toc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.5rem; }
        .hc-doc-toc-grid--single { display: block; margin-top: 0.5rem; }
        .hc-doc-toc-grid--single ol { columns: 2; column-gap: 2.5rem; }
        .hc-doc-toc-grid--single li { break-inside: avoid; }
        .hc-doc-toc-label {
            display: block; margin-top: 0.9rem;
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800; font-size: 1rem;
            color: var(--hc-gold) !important; text-decoration: none !important;
        }
        .hc-doc-toc ol { margin: 0.35rem 0 0; padding-left: 1.6rem; }
        .hc-doc-toc li { font-size: 0.86rem; line-height: 1.45; padding: 0.12rem 0; }
        .hc-doc-toc li::marker { color: rgba(47, 230, 217, 0.8); font-weight: 800; }
        .hc-doc-toc li a { color: rgba(255, 255, 255, 0.8); text-decoration: none; }
        .hc-doc-toc li a:hover { color: #ffffff; text-decoration: underline; }

        .hc-doc-part {
            margin: 2.5rem 0 0; padding-top: 1.5rem;
            border-top: 1px solid rgba(255, 255, 255, 0.14);
            scroll-margin-top: 1rem;
        }
        .hc-doc-part-label {
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 900; font-size: 0.78rem;
            letter-spacing: 0.16em; text-transform: uppercase; color: var(--hc-gold); margin: 0;
        }
        .hc-doc h2 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: clamp(1.3rem, 5vw, 1.7rem); line-height: 1.15;
            color: #ffffff; margin: 0.15rem 0 0;
        }
        .hc-doc-section { margin-top: 1.9rem; scroll-margin-top: 1rem; }
        .hc-doc h3 {
            font-family: 'Baloo 2', 'Nunito', sans-serif; font-weight: 800;
            font-size: 1.15rem; line-height: 1.25; color: #ffffff; margin: 0;
        }
        .hc-doc-num { color: var(--hc-teal); }
        /* Arriving from the contents list or a "Section N" link: flash the heading. */
        .hc-doc-section:target h3 { color: var(--hc-gold); }

        /* The conspicuous paragraphs stay uppercase (that is the legal point of them)
           but set smaller and looser, so a wall of capitals is still readable. */
        .hc-doc p.hc-doc-caps {
            font-size: 0.8rem; line-height: 1.7; letter-spacing: 0.02em;
            padding: 0.85rem 1rem; border-radius: 12px;
            background: rgba(255, 255, 255, 0.05); border: 1px solid rgba(255, 255, 255, 0.1);
            color: rgba(255, 255, 255, 0.88);
        }

        .hc-doc-blank {
            padding: 0 0.2em; border-radius: 4px;
            background: rgba(255, 199, 44, 0.14); color: var(--hc-gold);
            border-bottom: 1px dashed rgba(255, 199, 44, 0.7);
        }
        .hc-doc p.hc-doc-note {
            padding: 0.7rem 0.9rem; border-radius: 10px;
            border: 1px dashed rgba(255, 199, 44, 0.45); background: rgba(255, 199, 44, 0.06);
            font-size: 0.86rem; color: rgba(255, 255, 255, 0.75);
        }
        .hc-doc-note > span {
            display: block; margin-bottom: 0.2rem;
            font-family: 'Montserrat', 'Nunito', sans-serif; font-weight: 800; font-size: 0.66rem;
            letter-spacing: 0.12em; text-transform: uppercase; color: var(--hc-gold);
        }

        .hc-doc-contact {
            margin-top: 2.5rem; padding-top: 1.25rem;
            border-top: 1px solid rgba(255, 255, 255, 0.14);
        }
        .hc-doc-top { display: inline-block; margin-top: 1.25rem; font-size: 0.85rem; }

        @media (max-width: 560px) {
            .hc-doc { padding: 1.5rem 1.1rem 1.75rem; border-radius: 16px; }
            .hc-doc-toc-grid { grid-template-columns: 1fr; }
            .hc-doc-toc-grid--single ol { columns: 1; }
        }
        @media print {
            body::before { display: none; }
            .hc-doc { border: 0; box-shadow: none; background: none; }
            .hc-doc, .hc-doc p, .hc-doc li, .hc-doc h1, .hc-doc h2, .hc-doc h3, .hc-doc strong { color: #000 !important; }
            .hc-topbar, .hc-doc-toc, .hc-doc-top, .hc-footer { display: none; }
        }`;
}

export function renderLegalDocument(doc: LegalDocument, baseUrl: string): string {
    const head = renderHead({ title: doc.title, description: doc.description, path: doc.path, baseUrl });
    // One part on its own is simply "the document": no part banner, contents as one list.
    const multiPart = doc.parts.length > 1;

    return `<!DOCTYPE html>
<html lang="en">
<head>
    ${head}${doc.isDraft ? '\n    <meta name="robots" content="noindex">' : ''}
    <style>${documentStyles()}
    </style>
</head>
<body>
    <main class="hc-page hc-page--doc">
        ${topbar('/beta/')}

        <article class="hc-doc" id="top">
            <p class="hc-doc-eyebrow">Legal</p>
            <h1>${escapeHtml(doc.heading)}</h1>
            <p class="hc-doc-dates">
                <span><strong>Effective:</strong> ${inline(doc.effectiveDate)}</span>
                <span><strong>Last updated:</strong> ${inline(doc.lastUpdated)}</span>
            </p>
            ${doc.isDraft ? `
            <p class="hc-doc-draft"><strong>Draft — pending legal review.</strong> ${escapeHtml(doc.draftNoun)} not yet final. Highlighted items in [brackets] are still being completed.</p>` : ''}

            ${doc.intro.map((p) => `<p>${inline(p)}</p>`).join('\n            ')}
            ${doc.callout ? `
            <div class="hc-doc-callout"><p>${inline(doc.callout)}</p></div>` : ''}
            ${(doc.afterCallout ?? []).map((p) => `<p>${inline(p)}</p>`).join('\n            ')}

            <details class="hc-doc-toc" open>
                <summary>Contents</summary>
                <nav class="hc-doc-toc-grid${multiPart ? '' : ' hc-doc-toc-grid--single'}" aria-label="Table of contents">${renderToc(doc.parts, multiPart)}
                </nav>
            </details>
            ${doc.parts.map((part) => `${multiPart ? `
            <div class="hc-doc-part" id="${part.id}">
                <p class="hc-doc-part-label">${escapeHtml(part.label)}</p>
                <h2>${escapeHtml(part.title)}</h2>
            </div>` : ''}${part.sections.map((s) => renderSection(s, doc.isDraft)).join('')}`).join('\n')}

            <div class="hc-doc-contact">
                <p><strong>Contact.</strong> ${inline(doc.contact)}</p>
                <a class="hc-doc-top" href="#top">&uarr; Back to top</a>
            </div>
        </article>

        ${footer()}
    </main>
</body>
</html>`;
}
