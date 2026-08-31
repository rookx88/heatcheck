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

function mount() {
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
