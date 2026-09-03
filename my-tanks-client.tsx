// Standalone bundle (built via scripts/build-my-tanks.ts, not the main Vite app)
// mounted on the static /my-tanks/ page - a logged-in user's picks in two tabs:
// pending (not yet settled) and settled (result + Ember earned). Same standalone
// pattern as account-client.tsx: static shell, everything fetched client-side from
// GET /api/picks/mine. Deliberately does NOT import tank-pick-client - that module
// lives in the tank-shared chunk, and this page needs one raw fetch, not the
// pick-submission machinery.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContentChrome } from './components/ContentChrome';
import { formatGameTime, formatSettleDate, hasKickoffPassed } from './tank-deck-format';

interface PendingPick {
    slug: string;
    side: string;
    createdAt: string;
    kickoff: string | null;
    impliedProb: number | null; // implied_prob_at_lock, frozen at pick time (null on old rows)
    tagline: string;
}

interface SettledPick {
    slug: string;
    side: string;
    createdAt: string;
    settledAt: string | null;
    result: 'correct' | 'incorrect';
    tagline: string;
    emberAwarded: number;
}

interface MinePicks {
    pending: PendingPick[];
    settled: SettledPick[];
    settledCursor: string | null;
    record: { correct: number; incorrect: number; emberTotal: number };
}

const tankHref = (slug: string) => `/the-tank/articles/${encodeURIComponent(slug)}/`;

function PendingList({ picks }: { picks: PendingPick[] }) {
    if (picks.length === 0) {
        return (
            <p className="hc-mytanks-empty">
                No open picks right now. <a href="/the-tank-hq/">Head to The Tank HQ</a> to make your next call.
            </p>
        );
    }
    // Rows arrive kickoff-sorted (soonest first) from the server. A game that already
    // kicked off shows its live state instead of a stale start time.
    const now = Date.now();
    return (
        <ul className="hc-mytanks-list">
            {picks.map((p) => {
                const started = p.kickoff ? hasKickoffPassed(p.kickoff, now) : false;
                const pct = typeof p.impliedProb === 'number' && isFinite(p.impliedProb)
                    ? Math.round(p.impliedProb * 100)
                    : null;
                return (
                    <li key={p.slug} className="hc-mytanks-row">
                        <a href={tankHref(p.slug)}>{p.tagline}</a>
                        <div className="hc-mytanks-meta">
                            <span className="hc-mytanks-side">
                                You took &ldquo;{p.side}&rdquo;{pct !== null ? ` at ${pct}%` : ''}
                            </span>
                            {started ? (
                                <span className="hc-mytanks-live">In progress — settles soon</span>
                            ) : (
                                <>
                                    {p.kickoff && <span>{formatGameTime(p.kickoff)}</span>}
                                    <span>Settles after the game</span>
                                </>
                            )}
                        </div>
                    </li>
                );
            })}
        </ul>
    );
}

function SettledList({ picks, record, cursor, loadingMore, onLoadMore }: {
    picks: SettledPick[];
    record: MinePicks['record'];
    cursor: string | null;
    loadingMore: boolean;
    onLoadMore: () => void;
}) {
    if (picks.length === 0) {
        return <p className="hc-mytanks-empty">Nothing has settled yet - results land here once your games finish.</p>;
    }
    return (
        <>
            <p className="hc-mytanks-record">
                {record.correct}-{record.incorrect} on settled calls
                {record.emberTotal > 0 && <> · <span className="hc-mytanks-ember">+{record.emberTotal} Ember</span></>}
            </p>
            <ul className="hc-mytanks-list">
                {picks.map((p) => (
                    <li key={p.slug} className="hc-mytanks-row">
                        <a href={tankHref(p.slug)}>{p.tagline}</a>
                        <div className="hc-mytanks-meta">
                            <span className={`hc-mytanks-badge hc-mytanks-badge--${p.result}`}>
                                {p.result === 'correct' ? 'Correct' : 'Incorrect'}
                            </span>
                            <span className="hc-mytanks-side">You took &ldquo;{p.side}&rdquo;</span>
                            {p.settledAt && <span>{formatSettleDate(p.settledAt).replace('Resolves', 'Settled')}</span>}
                            {p.emberAwarded > 0 && <span className="hc-mytanks-ember">+{p.emberAwarded} Ember</span>}
                        </div>
                    </li>
                ))}
            </ul>
            {cursor && (
                <button type="button" className="hc-mytanks-more" onClick={onLoadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                </button>
            )}
        </>
    );
}

function MyTanksPage() {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [data, setData] = useState<MinePicks | null>(null);
    const [tab, setTab] = useState<'pending' | 'settled'>('pending');
    const [loadingMore, setLoadingMore] = useState(false);

    const loadMore = async () => {
        if (!data?.settledCursor || loadingMore) return;
        setLoadingMore(true);
        try {
            const res = await fetch(`/api/picks/mine?before=${encodeURIComponent(data.settledCursor)}`);
            const body = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(body.message || 'Failed to load more.');
            const page = body as Pick<MinePicks, 'settled' | 'settledCursor'>;
            setData((prev) => prev && {
                ...prev,
                settled: [...prev.settled, ...page.settled],
                settledCursor: page.settledCursor,
            });
        } catch {
            // Leave the button enabled - a retry can succeed.
        } finally {
            setLoadingMore(false);
        }
    };

    useEffect(() => {
        (async () => {
            try {
                const res = await fetch('/api/picks/mine');
                if (res.status === 401) {
                    window.location.replace('/login/');
                    return;
                }
                const body = await res.json().catch(() => ({}));
                if (!res.ok) throw new Error(body.message || 'Failed to load your picks.');
                const mine = body as MinePicks;
                setData(mine);
                // A returning user with nothing in flight lands on what they have.
                if (mine.pending.length === 0 && mine.settled.length > 0) setTab('settled');
                setPhase('ready');
            } catch {
                setPhase('error');
            }
        })();
    }, []);

    if (phase === 'loading') {
        return <p className="hc-mytanks-loading">Loading your Tanks…</p>;
    }
    if (phase === 'error' || !data) {
        return <p className="hc-mytanks-loading">Could not load your picks. Try refreshing.</p>;
    }

    return (
        <div className="hc-mytanks-card">
            <h1>My Tanks</h1>
            <div className="hc-mytanks-tabs" role="tablist">
                <button
                    type="button" role="tab" aria-selected={tab === 'pending'}
                    className={`hc-mytanks-tab${tab === 'pending' ? ' is-active' : ''}`}
                    onClick={() => setTab('pending')}
                >
                    Open ({data.pending.length})
                </button>
                <button
                    type="button" role="tab" aria-selected={tab === 'settled'}
                    className={`hc-mytanks-tab${tab === 'settled' ? ' is-active' : ''}`}
                    onClick={() => setTab('settled')}
                >
                    Settled ({data.record.correct + data.record.incorrect})
                </button>
            </div>
            {tab === 'pending'
                ? <PendingList picks={data.pending} />
                : (
                    <SettledList
                        picks={data.settled} record={data.record}
                        cursor={data.settledCursor} loadingMore={loadingMore} onLoadMore={loadMore}
                    />
                )}
        </div>
    );
}

function mount() {
    const root = document.getElementById('my-tanks-root');
    if (!root) return;
    // Sibling of the page, not a child: MyTanksPage returns early on its loading and
    // empty states, and the topbar chip should not blink out with them. ContentChrome
    // portals the chip into the topbar's [data-hc-hud-slot] (topbar(null) in
    // my-tanks-template.ts).
    createRoot(root).render(<><ContentChrome /><MyTanksPage /></>);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
