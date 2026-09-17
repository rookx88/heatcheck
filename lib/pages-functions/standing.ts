// A viewer's own standing: Ember balance, lifetime earned, and Hall of Fame rank, as one
// lazily-built statement so callers can drop it into a sql.transaction([...]) batch (the
// encounterFactsStatement pattern - Neon's tagged template can't compose fragments, so a
// function returning the whole statement is the reusable unit).
//
// Rank is competition rank: 1 + the number of board-eligible accounts (a username and
// lifetime_earned > 0) that have earned strictly more - the exact arithmetic
// functions/api/hall-of-fame.ts uses for the ranked board itself (RANK() OVER), so the
// number here matches the one on the board. NULL rank when the account has earned
// nothing: the board never lists them, so "Unranked" is the truthful reading.
//
// Shared by GET /api/hall-of-fame (the `me` half) and GET /api/account (the standing
// strip). A zero-row result means no ember_balances row yet - a brand-new account,
// not an error; callers treat it as balance 0 / earned 0 / unranked.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface StandingRow {
    balance: number;
    lifetime_earned: number;
    rank: number | null;
}

export function standingStatement(sql: NeonQueryFunction<false, false>, userId: string) {
    return sql`
        SELECT b.balance,
               b.lifetime_earned,
               CASE WHEN b.lifetime_earned > 0 THEN
                   (1 + (SELECT COUNT(*) FROM ember_balances b2
                         JOIN waitlist w2 ON w2.id = b2.user_id
                         WHERE b2.lifetime_earned > b.lifetime_earned AND w2.username IS NOT NULL))::int
               END AS rank
        FROM ember_balances b
        WHERE b.user_id = ${userId}
        LIMIT 1
    `;
}

export function readStanding(rows: unknown[]): StandingRow {
    if (rows.length === 0) return { balance: 0, lifetime_earned: 0, rank: null };
    const r = rows[0] as { balance: number | string; lifetime_earned: number | string; rank: number | string | null };
    return {
        balance: Number(r.balance),
        lifetime_earned: Number(r.lifetime_earned),
        rank: r.rank === null || r.rank === undefined ? null : Number(r.rank),
    };
}
