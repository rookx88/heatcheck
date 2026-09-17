// Connections: the Discord link (functions/api/discord/link.ts -> callback.ts ->
// unlink.ts). The one-time banner reads the ?discord= flag callback.ts redirects back
// with - linked | taken | error | state - and the unlink call now surfaces its failure
// instead of silently leaving the button re-enabled.

import React, { useState } from 'react';

export type DiscordFlag = 'linked' | 'error' | 'taken' | 'state';

// Query flag set by GET /api/discord/callback's redirect - a one-time banner, not part
// of ongoing page state.
export function readDiscordFlag(): DiscordFlag | null {
    const value = new URLSearchParams(window.location.search).get('discord');
    return value === 'linked' || value === 'error' || value === 'taken' || value === 'state' ? value : null;
}

const FLAG_COPY: Record<DiscordFlag, string> = {
    linked: 'Discord connected.',
    taken: 'That Discord account is already linked to a different Heatchecks account.',
    error: 'Could not connect Discord - try again.',
    state: 'That Discord sign-in didn’t start in this browser. Start again from here.',
};

interface ConnectionsTabProps {
    discord: { linked: boolean; username: string | null };
    flag: DiscordFlag | null;
    onUnlinked: () => void;
}

export const ConnectionsTab: React.FC<ConnectionsTabProps> = ({ discord, flag, onUnlinked }) => {
    const [unlinking, setUnlinking] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleUnlink = async () => {
        if (unlinking) return;
        setUnlinking(true);
        setError(null);
        try {
            const res = await fetch('/api/discord/unlink', { method: 'POST' });
            if (res.ok) onUnlinked();
            else setError('Could not disconnect Discord - try again.');
        } catch {
            setError('Could not disconnect Discord - try again.');
        } finally {
            setUnlinking(false);
        }
    };

    return (
        <section className="hc-acct-panel" aria-labelledby="hc-acct-conn-h">
            <h2 id="hc-acct-conn-h">Connections</h2>
            <p className="hc-acct-lede">Other places this account can act from.</p>
            {flag && (
                <p className={`hc-acct-flag hc-acct-flag--${flag === 'linked' ? 'ok' : 'error'}`} role="status">{FLAG_COPY[flag]}</p>
            )}
            <div className="hc-acct-rows">
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">Discord</span>
                        <span className="hc-acct-row-desc">
                            {discord.linked ? (
                                <>Connected as <strong>{discord.username}</strong>. Picks made from Discord count toward your daily picks.</>
                            ) : (
                                <>Connect Discord to make picks directly from the server - they count the same as picks made here.</>
                            )}
                        </span>
                        {error && <p className="hc-acct-error" role="alert">{error}</p>}
                    </div>
                    <div className="hc-acct-row-control">
                        {discord.linked ? (
                            <button type="button" className="hc-acct-button hc-acct-button--secondary" onClick={handleUnlink} disabled={unlinking}>
                                {unlinking ? 'Disconnecting…' : 'Disconnect'}
                            </button>
                        ) : (
                            <a className="hc-acct-button" href="/api/discord/link">Connect Discord</a>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
};
