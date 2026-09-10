-- notifications.mood: the face the pet pulls while the PetWidget bubble speaks the
-- row ('happy' | 'sad' | NULL = the normal face). Set by the producers, never
-- inferred from the copy: settlement (win happy / loss sad, lib/pages-functions/
-- ledger.ts), every pet find (happy, ledger.ts + discovery.ts), the hungry reminder
-- (sad, functions/api/notify-sweep.ts) and the welcome message (happy,
-- functions/api/onboarding/complete.ts). The daily drop digest and newsletter rows
-- leave it NULL. Sprites: assets/images/pets/mud_puppy_{happy,sad}.png via
-- scripts/make-pet-expressions.ts; components/PetPortrait.tsx swaps them in.
--
-- DEPLOY ORDER: apply this BEFORE deploying the code that writes it. The find
-- inserts run inside GET /api/toolbar-state and the settle insert shares a
-- transaction with the payout - a missing column would 500 the toolbar read and
-- stop settlements.
-- Execute: psql "$DATABASE_URL" -f add_mood_to_notifications.sql

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS mood TEXT CHECK (mood IS NULL OR mood IN ('happy', 'sad'));
