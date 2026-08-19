// The Hatchery island (/the-hatchery/) - mounts the egg-shop scene with its two
// modals. Fourth/fifth entry of scripts/build-tank-bundles.ts alongside the other
// tank-world pages, so it shares the React/motion chunk.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { HatcheryScreen } from './components/HatcheryScreen';
// The modals render with the shared .tank-modal-* chrome, which lives in
// TankScreen.css - imported here so this page's CSS bundle carries it too (this
// page doesn't mount TankScreen itself).
import './components/TankScreen.css';

function mount() {
    const root = document.getElementById('hatchery-page-root');
    if (!root) return;
    createRoot(root).render(<HatcheryScreen />);
}

mount();
