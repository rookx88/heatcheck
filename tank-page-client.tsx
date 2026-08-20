// Standalone bundle (built via scripts/build-tank-bundles.ts, not the main Vite app)
// that mounts the full-screen Tank HQ page (/the-tank-hq/): the clickable "Tanks
// Available" hotspot over assets/new-website/Tanks- Background.svg, and the modal
// carousel of available tanks. Top-right carries the MapHud (user + Ember + mini nav).

import React from 'react';
import { createRoot } from 'react-dom/client';
import { TankScreen, type TankEntry } from './components/TankScreen';

function mount() {
    const root = document.getElementById('tank-page-root');
    const dataEl = document.getElementById('tank-page-data');
    if (!root) return;
    let tanks: TankEntry[] = [];
    if (dataEl && dataEl.textContent) {
        try {
            tanks = JSON.parse(dataEl.textContent);
        } catch (err) {
            console.error('[Tank Page] Failed to parse tanks payload:', err);
        }
    }
    createRoot(root).render(<TankScreen tanks={tanks} />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
