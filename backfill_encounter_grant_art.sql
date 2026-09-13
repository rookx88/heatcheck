-- encounters.grants.item gains `name` and `art`, the two things the encounter stage's
-- reward reveal needs and cannot look up for itself: no endpoint exposes an UNOWNED
-- items_catalog row, so the payload has to carry them. The fire statement resolves
-- both from now on (lib/pages-functions/encounters/evaluate.ts fireEncounter); this is
-- the one-time catch-up for rows that fired before that deploy.
--
-- `art` follows the notifications.art contract (add_art_to_notifications.sql): a
-- subpath under /assets/images/, NULL when the type has no artwork at all. The
-- per-type derivation is the catalog's existing one - food is keyed by SKU,
-- memorabilia carries config.image (add_memorabilia_items.sql), collectibles
-- config.cover_image (add_genesis_collectibles.sql), and eggs have no file to show
-- (Egg3D draws them procedurally from a hue).
--
-- Cosmetic rather than load-bearing: only an unseen 'offered' row is ever rendered,
-- and a 'seen' row's grants is read only for the `ember` heal flag. Every row with an
-- item is updated anyway so the column has ONE shape for whatever reads it next.
--
-- No schema change, so deploy order does not matter. Safe to re-run: the
-- NOT (... ? 'art') qual makes a second run a no-op.
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f backfill_encounter_grant_art.sql -d "$DATABASE_URL"

UPDATE encounters e
SET grants = jsonb_set(
        e.grants,
        '{item}',
        (e.grants->'item') || jsonb_build_object(
            'name', c.name,
            'art', CASE c.item_type
                       WHEN 'food'        THEN 'food/' || c.key || '.png'
                       WHEN 'memorabilia' THEN c.config->>'image'
                       WHEN 'collectible' THEN c.config->>'cover_image'
                       ELSE NULL
                   END))
FROM items_catalog c
WHERE c.key = e.grants->'item'->>'catalogKey'
  AND e.grants ? 'item'
  AND NOT (e.grants->'item' ? 'art');
