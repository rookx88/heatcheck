// ===================================================================================
// HEATCHECKS TANK — ARTICLE DECK CLIENT (tank-article-deck-client.tsx)
// ===================================================================================
// Small standalone bundle (built via scripts/build-tank-article-deck.ts, not the main
// Vite app) that hydrates on top of the server-rendered Tank article body. Reads the
// JSON embedded next to each deck root and renders the shared Fishtank artifact
// (components/Fishtank.tsx - also reused by the-tank page's carousel).
// ===================================================================================

import React from 'react';
import { createRoot } from 'react-dom/client';
import { Fishtank, type DeckPayload } from './components/Fishtank';

// One deck per `[data-tank-deck]`, its payload in the JSON script right after it (a
// sibling, not a child: root.render clears the container). An article mounts one; a lines
// page (scripts/templates/tank-lines-template.ts) mounts one per line, each with its own
// slug so a pick lands on the right tank_pages row.
function mount() {
    document.querySelectorAll<HTMLElement>('[data-tank-deck]').forEach((root) => {
        const dataEl = root.nextElementSibling;
        if (!(dataEl instanceof HTMLScriptElement) || !dataEl.textContent) return;
        try {
            const { slug, ...payload } = JSON.parse(dataEl.textContent) as DeckPayload & { slug: string };
            createRoot(root).render(<Fishtank payload={payload} slug={slug} />);
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
