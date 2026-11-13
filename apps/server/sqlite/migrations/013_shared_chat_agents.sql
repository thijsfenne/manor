-- Every chat agent is shared (decided 2026-11-09): the DM-only lock and the persona
-- folder link that existed only for it are gone from the agent record. Clearing them
-- here rather than ignoring them on read keeps the stored roster equal to what the
-- server sends, so no client or later code can trip over a stale `dmOnly: true`.
-- Chats, memberships, routines and history are untouched.
UPDATE records SET value = json_remove(value, '$.dmOnly', '$.projectId')
WHERE collection = 'agents';

PRAGMA user_version = 13;
