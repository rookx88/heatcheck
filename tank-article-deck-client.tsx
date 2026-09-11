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

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Fishtank, type DeckPayload } from './components/Fishtank';
import { ContentChrome } from './components/ContentChrome';
import { ArticleIndexes } from './components/ArticleIndexes';
import { ArticleMarket, type MarketPanelSeed } from './components/ArticleMarket';

function mount() {
    // "Polymarket prices" - this market's current prices, in place of the dated
    // fallback (the prices when the story was written). Same contract as the indexes
    // island below: the fallback stays until the island confirms it has something real
    // to show, so a failed fetch or no JS leaves the dated fallback in place.
    const marketRoot = document.getElementById('tank-article-market');
    const marketData = document.getElementById('tank-article-market-data');
    if (marketRoot && marketData?.textContent) {
        try {
            const seed = JSON.parse(marketData.textContent) as MarketPanelSeed;
            const fallback = marketRoot.querySelector('.tank-article-market-fallback');
            const host = document.createElement('div');
            marketRoot.appendChild(host);
            createRoot(host).render(<ArticleMarket seed={seed} onReady={() => fallback?.remove()} />);
        } catch (err) {
            console.error('[Tank Article] market panel seed unreadable:', err);
        }
    }

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

    const root = document.getElementById('tank-article-deck-root');
    const dataEl = document.getElementById('tank-article-deck-data');
    if (!root || !dataEl || !dataEl.textContent) return;
    try {
        const { slug, ...payload } = JSON.parse(dataEl.textContent) as DeckPayload & { slug: string };
        createRoot(root).render(<Fishtank payload={payload} slug={slug} />);
    } catch (err) {
        console.error('[Tank Article Deck] Failed to parse deck payload:', err);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
