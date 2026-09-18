// ===================================================================================
// HEATCHECKS TANK — ARTICLE DECK CLIENT (tank-article-deck-client.tsx)
// ===================================================================================
// Small standalone bundle (built via scripts/build-tank-article-deck.ts, not the main
// Vite app) that hydrates on top of the server-rendered Tank article body. Reads the
// embedded #tank-article-deck-data JSON and renders the shared Fishtank artifact
// (components/Fishtank.tsx - also reused by the-tank page's carousel), plus the
// shared identity chrome (components/ContentChrome.tsx - the same header chip, pet
// widget, and Inbox host the TANKDAQ content pages mount).
// ===================================================================================

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Fishtank, type DeckPayload } from './components/Fishtank';
import { ContentChrome } from './components/ContentChrome';
import { ArticleIndexes } from './components/ArticleIndexes';
import { ArticleMarket, type MarketPanelSeed } from './components/ArticleMarket';

// Fishtank's stage box is this tall at every scale - see its `scale` prop note.
const STAGE_H = 420;

// The deck shrinks only as far as it must for the cube AND its turn arrows to fit
// inside the panel it sits on: each arrow sits (200s + 18)px from the cube's centre
// and is 40px wide, so the pair spans 400s + 76px. Two bounds, whichever binds:
//
//  - the viewport, plus ~16px of breathing room, against a panel as wide as the
//    viewport less the page's 8px side padding: 400s + 92 <= vw - 16. This is the one
//    that binds on a phone, where the panel spans the screen.
//  - the panel's own width: 400s + 76 <= panelW. This is the one that binds on a
//    lines page, whose three-column board gives each line's deck a ~337px box - a
//    third of the page less an 8px inset, not the 480px rail an article's deck gets.
//
// Full size wherever both fit, which is every desktop article and most tablets;
// floored so a very narrow phone still gets a legible cube. The reserved space before
// this mounts is mirrored in CSS - the min-height clamp on .tank-article-artifact in
// tank-article-template.ts and the desktop override in tank-lines-template.ts. Change
// one, change both.
//
// The panel is the mount's PARENT: the mount point is a flex item sized by its content
// (0px wide on an article page, where the cube just paints around that point), so its
// own box says nothing about the room available - see Fishtank's wrapper note.
function deckScale(host: HTMLElement): number {
    const vw = document.documentElement.clientWidth;
    const panelW = (host.parentElement ?? host).getBoundingClientRect().width;
    const byPanel = panelW > 0 ? (panelW - 76) / 400 : 1;
    return Math.min(1, Math.max(0.6, Math.min((vw - 108) / 400, byPanel)));
}

// Re-sized on resize so a phone rotated to landscape gets its full-size cube back,
// and on the panel's own resize - a lines page's board reflows from one column to
// three at 1180px, which changes the room without changing it by the same ratio.
// Fishtank paints its stage scaled but keeps the 420px layout box, so a smaller cube
// would leave STAGE_H * (1 - s) / 2 of unpainted stage above it and below it; the
// wrapper pulls exactly that back so the panel tightens around the cube. Margins, not
// a transform: a transformed ancestor would become the containing block for the fixed
// captain widget and its modal overlays (same reason the homepage showcase gives).
const ArticleDeck: React.FC<{ payload: DeckPayload; slug: string; host: HTMLElement }> = ({ payload, slug, host }) => {
    const [scale, setScale] = useState(() => deckScale(host));
    useEffect(() => {
        const remeasure = () => setScale(deckScale(host));
        remeasure();
        window.addEventListener('resize', remeasure);
        window.addEventListener('orientationchange', remeasure);
        const panel = host.parentElement;
        const observer = panel && typeof ResizeObserver !== 'undefined' ? new ResizeObserver(remeasure) : null;
        if (panel) observer?.observe(panel);
        return () => {
            window.removeEventListener('resize', remeasure);
            window.removeEventListener('orientationchange', remeasure);
            observer?.disconnect();
        };
    }, [host]);
    const reclaim = Math.round((STAGE_H * (1 - scale)) / 2);
    return (
        <div style={reclaim ? { margin: `${-reclaim}px 0` } : undefined}>
            <Fishtank payload={payload} slug={slug} scale={scale} />
        </div>
    );
};

function mount() {
    // "Polymarket prices" - this market's current prices, in place of the dated
    // fallback (the prices when the Tank was created). Same contract as the indexes
    // island below: the fallback stays until the island confirms it has something real
    // to show, so a failed fetch or no JS leaves the dated fallback in place. One
    // island per `[data-tank-market]`: an article has one, a lines page has one per
    // line, each carrying its own seed script.
    document.querySelectorAll<HTMLElement>('[data-tank-market]').forEach((marketRoot) => {
        const marketData = marketRoot.querySelector('script[type="application/json"]');
        if (!marketData?.textContent) return;
        try {
            const seed = JSON.parse(marketData.textContent) as MarketPanelSeed;
            const fallback = marketRoot.querySelector('.tank-article-market-fallback');
            const host = document.createElement('div');
            marketRoot.appendChild(host);
            createRoot(host).render(<ArticleMarket seed={seed} onReady={() => fallback?.remove()} />);
        } catch (err) {
            console.error('[Tank Article] market panel seed unreadable:', err);
        }
    });

    // "Indexes this story moved", in place of the bullet cards. The cards stay in the
    // DOM until this component confirms it has something to show - onReady fires only
    // after a successful fetch with at least one tagged index - so an untagged Tank, a
    // failed fetch, or no JS at all leaves the server-rendered fallback untouched.
    // createRoot().render() appends rather than replaces, hence the explicit clear.
    const indexRoot = document.getElementById('tank-article-indexes');
    const indexSlug = indexRoot?.getAttribute('data-slug');
    if (indexRoot && indexSlug) {
        const cards = indexRoot.querySelector('.tank-article-cards');
        const host = document.createElement('div');
        indexRoot.appendChild(host);
        createRoot(host).render(
            <ArticleIndexes slug={indexSlug} onReady={() => cards?.remove()} />,
        );
    }
    // Identity chrome (username + Ember chip with the mini nav, the captain widget,
    // and the Inbox modal host) in its own root, mounted before - and independently
    // of - the deck: a malformed payload below must not cost a signed-in reader their
    // header. Each piece self-gates on /api/toolbar-state, so logged-out readers get
    // just the "Log in" pill and a clean article.
    const chromeRoot = document.getElementById('tank-article-chrome');
    if (chromeRoot) createRoot(chromeRoot).render(<ContentChrome />);

    // One deck per `[data-tank-deck]`, its payload in the JSON script right after it (a
    // sibling, not a child: root.render clears the container). An article mounts one; a
    // lines page mounts one per line, each with its own slug so picks land on the right
    // row.
    document.querySelectorAll<HTMLElement>('[data-tank-deck]').forEach((root) => {
        const dataEl = root.nextElementSibling;
        if (!(dataEl instanceof HTMLScriptElement) || !dataEl.textContent) return;
        try {
            const { slug, ...payload } = JSON.parse(dataEl.textContent) as DeckPayload & { slug: string };
            createRoot(root).render(<ArticleDeck payload={payload} slug={slug} host={root} />);
        } catch (err) {
            console.error('[Tank Article Deck] Failed to parse deck payload:', err);
        }
    });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
