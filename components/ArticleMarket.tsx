// "Polymarket prices" - the live market panel on a Tank article page.
//
// Replaces the server-rendered fallback (the prices frozen when the story was written,
// dated) with the market's CURRENT prices from /api/tank-market, which reads one
// Polymarket Gamma market and is cached at the edge for ~2 minutes. Same "render nothing
// until there is something real to show" pattern as ArticleIndexes: the caller removes
// the fallback only once onReady fires, so a failed fetch, a closed market, or no JS at
// all leaves the dated fallback in place.
//
// NEUTRAL BY CONSTRUCTION. A price is reported, not scored. Every side gets the same
// weight and colour, in the market's own outcome order (never sorted by price), with no
// arrows, no red/green and no "+" signs - those read as a stock ticker and imply
// momentum. Earlier prices are shown as LEVELS ("24 hours ago: Chiefs 56%"), never as
// deltas. Tank content never pushes a take, and this panel sits right beside the story.
//
// After kickoff it never fetches at all: in-play prices move with the score and would
// read like a result, which is the "How it ended" section's job once the market settles.

import React, { useEffect, useState } from 'react';
import { MARKET_PANEL_NOTE } from '../tank-deck-format';

export interface MarketPanelSeed {
    marketId: string;
    kickoff: string | null;
    writtenLabel: string;          // "Sep 8" - when the story was written
    outcomes: string[];            // the market's own outcome labels, in its own order
    labels?: string[];             // display names, parallel to outcomes ("Chelsea FC -2.5" for a spread)
    writtenPct: number[] | null;   // whole %, parallel to outcomes; null when not showable
    question: string | null;       // the market's wording, which names the Yes side
}

interface TankMarketBody {
    available: boolean;
    liveBook?: boolean;
    closed?: boolean;
    question?: string | null;
    outcomes?: string[];
    pct?: number[];
    pct24hAgo?: number[] | null;
    asOf?: string;
    note: string;
}

type PanelState =
    | { kind: 'live'; outcomes: string[]; pct: number[]; pct24hAgo: number[] | null; asOf: string | null; question: string | null }
    | { kind: 'noTrading'; question: string | null }
    | { kind: 'inPlay' };

function isYesNo(outcomes: string[]): boolean {
    return outcomes.length === 2
        && outcomes[0].trim().toLowerCase() === 'yes' && outcomes[1].trim().toLowerCase() === 'no';
}

function asOfLabel(iso: string | undefined): string | null {
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })} ET`;
}

function levels(outcomes: string[], pct: number[]): string {
    return outcomes.map((o, i) => `${o} ${pct[i]}%`).join(' · ');
}

export const ArticleMarket: React.FC<{ seed: MarketPanelSeed; onReady: () => void }> = ({ seed, onReady }) => {
    const [state, setState] = useState<PanelState | null>(null);

    useEffect(() => {
        const kickoffMs = seed.kickoff ? new Date(seed.kickoff).getTime() : NaN;
        if (Number.isFinite(kickoffMs) && kickoffMs <= Date.now()) {
            setState({ kind: 'inPlay' });
            onReady();
            return;
        }
        let cancelled = false;
        (async () => {
            try {
                const res = await fetch(`/api/tank-market?m=${encodeURIComponent(seed.marketId)}`);
                if (!res.ok) return;
                const body = (await res.json()) as TankMarketBody;
                // Unavailable or closed: keep the dated fallback. A settled market is the
                // "How it ended" section's to describe.
                if (cancelled || !body.available || body.closed) return;
                const question = body.question ?? seed.question;
                if (!body.liveBook) {
                    setState({ kind: 'noTrading', question });
                } else if (body.outcomes && body.pct && body.outcomes.length === body.pct.length) {
                    setState({
                        kind: 'live',
                        outcomes: body.outcomes,
                        pct: body.pct,
                        pct24hAgo: body.pct24hAgo ?? null,
                        asOf: asOfLabel(body.asOf),
                        question,
                    });
                } else {
                    return;
                }
                onReady();
            } catch (err) {
                console.error('[Tank Article] market panel failed to load:', err);
            }
        })();
        return () => { cancelled = true; };
    }, [seed, onReady]);

    if (!state) return null;

    const question = state.kind === 'inPlay' ? seed.question : state.question;
    const showQuestion = !!question && isYesNo(state.kind === 'live' ? state.outcomes : seed.outcomes);

    // The build-time display names (a spread side carries its line) - used only while the
    // market's outcomes are still the ones the page was built with.
    const namesFor = (outcomes: string[]): string[] =>
        seed.labels && seed.labels.length === outcomes.length && outcomes.every((o, i) => o === seed.outcomes[i])
            ? seed.labels
            : outcomes;

    const meta: string[] = [];
    if (state.kind === 'live' && state.asOf) meta.push(`As of ${state.asOf}`);
    if (seed.writtenPct) meta.push(`When this story was written (${seed.writtenLabel}): ${levels(namesFor(seed.outcomes), seed.writtenPct)}`);
    if (state.kind === 'live' && state.pct24hAgo) meta.push(`24 hours ago: ${levels(namesFor(state.outcomes), state.pct24hAgo)}`);

    return (
        <>
            {showQuestion && <p className="tank-article-market-question">{question}</p>}
            {state.kind === 'live' && (
                <ul className="tank-article-market-rows">
                    {state.outcomes.map((o, i) => (
                        <li key={`${o}-${i}`}><span>{namesFor(state.outcomes)[i]}</span><span>{state.pct[i]}%</span></li>
                    ))}
                </ul>
            )}
            {state.kind === 'noTrading' && (
                <p className="tank-article-market-meta">Not enough trading on this market to show a price.</p>
            )}
            {state.kind === 'inPlay' && (
                <p className="tank-article-market-meta">Prices during the game aren't shown.</p>
            )}
            {meta.length > 0 && (
                <p className="tank-article-market-meta">
                    {meta.map((line, i) => (
                        <React.Fragment key={i}>{i > 0 && <br />}{line}</React.Fragment>
                    ))}
                </p>
            )}
            <p className="tank-article-market-note">{MARKET_PANEL_NOTE}</p>
        </>
    );
};

export default ArticleMarket;
