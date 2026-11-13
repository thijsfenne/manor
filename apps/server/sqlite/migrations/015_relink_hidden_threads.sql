-- Hide project used to cut the project's link to its thread and archive the chat, so
-- the thread turned into a loose archived chat and adding the project back made an
-- empty one. Hiding now keeps the link (decided 2026-11-12). This gives a project
-- that is still without a thread its old one back, where that is unambiguous.
--
-- A thread is a Single project chat in that project, titled with the project's name,
-- that no handoff started as a Session and that is not a side chat. Where several
-- match one project, the one last written in is taken and the others stay as they are.
-- A project that already has a thread is left alone, also when an older one exists.
UPDATE records SET value = json_set(records.value, '$.threadChatId', pick.chatId)
FROM (
  SELECT projectId, chatId FROM (
    SELECT project.key AS projectId, chat.key AS chatId,
      row_number() OVER (
        PARTITION BY project.key
        ORDER BY json_extract(chat.value, '$.lastMessageAt') DESC, json_extract(chat.value, '$.createdAt') DESC, chat.key DESC
      ) AS place
    FROM records AS project
    JOIN records AS chat ON chat.collection = 'chats'
      AND json_extract(chat.value, '$.projectId') = project.key
      AND json_extract(chat.value, '$.title') = json_extract(project.value, '$.name')
    WHERE project.collection = 'projects'
      AND json_extract(project.value, '$.threadChatId') IS NULL
      AND json_extract(chat.value, '$.kind') = 'project'
      AND json_extract(chat.value, '$.mode') = 'single'
      AND json_extract(chat.value, '$.parentChatId') IS NULL
      AND chat.key NOT IN (
        SELECT json_extract(value, '$.workChatId') FROM records
        WHERE collection = 'workHandoffs' AND json_extract(value, '$.workChatId') IS NOT NULL
      )
  ) WHERE place = 1
) AS pick
WHERE records.collection = 'projects' AND records.key = pick.projectId;

PRAGMA user_version = 15;
