// ===================================================================================
// HEATCHECKS TANK — ARTICLE DECK CLIENT (tank-article-deck-client.tsx)
// ===================================================================================
// Small standalone bundle (built via scripts/build-tank-article-deck.ts, not the main
// Vite app) that hydrates on top of the server-rendered Tank article body. Reads the
// embedded #tank-article-deck-data JSON and renders the shared Fishtank artifact
// (components/Fishtank.tsx - also reused by the-tank page's carousel).
// ===================================================================================

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Fishtank, type DeckPayload } from './components/Fishtank';
import { PetWidget } from './components/PetWidget';
import { NotificationsHost } from './components/NotificationsHost';

function mount() {
    const root = document.getElementById('tank-article-deck-root');
    const dataEl = document.getElementById('tank-article-deck-data');
    if (!root || !dataEl || !dataEl.textContent) return;
    try {
        const { slug, ...payload } = JSON.parse(dataEl.textContent) as DeckPayload & { slug: string };
        createRoot(root).render(
            <>
                <Fishtank payload={payload} slug={slug} />
                {/* Captain widget, viewport-fixed like the homepage so it rides the
                    scroll. Self-gating: renders nothing for logged-out readers (its
                    pet fetch 401s) or petless accounts - the article reads clean. */}
                <PetWidget variant="fixed" />
                {/* Inbox modal host - article pages have no header menu, so the pet
                    widget's Inbox action is the only opener here. */}
                <NotificationsHost />
            </>
        );
    } catch (err) {
        console.error('[Tank Article Deck] Failed to parse deck payload:', err);
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
