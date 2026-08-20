// Join HeatChecks - the register modal behind the homepage's logged-out register
// CTA. Registration IS the magic link: POST /api/login (via requestLoginLink) is one
// endpoint for new and returning emails alike - an unknown email creates the account
// row and gets the same link, and the response never reveals whether the address
// already existed. So this modal is just an email form + a sent state; there is no
// password and no separate signup path to build.

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { requestLoginLink } from '../tank-pick-client';
import './TankScreen.css';    // shared .tank-modal-* chrome
import './HatcheryModal.css'; // shared action/caption/error classes
import './RegisterModal.css';

type SendState = 'idle' | 'sending' | 'sent' | 'error';

interface RegisterModalProps {
    onClose: () => void;
}

export const RegisterModal: React.FC<RegisterModalProps> = ({ onClose }) => {
    const [email, setEmail] = useState('');
    const [state, setState] = useState<SendState>('idle');
    const [error, setError] = useState<string | null>(null);
    const closeButtonRef = useRef<HTMLButtonElement>(null);

    useEffect(() => {
        document.body.style.overflow = 'hidden';
        closeButtonRef.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => {
            document.body.style.overflow = '';
            document.removeEventListener('keydown', onKeyDown);
        };
    }, [onClose]);

    const submit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = email.trim();
        if (!trimmed || state === 'sending') return;
        setState('sending');
        setError(null);
        try {
            await requestLoginLink(trimmed);
            setState('sent');
        } catch (err: any) {
            // Includes the server's rate-limit copy on 429 (1/minute, capped daily).
            setError(err?.message || 'Something went wrong — try again.');
            setState('error');
        }
    }, [email, state]);

    return (
        // Same non-dismissing overlay contract as the other tank modals.
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel register-modal"
                role="dialog"
                aria-modal="true"
                aria-label="Join HeatChecks"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    <span>Join HeatChecks</span>
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">
                    {state === 'sent' ? (
                        <div className="register-modal-sent">
                            <div className="register-modal-check" aria-hidden="true">&#10003;</div>
                            <p className="register-modal-lede">Check your inbox!</p>
                            <p className="hatchery-caption">
                                Your magic link creates your account and signs you in — one tap, no password.
                            </p>
                            <button className="hatchery-buy" onClick={onClose}>Got it</button>
                        </div>
                    ) : (
                        <>
                            <p className="register-modal-lede">
                                Make picks, earn Ember, hatch and raise your own Mud Puppy.
                            </p>
                            <form className="register-modal-form" onSubmit={submit}>
                                <input
                                    className="register-modal-input"
                                    type="email"
                                    required
                                    value={email}
                                    onChange={(e) => { setEmail(e.target.value); setError(null); }}
                                    placeholder="you@email.com"
                                    autoFocus
                                    aria-label="Email address"
                                />
                                <button className="hatchery-confirm" type="submit" disabled={state === 'sending' || !email.trim()}>
                                    {state === 'sending' ? 'Sending…' : 'Send my magic link'}
                                </button>
                            </form>
                            <p className="hatchery-caption">No password — there isn&rsquo;t one. The link in your inbox does everything.</p>
                            {error && <div className="hatchery-error" role="alert">{error}</div>}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

export default RegisterModal;
