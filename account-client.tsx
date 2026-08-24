// Standalone bundle (built via scripts/build-account.ts, not the main Vite app)
// mounted on the static /account/ page - the only place a logged-in user can see and
// manage their account, currently just the Discord link. Same standalone-bundle
// pattern as welcome-client.tsx: static HTML shell, all personalization fetched
// client-side from GET /api/session.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

interface SessionData {
    email: string;
    username: string | null;
    discordLinked: boolean;
    discordUsername: string | null;
}

// Query flag set by GET /api/discord/callback's redirect (?discord=linked|error|taken)
// - a one-time banner, not part of ongoing page state.
function readDiscordFlag(): 'linked' | 'error' | 'taken' | null {
    const value = new URLSearchParams(window.location.search).get('discord');
    return value === 'linked' || value === 'error' || value === 'taken' ? value : null;
}

function DiscordFlagBanner({ flag }: { flag: 'linked' | 'error' | 'taken' | null }) {
    if (!flag) return null;
    const text = flag === 'linked'
        ? 'Discord connected.'
        : flag === 'taken'
        ? 'That Discord account is already linked to a different Heatchecks account.'
        : 'Could not connect Discord - try again.';
    return <p className={`hc-account-flag hc-account-flag--${flag === 'linked' ? 'ok' : 'error'}`}>{text}</p>;
}

function AccountPage() {
    const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
    const [session, setSession] = useState<SessionData | null>(null);
    const [unlinking, setUnlinking] = useState(false);
    const [flag] = useState(readDiscordFlag);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/session');
                if (res.status === 401) {
                    window.location.replace('/login/');
                    return;
                }
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.message || 'Failed to load account.');
                setSession(data as SessionData);
                setPhase('ready');
            } catch {
                setPhase('ready');
            }
        })();
    }, []);

    const handleUnlink = async () => {
        if (unlinking || !session) return;
        setUnlinking(true);
        try {
            const res = await fetch('/api/discord/unlink', { method: 'POST' });
            if (res.ok) {
                setSession({ ...session, discordLinked: false, discordUsername: null });
            }
        } finally {
            setUnlinking(false);
        }
    };

    if (phase === 'loading') {
        return <p className="hc-account-loading">Loading your account…</p>;
    }
    if (!session) {
        return <p className="hc-account-loading">Could not load your account. Try refreshing.</p>;
    }

    return (
        <div className="hc-account-card">
            <h1>Account</h1>
            <DiscordFlagBanner flag={flag} />
            <dl className="hc-account-facts">
                <dt>Name</dt>
                <dd>{session.username ?? '—'}</dd>
                <dt>Email</dt>
                <dd>{session.email}</dd>
            </dl>
            <div className="hc-account-discord">
                <h2>Discord</h2>
                {session.discordLinked ? (
                    <>
                        <p>Connected as <strong>{session.discordUsername}</strong>. Picks made from Discord count toward your daily picks.</p>
                        <button type="button" className="hc-account-button hc-account-button--secondary" onClick={handleUnlink} disabled={unlinking}>
                            {unlinking ? 'Disconnecting…' : 'Disconnect'}
                        </button>
                    </>
                ) : (
                    <>
                        <p>Connect Discord to make picks directly from the server - they count the same as picks made here.</p>
                        <a className="hc-account-button" href="/api/discord/link">Connect Discord</a>
                    </>
                )}
            </div>
        </div>
    );
}

function mount() {
    const root = document.getElementById('account-root');
    if (!root) return;
    createRoot(root).render(<AccountPage />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
