-- Manor's own wording for the model ("[Manor] Session accepted as Single with ...", Confirm's
-- commit request, a project thread's wake) now lives in a user message's `instruction`,
-- not its `text`. Rows written before that are moved by `moveManorWording` in
-- sqliteDatabase.ts, which needs the same split the clients use. The existing update
-- trigger then keeps the ⌘K index to what the user may read.

PRAGMA user_version = 12;
