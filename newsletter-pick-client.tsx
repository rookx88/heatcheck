// Standalone bundle (built via scripts/build-newsletter-pick.ts, not the main Vite app)
// mounted on the static /newsletter-pick/ page - the only surface a newsletter_only Tank
// can render on, reached exclusively via the signed link in the weekly email
// (emails/NewsletterIssue.tsx). No login: the token in the URL is the auth.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { getOrCreateVisitorId } from './tank-analytics-client';

interface PreviewData {
    weekKey: string;
    hook: string;
    question: string;
    sides: string[];
}

function NewsletterPick() {
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') || '';
    const issue = params.get('issue') || '';

    const [preview, setPreview] = useState<PreviewData | null>(null);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [result, setResult] = useState<{ side: string } | null>(null);

    useEffect(() => {
        if (!token || !issue) {
            setLoadError('This link is missing required information.');
            return;
        }
        fetch(`/api/newsletter/pick?token=${encodeURIComponent(token)}&issue=${encodeURIComponent(issue)}`)
            .then(async (res) => {
                const data = await res.json();
                if (!res.ok) throw new Error(data.message || 'This link is invalid or has expired.');
                setPreview(data);
            })
            .catch((err) => setLoadError(err.message || 'Failed to load this week’s pick.'));
    }, [token, issue]);

    const handlePick = async (side: string, sideIndex: number) => {
        setSubmitting(true);
        setSubmitError(null);
        try {
            const res = await fetch('/api/newsletter/pick', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, issue, side, sideIndex, visitorId: getOrCreateVisitorId() }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.message || 'Failed to submit your call.');
            setResult({ side: data.pick.side });
        } catch (err: any) {
            setSubmitError(err.message || 'Failed to submit your call.');
        } finally {
            setSubmitting(false);
        }
    };

    if (loadError) {
        return <div className="hc-newsletter-pick-error">{loadError}</div>;
    }
    if (!preview) {
        return <div className="hc-newsletter-pick-loading">Loading this week’s exclusive call...</div>;
    }
    if (result) {
        return (
            <div className="hc-newsletter-pick-done">
                <h2>You called it: {result.side}</h2>
                <p>We’ll let you know how it settles.</p>
            </div>
        );
    }

    return (
        <div className="hc-newsletter-pick">
            <p className="hc-newsletter-pick-eyebrow">Newsletter Exclusive · Week {preview.weekKey}</p>
            <h1>{preview.hook}</h1>
            <p className="hc-newsletter-pick-question">{preview.question}</p>
            <div className="hc-newsletter-pick-sides">
                {preview.sides.map((side, i) => (
                    <button key={side} disabled={submitting} onClick={() => handlePick(side, i)}>
                        {side}
                    </button>
                ))}
            </div>
            {submitError && <p className="hc-newsletter-pick-error">{submitError}</p>}
        </div>
    );
}

function mount() {
    const root = document.getElementById('newsletter-pick-root');
    if (!root) return;
    createRoot(root).render(<NewsletterPick />);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
