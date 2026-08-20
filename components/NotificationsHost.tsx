// Renders the inbox modal when anything dispatches OPEN_INBOX_EVENT (the header
// menus). Exists because the menus themselves can't host a fixed-overlay modal:
// MapHud lives inside the map pages' transformed frames, and a transformed ancestor
// becomes the containing block for position:fixed (the same trap documented at
// PetWidget's mount points). This host is mounted at those known-safe spots instead -
// beside the PetWidget in LandScreen/TankScreen, and on a body-level root on the
// homepage.

import React, { useEffect, useState } from 'react';
import { NotificationsModal } from './NotificationsModal';
import { OPEN_INBOX_EVENT } from '../notifications-client';

export const NotificationsHost: React.FC = () => {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onOpen = () => setOpen(true);
        window.addEventListener(OPEN_INBOX_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_INBOX_EVENT, onOpen);
    }, []);

    if (!open) return null;
    return <NotificationsModal onClose={() => setOpen(false)} />;
};

export default NotificationsHost;
