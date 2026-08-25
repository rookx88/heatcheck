// Standalone bundle (built via scripts/build-login.ts, not the main Vite app) mounted
// on the static /login/ page - the magic-link entry point and landing target.
//
// With ?token= in the URL this page consumes the link by POSTing it to
// /api/login/consume - deliberately a JS-initiated POST, never a GET that consumes on
// fetch, so email-scanner prefetching (Outlook SafeLinks, Gmail) can't burn the
// single-use nonce before the human clicks. Without a token it's the "enter email,
// get a link" form posting to /api/login.

import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getOrCreateVisitorId } from './tank-analytics-client';
import { setCachedAccount } from './tank-pick-client';

const RESEND_COOLDOWN_SECONDS = 60;

// Set by GET /api/discord/callback's no-session branch when Discord didn't grant a
// verified email to create/match an account from - a one-time notice, not state to
// track beyond the initial read.
function readDiscordNoEmailFlag(): boolean {
    return new URLSearchParams(window.location.search).get('discord') === 'no_email';
}

function RequestLinkForm({ initialError }: { initialError: string | null }) {
    const [email, setEmail] = useState('');
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(initialError);
    const [cooldown, setCooldown] = useState(0);
    const [discordNoEmail] = useState(readDiscordNoEmailFlag);

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
        return () => window.clearTimeout(t);
    }, [cooldown]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (sending || cooldown > 0) return;
        setSending(true);
        setError(null);
        try {
            const res = await fetch('/api/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: email.trim() }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.message || 'Could not send a login link right now.');
            setSent(true);
            // Server enforces the real cooldown; this just keeps the button honest.
            setCooldown(RESEND_COOLDOWN_SECONDS);
        } catch (err: any) {
            setError(err.message || 'Could not send a login link right now.');
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="hc-login">
            <p className="hc-login-eyebrow">Heatchecks Login</p>
            <h1>Get back in your tank</h1>
            {discordNoEmail && (
                <p className="hc-login-notice">
                    Discord didn't share a verified email with us, so we couldn't create your account that way —
                    enter your email below instead. You can still connect Discord afterward from your account page.
                </p>
            )}
            {sent ? (
                <>
                    <p className="hc-login-copy">
                        Check your inbox — your login link is on the way. It works once and expires in 15 minutes.
                    </p>
                    <button className="hc-login-button" disabled={cooldown > 0 || sending} onClick={handleSubmit as any}>
                        {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
                    </button>
                </>
            ) : (
                <>
                    <form onSubmit={handleSubmit}>
                        <p className="hc-login-copy">
                            Enter your email and we'll send a one-tap login link. No password — there isn't one.
                        </p>
                        <input
                            className="hc-login-input"
                            type="email"
                            required
                            autoFocus
                            placeholder="you@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            disabled={sending}
                        />
                        <button className="hc-login-button" type="submit" disabled={sending}>
                            {sending ? 'Sending…' : 'Email me a login link'}
                        </button>
                    </form>
                    <div className="hc-login-divider"><span>or</span></div>
                    <a className="hc-login-button hc-login-button--discord" href="/api/discord/link">
                        Continue with Discord
                    </a>
                </>
            )}
            {error && <p className="hc-login-error">{error}</p>}
        </div>
    );
}

function ConsumeToken({ token }: { token: string }) {
    const [error, setError] = useState<string | null>(null);
    const [email, setEmail] = useState<string | null>(null);
    const [onboarded, setOnboarded] = useState(true);
    // React 18 StrictMode double-invokes effects in dev; a second POST would see the
    // already-NULLed nonce and misreport "already used", so guard the first fire.
    const fired = useRef(false);

    useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        (async () => {
            try {
                const res = await fetch('/api/login/consume', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token, visitorId: getOrCreateVisitorId() }),
                });
                const data = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(data.message || 'This login link is invalid or has expired. Request a new one.');
                // Scrub ?token= from the URL immediately (before any navigation) so the
                // consumed token doesn't linger in browser history or a shared/copied URL.
                // The token is single-use and already consumed, but there's no reason to
                // leave it lying around.
                try {
                    window.history.replaceState(null, '', '/login/');
                } catch { /* non-fatal */ }
                setEmail(data.email as string);
                setCachedAccount({ email: data.email as string, verified: true });
                // Un-onboarded accounts go to the /welcome/ letter, not the homepage.
                // A missing field (stale cached bundle against a newer API) also
                // routes to /welcome/, which is safe: that page self-redirects when
                // the server says the account is already onboarded.
                setOnboarded(Boolean(data.onboarded));
                window.setTimeout(() => {
                    window.location.href = data.onboarded ? '/' : '/welcome/';
                }, 1500);
            } catch (err: any) {
                setError(err.message || 'This login link is invalid or has expired. Request a new one.');
            }
        })();
    }, [token]);

    if (error) return <RequestLinkForm initialError={error} />;
    if (email) {
        return (
            <div className="hc-login">
                <p className="hc-login-eyebrow">Heatchecks Login</p>
                <h1>You're in as {email}</h1>
                <p className="hc-login-copy">
                    {onboarded ? 'Taking you to your tank…' : 'One moment — there’s a letter waiting for you.'}
                </p>
            </div>
        );
    }
    return (
        <div className="hc-login">
            <p className="hc-login-copy">Logging you in…</p>
        </div>
    );
}

function LoginPage() {
    const token = new URLSearchParams(window.location.search).get('token') || '';
    return token ? <ConsumeToken token={token} /> : <RequestLinkForm initialError={null} />;
}

function mount() {
    const root = document.getElementById('login-root');
    if (!root) return;
    createRoot(root).render(<LoginPage />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
