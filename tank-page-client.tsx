// Standalone bundle (built via scripts/build-tank-page.ts, not the main Vite app)
// that mounts the full-screen Tank page: the clickable "Tanks Available" hotspot
// over assets/new-website/Tanks- Background.svg, and the modal carousel of
// available tanks.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { TankScreen, type TankEntry, type LinesBoardEntry } from './components/TankScreen';

function readJson<T>(id: string, fallback: T): T {
    const el = document.getElementById(id);
    if (!el || !el.textContent) return fallback;
    try {
        return JSON.parse(el.textContent) as T;
    } catch (err) {
        console.error(`[Tank Page] Failed to parse #${id}:`, err);
        return fallback;
    }
}

function mount() {
    const root = document.getElementById('tank-page-root');
    if (!root) return;
    const tanks = readJson<TankEntry[]>('tank-page-data', []);
    const linesBoard = readJson<LinesBoardEntry[]>('tank-lines-data', []);
    createRoot(root).render(<TankScreen tanks={tanks} linesBoard={linesBoard} backHref="/" />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
