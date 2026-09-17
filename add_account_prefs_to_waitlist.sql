-- Account-page preferences and soft delete (scripts/templates/account-template.ts +
-- account-client.tsx, functions/api/account*.ts).
--
-- Three per-channel opt-outs, every one defaulting to today's behaviour (on):
--   email_settlement_results - the "You called it" / "Your Tank call settled" email
--                              (functions/api/settle.ts -> lib/pages-functions/email.ts)
--   notify_pet_hungry        - the in-app "my tummy's rumbling" row
--                              (functions/api/notify-sweep.ts writer 1)
--   notify_daily_drop        - the in-app "fresh drop" digest row
--                              (functions/api/notify-sweep.ts writer 2)
-- The newsletter's switch is the existing newsletter_opt_in column
-- (add_newsletter_optin_to_waitlist.sql); the account page just gains an opt-OUT path
-- for it. Login links and verification codes have no switch - they are how you get in.
--
-- deleted_at marks a soft-deleted account. Deletion is a soft delete on purpose:
-- ember_ledger / ember_balances / item_ledger / share_* / community_* all reference
-- waitlist(id) with NO cascade and are append-only by design, so the row stays and is
-- anonymized instead (functions/api/account/delete.ts scrubs email + username, revokes
-- sessions, drops the Discord link). getSession() refuses a row with deleted_at set.
--
-- Deploy gap: lib/pages-functions/session.ts filters on deleted_at and settle.ts /
-- notify-sweep.ts read the three flags, so every authenticated request 500s until this
-- is applied. Apply BEFORE deploying the code that references these columns.
-- Execute: psql "$DATABASE_URL" -f add_account_prefs_to_waitlist.sql

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS email_settlement_results BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notify_pet_hungry        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS notify_daily_drop        BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS deleted_at               TIMESTAMP WITH TIME ZONE;
