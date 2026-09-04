// The Ember price of an index, and the integer Ember math built on it. Pure and
// dependency-free - no DB, no DOM - so the SAME function runs in the Pages Function that
// prices a trade, in the static build, and in the client bundle that draws the chart.
// Sharing it is the point: a price computed two ways would eventually disagree.
//
//   price = baseline * exp(value / scale)
//
// `value` is the index's cumulative SUM(delta) - the exact number already shown as a
// percentage (getTickerValues, tickers.ts). This is a second READ of that number, never a
// second computation. exp() of any real is strictly positive, so a price can crawl toward
// zero under sustained bad results but can never reach it or go negative - a property of
// the transform, not something a floor or a clamp enforces, and there is neither.
//
// Trading never writes ticker_events. Stories and results move the price; a trade only
// consumes it.

export interface PriceParams {
    baseline: number;
    scale: number;
}

// Prices are quoted to four decimal places. Everything downstream - the cost of a buy,
// the credit of a sell, the P/L on a position - derives from the ROUNDED number, and the
// rounded number is what a trade persists, so a quote and its consequences always agree.
export const PRICE_DECIMALS = 4;
const PRICE_UNITS = 10 ** PRICE_DECIMALS;

// Whole shares only. The cap keeps shares * price inside a 32-bit INT (ember_amount and
// ember_balances.balance are INT) with room to spare, and bounds what one request can do.
export const MAX_SHARES_PER_TRADE = 100_000;

// The framing constraint, extended to prices. RETROSPECTIVE_NOTE (tickers.ts) covers the
// percentage displays; a PRICE invites forward-looking reading in a way a percentage
// doesn't, so every response that carries a price ships this alongside, and the client
// renders it verbatim next to the price.
export const PRICE_NOTE =
    "Ember prices re-express each index's cumulative record - a look back at how tagged storylines have gone, not a forecast. Ember is play currency.";

export function priceFromValue(value: number, p: PriceParams): number {
    const raw = p.baseline * Math.exp(value / p.scale);
    return Math.round(raw * PRICE_UNITS) / PRICE_UNITS;
}

// shares * price in ten-thousandths, as an exact integer product. 2 * 50.0000 must be
// exactly 100 Ember, never 101 via 100.00000000000001 - so the price is converted to an
// integer count of units first and the multiplication happens in integers.
function totalUnits(shares: number, price: number): number {
    return shares * Math.round(price * PRICE_UNITS);
}

// A buy costs ceil(shares * price) Ember: the trader never gets a fraction of an Ember
// for free.
export function buyCost(shares: number, price: number): number {
    const units = totalUnits(shares, price);
    return Math.floor(units / PRICE_UNITS) + (units % PRICE_UNITS === 0 ? 0 : 1);
}

// A sell credits floor(shares * price) Ember: the house never pays a fraction it doesn't
// owe. Rounding therefore never favours the trader in either direction.
export function sellCredit(shares: number, price: number): number {
    return Math.floor(totalUnits(shares, price) / PRICE_UNITS);
}

// The price's percentage change between two points of the SAME cumulative series the
// chart already has: exp(dValue / scale) - 1. This is what sits beside the headline price.
export function windowReturnPct(valueNow: number, valueAnchor: number, p: PriceParams): number {
    return (Math.exp((valueNow - valueAnchor) / p.scale) - 1) * 100;
}

export function isWholeShares(n: unknown): n is number {
    return typeof n === 'number' && Number.isInteger(n) && n >= 1 && n <= MAX_SHARES_PER_TRADE;
}

// For a mirror pair with identical (baseline, scale) - $OVERS/$UNDERS, each league
// favorite/underdog pair - the cumulative values move as exact inverses, so under exp()
// ln(p_a) + ln(p_b) is CONSTANT over time: the moves are inverse in log space
// (multiplicative returns), never as +/- the same number of Ember. This returns how far
// that constant drifted between two moments; an acceptance test asserts it is ~0.
export function mirrorLogSumDrift(pa0: number, pb0: number, pa1: number, pb1: number): number {
    return Math.abs((Math.log(pa1) + Math.log(pb1)) - (Math.log(pa0) + Math.log(pb0)));
}
