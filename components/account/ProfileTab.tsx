// Profile: who this account is. Username and email are read-only - there is no
// rename flow (the signature is permanent; add_username_to_waitlist.sql provisioned
// a cooldown column but nothing uses it) and email is the account's identity. The one
// action is resending the verification code, through POST /api/resend-verification,
// whose contract is non-enumerating: it always answers { sent: true }, so the copy
// here is deliberately generic and the button just rests for its 60s cooldown.

import React, { useEffect, useState } from 'react';
import type { AccountData } from './types';

const RESEND_COOLDOWN_S = 60;

export const ProfileTab: React.FC<{ data: AccountData }> = ({ data }) => {
    const [cooldown, setCooldown] = useState(0);
    const [sentNote, setSentNote] = useState<string | null>(null);

    useEffect(() => {
        if (cooldown <= 0) return;
        const t = window.setTimeout(() => setCooldown((c) => c - 1), 1000);
        return () => window.clearTimeout(t);
    }, [cooldown]);

    const resend = async () => {
        if (cooldown > 0) return;
        setCooldown(RESEND_COOLDOWN_S);
        try {
            const res = await fetch('/api/resend-verification', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email: data.email }),
            });
            setSentNote(res.ok
                ? 'If that address still needs verifying, a fresh code is on its way. Check spam if it takes a minute.'
                : 'Could not send right now - try again in a minute.');
        } catch {
            setSentNote('Could not send right now - try again in a minute.');
        }
    };

    return (
        <section className="hc-acct-panel" aria-labelledby="hc-acct-profile-h">
            <h2 id="hc-acct-profile-h">Profile</h2>
            <p className="hc-acct-lede">Your signature and the inbox this account belongs to.</p>
            <div className="hc-acct-rows">
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">Username</span>
                        <span className="hc-acct-row-desc">Signatures are permanent - it&rsquo;s the name on the Hall of Fame.</span>
                    </div>
                    <div className="hc-acct-row-control"><span className="hc-acct-row-value">{data.username ?? '—'}</span></div>
                </div>
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">Email</span>
                        <span className="hc-acct-row-desc">Login links and settlement emails go here.</span>
                    </div>
                    <div className="hc-acct-row-control"><span className="hc-acct-row-value">{data.email}</span></div>
                </div>
                <div className="hc-acct-row">
                    <div className="hc-acct-row-text">
                        <span className="hc-acct-row-label">Verification</span>
                        <span className="hc-acct-row-desc">
                            {data.verified
                                ? 'This inbox is confirmed.'
                                : 'Confirm your inbox so settlement results and the newsletter can reach you.'}
                        </span>
                        {sentNote && <p className="hc-acct-note" aria-live="polite">{sentNote}</p>}
                    </div>
                    <div className="hc-acct-row-control">
                        {data.verified ? (
                            <span className="hc-acct-badge hc-acct-badge--ok">Verified</span>
                        ) : (
                            <>
                                <span className="hc-acct-badge hc-acct-badge--warn">Unverified</span>
                                <button type="button" className="hc-acct-button hc-acct-button--secondary" onClick={resend} disabled={cooldown > 0}>
                                    {cooldown > 0 ? `Sent (${cooldown}s)` : 'Resend code'}
                                </button>
                            </>
                        )}
                    </div>
                </div>
            </div>
        </section>
    );
};
