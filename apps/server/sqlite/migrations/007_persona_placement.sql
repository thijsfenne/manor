-- Preserve only the team of an already accepted, unfinished Multiple Session.
-- Pending proposals and ordinary historical chats acquire no routing exception.
UPDATE records AS c SET value = json_set(c.value, '$.legacySessionAgentIds', json((
  SELECT json_group_array(agent_id) FROM (
    SELECT json_extract(h.value, '$.leadAgentId') AS agent_id
    FROM records h WHERE h.collection = 'workHandoffs' AND json_extract(h.value, '$.workChatId') = c.key
    UNION
    SELECT json_extract(h.value, '$.firstExecutor.agentId')
    FROM records h WHERE h.collection = 'workHandoffs' AND json_extract(h.value, '$.workChatId') = c.key
    UNION
    SELECT team.value FROM records h, json_each(h.value, '$.supportingAgentIds') team
    WHERE h.collection = 'workHandoffs' AND json_extract(h.value, '$.workChatId') = c.key
    UNION
    SELECT json_extract(e.payload, '$.agentId') FROM events e WHERE e.chat_id = c.key
    UNION
    -- Keep the existing lead's review route even when the first review has not run.
    SELECT allowed.value FROM records h
    JOIN records a ON a.collection = 'agents' AND a.key = json_extract(h.value, '$.leadAgentId'),
      json_each(a.value, '$.mentionAllowlist') allowed
    WHERE h.collection = 'workHandoffs' AND json_extract(h.value, '$.workChatId') = c.key
      AND allowed.value = 'argus'
  ) WHERE agent_id IS NOT NULL
)))
WHERE c.collection = 'chats'
  AND json_extract(c.value, '$.kind') = 'project'
  AND coalesce(json_extract(c.value, '$.mode'), 'house') <> 'single'
  AND json_extract(c.value, '$.settledAt') IS NULL
  AND EXISTS (
    SELECT 1 FROM records h WHERE h.collection = 'workHandoffs'
      AND json_extract(h.value, '$.workChatId') = c.key
      AND json_extract(h.value, '$.acceptedAt') IS NOT NULL
      AND json_extract(h.value, '$.state') = 'active'
  );

-- Keep ids, runtime choices, connections, skills, memory and all historical events.
UPDATE records SET value = json_set(value, '$.placement',
  CASE WHEN key IN ('wren', 'argus', 'ellis') THEN 'session' ELSE 'chat' END)
WHERE collection = 'agents';

UPDATE records SET value = json_set(value,
  '$.role', 'Session engineer',
  '$.description', 'Engineer across the stack, with frontend expertise. Owns implementation and verification in Sessions.',
  '$.character', json_extract(value, '$.character') || char(10) || char(10) ||
    'Your Session role now covers architecture, backend, runtime, tooling and frontend. Implement the approved brief across the stack. Preserve your frontend craft. Bring Argus in for review. Do not route backend implementation to Smith; he is the technical contact in chat.',
  '$.isCos', json('false'), '$.dmOnly', json('false'))
WHERE collection = 'agents' AND key = 'wren';

UPDATE records SET value = json_set(value,
  '$.isCos', json('false'), '$.dmOnly', json('false'))
WHERE collection = 'agents' AND key = 'argus';

-- Keep old summon authority for captured teams; placement filters it in new Sessions.
UPDATE records SET value = json_set(value, '$.mentionAllowlist', json((
  SELECT json_group_array(id) FROM (
    SELECT value AS id FROM json_each(records.value, '$.mentionAllowlist')
    UNION SELECT 'wren' UNION SELECT 'argus' UNION SELECT 'ellis'
  ) WHERE id <> records.key
))) WHERE collection = 'agents' AND key IN ('wren', 'argus');

-- Ellis gets the engineer's working tools and runtime, with his own identity and memory id.
INSERT INTO records(collection, key, value)
SELECT 'agents', 'ellis', json_remove(json_set(value,
  '$.id', 'ellis', '$.name', 'Ellis', '$.role', 'Session generalist',
  '$.description', 'Research, documents and other knowledge work in Sessions.',
  '$.character', 'You are Ellis, the Session generalist. Carry out the approved brief for research, documents, analysis and other knowledge work. Use primary sources where possible, distinguish evidence from inference and deliver the actual artifact. Ask Wren for engineering and Argus for review when the assignment needs them. Keep the user-facing result concise, with only limitations that affect its use. Speak only as yourself.',
  '$.mentionAllowlist', json('["wren","argus"]'), '$.pinned', json('false'), '$.railPinned', json('false')),
  '$.avatar', '$.avatarShape')
FROM records WHERE collection = 'agents' AND key = 'wren'
  AND NOT EXISTS (SELECT 1 FROM records WHERE collection = 'agents' AND key = 'ellis');

PRAGMA user_version = 7;
