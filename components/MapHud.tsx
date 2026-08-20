// Top-right HUD on the map pages (Tank Land, Tank HQ, Hatchery, food shops) -
// replaces the old checkmark back button with the same identity surface the
// homepage header shows: username + Ember total. Clicking the chip opens a mini
// nav (Home / Log out). Logged out, it renders the homepage's "Log in" pill
// instead. Self-hydrating from the session cookie; balance refreshes on bfcache
// restores so it never shows a stale total after Back.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getSessionInfo, logout } from '../tank-pick-client';
import { getEmberBalance } from '../egg-shop-client';
import { dispatchInboxOpen } from '../notifications-client';
import './MapHud.css';

// Same flame glyph the homepage's ember chip uses.
const EmberIcon: React.FC = () => (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="currentColor">
        <path d="M12 2c.6 3.8-1.2 5.6-2.9 7.3C7.4 11 6 12.6 6 15a6 6 0 0 0 12 0c0-1.7-.6-3.1-1.5-4.5-.4 1-.9 1.7-1.8 2.3.3-3.4-1-6.5-2.7-8.8Z" />
    </svg>
);

export const MapHud: React.FC = () => {
    const [username, setUsername] = useState<string | null>(null);
    const [balance, setBalance] = useState<number | null>(null);
    const [loggedIn, setLoggedIn] = useState<boolean | null>(null); // null = still hydrating
    const [menuOpen, setMenuOpen] = useState(false);
    const [loggingOut, setLoggingOut] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);

    const hydrate = useCallback(async () => {
        try {
            const session = await getSessionInfo();
            if (!session) {
                setLoggedIn(false);
                return;
            }
            setLoggedIn(true);
            setUsername(session.username ?? session.email);
            const bal = await getEmberBalance();
            if (bal !== null) setBalance(bal);
        } catch {
            // HUD is chrome - fail quiet, keep whatever state we had.
            setLoggedIn((v) => v ?? false);
        }
    }, []);

    useEffect(() => {
        hydrate();
    }, [hydrate]);

    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (e.persisted) hydrate();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [hydrate]);

    // Click-away + Escape close the mini nav.
    useEffect(() => {
        if (!menuOpen) return;
        const onDown = (e: PointerEvent) => {
            if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') setMenuOpen(false);
        };
        document.addEventListener('pointerdown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('pointerdown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [menuOpen]);

    const doLogout = useCallback(async () => {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await logout();
        } catch {
            // Even if the request hiccups, leave the page - the homepage re-checks
            // the session server-side anyway.
        }
        window.location.href = '/';
    }, [loggingOut]);

    if (loggedIn === null) return null; // avoid a flash while hydrating
    if (!loggedIn) {
        return (
            <div className="map-hud">
                <a className="map-hud__login" href="/login/">Log in</a>
            </div>
        );
    }

    return (
        <div className="map-hud" ref={rootRef}>
            <button
                type="button"
                className="map-hud__chip"
                onClick={() => setMenuOpen((v) => !v)}
                aria-expanded={menuOpen}
                aria-haspopup="menu"
                aria-label={`${username ?? 'Account'} - ${balance ?? 0} Ember. Open menu`}
            >
                {username && <span className="map-hud__name">{username}</span>}
                <span className="map-hud__ember"><EmberIcon />{balance ?? '—'}</span>
            </button>
            {menuOpen && (
                <div className="map-hud__menu" role="menu">
                    <a className="map-hud__item" role="menuitem" href="/">Home</a>
                    {/* Dispatches to the page's NotificationsHost - the modal can't
                        render here, inside the transformed map frame (fixed-overlay
                        containing-block trap). */}
                    <button
                        type="button"
                        className="map-hud__item"
                        role="menuitem"
                        onClick={() => { setMenuOpen(false); dispatchInboxOpen(); }}
                    >
                        Inbox
                    </button>
                    <button type="button" className="map-hud__item" role="menuitem" onClick={doLogout} disabled={loggingOut}>
                        {loggingOut ? 'Logging out…' : 'Log out'}
                    </button>
                </div>
            )}
        </div>
    );
};

export default MapHud;
