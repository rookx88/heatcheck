// Renders My Playbook when anything dispatches OPEN_PLAYBOOK_EVENT (the header menus).
// Mounted at the same known-safe spots as NotificationsHost, for the same reason: the
// menus live inside transformed map frames that would trap a position:fixed overlay.

import React, { useEffect, useState } from 'react';
import { PlaybookModal } from './PlaybookModal';
import { OPEN_PLAYBOOK_EVENT } from '../plays-client';

export const PlaybookHost: React.FC = () => {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const onOpen = () => setOpen(true);
        window.addEventListener(OPEN_PLAYBOOK_EVENT, onOpen);
        return () => window.removeEventListener(OPEN_PLAYBOOK_EVENT, onOpen);
    }, []);

    if (!open) return null;
    return <PlaybookModal onClose={() => setOpen(false)} />;
};

export default PlaybookHost;
