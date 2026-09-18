-- The welcome letter (welcome-client.tsx / functions/api/onboarding/complete.ts) now
-- carries two things it didn't before:
--
--   waitlist.terms_accepted_at / terms_version - the record that this account ticked
--     "I've read and agree to the Terms of Service and Privacy Policy" when it signed the
--     letter. Stamped by the same guarded UPDATE that stamps onboarded_at, so the two are
--     set together exactly once. terms_version is lib/pages-functions/terms.ts
--     TERMS_VERSION at signing time (the Terms' effective date). Accounts onboarded
--     before this migration keep NULL - they were never shown the checkbox.
--
--   ember_rules['welcome_gift'] - Sports McLaren's starting Ember, credited once per
--     account when the letter is signed (ledger.welcomeGiftEmber()). A GIFT, not game
--     earnings: an 'earn' row deliberately absent from ledger.ts
--     LIFETIME_EARNED_RULE_KEYS, so it folds `balance` only and never moves the Hall of
--     Fame (same treatment as encounter_gift). 100 = one standard egg
--     (spend_egg_standard); retune here, the letter reads the amount from this row.
--
-- Idempotent; safe to re-run.

BEGIN;

ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMP WITH TIME ZONE;
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS terms_version TEXT;

INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('welcome_gift', 1, 'source', true, '{"amount": 100}')
ON CONFLICT (key, version) DO NOTHING;

COMMIT;
