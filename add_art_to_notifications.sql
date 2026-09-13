-- notifications.art: what the PetWidget bubble SHOWS while it speaks the row, as
-- opposed to `mood`, which is the face the pet pulls while saying it. Set by the
-- producers, never inferred from the copy - a find should be recognisable at a
-- glance without reading the sentence.
--
-- Exactly two shapes, and the client switches on the first:
--   'ember'        - the currency. The widget floats a $$$ chip over the pet's head
--                    and pops it; no image goes in the bubble. The one sentinel.
--   '<subpath>'    - anything else is a path under /assets/images/, rendered as an
--                    <img> inside the bubble. Same contract as items_catalog's
--                    config.cover_image / config.image, so the producer resolves the
--                    path once and every renderer stays dumb:
--                      food/food_chicken_wings.png
--                      memorabilia/worn_football.png
--                      collectibles/neon_og_card.jpg
--   NULL           - no art; the bubble is text only. This is the default and what
--                    every pre-existing row keeps.
--
-- Writers: lib/pages-functions/discovery.ts (all four find branches, via
-- discoveryFindEmber() for the ember one). Settlement notifications deliberately
-- leave it NULL - the flourish is for the pet FINDING Ember, not for every Ember
-- event that lands in the inbox.
--
-- DEPLOY ORDER: apply this BEFORE deploying the code that writes it. The find
-- inserts run inside GET /api/toolbar-state, so a missing column would 500 the
-- toolbar read for every pet owner, not just the one who rolled a find.
-- Execute: psql "$DATABASE_URL" -f add_art_to_notifications.sql

ALTER TABLE notifications
    ADD COLUMN IF NOT EXISTS art TEXT;
