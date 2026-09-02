// The ONE auth form: magic-link email + "Continue with Discord", shared by the
// homepage register modal (RegisterModal.tsx) and the /login/ page
// (login-client.tsx). Registration IS login here - POST /api/login is a single
// endpoint for new and returning emails alike, and the Discord callback likewise
// creates-or-matches an account - so there is exactly one form to maintain, and
// the two surfaces differ only in the chrome they wrap around it.
//
// CLASS PREFIX: every class here is `hc-authform-*`, NOT `hc-auth-*`. The homepage
// styles its own logged-in header chip as `.hc-auth { display: flex }`
// (lib/pages-functions/homepage/render.ts), and this form's root used to carry that
// exact class - so on the homepage the header's rule turned this form's children
// (lede, form, divider, Discord link) into a horizontal row, which is what made the
// register modal render as four squashed columns. The prefix keeps the two apart.
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
    // Bold pitch line above the form (the register modal's value prop). A node, not
    // a string, so callers can highlight their own key words (the modal golds
    // "Ember" and purples "Mud Puppy" to tie the copy to the art above it). Omit for
    // surfaces that carry their own heading (the /login/ page h1).
    lede?: React.ReactNode;
    // Renders the "Discord didn't share a verified email" notice - set by the
    // /login/ page when it lands with ?discord=no_email.
    discordNoEmail?: boolean;
    // Seed the error slot (the /login/ page falls back to this form with the
    // consume-token failure message).
    initialError?: string | null;
    // When provided, the sent state offers a "Got it" button that calls this -
    // the modal passes its onClose so people can dismiss after sending.
    onDone?: () => void;
    // Hides the world/Mud Puppy art band. Nothing sets it today; it exists so a
    // future cramped surface can drop the decoration without forking the form.
    hideArt?: boolean;
}

// The decorative band: the sports world the homepage leads with, and the Mud Puppy
// the copy promises, sized down to modal scale. Purely presentational - aria-hidden
// with empty alt so it adds nothing to the accessibility tree, since the lede
// underneath already says what both of them are.
//
// The *-auth.webp files are downscaled derivatives (scripts/make-auth-art.ts), not
// the full-size homepage art: rendered at ~120px, the originals cost 530KB between
// them versus 48KB here. Eager rather than lazy, deliberately - this art is above
// the fold on /login/ and on screen the instant the modal opens, so there is
// nothing to defer, and at this weight there's no reason to.
const AuthArt: React.FC = () => (
    <div className="hc-authform-art" aria-hidden="true">
        <img
            className="hc-authform-art-world"
            src="/assets/images/world-map-auth.webp"
            alt=""
            width="118"
            height="118"
            loading="eager"
            decoding="async"
        />
        <img
            className="hc-authform-art-puppy"
            src="/assets/images/mudpuppy-auth.webp"
            alt=""
            height="134"
            loading="eager"
            decoding="async"
        />
    </div>
);

const DiscordMark: React.FC = () => (
    <svg className="hc-authform-discord-mark" viewBox="0 0 127 96" aria-hidden="true" focusable="false">
        <path
            fill="currentColor"
            d="M107.7 8.07A105.15 105.15 0 0 0 81.47 0a72.06 72.06 0 0 0-3.36 6.83 97.68 97.68 0 0 0-29.11 0A72.37 72.37 0 0 0 45.64 0a105.89 105.89 0 0 0-26.25 8.09C2.79 32.65-1.71 56.6.54 80.21a105.73 105.73 0 0 0 32.17 16.15 77.7 77.7 0 0 0 6.89-11.11 68.42 68.42 0 0 1-10.85-5.18c.91-.66 1.8-1.34 2.66-2a75.57 75.57 0 0 0 64.32 0c.87.71 1.76 1.39 2.66 2a68.68 68.68 0 0 1-10.87 5.19 77 77 0 0 0 6.89 11.1 105.25 105.25 0 0 0 32.19-16.14c2.64-27.38-4.51-51.11-18.9-72.15ZM42.45 65.69C36.18 65.69 31 60 31 53s5-12.74 11.43-12.74S54 46 53.89 53s-5.05 12.69-11.44 12.69Zm42.24 0C78.41 65.69 73.25 60 73.25 53s5-12.74 11.44-12.74S96.23 46 96.12 53s-5.04 12.69-11.43 12.69Z"
        />
    </svg>
);

export const AuthForm: React.FC<AuthFormProps> = ({ lede, discordNoEmail, initialError = null, onDone, hideArt }) => {
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
            <div className="hc-authform hc-authform-sent">
                <div className="hc-authform-check" aria-hidden="true">&#10003;</div>
                <p className="hc-authform-sent-title">Check your inbox!</p>
                <p className="hc-authform-copy">
                    Your magic link is on the way — it signs you in, or creates your account if
                    you&rsquo;re new. It works once and expires in 15 minutes.
                </p>
                <button
                    className="hc-authform-button"
                    disabled={cooldown > 0 || sending}
                    onClick={handleSubmit as any}
                >
                    {cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend link'}
                </button>
                {onDone && (
                    <button className="hc-authform-button hc-authform-button--quiet" onClick={onDone}>
                        Got it
                    </button>
                )}
                {error && <p className="hc-authform-error" role="alert">{error}</p>}
            </div>
        );
    }

    return (
        <div className="hc-authform">
            {!hideArt && <AuthArt />}
            {lede && <p className="hc-authform-lede">{lede}</p>}
            {discordNoEmail && (
                <p className="hc-authform-notice">
                    Discord didn&rsquo;t share a verified email with us, so we couldn&rsquo;t create your
                    account that way — enter your email below instead. You can still connect Discord
                    afterward from your account page.
                </p>
            )}
            <form onSubmit={handleSubmit}>
                <p className="hc-authform-copy">
                    Enter your email and we&rsquo;ll send a one-tap magic link — it signs you in, or
                    creates your account if you&rsquo;re new. No password, there isn&rsquo;t one.
                </p>
                <input
                    className="hc-authform-input"
                    type="email"
                    required
                    autoFocus
                    placeholder="you@email.com"
                    value={email}
                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                    disabled={sending}
                    aria-label="Email address"
                />
                <button className="hc-authform-button" type="submit" disabled={sending || !email.trim()}>
                    {sending ? 'Sending…' : 'Send my magic link'}
                </button>
            </form>
            <div className="hc-authform-divider"><span>or</span></div>
            <a className="hc-authform-button hc-authform-button--discord" href="/api/discord/link">
                <DiscordMark />
                Continue with Discord
            </a>
            {error && <p className="hc-authform-error" role="alert">{error}</p>}
        </div>
    );
};

export default AuthForm;
