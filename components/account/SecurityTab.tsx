// Security: sessions and the exit doors. "Log out of all other devices" hits
// POST /api/account/sessions/revoke-others (every live session but this one, server-
// side); "Log out" is the same POST /api/logout the header menu uses; and the danger
// zone is POST /api/account/delete - a soft delete (see that file's header for exactly
// what is scrubbed and what stays), gated on typing the username or DELETE, checked
// here for the button and again on the server.

import React, { useState } from 'react';
import type { AccountData } from './types';

interface SecurityTabProps {
    data: AccountData;
    onSessionsRevoked: (activeNow: number) => void;
}

export const SecurityTab: React.FC<SecurityTabProps> = ({ data, onSessionsRevoked }) => {
    const [revoking, setRevoking] = useState(false);
    const [revokeNote, setRevokeNote] = useState<string | null>(null);
    const [loggingOut, setLoggingOut] = useState(false);
    const [confirm, setConfirm] = useState('');
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const others = Math.max(0, data.sessions.active - 1);

    const revokeOthers = async () => {
        if (revoking) return;
        setRevoking(true);
        setRevokeNote(null);
        try {
            const res = await fetch('/api/account/sessions/revoke-others', { method: 'POST' });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || 'Could not log out other devices.');
            const n = Number(body.revoked ?? 0);
            setRevokeNote(n === 0 ? 'No other devices were signed in.' : `Logged out of ${n} other ${n === 1 ? 'device' : 'devices'}.`);
            onSessionsRevoked(Number(body.active ?? 1));
        } catch (err) {
            setRevokeNote(err instanceof Error ? err.message : 'Could not log out other devices.');
        } finally {
            setRevoking(false);
        }
    };

    const logout = async () => {
        if (loggingOut) return;
        setLoggingOut(true);
        try {
            await fetch('/api/logout', { method: 'POST' });
        } finally {
            window.location.replace('/');
        }
    };

    const trimmed = confirm.trim();
    const confirmOk = trimmed === 'DELETE' || (data.username !== null && trimmed.toLowerCase() === data.username.toLowerCase());

    const deleteAccount = async () => {
        if (deleting || !confirmOk) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            const res = await fetch('/api/account/delete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ confirm: trimmed }),
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || 'Could not delete the account.');
            window.location.replace('/');
        } catch (err) {
            setDeleteError(err instanceof Error ? err.message : 'Could not delete the account.');
            setDeleting(false);
        }
    };

    return (
        <section className="hc-acct-panel" aria-labelledby="hc-acct-sec-h">
            <h2 id="hc-acct-sec-h">Security</h2>
            <p className="hc-acct-lede">There&rsquo;s no password - a login link to your inbox is the key. These are the locks.</p>
            <div className="hc-acct-rows">
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">
                            Signed in on {data.sessions.active} {data.sessions.active === 1 ? 'device' : 'devices'}
                        </span>
                        <span className="hc-acct-row-desc">
                            {others === 0
                                ? 'Just this one. A login link opened elsewhere would show up here.'
                                : `This device plus ${others} ${others === 1 ? 'other' : 'others'}. Logging the others out takes effect on their next request.`}
                        </span>
                        {revokeNote && <p className="hc-acct-note" aria-live="polite">{revokeNote}</p>}
                    </div>
                    <div className="hc-acct-row-control">
                        <button type="button" className="hc-acct-button hc-acct-button--secondary" onClick={revokeOthers} disabled={revoking || others === 0}>
                            {revoking ? 'Logging out…' : 'Log out other devices'}
                        </button>
                    </div>
                </div>
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">Log out</span>
                        <span className="hc-acct-row-desc">Ends this session on this device only.</span>
                    </div>
                    <div className="hc-acct-row-control">
                        <button type="button" className="hc-acct-button hc-acct-button--secondary" onClick={logout} disabled={loggingOut}>
                            {loggingOut ? 'Logging out…' : 'Log out'}
                        </button>
                    </div>
                </div>
            </div>

            <div className="hc-acct-danger">
                <h2>Delete account</h2>
                <p className="hc-acct-lede">This can&rsquo;t be undone. Deleting your account:</p>
                <ul>
                    <li>Frees your username and email - the name goes back in the pool, and you could sign up fresh later.</li>
                    <li>Logs you out everywhere, disconnects Discord, releases your Captain&rsquo;s name and clears your inbox.</li>
                    <li>Keeps your past calls and Ember history in the books, but no longer tied to anything that identifies you.</li>
                    <li>Removes you from the Hall of Fame and stops every email.</li>
                </ul>
                <label className="hc-acct-row-desc" htmlFor="hc-acct-confirm">
                    Type <strong>{data.username ?? 'DELETE'}</strong>{data.username ? ' (or DELETE)' : ''} to confirm.
                </label>
                <div className="hc-acct-confirm">
                    <input
                        id="hc-acct-confirm"
                        className="hc-acct-input"
                        type="text"
                        autoComplete="off"
                        spellCheck={false}
                        value={confirm}
                        onChange={(e) => setConfirm(e.target.value)}
                        placeholder={data.username ?? 'DELETE'}
                    />
                    <button type="button" className="hc-acct-button hc-acct-button--danger" onClick={deleteAccount} disabled={!confirmOk || deleting}>
                        {deleting ? 'Deleting…' : 'Delete my account'}
                    </button>
                </div>
                {deleteError && <p className="hc-acct-error" role="alert">{deleteError}</p>}
            </div>
        </section>
    );
};
