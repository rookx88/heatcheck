// Join HeatChecks - the register modal behind the homepage's logged-out register
// CTA. All of the actual auth UI lives in the shared AuthForm (magic link +
// Discord - the same component the /login/ page renders); this file is only the
// tank-modal chrome around it: overlay, header, close button, Escape handling,
// and the body-scroll lock.

import React, { useEffect, useRef } from 'react';
import { AuthForm } from './AuthForm';
import './TankScreen.css';    // shared .tank-modal-* chrome
import './RegisterModal.css';

interface RegisterModalProps {
    onClose: () => void;
}

export const RegisterModal: React.FC<RegisterModalProps> = ({ onClose }) => {
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
                    <AuthForm
                        lede="Make picks, earn Ember, hatch and raise your own Mud Puppy."
                        onDone={onClose}
                    />
                </div>
            </div>
        </div>
    );
};

export default RegisterModal;
