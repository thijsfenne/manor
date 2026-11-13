-- Every existing room ranks against its own index only; Knowledge work is opted in per room.
UPDATE records SET value = json_set(value, '$.memoryScope', 'project')
WHERE collection = 'projects' AND json_extract(value, '$.memoryScope') IS NULL;
PRAGMA user_version = 4;
