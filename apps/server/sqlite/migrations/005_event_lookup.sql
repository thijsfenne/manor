CREATE INDEX IF NOT EXISTS events_chat_event_id ON events(chat_id, event_id);
PRAGMA user_version = 5;
