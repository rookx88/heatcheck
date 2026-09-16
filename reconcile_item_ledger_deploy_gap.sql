-- Closes the item-journal gap left between applying create_item_ledger_tables.sql and
-- deploying the code that writes item_ledger.
--
-- WHY THIS EXISTS. The migration had to ship first: the journal is written inside the
-- statements that grant items during an ordinary page load, so the table must exist
-- before that code runs. But the code already deployed does not write the journal, so
-- every feed, hatch, purchase or find in that window moved inventory with no row here.
-- On 2026-09-16 the sweep showed one account (rook) off by three SKUs: a ribeye and a
-- worm delicacy fed, and a home-run baseball found, all after the opening balances.
--
-- WHEN TO RUN. Immediately AFTER the item-ledger code is live on every deployment that
-- shares this database. Running it earlier just fixes the snapshot while the old code
-- keeps drifting; run it again after deploy in that case.
--
-- WHAT IT WRITES. One 'deploy_gap' adjustment row per (user, SKU) whose SUM(delta)
-- disagrees with what they hold, carrying exactly the difference. Nothing is invented
-- about WHAT happened - the row says only that the journal was reconciled, and the
-- metadata records both sides. The individual movements are recoverable elsewhere:
-- purchases from ember_ledger, finds from notifications, feeds from pets.feed_count.
--
-- RERUNNABLE. A second run finds no mismatches and writes nothing. The idempotency key
-- also carries both totals, so an identical gap cannot be written twice.

BEGIN;

INSERT INTO item_reasons (key, kind, description)
VALUES ('deploy_gap', 'adjustment',
        'Reconciles movements made by pre-journal code between the migration and the code deploy')
ON CONFLICT (key, kind) DO NOTHING;

WITH led AS (
    SELECT user_id, catalog_key, item_type, SUM(delta)::int AS total
    FROM item_ledger GROUP BY 1, 2, 3
), inv AS (
    SELECT user_id, catalog_key, item_type, SUM(quantity)::int AS total
    FROM inventory_items GROUP BY 1, 2, 3
), gap AS (
    SELECT COALESCE(l.user_id, i.user_id)         AS user_id,
           COALESCE(l.catalog_key, i.catalog_key) AS catalog_key,
           COALESCE(l.item_type, i.item_type)     AS item_type,
           COALESCE(l.total, 0)                   AS ledger_total,
           COALESCE(i.total, 0)                   AS held_total
    FROM led l
    FULL OUTER JOIN inv i
      ON l.user_id = i.user_id AND l.catalog_key = i.catalog_key AND l.item_type = i.item_type
    WHERE COALESCE(l.total, 0) <> COALESCE(i.total, 0)
)
INSERT INTO item_ledger (user_id, catalog_key, item_type, delta, reason, reason_kind,
                         idempotency_key, metadata)
SELECT user_id, catalog_key, item_type, held_total - ledger_total, 'deploy_gap', 'adjustment',
       'deploy_gap:' || user_id || ':' || catalog_key || ':' || ledger_total || '->' || held_total,
       jsonb_build_object('ledgerBefore', ledger_total, 'held', held_total)
FROM gap
ON CONFLICT (idempotency_key) DO NOTHING;

-- Must return zero rows. If it does not, ROLLBACK instead of COMMIT and investigate.
WITH led AS (
    SELECT user_id, catalog_key, SUM(delta)::int AS total FROM item_ledger GROUP BY 1, 2
), inv AS (
    SELECT user_id, catalog_key, SUM(quantity)::int AS total FROM inventory_items GROUP BY 1, 2
)
SELECT COALESCE(l.user_id, i.user_id) AS user_id, COALESCE(l.catalog_key, i.catalog_key) AS catalog_key,
       COALESCE(l.total, 0) AS ledger, COALESCE(i.total, 0) AS held
FROM led l FULL OUTER JOIN inv i ON l.user_id = i.user_id AND l.catalog_key = i.catalog_key
WHERE COALESCE(l.total, 0) <> COALESCE(i.total, 0);

COMMIT;
