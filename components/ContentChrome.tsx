// Identity chrome for SCROLLING content pages - the analogue of what LandScreen gives
// the full-screen map pages. Same three pieces, same components, same single
// /api/toolbar-state hydration:
//   MapHud            - username + Ember chip with the mini nav, or a Log in pill when
//                       logged out (it self-gates; nothing renders while hydrating).
//   PetWidget(fixed)  - the captain, bottom-right, riding the scroll. Self-gating too:
//                       renders nothing for logged-out or petless visitors. "fixed" is
//                       the variant for normal pages ("card" hardcodes the map frame's
//                       geometry) - same choice tank-article-deck-client makes.
//   NotificationsHost - hosts the Inbox modal. Required: MapHud's and PetWidget's Inbox
//                       actions only DISPATCH the open event, they can't render it.
//
// MapHud is position:absolute, so it needs a positioned box to sit in. Here that's
// .hc-chrome-hud, an in-flow right-aligned slot the page puts under its topbar - so
// the chip lands where the homepage's Log in button does, and its dropdown overlays
// rather than shoving the page down. Pages using this must NOT have a transformed
// ancestor around it (that would trap PetWidget's fixed modal overlays); a plain
// .hc-page column is fine.

import React from 'react';
import { MapHud } from './MapHud';
import { PetWidget } from './PetWidget';
import { NotificationsHost } from './NotificationsHost';
import './ContentChrome.css';

export const ContentChrome: React.FC = () => (
    <>
        <div className="hc-chrome-hud">
            <MapHud />
        </div>
        <PetWidget variant="fixed" />
        <NotificationsHost />
    </>
);

export default ContentChrome;
