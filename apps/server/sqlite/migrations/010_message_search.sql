-- Full-text index over what was said in a chat: the user's messages and persona replies,
-- for the ⌘K palette. Tool output, reasoning and Manor's own wake rows stay out.
--
-- The index is derived: the events stay exactly as they were, and triggers keep the
-- index in step with every append, replace and delete, so no store code has to
-- remember it. `rowid` is the event's `seq`; `chat_id` rides along unindexed so the
-- per-chat cap needs no join, and comes first so reading it never pages through a
-- long reply. `remove_diacritics 2` lets "cafe" find "café". The prefix indexes make
-- the first keystrokes cheap: on the 2026-10-09 copy of the live store (29k messages)
-- a one-letter query fell from 280ms to 50ms for about 17MB more index.
CREATE VIRTUAL TABLE IF NOT EXISTS message_search USING fts5(
  chat_id UNINDEXED,
  text,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '1 2 3'
);

-- Rebuilt from scratch, so running this file again over an indexed database is safe.
DELETE FROM message_search;
INSERT INTO message_search(rowid, text, chat_id)
  SELECT seq, json_extract(payload, '$.text'), chat_id FROM events
  WHERE json_extract(payload, '$.type') IN ('user_message', 'agent_message')
    AND coalesce(json_extract(payload, '$.source'), '') <> 'background_wake'
    AND coalesce(json_extract(payload, '$.text'), '') <> '';

CREATE TRIGGER IF NOT EXISTS message_search_insert AFTER INSERT ON events
WHEN json_extract(new.payload, '$.type') IN ('user_message', 'agent_message')
  AND coalesce(json_extract(new.payload, '$.source'), '') <> 'background_wake'
  AND coalesce(json_extract(new.payload, '$.text'), '') <> ''
BEGIN
  INSERT INTO message_search(rowid, text, chat_id)
    VALUES (new.seq, json_extract(new.payload, '$.text'), new.chat_id);
END;

CREATE TRIGGER IF NOT EXISTS message_search_update AFTER UPDATE OF payload ON events
BEGIN
  DELETE FROM message_search WHERE rowid = old.seq;
  INSERT INTO message_search(rowid, text, chat_id)
    SELECT new.seq, json_extract(new.payload, '$.text'), new.chat_id
    WHERE json_extract(new.payload, '$.type') IN ('user_message', 'agent_message')
      AND coalesce(json_extract(new.payload, '$.source'), '') <> 'background_wake'
      AND coalesce(json_extract(new.payload, '$.text'), '') <> '';
END;

CREATE TRIGGER IF NOT EXISTS message_search_delete AFTER DELETE ON events
BEGIN
  DELETE FROM message_search WHERE rowid = old.seq;
END;

PRAGMA user_version = 10;
