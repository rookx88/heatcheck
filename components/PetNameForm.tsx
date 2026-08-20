// The one pet-naming form, shared by the incubator's hatch reveal (name your fresh
// captain) and the pet widget's "Name your pet" modal (for anyone who dismissed the
// reveal early). Names are one-time and globally unique - across other pets AND
// account usernames - so the server is the judge; this form just submits and
// surfaces its verdicts. On success it announces the updated pet through the
// hc:pet-updated window event so every mounted widget/HUD refreshes.

import React, { useCallback, useState } from 'react';
import { namePet, NameRejectedError, type PetInfo } from '../egg-shop-client';
import './PetNameForm.css';

export const PET_UPDATED_EVENT = 'hc:pet-updated';

export function announcePetUpdated(): void {
    window.dispatchEvent(new CustomEvent(PET_UPDATED_EVENT));
}

interface PetNameFormProps {
    onNamed: (pet: PetInfo) => void;
}

export const PetNameForm: React.FC<PetNameFormProps> = ({ onNamed }) => {
    const [name, setName] = useState('');
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = useCallback(async () => {
        const trimmed = name.trim();
        if (!trimmed || saving) return;
        setSaving(true);
        setError(null);
        try {
            const { pet } = await namePet(trimmed);
            announcePetUpdated();
            onNamed(pet);
        } catch (err: any) {
            if (err instanceof NameRejectedError) {
                setError(err.message);
            } else {
                setError(err?.message || 'Naming failed — try again.');
            }
        } finally {
            setSaving(false);
        }
    }, [name, saving, onNamed]);

    return (
        <form
            className="pet-name-form"
            onSubmit={(e) => { e.preventDefault(); submit(); }}
        >
            <input
                className="pet-name-input"
                type="text"
                value={name}
                onChange={(e) => { setName(e.target.value); setError(null); }}
                placeholder="Name your mud puppy"
                maxLength={20}
                autoFocus
                aria-label="Pet name"
            />
            <button className="hatchery-confirm pet-name-save" type="submit" disabled={saving || !name.trim()}>
                {saving ? 'Naming…' : 'Name it'}
            </button>
            {error && <div className="hatchery-error pet-name-error" role="alert">{error}</div>}
            <div className="hatchery-caption">One name, forever — 2-20 letters, numbers, or spaces. It must be one of a kind.</div>
        </form>
    );
};

export default PetNameForm;
