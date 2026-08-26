// Logged-out echo of the pet widget (components/PetWidget.tsx): there's no real
// pet to show yet, so this renders the same base portrait/name chrome, but a
// click opens an info panel explaining what a Mud Puppy is instead of the real
// Feed/Inventory actions, ending in the register flow (RegisterModal).

import React, { useState } from 'react';
import { PetPortrait } from './PetPortrait';
import { RegisterModal } from './RegisterModal';
import './TankScreen.css';
import './PetWidget.css';
import './MudPuppyPromo.css';

interface MudPuppyPromoProps {
    // Mirrors PetWidget's variant prop - 'fixed' for the homepage's scrolling page.
    variant?: 'card' | 'fixed';
}

// render_mode 'none' (not 'filter') so petImageFilter() applies no hue-rotate -
// this always shows the base green art, since there's no real pet color yet.
const PLACEHOLDER_PET = { render_mode: 'none', render_config: {}, state: 'hungry' as const };

export const MudPuppyPromo: React.FC<MudPuppyPromoProps> = ({ variant = 'card' }) => {
    const [infoOpen, setInfoOpen] = useState(false);
    const [registerOpen, setRegisterOpen] = useState(false);

    return (
        <div className={`pet-widget pet-widget--${variant}`}>
            <div className="pet-widget__row">
                <button
                    type="button"
                    className="pet-widget__pet"
                    onClick={() => setInfoOpen(true)}
                    aria-label="Your Mud Puppy - what is it?"
                >
                    <PetPortrait pet={PLACEHOLDER_PET} />
                </button>
            </div>
            <div className="pet-widget__name">Your Mud Puppy</div>

            {infoOpen && (
                <div className="tank-modal-overlay" onClick={() => setInfoOpen(false)}>
                    <div
                        className="tank-modal-panel"
                        role="dialog"
                        aria-modal="true"
                        aria-label="About your Mud Puppy"
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div className="tank-modal-header">
                            <span>Your Mud Puppy</span>
                            <button className="tank-modal-close" onClick={() => setInfoOpen(false)} aria-label="Close">
                                &times;
                            </button>
                        </div>
                        <div className="tank-modal-body mudpuppy-promo-body">
                            <PetPortrait pet={PLACEHOLDER_PET} size={120} />
                            <p>
                                Mud Puppies are creatures hatched from eggs that accompany you to build
                                your training facility, team and eventual franchise. Not only does your
                                pet compete in tournaments and competitions but they also help you find
                                rare items.
                            </p>
                            <button
                                type="button"
                                className="hatchery-confirm mudpuppy-promo-cta"
                                onClick={() => { setInfoOpen(false); setRegisterOpen(true); }}
                            >
                                Click here to register to get started today!
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {registerOpen && <RegisterModal onClose={() => setRegisterOpen(false)} />}
        </div>
    );
};

export default MudPuppyPromo;
