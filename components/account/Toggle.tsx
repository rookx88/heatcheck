// An accessible on/off switch row for the account page: label + description on the
// left, the switch on the right. The parent owns the value (optimistic update + revert
// happen in account-client.tsx's updatePref); this component only shows the pending
// state, a brief "Saved", or the server's error text when the flip was rejected.

import React, { useId, useState } from 'react';

interface ToggleProps {
    label: string;
    description?: string;
    checked: boolean;
    onChange: (next: boolean) => Promise<string | null>;
}

export const Toggle: React.FC<ToggleProps> = ({ label, description, checked, onChange }) => {
    const id = useId();
    const [pending, setPending] = useState(false);
    const [saved, setSaved] = useState(0); // a counter so a second save re-triggers the fade
    const [error, setError] = useState<string | null>(null);

    const flip = async () => {
        if (pending) return;
        setPending(true);
        setError(null);
        const message = await onChange(!checked);
        setPending(false);
        if (message) setError(message);
        else setSaved((n) => n + 1);
    };

    return (
        <div className="hc-acct-row hc-acct-row--inline">
            <div className="hc-acct-row-text">
                <span className="hc-acct-row-label" id={`${id}-label`}>{label}</span>
                {description && <span className="hc-acct-row-desc" id={`${id}-desc`}>{description}</span>}
                {error && <p className="hc-acct-error" role="alert">{error}</p>}
            </div>
            <div className="hc-acct-row-control">
                {saved > 0 && !error && <span key={saved} className="hc-acct-saved" aria-live="polite">Saved</span>}
                <button
                    type="button"
                    role="switch"
                    className="hc-acct-switch"
                    aria-checked={checked}
                    aria-labelledby={`${id}-label`}
                    aria-describedby={description ? `${id}-desc` : undefined}
                    disabled={pending}
                    onClick={flip}
                />
            </div>
        </div>
    );
};
