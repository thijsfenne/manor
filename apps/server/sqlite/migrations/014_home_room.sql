-- "No project" used to be a project row named General that stood for the memory
-- system (decided 2026-11-11: it is not a project). The room is now built in under
-- the fixed id `home`, so everything that pointed at that row points there instead
-- and the row goes. Its folder and memory reach come from the server, as before.
--
-- Only a General without a thread was that room. One with a thread is a project the
-- user sees in the sidebar, and it is left exactly as it is.
UPDATE records SET value = json_set(value, '$.projectId', 'home')
WHERE collection IN ('chats', 'routines', 'workHandoffs')
  AND json_extract(value, '$.projectId') IN (
    SELECT key FROM records
    WHERE collection = 'projects'
      AND json_extract(value, '$.name') = 'General'
      AND json_extract(value, '$.threadChatId') IS NULL
  );

-- A scheduled task could also run with no room at all, which read as "No project" too
-- but reached no memory folder. One meaning now (2026-11-11): such a task works in the
-- home room. Only a task with neither a project nor a chat is that; a persona's task
-- in a direct message has its chat and is left alone. Runs already made keep theirs.
UPDATE records SET value = json_set(value, '$.projectId', 'home')
WHERE collection = 'routines'
  AND json_extract(value, '$.projectId') IS NULL
  AND json_extract(value, '$.chatId') IS NULL;

-- A proposal card names its room; the name the row had would now be a stale label.
UPDATE records SET value = json_set(value, '$.projectName', 'No project')
WHERE collection = 'workHandoffs' AND json_extract(value, '$.projectId') = 'home';

DELETE FROM records
WHERE collection = 'projects'
  AND json_extract(value, '$.name') = 'General'
  AND json_extract(value, '$.threadChatId') IS NULL;

PRAGMA user_version = 14;
