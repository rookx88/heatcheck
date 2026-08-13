-- Heatchecks Ember ledger — append-only earn/spend history plus a cached balance.
-- The ledger is a diary, not a bank balance: ember_ledger rows are never UPDATEd or
-- DELETEd, only appended; corrections are future reversal rows, not edits. ember_rules
-- is versioned the same way — changing a payout amount inserts a new (key, version) row
-- and flips `active`, never mutates an existing row's config, so a historical
-- ember_ledger row stays explainable by the rule_version it was stamped with.
-- Run this SQL file against the main app database to create the tables.
-- Execute: psql "$DATABASE_URL" -f create_ember_ledger_tables.sql

CREATE TABLE IF NOT EXISTS ember_rules (
    key        TEXT NOT NULL,
    version    INT NOT NULL,
    kind       TEXT NOT NULL,                 -- 'source' | 'sink'
    active     BOOLEAN NOT NULL DEFAULT true,
    config     JSONB NOT NULL DEFAULT '{}',    -- e.g. { "amount": 10 } — payout/cost for this version
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (key, version)
);

-- Only one active version per key, enforced at the DB level (not just app-level) so a
-- bad deploy can't silently create two "active" rows for the same key.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ember_rules_one_active_per_key
    ON ember_rules(key) WHERE active;

CREATE TABLE IF NOT EXISTS ember_ledger (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID NOT NULL REFERENCES waitlist(id),
    amount          INT NOT NULL,               -- signed delta; SUM(amount) per user_id == balance
    entry_type      TEXT NOT NULL,              -- 'earn' | 'spend' | 'reversal' | 'adjustment'
    rule_key        TEXT NOT NULL,
    rule_version    INT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    metadata        JSONB NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (rule_key, rule_version) REFERENCES ember_rules(key, version)
);

CREATE INDEX IF NOT EXISTS idx_ember_ledger_user_created ON ember_ledger(user_id, created_at);

-- Fast-read cache of the balance, updated in the same statement as the ledger insert.
-- A convenience, NOT the truth — always reconstructable from ember_ledger via rebuildBalance().
CREATE TABLE IF NOT EXISTS ember_balances (
    user_id    UUID PRIMARY KEY REFERENCES waitlist(id),
    balance    INT NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Seed rules — placeholder amounts, TBD by product. Change later by inserting a new
-- (key, version + 1) row and flipping active; never UPDATE config on an existing row.
INSERT INTO ember_rules (key, version, kind, active, config) VALUES
    ('correct_call', 1, 'source', true, '{"amount": 10}'),
    ('participation', 1, 'source', true, '{"amount": 2}')
ON CONFLICT (key, version) DO NOTHING;
