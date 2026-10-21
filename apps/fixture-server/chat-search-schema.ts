/**
 * The chat search index's SQLite objects in the workflow database, exactly
 * as `sqlite_schema` stores them. Read-only tools that vet that database
 * (legacy inventory, copied tuples) accept these and nothing else virtual.
 */
export const CHAT_SEARCH_FTS = "chat_search_fts";
/** A built-in FTS5 table; its SQL text is compared byte for byte. */
export const CHAT_SEARCH_FTS_SQL =
  "CREATE VIRTUAL TABLE chat_search_fts USING fts5(scope, body, content='', contentless_delete=1, tokenize='unicode61 remove_diacritics 2', prefix='2 3')";
/** The shadow tables FTS5 creates for it (a contentless table has no _content). */
export const CHAT_SEARCH_FTS_SHADOW: Readonly<Record<string, string>> = {
  chat_search_fts_data:
    "CREATE TABLE 'chat_search_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
  chat_search_fts_idx:
    "CREATE TABLE 'chat_search_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID",
  chat_search_fts_docsize:
    "CREATE TABLE 'chat_search_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB, origin INTEGER)",
  chat_search_fts_config:
    "CREATE TABLE 'chat_search_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID",
};
