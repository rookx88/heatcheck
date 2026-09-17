-- Removes the quests compatibility view left by rename_quests_to_plays.sql.
--
-- Run ONLY after the Plays code is live on every deployment that shares this database.
-- Code from before the rename reads quests on every toolbar-state call, so dropping the
-- view while any such deployment is serving breaks its header.
--
-- Execute: psql -v ON_ERROR_STOP=1 -1 -f drop_quests_compat_view.sql -d "$DATABASE_URL"

DROP VIEW IF EXISTS quests;
