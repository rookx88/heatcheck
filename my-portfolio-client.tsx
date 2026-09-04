// Standalone bundle (built via scripts/build-my-portfolio.ts, not the main Vite app)
// mounted on the static /my-portfolio/ page - everything a signed-in user holds, in two
// top-level tabs that each own their own fetch, loading and error state:
//
//   Tanks   - their picks: Open (not yet settled) and Settled (result + Ember earned),
//             from GET /api/picks/mine. This is the former My Tanks page, unchanged.
//   Indexes - their TANKDAQ share holdings: Active positions priced right now, and the
//             full trade History, from GET /api/tankdaq/holdings.
//
// The two are independent on purpose. The old page gated everything on /api/picks/mine
// succeeding, so a portfolio section hung off the same fetch would vanish whenever picks
// failed. ?tab=indexes deep-links the second tab (the ticker pages link there).
//
// Same standalone pattern as account-client.tsx: static shell, all personalization
// fetched client-side. Deliberately does NOT import tank-pick-client - that module lives
// in the tank-shared chunk, and this page needs raw fetches, not the pick-submission
// machinery.

import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ContentChrome } from './components/ContentChrome';
import { formatGameTime, formatSettleDate, hasKickoffPassed } from './tank-deck-format';
import { getHoldings, type HoldingsResponse, type HoldingPosition, type TradeHistoryItem } from './tankdaq-shares-client';

// ---------------------------------------------------------------------------------
// Tanks (picks) - the former My Tanks page
// ---------------------------------------------------------------------------------

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
            <p className="hc-portfolio-empty">
                No open picks right now. <a href="/the-tank-hq/">Head to The Tank HQ</a> to make your next call.
            </p>
        );
    }
    // Rows arrive kickoff-sorted (soonest first) from the server. A game that already
    // kicked off shows its live state instead of a stale start time.
    const now = Date.now();
    return (
        <ul className="hc-portfolio-list">
            {picks.map((p) => {
                const started = p.kickoff ? hasKickoffPassed(p.kickoff, now) : false;
                const pct = typeof p.impliedProb === 'number' && isFinite(p.impliedProb)
                    ? Math.round(p.impliedProb * 100)
                    : null;
                return (
                    <li key={p.slug} className="hc-portfolio-row">
                        <a href={tankHref(p.slug)}>{p.tagline}</a>
                        <div className="hc-portfolio-meta">
                            <span className="hc-portfolio-side">
                                You took &ldquo;{p.side}&rdquo;{pct !== null ? ` at ${pct}%` : ''}
                            </span>
                            {started ? (
                                <span className="hc-portfolio-live">In progress — settles soon</span>
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
        return <p className="hc-portfolio-empty">Nothing has settled yet - results land here once your games finish.</p>;
    }
    return (
        <>
            <p className="hc-portfolio-record">
                {record.correct}-{record.incorrect} on settled calls
                {record.emberTotal > 0 && <> · <span className="hc-portfolio-ember">+{record.emberTotal} Ember</span></>}
            </p>
            <ul className="hc-portfolio-list">
                {picks.map((p) => (
                    <li key={p.slug} className="hc-portfolio-row">
                        <a href={tankHref(p.slug)}>{p.tagline}</a>
                        <div className="hc-portfolio-meta">
                            <span className={`hc-portfolio-badge hc-portfolio-badge--${p.result}`}>
                                {p.result === 'correct' ? 'Correct' : 'Incorrect'}
                            </span>
                            <span className="hc-portfolio-side">You took &ldquo;{p.side}&rdquo;</span>
                            {p.settledAt && <span>{formatSettleDate(p.settledAt).replace('Resolves', 'Settled')}</span>}
                            {p.emberAwarded > 0 && <span className="hc-portfolio-ember">+{p.emberAwarded} Ember</span>}
                        </div>
                    </li>
                ))}
            </ul>
            {cursor && (
                <button type="button" className="hc-portfolio-more" onClick={onLoadMore} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                </button>
            )}
        </>
    );
}

function TanksSection() {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'onboarding'>('loading');
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
                // Signed in but not onboarded: the old page fell into the generic error
                // branch here. Say what's actually needed instead.
                if (res.status === 403) {
                    setPhase('onboarding');
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

    if (phase === 'loading') return <p className="hc-portfolio-loading">Loading your Tanks…</p>;
    if (phase === 'onboarding') {
        return <p className="hc-portfolio-empty">Finish setting up your account to see your Tanks. <a href="/welcome/">Finish setup</a></p>;
    }
    if (phase === 'error' || !data) return <p className="hc-portfolio-loading">Could not load your picks. Try refreshing.</p>;

    return (
        <>
            <div className="hc-portfolio-tabs" role="tablist" aria-label="Tank picks">
                <button type="button" role="tab" aria-selected={tab === 'pending'}
                    className={`hc-portfolio-tab${tab === 'pending' ? ' is-active' : ''}`} onClick={() => setTab('pending')}>
                    Open ({data.pending.length})
                </button>
                <button type="button" role="tab" aria-selected={tab === 'settled'}
                    className={`hc-portfolio-tab${tab === 'settled' ? ' is-active' : ''}`} onClick={() => setTab('settled')}>
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
        </>
    );
}

// ---------------------------------------------------------------------------------
// Indexes (TANKDAQ share holdings)
// ---------------------------------------------------------------------------------

function fmtEmber(v: number): string {
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtSigned(v: number): string {
    const n = Object.is(v, -0) ? 0 : Math.round(v);
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toLocaleString('en-US')}`;
}
function signOf(v: number): 'pos' | 'neg' | 'zero' {
    return v > 0 ? 'pos' : v < 0 ? 'neg' : 'zero';
}
function tradeDate(iso: string): string {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const tickerHref = (key: string) => `/tankdaq/${encodeURIComponent(key)}/`;

function ActivePositions({ positions, totals, balance }: { positions: HoldingPosition[]; totals: HoldingsResponse['totals']; balance: number }) {
    if (positions.length === 0) {
        return (
            <p className="hc-portfolio-empty">
                You don&rsquo;t hold any indexes yet. <a href="/tankdaq/indexes/">Browse the board</a> to find one.
            </p>
        );
    }
    return (
        <>
            <div className="hc-portfolio-tablewrap">
                <table className="hc-portfolio-table">
                    <thead>
                        <tr>
                            <th>Index</th>
                            <th className="num">Shares</th>
                            <th className="num">Avg cost</th>
                            <th className="num">Price</th>
                            <th className="num">Value</th>
                            <th className="num">P/L</th>
                        </tr>
                    </thead>
                    <tbody>
                        {positions.map((p) => (
                            <tr key={p.tickerKey}>
                                <td className="hc-portfolio-sym">
                                    <a href={tickerHref(p.tickerKey)}>{p.displayName}</a>
                                    <span className="hc-portfolio-symlabel">{p.indexLabel}{p.tradeable ? '' : ' · not trading'}</span>
                                </td>
                                <td className="num">{p.shares.toLocaleString('en-US')}</td>
                                <td className="num">{fmtEmber(p.avgBuyPrice)}</td>
                                <td className="num">{p.price === null ? '—' : fmtEmber(p.price)}</td>
                                <td className="num">{p.marketValue === null ? '—' : p.marketValue.toLocaleString('en-US')}</td>
                                <td className={`num is-${p.unrealizedPnl === null ? 'zero' : signOf(p.unrealizedPnl)}`}>
                                    {p.unrealizedPnl === null ? '—' : fmtSigned(p.unrealizedPnl)}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                    <tfoot>
                        <tr>
                            <td colSpan={4}>Total</td>
                            <td className="num">{totals.marketValue.toLocaleString('en-US')}</td>
                            <td className={`num is-${signOf(totals.unrealizedPnl)}`}>{fmtSigned(totals.unrealizedPnl)}</td>
                        </tr>
                    </tfoot>
                </table>
            </div>
            <p className="hc-portfolio-balance">
                Ember balance <strong>{balance.toLocaleString('en-US')}</strong>
                {totals.realizedPnl !== 0 && <> &middot; realized <span className={`is-${signOf(totals.realizedPnl)}`}>{fmtSigned(totals.realizedPnl)}</span></>}
            </p>
        </>
    );
}

function TradeHistory({ trades }: { trades: TradeHistoryItem[] }) {
    if (trades.length === 0) {
        return <p className="hc-portfolio-empty">No trades yet.</p>;
    }
    return (
        <ul className="hc-portfolio-list">
            {trades.map((t) => (
                <li key={t.id} className="hc-portfolio-row">
                    <div className="hc-portfolio-traderow">
                        <span className={`hc-portfolio-badge hc-portfolio-badge--${t.side}`}>{t.side === 'buy' ? 'Buy' : 'Sell'}</span>
                        <a href={tickerHref(t.tickerKey)}>{t.displayName}</a>
                        <span className="hc-portfolio-tradeqty">{t.shares.toLocaleString('en-US')} @ {fmtEmber(t.price)}</span>
                    </div>
                    <div className="hc-portfolio-meta">
                        <span className="hc-portfolio-ember">{t.side === 'buy' ? '−' : '+'}{t.emberAmount.toLocaleString('en-US')} Ember</span>
                        {t.side === 'sell' && t.realizedPnl !== null && (
                            <span className={`is-${signOf(t.realizedPnl)}`}>{fmtSigned(t.realizedPnl)} realized</span>
                        )}
                        <span>{tradeDate(t.createdAt)}</span>
                    </div>
                </li>
            ))}
        </ul>
    );
}

function IndexesSection() {
    const [phase, setPhase] = useState<'loading' | 'ready' | 'error' | 'auth'>('loading');
    const [data, setData] = useState<HoldingsResponse | null>(null);
    const [tab, setTab] = useState<'active' | 'history'>('active');

    useEffect(() => {
        (async () => {
            try {
                const h = await getHoldings();
                if (!h) { setPhase('auth'); return; } // 401 or 403 - see the prompt below
                setData(h);
                if (h.positions.length === 0 && h.trades.length > 0) setTab('history');
                setPhase('ready');
            } catch {
                setPhase('error');
            }
        })();
    }, []);

    if (phase === 'loading') return <p className="hc-portfolio-loading">Loading your indexes…</p>;
    if (phase === 'auth') {
        // Reached by deep-linking ?tab=indexes while logged out or un-onboarded; the
        // Tanks tab would have redirected. Say what to do rather than bouncing.
        return <p className="hc-portfolio-empty"><a href="/login/">Log in</a> to see your index holdings.</p>;
    }
    if (phase === 'error' || !data) return <p className="hc-portfolio-loading">Could not load your holdings. Try refreshing.</p>;

    return (
        <>
            <div className="hc-portfolio-tabs" role="tablist" aria-label="Index holdings">
                <button type="button" role="tab" aria-selected={tab === 'active'}
                    className={`hc-portfolio-tab${tab === 'active' ? ' is-active' : ''}`} onClick={() => setTab('active')}>
                    Active ({data.positions.length})
                </button>
                <button type="button" role="tab" aria-selected={tab === 'history'}
                    className={`hc-portfolio-tab${tab === 'history' ? ' is-active' : ''}`} onClick={() => setTab('history')}>
                    History ({data.trades.length})
                </button>
            </div>
            {tab === 'active'
                ? <ActivePositions positions={data.positions} totals={data.totals} balance={data.balance} />
                : <TradeHistory trades={data.trades} />}
            <p className="hc-portfolio-note">{data.priceNote}</p>
        </>
    );
}

// ---------------------------------------------------------------------------------

type TopTab = 'tanks' | 'indexes';

function MyPortfolioPage() {
    const [tab, setTab] = useState<TopTab>(() =>
        new URLSearchParams(window.location.search).get('tab') === 'indexes' ? 'indexes' : 'tanks');

    // Keep the URL honest so a refresh or a shared link lands on the same tab.
    const select = (t: TopTab) => {
        setTab(t);
        const url = new URL(window.location.href);
        if (t === 'indexes') url.searchParams.set('tab', 'indexes'); else url.searchParams.delete('tab');
        window.history.replaceState(null, '', url);
    };

    return (
        <div className="hc-portfolio-card">
            <h1>My Portfolio</h1>
            <div className="hc-portfolio-toptabs" role="tablist" aria-label="Portfolio sections">
                <button type="button" role="tab" aria-selected={tab === 'tanks'}
                    className={`hc-portfolio-toptab${tab === 'tanks' ? ' is-active' : ''}`} onClick={() => select('tanks')}>
                    Tanks
                </button>
                <button type="button" role="tab" aria-selected={tab === 'indexes'}
                    className={`hc-portfolio-toptab${tab === 'indexes' ? ' is-active' : ''}`} onClick={() => select('indexes')}>
                    Indexes
                </button>
            </div>
            {tab === 'tanks' ? <TanksSection /> : <IndexesSection />}
        </div>
    );
}

function mount() {
    const root = document.getElementById('my-portfolio-root');
    if (!root) return;
    // Sibling of the page, not a child: the sections return early on their loading and
    // empty states, and the topbar chip should not blink out with them. ContentChrome
    // portals the chip into the topbar's [data-hc-hud-slot] (topbar(null) in
    // my-portfolio-template.ts).
    createRoot(root).render(<><ContentChrome /><MyPortfolioPage /></>);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
} else {
    mount();
}
