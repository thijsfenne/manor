-- Historical chats keep their existing household behavior.
UPDATE records SET value = json_set(value, '$.mode', 'house')
WHERE collection = 'chats' AND json_extract(value, '$.mode') IS NULL;
PRAGMA user_version = 3;
