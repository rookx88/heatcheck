// Shared insert helper for the analytics `events` table - used by functions/api/track.ts
// (anonymous, pre-conversion events) and by picks.ts/verify-email.ts (which attach the
// resulting waitlist_id once known, bridging a visitor's anonymous history to their
// account). See create_events_table.sql for the schema this writes to.

import type { NeonQueryFunction } from '@neondatabase/serverless';

export const EVENT_TYPES = [
    'page_view',
    'tank_opened',
    'wall_viewed',
    'pick_submitted',
    'pick_conflict',
    'email_verified',
    'logged_in',
    'onboarding_completed',
    'newsletter_opt_in',
    'newsletter_sent',
    'newsletter_exclusive_pick',
    'pick_settled',
    'hatchery_opened',
    'egg_purchased',
    'egg_hatched',
    'food_purchased',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface LogEventInput {
    visitorId: string;
    waitlistId?: string | null;
    eventType: EventType;
    path?: string | null;
    tankSlug?: string | null;
    wallKind?: string | null;
    metadata?: unknown;
}

export async function logEvent(sql: NeonQueryFunction<false, false>, input: LogEventInput): Promise<void> {
    await sql`
        INSERT INTO events (visitor_id, waitlist_id, event_type, path, tank_slug, wall_kind, metadata)
        VALUES (
            ${input.visitorId},
            ${input.waitlistId ?? null},
            ${input.eventType},
            ${input.path ?? null},
            ${input.tankSlug ?? null},
            ${input.wallKind ?? null},
            ${input.metadata !== undefined ? JSON.stringify(input.metadata) : null}
        )
    `;
}
