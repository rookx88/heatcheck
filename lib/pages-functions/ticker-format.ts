// The display strings for an index quote, shared by every surface that prints one:
// the SSR homepage (market-movers.ts), the TANKDAQ islands, the article-page tiles,
// and the acceptance harness. One formatter per number so a value can never read
// "+1.2%" on the tape and "+1.20%" on the card. Pure and dependency-free - no Intl,
// no DOM - so Workers, the tsx static build, and browsers print byte-identical text.
//
// The quote form is stock-ticker style: the Ember price, then the price's % change
// over the surface's window in parentheses - "45.23 (+1.2%)". The percentage is a
// PRICE return (ticker-price.ts's priceReturnPct), never the cumulative index points.

export type Sign = 'pos' | 'neg' | 'zero';

export function signOf(v: number): Sign {
    if (v > 0) return 'pos';
    if (v < 0) return 'neg';
    return 'zero';
}

// Real minus (U+2212); -0 normalizes to "+0.0%".
export function formatSignedPct(v: number): string {
    const normalized = Object.is(v, -0) ? 0 : v;
    return `${normalized >= 0 ? '+' : '−'}${Math.abs(normalized).toFixed(1)}%`;
}

// Ember prices read to the cent with thousands grouping: "1,234.50". Hand-rolled
// rather than toLocaleString so the output does not depend on the runtime's ICU data.
export function formatEmber(v: number): string {
    const fixed = Math.abs(v).toFixed(2);
    const [whole, frac] = fixed.split('.');
    const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${v < 0 ? '−' : ''}${grouped}.${frac}`;
}

// "45.23 (+1.2%)" - the ONE string the tape, the cards, the board tooltips and the
// island tiles all print for an index.
export function formatQuote(price: number, returnPct: number): string {
    return `${formatEmber(price)} (${formatSignedPct(returnPct)})`;
}
