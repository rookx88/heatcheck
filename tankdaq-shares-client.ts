// Client for the TANKDAQ share-trading endpoints (functions/api/tankdaq/*.ts): buy and
// sell whole shares of an index at its live Ember price, and read the signed-in user's
// holdings. Plain fetch() to same-origin Pages Functions, cookie-authed via hc_session -
// the egg-shop-client.ts conventions, deliberately not apiClient.ts (the admin tool).
//
// The client never sends a price. It sends a ticker, a whole-share count and a
// tradeToken; the server prices the trade at the moment it lands. A tradeToken is
// minted once per INTENT and reused verbatim on retry - that is what makes a
// double-submit or a retried network failure debit exactly once.

import { InsufficientEmberError } from './egg-shop-client';
import { dispatchBalanceUpdated } from './toolbar-state-client';

export interface Position {
    shares: number;
    avgBuyPrice: number; // Ember actually paid / shares - includes each buy's ceil
}

export interface TradeReceipt {
    side: 'buy' | 'sell';
    tickerKey: string;
    shares: number;
    price: number;        // the server's quote, 4 dp
    emberAmount: number;  // ceil(shares*price) on a buy, floor on a sell
    realizedPnl?: number | null;
}

export interface TradeResponse {
    ok: true;
    replay: boolean;      // true = this token was already recorded; nothing new happened
    trade: TradeReceipt;
    position: Position | null; // null after a sale empties the position
    balance: number;
    note: string;
    priceNote: string;
}

export interface HoldingPosition {
    tickerKey: string;
    displayName: string;
    indexLabel: string;
    ruleType: string;
    shares: number;
    avgBuyPrice: number;
    costBasis: number;           // Ember paid, rounded
    price: number | null;        // null when the index is no longer active
    marketValue: number | null;  // what a full sell would credit right now
    unrealizedPnl: number | null;
    value: number | null;        // the index's cumulative %
    tradeable: boolean;
}

export interface TradeHistoryItem {
    id: string;
    tickerKey: string;
    displayName: string;
    side: 'buy' | 'sell';
    shares: number;
    price: number;
    emberAmount: number;
    realizedPnl: number | null;
    createdAt: string;
}

export interface HoldingsResponse {
    note: string;
    priceNote: string;
    balance: number;
    positions: HoldingPosition[];
    trades: TradeHistoryItem[];
    totals: { marketValue: number; costBasis: number; unrealizedPnl: number; realizedPnl: number };
}

// 409 - asked to sell more than held; carries the server's held count so the UI can
// clamp to the real number.
export class InsufficientSharesError extends Error {
    shares: number;
    constructor(shares: number) {
        super('Not enough shares.');
        this.name = 'InsufficientSharesError';
        this.shares = shares;
    }
}

// 404 - the index isn't active (or doesn't exist), so it has no price to trade at.
export class TickerUnavailableError extends Error {
    constructor(message?: string) {
        super(message || 'That index is not available to trade.');
        this.name = 'TickerUnavailableError';
    }
}

async function parseJsonSafe(res: Response): Promise<any> {
    try {
        return await res.json();
    } catch {
        return {};
    }
}

// 401 = logged out, 403 = not onboarded - both "not in a state to see this" rather
// than errors; returned as null so callers render the logged-out prompt.
export async function getHoldings(): Promise<HoldingsResponse | null> {
    const res = await fetch('/api/tankdaq/holdings');
    if (res.status === 401 || res.status === 403) return null;
    const data = await parseJsonSafe(res);
    if (!res.ok) throw new Error(data.message || `GET /api/tankdaq/holdings failed: ${res.status}`);
    return data as HoldingsResponse;
}

async function trade(path: string, tickerKey: string, shares: number, tradeToken: string): Promise<TradeResponse> {
    const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tickerKey, shares, tradeToken }),
    });
    const data = await parseJsonSafe(res);
    if (res.status === 402) throw new InsufficientEmberError(typeof data.balance === 'number' ? data.balance : 0);
    if (res.status === 409) throw new InsufficientSharesError(typeof data.shares === 'number' ? data.shares : 0);
    if (res.status === 404) throw new TickerUnavailableError(data.message);
    if (!res.ok) throw new Error(data.message || `POST ${path} failed: ${res.status}`);
    // Ember moved (or, on a replay, already had) - the HUD chip shows the same number.
    dispatchBalanceUpdated();
    return data as TradeResponse;
}

export function buyShares(tickerKey: string, shares: number, tradeToken: string): Promise<TradeResponse> {
    return trade('/api/tankdaq/buy', tickerKey, shares, tradeToken);
}

export function sellShares(tickerKey: string, shares: number, tradeToken: string): Promise<TradeResponse> {
    return trade('/api/tankdaq/sell', tickerKey, shares, tradeToken);
}
