// "Indexes this story moved" - the Exchange section on a Tank article page.
//
// Replaces the article's bullet-card list, which duplicated text the 3D artifact
// already paints. Each index the Tank is tagged to gets a TANKDAQ-style tile (its
// Ember price, with the price's % change over the boards' adaptive window in
// parentheses - the same quote form the homepage tape and the Index Board print)
// beside a line composed server-side by /api/tickers/tank describing the
// market's own price over the 3 days before the story was added to the index, and what
// the index did ("Over the 3 days before this story was added to $DOGS, the price on the
// Chiefs went from 52% to 57%. The index rose 0.6%.").
//
// FALLBACK IS THE DEFAULT, NOT THE ERROR PATH: this renders null until it has at least
// one tag, and the caller only swaps the DOM when it returns something. So an untagged
// Tank, a no-JS reader, and a failed fetch all keep the server-rendered cards - the
// page never loses that spot and no crawlable text disappears.
//
// The endpoint's `note` (RETROSPECTIVE_NOTE - "not a forecast") is rendered visibly
// under the list. market-movers.ts requires it wherever ticker values appear, and this
// section showed values without it until 2026-09-10.
//
// Why the sentences arrive pre-composed: building them here would mean importing
// market-movers.ts (every SSR string builder) into the article bundle. Same split
// /api/tickers/detail already uses.

import React, { useEffect, useState } from 'react';
import { formatEmber, formatSignedPct, signOf } from '../lib/pages-functions/ticker-format';
import type { WindowInfo } from '../lib/pages-functions/ticker-window';

interface TankTag {
    tickerKey: string;
    displayName: string | null;
    indexLabel: string | null;
    tickerValue: number | null;
    price: number | null;
    priceReturnPct: number | null; // the price's % change over the response's window
    tagDelta: number | null;
    rawDelta: number | null;
    sentence: string | null;
}

// Same palette as the TANKDAQ board (tankdaq-heatmap-client.tsx).
const NEON = { pos: '61, 220, 100', neg: '255, 107, 87', zero: '148, 163, 184' } as const;

const DEFAULT_WINDOW: WindowInfo = { label: 'the last 24 hours', short: '24H', widened: false };

export const ArticleIndexes: React.FC<{ slug: string; onReady: () => void }> = ({ slug, onReady }) => {
    const [tags, setTags] = useState<TankTag[] | null>(null);
    const [note, setNote] = useState<string | null>(null);
    const [priceNote, setPriceNote] = useState<string | null>(null);
    const [window, setWindow] = useState<WindowInfo>(DEFAULT_WINDOW);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/tickers/tank?slug=${encodeURIComponent(slug)}`);
                if (!res.ok) return;
                const body = (await res.json()) as { tags: TankTag[]; note?: string; priceNote?: string; window?: WindowInfo };
                // Only indexes with a real news move and a live, priced ticker behind them.
                const usable = (body.tags ?? []).filter((t) =>
                    t.displayName && t.sentence && t.tickerValue !== null && t.price !== null && t.priceReturnPct !== null);
                if (!cancelled && usable.length > 0) {
                    setTags(usable);
                    setNote(typeof body.note === 'string' && body.note.trim() ? body.note : null);
                    setPriceNote(typeof body.priceNote === 'string' && body.priceNote.trim() ? body.priceNote : null);
                    if (body.window && typeof body.window.short === 'string') setWindow(body.window);
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
            <p className="hc-tai-sub">What the market's price did before each index added this story, and where each index's Ember price stands now.</p>
            <ul className="hc-tai-list">
                {tags.map((t) => {
                    // The tile's frame follows THIS story's own effect on the index (the
                    // sentence beside it); the quote's colour follows the window return.
                    const dir = signOf(t.tagDelta ?? 0);
                    const neon = NEON[dir];
                    const price = t.price ?? 0;
                    const ret = t.priceReturnPct ?? 0;
                    const retSign = signOf(ret);
                    return (
                        <li key={t.tickerKey} className="hc-tai-row">
                            <a className="hc-tai-tile" href={`/tankdaq/${t.tickerKey}/`}
                                style={{
                                    border: `2px solid rgba(${neon}, 0.85)`,
                                    boxShadow: `0 3px 0 rgba(${neon}, 0.8), 0 5px 0 rgba(0,0,0,0.95), 0 9px 14px rgba(0,0,0,0.7), inset 0 1px 0 rgba(255,255,255,0.12), inset 0 0 16px rgba(${neon}, 0.18)`,
                                }}
                                aria-label={`${t.displayName}: ${formatEmber(price)} Ember (${formatSignedPct(ret)} over ${window.label}). Open this index.`}>
                                <span className="hc-tai-sym">{t.displayName}</span>
                                <span className="hc-tai-quote">
                                    <span className="hc-tai-price">{formatEmber(price)}</span>{' '}
                                    <span className="hc-tai-return" style={{ color: `rgb(${NEON[retSign]})` }}>({formatSignedPct(ret)})</span>
                                </span>
                                <span className="hc-tai-label">{t.indexLabel ?? 'Index'} &middot; {window.short}</span>
                            </a>
                            <p className="hc-tai-note">{t.sentence}</p>
                        </li>
                    );
                })}
            </ul>
            {note && <p className="hc-tai-sub" style={{ marginTop: '0.9rem', marginBottom: 0 }}>{note}</p>}
            {priceNote && <p className="hc-tai-sub" style={{ marginTop: '0.35rem', marginBottom: 0 }}>{priceNote}</p>}
        </>
    );
};

export default ArticleIndexes;
