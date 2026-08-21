// The one way a pet is drawn anywhere (widget, feed modal, name modal, hatch
// reveal): the shared tinted base body, with the satiated aura layered behind it
// while state === 'satisfied'. The aura is pure state feedback - it appears when the
// pet is fed past the Hungry threshold and vanishes once decay drops it back below,
// so "is my pet okay?" is answerable at a glance without ever exposing the number.

import React from 'react';
import { PET_IMAGE_SRC, petImageFilter } from './petRender';
import './PetPortrait.css';

export const AURA_IMAGE_SRC = '/assets/images/pets/aura-satiated.svg';

// Structural subset of egg-shop-client's PetInfo - everything the portrait needs,
// nothing it doesn't, so hatch outcomes and widget pets both fit.
interface PortraitPet {
    render_mode: string;
    render_config: Record<string, unknown>;
    state: 'hungry' | 'satisfied';
}

export const PetPortrait: React.FC<{
    pet: PortraitPet;
    // The pet image's square edge in px; the aura overflows it slightly on all sides.
    // OMIT it where stylesheet rules own the sizing (PetWidget's responsive
    // .pet-portrait__img rules) - the wrapper shrink-wraps the img either way, so
    // the aura's percentage insets track whatever size the body renders at.
    size?: number;
    className?: string;
    alt?: string;
}> = ({ pet, size, className, alt = '' }) => (
    <span className={`pet-portrait${className ? ` ${className}` : ''}`}>
        {pet.state === 'satisfied' && (
            <img className="pet-portrait__aura" src={AURA_IMAGE_SRC} alt="" aria-hidden="true" />
        )}
        <img
            className="pet-portrait__img"
            src={PET_IMAGE_SRC}
            style={{ filter: petImageFilter(pet.render_mode, pet.render_config) }}
            alt={alt}
            {...(size !== undefined ? { width: size, height: size } : {})}
        />
    </span>
);

export default PetPortrait;
