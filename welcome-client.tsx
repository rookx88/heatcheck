// Standalone bundle (built via scripts/build-welcome.ts, not the main Vite app)
// mounted on the static /welcome/ page - the first-login letter from Sports McLaren,
// ending in the username "signature" that completes onboarding.
//
// Server truth only: the page asks GET /api/onboarding-status on load (and again on
// bfcache restore) and routes itself - no session -> /login/, already onboarded ->
// /the-tank/. The letter renders from letterData exactly once; the signature form
// keeps its own state so a taken-name 409 never disturbs the rest of the letter.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getOrCreateVisitorId } from './tank-analytics-client';

// Mirror of USERNAME_RE in lib/pages-functions/username.ts - instant feedback only;
// the server (and ultimately the DB's unique index) is authoritative.
const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;

interface LetterData {
    balance: number;
    pickCount: number;
    isFoundingEra: boolean;
}

// The founding-era record sentence, built only from real nonzero numbers -
// isFoundingEra guarantees at least one of the two is nonzero, but not both, so
// each fragment appears only when its number is real. Never renders a zero, never
// invents a number.
function RecordSentence({ data }: { data: LetterData }) {
    const parts: React.ReactNode[] = [];
    if (data.balance > 0) {
        parts.push(
            <React.Fragment key="ember">
                <span className="hc-letter-ember">{data.balance.toLocaleString()} Ember</span> standing against your name
            </React.Fragment>
        );
    }
    if (data.pickCount > 0) {
        parts.push(
            <React.Fragment key="picks">
                {data.pickCount === 1 ? 'one pick' : `${data.pickCount} picks`} on the record
            </React.Fragment>
        );
    }
    return (
        <>
            {parts.map((p, i) => (
                <React.Fragment key={i}>
                    {i > 0 ? ', and ' : ''}
                    {p}
                </React.Fragment>
            ))}
        </>
    );
}

function Letter({ data, children }: { data: LetterData; children: React.ReactNode }) {
    return (
        <div className="hc-letter">
            <p className="hc-letter-eyebrow">From the desk of Sports McLaren</p>
            <p className="hc-letter-role">Tenured Axolotl &middot; Inventor of Ember Harvesting</p>
            {data.isFoundingEra ? (
                <>
                    <p>To one of the early ones,</p>
                    <p>
                        I'll keep this short. You were here before the door had a proper handle, so you know
                        most of it already.
                    </p>
                    <p>
                        My name is Sports McLaren — axolotl, tenured, and the one who first worked out how to
                        draw Ember off a game that was going to be played anyway. You've been drawing some
                        yourself: <RecordSentence data={data} />. I checked the ledger twice. I always check
                        twice.
                    </p>
                    <p>
                        All of it carries forward. Nothing you've earned is going anywhere; it simply has a
                        proper home now.
                    </p>
                    <p>
                        There is more ahead — an egg that will want hatching, eventually, and a wider world
                        past the tanks — but I don't narrate the future. It shows up regardless.
                    </p>
                    <p>
                        One piece of business remains. A letter isn't finished until it's signed, and around
                        here, the signature is the name. Choose the one your record will answer to.
                    </p>
                </>
            ) : (
                <>
                    <p>To the newest name on the ledger,</p>
                    <p>
                        I'll keep this short. In my experience, long letters are how you can tell the writer
                        has nothing to say.
                    </p>
                    <p>
                        My name is Sports McLaren. I am an axolotl. I have been here longer than the paint,
                        and some years ago I worked out how to draw Ember off a game that was going to be
                        played anyway — they call it a mechanic now; at the time I called it a Tuesday. It
                        caught on.
                    </p>
                    <p>
                        Your account is new, and it holds exactly what you'd expect: nothing yet. I mention
                        this as a courtesy, not a criticism. Everything this account ever holds, you will
                        have put there yourself — Ember when your calls land, a record with your name on it.
                        I find that's the only kind of ledger worth keeping.
                    </p>
                    <p>
                        There is more ahead of you than a ledger, for what it's worth. An egg that will want
                        hatching, eventually. A wider world past the tanks. I don't narrate the future — it
                        shows up regardless.
                    </p>
                    <p>
                        One piece of business remains. A letter isn't finished until it's signed, and around
                        here, the signature is the name. Choose the one your work will answer to.
                    </p>
                </>
            )}
            {children}
            <p className="hc-letter-signoff">— S. McLaren</p>
        </div>
    );
}

function SignatureForm({ onSigned }: { onSigned: () => void }) {
    const [value, setValue] = useState('');
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        if (submitting) return;
        const username = value.trim();
        if (!USERNAME_RE.test(username)) {
            setError(
                username.length < 3 || username.length > 20
                    ? 'A signature runs 3 to 20 characters.'
                    : 'Letters, numbers, and underscores only.'
            );
            return;
        }
        setSubmitting(true);
        setError(null);
        try {
            const res = await fetch('/api/onboarding/complete', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, visitorId: getOrCreateVisitorId() }),
            });
            if (res.status === 401) {
                window.location.replace('/login/');
                return;
            }
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                // 400 validation / 409 taken: inline error, letter untouched, input
                // still editable - the person retries the signature, not the page.
                setError(data.message || 'Could not sign the letter right now. Try again.');
                setSubmitting(false);
                return;
            }
            // Success - including alreadyOnboarded (another tab/device won the race):
            // either way the account is signed; proceed under whichever name stuck.
            onSigned();
        } catch {
            setError('Could not sign the letter right now. Try again.');
            setSubmitting(false);
        }
    };

    return (
        <form onSubmit={handleSubmit}>
            <p className="hc-letter-sign-label">Sign here</p>
            <input
                className="hc-letter-signature"
                type="text"
                required
                autoFocus
                maxLength={20}
                placeholder="Your name in this world"
                value={value}
                onChange={(e) => setValue(e.target.value)}
                disabled={submitting}
                aria-label="Choose your username"
            />
            <p className="hc-letter-hint">3–20 characters. Letters, numbers, underscores. This is the name your record answers to.</p>
            <button className="hc-letter-button" type="submit" disabled={submitting}>
                {submitting ? 'Signing…' : 'Sign the letter'}
            </button>
            {error && <p className="hc-letter-error">{error}</p>}
        </form>
    );
}

function WelcomePage() {
    const [phase, setPhase] = useState<'loading' | 'letter' | 'signed'>('loading');
    const [letterData, setLetterData] = useState<LetterData | null>(null);
    // React 18 StrictMode double-invokes effects in dev; the status GET is harmless
    // twice but the guard keeps the redirect logic single-fire (same pattern as
    // login-client's ConsumeToken).
    const fired = useRef(false);

    const checkStatus = useCallback(async () => {
        try {
            const res = await fetch('/api/onboarding-status');
            if (res.status === 401) {
                window.location.replace('/login/');
                return;
            }
            const data = await res.json().catch(() => ({}));
            if (data.onboarded) {
                window.location.replace('/the-tank/');
                return;
            }
            if (data.letterData) {
                setLetterData(data.letterData as LetterData);
                setPhase((p) => (p === 'signed' ? p : 'letter'));
            }
        } catch {
            // Network hiccup: leave the loading state; a reload retries.
        }
    }, []);

    useEffect(() => {
        if (fired.current) return;
        fired.current = true;
        checkStatus();
    }, [checkStatus]);

    // bfcache restore (same fix as Fishtank's pageshow handler): a back-navigation
    // after signing must re-check with the server so it self-redirects instead of
    // resurrecting a submittable letter. A resurrected form that submits anyway just
    // gets alreadyOnboarded - this is belt and suspenders.
    useEffect(() => {
        const onPageShow = (e: PageTransitionEvent) => {
            if (!e.persisted) return;
            checkStatus();
        };
        window.addEventListener('pageshow', onPageShow);
        return () => window.removeEventListener('pageshow', onPageShow);
    }, [checkStatus]);

    const handleSigned = () => {
        setPhase('signed');
        window.setTimeout(() => {
            window.location.href = '/the-tank/';
        }, 1200);
    };

    if (phase === 'loading') {
        return <p className="hc-letter-loading">Opening your letter…</p>;
    }
    if (phase === 'signed') {
        return (
            <div className="hc-letter">
                <p className="hc-letter-eyebrow">From the desk of Sports McLaren</p>
                <p>Signed and entered into the record. The tank is this way.</p>
            </div>
        );
    }
    return (
        <Letter data={letterData as LetterData}>
            <SignatureForm onSigned={handleSigned} />
        </Letter>
    );
}

function mount() {
    const root = document.getElementById('welcome-root');
    if (!root) return;
    createRoot(root).render(<WelcomePage />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
