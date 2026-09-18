-- share_holdings.held_since - when the CURRENT position was opened.
--
-- Beaks's arc ends with a Play that asks the player to carry a position through one of
-- an index's daily closes (encounters/plays.ts, objective kind 'hold_through_close').
-- That is the one thing in the game a player cannot rush, which is the point of the
-- beat: the man who never holds a position asks the pet to hold one.
--
-- WHY A COLUMN AND NOT A QUERY. The alternative was correlating share_trades against
-- ticker_events, which has no supporting index and grows per user forever. This column
-- makes the check one probe: does a close event on that index exist with occurred_at
-- later than held_since (idx_ticker_events_key_time covers it exactly).
--
-- LIFECYCLE. ledger.buyShares sets it on the INSERT and deliberately does NOT touch it
-- in the ON CONFLICT DO UPDATE branch, so adding to a position never restarts the
-- clock. sellShares deletes the row when the position closes
-- (DELETE ... WHERE shares = 0), so the next buy starts a fresh position and a fresh
-- held_since. Nothing else writes it.
--
-- BACKFILL. Existing rows get updated_at, which is the last time the position changed -
-- the closest honest value available, and never later than the truth, so an existing
-- holder is not penalised. NOT NULL with a default so the buy statement needs no change
-- for rows it does not name.
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f add_held_since_to_share_holdings.sql -d "$DATABASE_URL"

ALTER TABLE share_holdings
    ADD COLUMN IF NOT EXISTS held_since TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW();

UPDATE share_holdings SET held_since = updated_at WHERE held_since > updated_at;
