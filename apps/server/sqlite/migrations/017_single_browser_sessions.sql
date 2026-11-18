-- A Browser session is one model beside the page (decided 2026-11-18): no personas,
-- no Multiple mode. Sessions made as Multiple before that become Single; their
-- transcripts stay as they are, and the next turn runs the house Single default
-- unless the session already holds a Single pin.
UPDATE records SET value = json_set(value, '$.mode', 'single')
WHERE collection = 'chats'
  AND json_extract(value, '$.kind') = 'browser'
  AND json_extract(value, '$.mode') IS NOT 'single';

PRAGMA user_version = 17;
