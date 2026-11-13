-- One CLI session per chat, persona and provider. The pair's single row becomes the
-- row of the provider that minted it; a row without one keeps an empty provider and
-- stays unresumable, as it was. Nothing is dropped.
UPDATE records SET key = key || '::' || coalesce(json_extract(value, '$.driver'), '')
WHERE collection = 'sessions';

PRAGMA user_version = 8;
