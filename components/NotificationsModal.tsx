// The notifications inbox: opened from the header menus (homepage .hc-auth dropdown,
// MapHud on the map pages) via NotificationsHost. Lists the account's notifications
// newest-first; unread rows are bright with a gold dot and mark themselves read when
// clicked (user decision: per-item acknowledgement, never mark-all-on-open, so the
// unread styling and the pet badge stay meaningful). Read rows are greyed and inert.
//
// PHASE NOTE: no claim UI here - claiming is a later phase. Clicking only ever writes
// read_at.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
    getNotifications,
    markNotificationRead,
    dispatchNotificationsUpdated,
    type NotificationItem,
} from '../notifications-client';
import './TankScreen.css';
import './HatcheryModal.css';
import './NotificationsModal.css';

interface NotificationsModalProps {
    onClose: () => void;
}

function dateLabel(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime())
        ? ''
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export const NotificationsModal: React.FC<NotificationsModalProps> = ({ onClose }) => {
    const [items, setItems] = useState<NotificationItem[] | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [loggedOut, setLoggedOut] = useState(false);
    const closeRef = useRef<HTMLButtonElement>(null);

    const load = useCallback(async () => {
        setError(null);
        try {
            const list = await getNotifications();
            if (list === null) {
                setLoggedOut(true);
                setItems([]);
            } else {
                setItems(list);
            }
        } catch (e: any) {
            setError(e.message || 'Could not load notifications.');
            setItems([]);
        }
    }, []);

    useEffect(() => {
        load();
    }, [load]);

    // Same modal discipline as FeedModal: scroll lock, close-button focus, Escape +
    // X close only (overlay clicks deliberately don't close).
    useEffect(() => {
        const previous = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        closeRef.current?.focus();
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKey);
        return () => {
            document.body.style.overflow = previous;
            document.removeEventListener('keydown', onKey);
        };
    }, [onClose]);

    const handleRead = useCallback((item: NotificationItem) => {
        if (item.readAt) return;
        // Optimistic: grey the row immediately; the server write is idempotent and a
        // failure just leaves it unread again on the next fetch.
        const stamp = new Date().toISOString();
        setItems((prev) => prev?.map((n) => (n.id === item.id ? { ...n, readAt: stamp } : n)) ?? prev);
        markNotificationRead(item.id)
            .catch(() => {
                setItems((prev) => prev?.map((n) => (n.id === item.id ? { ...n, readAt: null } : n)) ?? prev);
            })
            .finally(() => dispatchNotificationsUpdated());
    }, []);

    return (
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel"
                role="dialog"
                aria-modal="true"
                aria-label="Notifications inbox"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Inbox</span>
                    <button ref={closeRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">
                    {items === null && <p className="notif-loading">Loading…</p>}

                    {error && (
                        <>
                            <p className="hatchery-error" role="alert">{error}</p>
                            <button className="hatchery-buy" onClick={load}>Retry</button>
                        </>
                    )}

                    {loggedOut && !error && (
                        <div className="tank-modal-empty">
                            <p>Log in to see your notifications.</p>
                            <a className="hatchery-buy" href="/login/">Log in</a>
                        </div>
                    )}

                    {items !== null && !error && !loggedOut && items.length === 0 && (
                        <div className="tank-modal-empty">
                            <p>No notifications yet — settle a pick to earn your first.</p>
                        </div>
                    )}

                    {items !== null && items.length > 0 && (
                        <ul className="notif-list">
                            {items.map((n) => {
                                const unread = n.readAt === null;
                                return (
                                    <li key={n.id}>
                                        <button
                                            type="button"
                                            className={`notif-item${unread ? '' : ' is-read'}`}
                                            onClick={() => handleRead(n)}
                                            disabled={!unread}
                                            aria-label={
                                                unread
                                                    ? `Unread: ${n.message} Click to mark read.`
                                                    : n.message
                                            }
                                        >
                                            {unread && <span className="notif-dot" aria-hidden="true" />}
                                            <span className="notif-message">{n.message}</span>
                                            <span className="notif-date">{dateLabel(n.createdAt)}</span>
                                        </button>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                </div>
            </div>
        </div>
    );
};

export default NotificationsModal;
