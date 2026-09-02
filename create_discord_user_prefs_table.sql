-- Per-PERSON Discord preferences, as opposed to discord_guild_configs' per-server
-- settings. First and currently only preference: whose picture sits in the glow circle
-- on the /me rank card - the server's icon (the default, and what the card shipped
-- with) or the member's own avatar.
--
-- Deliberately keyed on discord_user_id ALONE, not (guild_id, discord_user_id): this is
-- effectively "my profile picture", and someone who sets it expects their card to look
-- the same in every server Heatchecks is in rather than having to set it once per
-- community.
--
-- Isolation reminder: display preferences only. Nothing here affects scoring, points,
-- Ember, or who can do what - a missing row simply means "defaults", which is why every
-- read is a LEFT JOIN or a COALESCE and no code path requires the row to exist.
--
-- Execute: psql "$DATABASE_URL" -f create_discord_user_prefs_table.sql

CREATE TABLE IF NOT EXISTS discord_user_prefs (
    discord_user_id VARCHAR(32) PRIMARY KEY,
    -- 'guild' = the server's icon (default), 'user' = their own Discord avatar.
    me_card_avatar VARCHAR(10) NOT NULL DEFAULT 'guild',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
