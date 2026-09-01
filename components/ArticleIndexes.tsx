// "Indexes this story moved" - the Exchange section on a Tank article page.
//
// Replaces the article's bullet-card list, which duplicated text the 3D artifact
// already paints. Each index the Tank is tagged to gets a TANKDAQ-style tile (its
// current value) beside a market-reaction line composed server-side by
// /api/tickers/tank ("Buyers stay wary on X - the market slid 5 points. $DOGS eases
// to -0.6%").
//
// FALLBACK IS THE DEFAULT, NOT THE ERROR PATH: this renders null until it has at least
// one tag, and the caller only swaps the DOM when it returns something. So an untagged
// Tank, a no-JS reader, and a failed fetch all keep the server-rendered cards - the
// page never loses that spot and no crawlable text disappears.
//
// Why the sentences arrive pre-composed: building them here would mean importing
// market-movers.ts (every SSR string builder) into the article bundle. Same split
// /api/tickers/detail already uses.

import React, { useEffect, useState } from 'react';

interface TankTag {
    tickerKey: string;
    displayName: string | null;
    indexLabel: string | null;
    tickerValue: number | null;
    tagDelta: number | null;
    rawDelta: number | null;
    sentence: string | null;
}

// Same palette as the TANKDAQ board (tankdaq-heatmap-client.tsx).
const NEON = { pos: '61, 220, 100', neg: '255, 107, 87', zero: '148, 163, 184' } as const;

function fmtPct(v: number): string {
    const n = Object.is(v, -0) ? 0 : v;
    return `${n >= 0 ? '+' : '−'}${Math.abs(n).toFixed(1)}%`;
}

export const ArticleIndexes: React.FC<{ slug: string; onReady: () => void }> = ({ slug, onReady }) => {
    const [tags, setTags] = useState<TankTag[] | null>(null);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/tickers/tank?slug=${encodeURIComponent(slug)}`);
                if (!res.ok) return;
                const body = (await res.json()) as { tags: TankTag[] };
                // Only indexes with a real news move and a live ticker behind them.
                const usable = (body.tags ?? []).filter((t) => t.displayName && t.sentence && t.tickerValue !== null);
                if (!cancelled && usable.length > 0) {
                    setTags(usable);
                    onReady();
                }
            } catch (err) {
                console.error('[Tank Article] index section failed to load:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [slug, onReady]);

    if (!tags) return null;

    return (
        <>
            <h2 className="hc-tai-heading">Indexes this story moved</h2>
            <p className="hc-tai-sub">How the market repriced, and where each index stands now.</p>
            <ul className="hc-tai-list">
                {tags.map((t) => {
                    const dir = (t.tagDelta ?? 0) > 0 ? 'pos' : (t.tagDelta ?? 0) < 0 ? 'neg' : 'zero';
                    const neon = NEON[dir];
                    const valueSign = (t.tickerValue ?? 0) > 0 ? 'pos' : (t.tickerValue ?? 0) < 0 ? 'neg' : 'zero';
                    return (
                        <li key={t.tickerKey} className="hc-tai-row">
                            <a className="hc-tai-tile" href={`/tankdaq/${t.tickerKey}/`}
                                style={{
                                    border: `2px solid rgba(${neon}, 0.85)`,
                                    boxShadow: `0 3px 0 rgba(${neon}, 0.8), 0 5px 0 rgba(0,0,0,0.95), 0 9px 14px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 0 16px rgba(${neon}, 0.18)`,
                                }}
                                aria-label={`${t.displayName}: ${fmtPct(t.tickerValue ?? 0)} overall. Open this index.`}>
                                <span className="hc-tai-sym">{t.displayName}</span>
                                <span className="hc-tai-val" style={{ color: `rgb(${NEON[valueSign]})` }}>{fmtPct(t.tickerValue ?? 0)}</span>
                                <span className="hc-tai-label">{t.indexLabel ?? 'Index'}</span>
                            </a>
                            <p className="hc-tai-note">{t.sentence}</p>
                        </li>
                    );
                })}
            </ul>
        </>
    );
};

export default ArticleIndexes;
