-- Original bytes of PDF and Word attachments. Kept beside the transcript rather than in
-- the event payload, so loading a chat never parses the document; deleted with its chat.
CREATE TABLE IF NOT EXISTS documents (
  chat_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (chat_id, document_id)
);
PRAGMA user_version = 6;
