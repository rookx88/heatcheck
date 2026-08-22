// Shared runner primitives for scripts/acceptance.ts and every suite under
// scripts/acceptance/suites/. Nothing here is domain-specific (that's fixtures.ts) -
// this file owns process-wide concerns: the DB pool, pass/fail/warn tallying (kept
// per-suite so the final summary can attribute failures), the shared fetch wrapper,
// and a teardown registry so an aborted suite still restores anything it version-flipped.

import { Pool } from 'pg';

export const BASE_URL = process.env.BASE_URL || 'http://localhost:8788';
export const EPS = 0.0005; // NUMERIC(6,3) comparisons

export let pool: Pool;
export function initPool(connectionString: string): Pool {
    pool = new Pool({ connectionString });
    return pool;
}

export function near(a: number, b: number, eps: number = EPS): boolean {
    return Math.abs(a - b) < eps;
}

// ---------------------------------------------------------------------------------
// Tallying - per-suite, so the final summary shows pass/fail/warn per phase, not just
// one global count. setActiveSuite() must be called before the first check()/warn() a
// suite makes.
// ---------------------------------------------------------------------------------

interface SuiteTally { pass: number; fail: number; warn: number; failures: string[] }
const tallies = new Map<string, SuiteTally>();
let active = 'unassigned';

export function setActiveSuite(name: string): void {
    active = name;
    if (!tallies.has(name)) tallies.set(name, { pass: 0, fail: 0, warn: 0, failures: [] });
    console.log(`\n########## ${name} ##########`);
}

export function section(title: string): void {
    console.log(`\n${title}`);
}

export function check(name: string, ok: boolean, detail?: string): boolean {
    const t = tallies.get(active) ?? tallies.set(active, { pass: 0, fail: 0, warn: 0, failures: [] }).get(active)!;
    if (ok) {
        t.pass++;
        console.log(`  PASS  ${name}`);
    } else {
        t.fail++;
        t.failures.push(name);
        console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ''}`);
    }
    return ok;
}

export function warn(msg: string): void {
    const t = tallies.get(active) ?? tallies.set(active, { pass: 0, fail: 0, warn: 0, failures: [] }).get(active)!;
    t.warn++;
    console.warn(`  WARN  ${msg}`);
}

export function printSummary(): number {
    console.log(`\n${'='.repeat(72)}`);
    console.log('SUMMARY');
    console.log('='.repeat(72));
    let totalPass = 0, totalFail = 0, totalWarn = 0;
    for (const [name, t] of tallies) {
        console.log(`  ${name.padEnd(24)} pass=${t.pass}  fail=${t.fail}  warn=${t.warn}`);
        if (t.failures.length) console.log(`      failed: ${t.failures.join('; ')}`);
        totalPass += t.pass; totalFail += t.fail; totalWarn += t.warn;
    }
    console.log('-'.repeat(72));
    console.log(`  TOTAL${''.padEnd(19)} pass=${totalPass}  fail=${totalFail}  warn=${totalWarn}`);
    console.log('='.repeat(72));
    return totalFail;
}

// ---------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------

export interface ApiOptions {
    body?: unknown;
    headers?: Record<string, string>;
    cookie?: string | null;
}
export interface ApiResult {
    status: number;
    json: any;
    headers: Headers;
}

export async function api(method: string, path: string, options?: ApiOptions): Promise<ApiResult> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(options?.headers ?? {}) };
    if (options?.cookie) headers['Cookie'] = options.cookie;
    const res = await fetch(`${BASE_URL}${path}`, {
        method,
        headers,
        body: options?.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let json: any = null;
    try {
        json = await res.json();
    } catch {
        /* non-JSON response surfaces as json === null */
    }
    return { status: res.status, json, headers: res.headers };
}

// ---------------------------------------------------------------------------------
// Teardown registry - suites register cleanup here so an aborted run (thrown error
// mid-suite) still runs every registered teardown, not just the ones after the throw.
// ---------------------------------------------------------------------------------

type Teardown = () => Promise<void>;
const teardowns: Teardown[] = [];

export function registerTeardown(fn: Teardown): void {
    teardowns.push(fn);
}

export async function runTeardowns(): Promise<void> {
    // Reverse order: last-registered (innermost / most recently flipped) restored first.
    for (const fn of teardowns.slice().reverse()) {
        try {
            await fn();
        } catch (err) {
            console.error('  Teardown failed (continuing):', err);
        }
    }
    teardowns.length = 0;
}

// ---------------------------------------------------------------------------------
// Suite plumbing
// ---------------------------------------------------------------------------------

export interface Suite {
    name: string;
    requiredEnv: string[];
    run: () => Promise<void>;
}
