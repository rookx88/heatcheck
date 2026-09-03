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

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { MapHud } from './MapHud';
import { PetWidget } from './PetWidget';
import { NotificationsHost } from './NotificationsHost';
import './ContentChrome.css';

export const ContentChrome: React.FC = () => {
    // Pages whose topbar was built with topbar(null) (waitlist-landing-template)
    // carry an empty [data-hc-hud-slot] on the logo's line, in place of the old
    // "Learn more" link. When one exists the chip belongs THERE, so it reads as part
    // of the header rather than a second row under it - hence a portal, since the
    // slot is server-rendered markup outside this component's own React root.
    // Resolved once, lazily: the slot is in the HTML before this bundle runs, so
    // there is no first-paint miss, and pages without one keep the .hc-chrome-hud
    // row exactly as before.
    const [topbarSlot] = useState<Element | null>(
        () => (typeof document === 'undefined' ? null : document.querySelector('[data-hc-hud-slot]'))
    );

    return (
        <>
            {topbarSlot
                ? createPortal(<MapHud />, topbarSlot)
                : <div className="hc-chrome-hud"><MapHud /></div>}
            <PetWidget variant="fixed" />
            <NotificationsHost />
        </>
    );
};

export default ContentChrome;
