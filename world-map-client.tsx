// Standalone bundle (built via scripts/build-world-map.ts, not the main Vite app)
// that mounts the interactive world map on the /claim-your-spot/ static page.
// Every sport island is inert ("Coming Soon") on this page; only the central
// region is live, retargeted to the Tank and relabeled to match the page copy.

import React from 'react';
import { createRoot } from 'react-dom/client';
import { WorldMap } from './components/WorldMap';
import { WORLD_MAP_REGIONS, type WorldMapRegion } from './components/worldMapRegions';

const CLAIM_YOUR_SPOT_REGIONS: WorldMapRegion[] = WORLD_MAP_REGIONS.map((region) =>
  region.type === 'central'
    ? { ...region, name: 'The Tank', route: '/the-tank/' }
    : { ...region, disabled: true }
);

function mount() {
  const root = document.getElementById('world-map-root');
  if (!root) return;
  createRoot(root).render(<WorldMap regions={CLAIM_YOUR_SPOT_REGIONS} />);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
