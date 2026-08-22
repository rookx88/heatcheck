// Genuine-parallelism primitive for Phase 1 (and Phase 4's brute-force re-proof).
// Plain `Promise.all([api(a), api(b)])` is NOT simultaneous enough to exercise a real
// race: the closures run sequentially up to their first `await`, so the first fetch
// pays connection-setup cost (DNS/TCP/keepalive) before the second one is even
// constructed, widening the gap between when each request actually reaches the server.
// fireParallel() closes that gap: warm the connection with a throwaway request first,
// then release every worker from a single shared, already-pending promise so they all
// resume in the same microtask drain and issue their fetch() calls back-to-back.

import { BASE_URL } from './harness';

export interface ParallelResult<T> { index: number; status: number; json: any; error?: unknown; extra?: T }

export interface FireParallelOptions {
    method: string;
    path: string;
    // Called once per worker (index 0..n-1) so each request can carry its own token,
    // cookie, or body while still firing in the same release wave.
    build: (index: number) => { body?: unknown; headers?: Record<string, string> };
    n?: number; // default 8; use 3-4 for anything touching Polymarket/Gamma
}

export async function fireParallel(opts: FireParallelOptions): Promise<ParallelResult<undefined>[]> {
    const n = opts.n ?? 8;

    // Warm the connection so the first real request doesn't pay setup cost the others don't.
    await fetch(`${BASE_URL}/`).catch(() => {});

    let release: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });

    const workers = Array.from({ length: n }, (_, index) =>
        (async (): Promise<ParallelResult<undefined>> => {
            const { body, headers } = opts.build(index);
            await gate;
            try {
                const res = await fetch(`${BASE_URL}${opts.path}`, {
                    method: opts.method,
                    headers: { 'Content-Type': 'application/json', ...(headers ?? {}) },
                    body: body === undefined ? undefined : JSON.stringify(body),
                });
                let json: any = null;
                try { json = await res.json(); } catch { /* non-JSON */ }
                return { index, status: res.status, json };
            } catch (error) {
                return { index, status: -1, json: null, error };
            }
        })(),
    );

    // All workers are now constructed and awaiting `gate` - release them together.
    release!();
    return Promise.all(workers);
}

// Counts results by HTTP status, for the common "exactly one 2xx, rest 4xx" assertion shape.
export function tally(results: ParallelResult<unknown>[]): Record<number, number> {
    const counts: Record<number, number> = {};
    for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
    return counts;
}

export function countStatus(results: ParallelResult<unknown>[], status: number): number {
    return results.filter((r) => r.status === status).length;
}
