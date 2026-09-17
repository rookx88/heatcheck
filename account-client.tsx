// Standalone bundle (built via scripts/build-account.ts, not the main Vite app)
// mounted on the static /account/ page - where a logged-in user sees and manages
// their account: a standing strip over four tabs (Profile / Notifications /
// Connections / Security). Same standalone-bundle pattern as welcome-client.tsx:
// static HTML shell, all personalization fetched client-side - here from ONE request,
// GET /api/account (functions/api/account.ts), which batches identity, preferences,
// session count, Discord and standing.
//
// Tabs mirror my-portfolio-client.tsx: the active tab lives in ?tab= (absent for the
// default) and is kept honest with replaceState, so a refresh or a shared
// /account/?tab=notifications link - the one every email footer carries - lands on
// the right panel.

import React, { useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContentChrome } from './components/ContentChrome';
import { StandingStrip } from './components/account/StandingStrip';
import { ProfileTab } from './components/account/ProfileTab';
import { NotificationsTab } from './components/account/NotificationsTab';
import { ConnectionsTab, readDiscordFlag } from './components/account/ConnectionsTab';
import { SecurityTab } from './components/account/SecurityTab';
import { TAB_IDS, type AccountData, type PrefKey, type TabId } from './components/account/types';

const TAB_LABELS: Record<TabId, string> = {
    profile: 'Profile',
    notifications: 'Notifications',
    connections: 'Connections',
    security: 'Security',
};

function readTab(): TabId {
    const raw = new URLSearchParams(window.location.search).get('tab');
    return (TAB_IDS as readonly string[]).includes(raw ?? '') ? (raw as TabId) : 'profile';
}

function AccountPage() {
    const [phase, setPhase] = useState<'loading' | 'ready'>('loading');
    const [data, setData] = useState<AccountData | null>(null);
    const [tab, setTab] = useState<TabId>(readTab);
    // A Discord OAuth return lands on /account/?discord=... - open Connections so the
    // banner is on screen, whatever tab the URL otherwise says.
    const [flag] = useState(readDiscordFlag);

    useEffect(() => {
        if (flag) setTab('connections');
    }, [flag]);

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/account');
                if (res.status === 401) {
                    window.location.replace('/login/');
                    return;
                }
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.message || 'Failed to load account.');
                setData(body as AccountData);
                setPhase('ready');
            } catch {
                setPhase('ready');
            }
        })();
    }, []);

    // Keep the URL honest so a refresh or a shared link lands on the same tab.
    const select = (t: TabId) => {
        setTab(t);
        const url = new URL(window.location.href);
        if (t === 'profile') url.searchParams.delete('tab'); else url.searchParams.set('tab', t);
        url.searchParams.delete('discord');
        window.history.replaceState(null, '', url);
    };

    // Optimistic: flip locally, POST, revert on a non-2xx and hand the message back to
    // the switch. The server echoes the full prefs row, which wins over the local guess.
    const updatePref = useCallback(async (key: PrefKey, value: boolean): Promise<string | null> => {
        let previous: boolean | undefined;
        setData((d) => {
            if (!d) return d;
            previous = d.prefs[key];
            return { ...d, prefs: { ...d.prefs, [key]: value } };
        });
        try {
            const res = await fetch('/api/account/prefs', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ [key]: value }),
            });
            const body = await res.json().catch(() => ({}));
            if (res.status === 401) {
                window.location.replace('/login/');
                return 'Login required.';
            }
            if (!res.ok) throw new Error(body.message || 'Could not save that.');
            if (body.prefs) setData((d) => (d ? { ...d, prefs: body.prefs } : d));
            return null;
        } catch (err) {
            setData((d) => (d && previous !== undefined ? { ...d, prefs: { ...d.prefs, [key]: previous } } : d));
            return err instanceof Error ? err.message : 'Could not save that.';
        }
    }, []);

    if (phase === 'loading') {
        return <p className="hc-acct-loading">Loading your account…</p>;
    }
    if (!data) {
        return <p className="hc-acct-loading">Could not load your account. Try refreshing.</p>;
    }

    return (
        <div className="hc-acct-frame">
            <header className="hc-acct-head">
                <div>
                    <p className="hc-acct-eyebrow">Your account</p>
                    <h1>{data.username ?? 'Account'}</h1>
                </div>
            </header>

            <StandingStrip standing={data.standing} createdAt={data.createdAt} />

            <div className="hc-acct-tabs" role="tablist" aria-label="Account sections">
                {TAB_IDS.map((t) => (
                    <button
                        key={t}
                        type="button"
                        role="tab"
                        id={`hc-acct-tab-${t}`}
                        aria-selected={tab === t}
                        aria-controls={`hc-acct-panel-${t}`}
                        className={`hc-acct-tab${tab === t ? ' is-active' : ''}`}
                        onClick={() => select(t)}
                    >
                        {TAB_LABELS[t]}
                    </button>
                ))}
            </div>

            <div id={`hc-acct-panel-${tab}`} role="tabpanel" aria-labelledby={`hc-acct-tab-${tab}`}>
                {tab === 'profile' && <ProfileTab data={data} />}
                {tab === 'notifications' && <NotificationsTab prefs={data.prefs} onUpdate={updatePref} />}
                {tab === 'connections' && (
                    <ConnectionsTab
                        discord={data.discord}
                        flag={flag}
                        onUnlinked={() => setData((d) => (d ? { ...d, discord: { linked: false, username: null } } : d))}
                    />
                )}
                {tab === 'security' && (
                    <SecurityTab
                        data={data}
                        onSessionsRevoked={(active) => setData((d) => (d ? { ...d, sessions: { active } } : d))}
                    />
                )}
            </div>
        </div>
    );
}

function mount() {
    const root = document.getElementById('account-root');
    if (!root) return;
    // ContentChrome is a sibling of the page, not a child of it: AccountPage returns
    // early while loading and on failure, and the identity chip in the topbar should
    // not blink out with those states. It portals itself into the topbar's
    // [data-hc-hud-slot] (topbar(null) in account-template.ts).
    createRoot(root).render(<><ContentChrome /><AccountPage /></>);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
