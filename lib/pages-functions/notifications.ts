// Shared idempotent insert for single-recipient notifications. The notifications
// table's idempotency_key UNIQUE + ON CONFLICT DO NOTHING is the whole dedupe story -
// callers pick a key that encodes "this exact moment" (e.g. 'welcome:<userId>') so
// retries and double-submits are structural no-ops. Set-based writers (the
// notify-sweep endpoint's INSERT...SELECTs) and ledger.ts's in-transaction settlement
// insert deliberately do NOT go through here - this is for the simple one-row cases.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export interface InsertNotificationInput {
    userId: string;
    type: 'informational' | 'claimable';
    message: string;
    refType: string | null;
    refId: string | null;
    idempotencyKey: string;
}

export async function insertNotificationIdempotent(
    sql: NeonQueryFunction<false, false>,
    input: InsertNotificationInput,
): Promise<void> {
    await sql`
        INSERT INTO notifications (user_id, type, message, ref_type, ref_id, idempotency_key)
        VALUES (${input.userId}, ${input.type}, ${input.message}, ${input.refType}, ${input.refId}, ${input.idempotencyKey})
        ON CONFLICT (idempotency_key) DO NOTHING
    `;
}
