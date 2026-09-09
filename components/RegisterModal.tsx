// Join HeatChecks / Log in - the auth modal behind the homepage's logged-out
// register CTA and every "Log in" pill. All of the actual auth UI lives in the
// shared AuthForm (magic link + Discord - the same component the /login/ page
// renders); this file is only the tank-modal chrome around it: overlay, header,
// close button, Escape handling, and the body-scroll lock.
//
// Registration IS login here (one endpoint, one form), so the two variants differ
// only in the header and the pitch line: "Join <logo>" with the Ember / Mud Puppy
// value prop, or "Log in" with a welcome-back line. /login/ stays as a real page
// for the emailed link to land on and as the no-JS fallback every pill still hrefs.

import React, { useEffect, useRef } from 'react';
import { AuthForm } from './AuthForm';
import './TankScreen.css';    // shared .tank-modal-* chrome
import './RegisterModal.css';

export type AuthModalVariant = 'register' | 'login';

interface RegisterModalProps {
    onClose: () => void;
    variant?: AuthModalVariant;
}

export const RegisterModal: React.FC<RegisterModalProps> = ({ onClose, variant = 'register' }) => {
    const closeButtonRef = useRef<HTMLButtonElement>(null);
    const isLogin = variant === 'login';

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

    return (
        // Same non-dismissing overlay contract as the other tank modals.
        <div className="tank-modal-overlay">
            <div
                className="tank-modal-panel register-modal"
                role="dialog"
                aria-modal="true"
                aria-label={isLogin ? 'Log in to HeatChecks' : 'Join HeatChecks'}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="tank-modal-header">
                    {isLogin ? (
                        <span>Log in</span>
                    ) : (
                        // The wordmark stands in for the word: "Join" + the same logo
                        // the page header carries. alt keeps the title readable.
                        <span className="register-modal__title">
                            Join
                            <img
                                className="register-modal__logo"
                                src="/assets/images/heatchecks-logo.webp"
                                alt="HeatChecks"
                                width="500"
                                height="241"
                                decoding="async"
                            />
                        </span>
                    )}
                    <button ref={closeButtonRef} className="tank-modal-close" onClick={onClose} aria-label="Close">
                        &times;
                    </button>
                </div>
                <div className="tank-modal-body">
                    <AuthForm
                        // Highlighted rather than plain text so the line keys to the art
                        // right above it: gold "Ember", purple "Mud Puppy" (the colour the
                        // character actually is).
                        lede={
                            isLogin ? (
                                <>Welcome back — get back in your tank.</>
                            ) : (
                                <>
                                    Make picks, earn <span className="hc-authform-hl-ember">Ember</span>, hatch
                                    and raise your own <span className="hc-authform-hl-puppy">Mud Puppy</span>.
                                </>
                            )
                        }
                        onDone={onClose}
                    />
                </div>
            </div>
        </div>
    );
};

// The login pill's modal: same panel, "Log in" header, welcome-back line.
export const LoginModal: React.FC<{ onClose: () => void }> = ({ onClose }) => (
    <RegisterModal variant="login" onClose={onClose} />
);

export default RegisterModal;
