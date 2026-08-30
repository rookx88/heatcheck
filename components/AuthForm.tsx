// The ONE auth form: magic-link email + "Continue with Discord", shared by the
// homepage register modal (RegisterModal.tsx) and the /login/ page
// (login-client.tsx). Registration IS login here - POST /api/login is a single
// endpoint for new and returning emails alike, and the Discord callback likewise
// creates-or-matches an account - so there is exactly one form to maintain, and
// the two surfaces differ only in the chrome they wrap around it.
//
// Bundling note: login-client.tsx is a standalone esbuild bundle (build-login.ts)
// whose CSS output (public/assets/login.css) exists because this module imports
// AuthForm.css - keep the import even though the tank/homepage bundles also carry
// these styles through their own CSS pipeline.

import React, { useEffect, useState } from 'react';
import { requestLoginLink } from '../tank-pick-client';
import './AuthForm.css';

// Client-side echo of the server's real 1/60s resend limit - keeps the button
// honest without pretending to be the enforcement.
const RESEND_COOLDOWN_SECONDS = 60;

interface AuthFormProps {
    // Bold pitch line above the form (the register modal's value prop). Omit for
    // surfaces that carry their own heading (the /login/ page h1).
    lede?: string;
    // Renders the "Discord didn't share a verified email" notice - set by the
    // /login/ page when it lands with ?discord=no_email.
    discordNoEmail?: boolean;
    // Seed the error slot (the /login/ page falls back to this form with the
    // consume-token failure message).
    initialError?: string | null;
    // When provided, the sent state offers a "Got it" button that calls this -
    // the modal passes its onClose so people can dismiss after sending.
    onDone?: () => void;
}

export const AuthForm: React.FC<AuthFormProps> = ({ lede, discordNoEmail, initialError = null, onDone }) => {
    const [email, setEmail] = useState('');
    const [sending, setSending] = useState(false);
    const [sent, setSent] = useState(false);
    const [error, setError] = useState<string | null>(initialError);
    const [cooldown, setCooldown] = useState(0);

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = window.setTimeout(() => setCooldown((s) => s - 1), 1000);
        return () => window.clearTimeout(t);
    }, [cooldown]);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim();
        if (!trimmed || sending || cooldown > 0) return;
        setSending(true);
        setError(null);
        try {
            await requestLoginLink(trimmed);
            setSent(true);
            setCooldown(RESEND_COOLDOWN_SECONDS);
        } catch (err: any) {
            // Includes the server's rate-limit copy on 429 (1/minute, capped daily).
            setError(err?.message || 'Could not send a magic link right now.');
        } finally {
            setSending(false);
        }
    };

    if (sent) {
        return (
            <div className="hc-auth-sent">
                <div className="hc-auth-check" aria-hidden="true">&#10003;</div>
                <p className="hc-auth-sent-title">Check your inbox!</p>
                <p className="hc-auth-copy">
                    Your magic link is on the way — it signs you in, or creates your account if
                    you&rsquo;re new. It works once and expires in 15 minutes.
                </p>
                <button
                    className="hc-auth-button"
                    disabled={cooldown > 0 || sending}
                    onClick={handleSubmit as any}
                >
                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
                </button>
                {onDone && (
                    <button className="hc-auth-button hc-auth-button--quiet" onClick={onDone}>
                        Got it
                    </button>
                )}
                {error && <p className="hc-auth-error" role="alert">{error}</p>}
            </div>
        );
    }

    return (
        <div className="hc-auth">
            {lede && <p className="hc-auth-lede">{lede}</p>}
            {discordNoEmail && (
                <p className="hc-auth-notice">
                    Discord didn&rsquo;t share a verified email with us, so we couldn&rsquo;t create your
                    account that way — enter your email below instead. You can still connect Discord
                    afterward from your account page.
                </p>
            )}
            <form onSubmit={handleSubmit}>
                <p className="hc-auth-copy">
                    Enter your email and we&rsquo;ll send a one-tap magic link — it signs you in, or
                    creates your account if you&rsquo;re new. No password, there isn&rsquo;t one.
                </p>
                <input
                    className="hc-auth-input"
                    type="email"
                    required
                    autoFocus
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                    disabled={sending}
                    aria-label="Email address"
                />
                <button className="hc-auth-button" type="submit" disabled={sending || !email.trim()}>
                    {sending ? 'Sending…' : 'Send my magic link'}
                </button>
            </form>
            <div className="hc-auth-divider"><span>or</span></div>
            <a className="hc-auth-button hc-auth-button--discord" href="/api/discord/link">
                Continue with Discord
            </a>
            {error && <p className="hc-auth-error" role="alert">{error}</p>}
        </div>
    );
};

export default AuthForm;
