-- Preserve the full old kickoff on the proposal before removing its unused shell.
-- Any additional content, session, checkout or dependent chat makes a target ineligible.
CREATE TEMP TABLE pending_work_shells AS
SELECT h.key AS handoff_id, c.key AS chat_id, json_extract(c.value, '$.title') AS title, e.payload AS kickoff
FROM records h
JOIN records c ON c.collection = 'chats' AND c.key = json_extract(h.value, '$.workChatId')
JOIN events e ON e.chat_id = c.key
WHERE h.collection = 'workHandoffs'
  AND json_extract(h.value, '$.acceptedAt') IS NULL
  AND json_extract(h.value, '$.state') IN ('active', 'settled')
  AND json_extract(c.value, '$.kind') = 'project'
  AND json_extract(c.value, '$.archivedAt') IS NULL
  AND json_extract(e.payload, '$.type') = 'user_message'
  AND json_extract(e.payload, '$.source') = 'work_handoff'
  AND json_extract(e.payload, '$.workHandoffId') = h.key
  AND (SELECT count(*) FROM events WHERE chat_id = c.key) = 1
  AND NOT EXISTS (
    SELECT 1 FROM json_each(e.payload)
    WHERE key NOT IN ('id', 'ts', 'type', 'text', 'mentions', 'source', 'workHandoffId',
      'workSourceChatId', 'workAuthorAgentId', 'workSupportingAgentIds', 'workTargetLeadId')
  )
  AND NOT EXISTS (
    SELECT 1 FROM records r
    WHERE NOT (r.collection = 'chats' AND r.key = c.key)
      AND NOT (r.collection = 'workHandoffs' AND r.key = h.key)
      AND NOT (r.collection IN ('transcriptMetadata', 'unsettledAt') AND r.key = c.key)
      AND (r.key = c.key OR substr(r.key, 1, length(c.key) + 2) = c.key || '::'
        OR json_extract(r.value, '$.chatId') = c.key
        OR json_extract(r.value, '$.parentChatId') = c.key
        OR json_extract(r.value, '$.sourceChatId') = c.key
        OR json_extract(r.value, '$.workChatId') = c.key)
  );
UPDATE records SET value = json_set(value,
  '$.workChatId', NULL,
  '$.title', (SELECT title FROM pending_work_shells WHERE handoff_id = records.key),
  '$.kickoff', json_extract((SELECT kickoff FROM pending_work_shells WHERE handoff_id = records.key), '$.text'),
  '$.authorAgentId', coalesce(json_extract((SELECT kickoff FROM pending_work_shells WHERE handoff_id = records.key), '$.workAuthorAgentId'), json_extract(value, '$.leadAgentId')),
  '$.legacyKickoffEvent', json((SELECT kickoff FROM pending_work_shells WHERE handoff_id = records.key)))
WHERE collection = 'workHandoffs' AND key IN (SELECT handoff_id FROM pending_work_shells);
DELETE FROM events WHERE chat_id IN (SELECT chat_id FROM pending_work_shells);
DELETE FROM records WHERE collection IN ('chats', 'transcriptMetadata', 'unsettledAt')
  AND key IN (SELECT chat_id FROM pending_work_shells);
DROP TABLE pending_work_shells;
PRAGMA user_version = 2;
