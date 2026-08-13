// Standalone bundle (built via scripts/build-analytics-beacon.ts, not the main Vite
// app) loaded on every renderHead()-based page (see scripts/templates/waitlist-landing-
// template.ts). Fires a single page_view event on load - no DOM mounting, unlike the
// other standalone bundles (world-map.js, tank-page.js).

import { trackEvent } from './tank-analytics-client';

trackEvent('page_view', { path: window.location.pathname });
