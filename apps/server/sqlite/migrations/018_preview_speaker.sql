-- A chat's listed line now says who said it (`fromUser` in its transcript metadata),
-- so the rail's preview card can read "You:". Rows written before that are filled in
-- by `recordPreviewSpeakers` in sqliteDatabase.ts, which needs the same rule the
-- store uses to pick the line.

PRAGMA user_version = 18;
