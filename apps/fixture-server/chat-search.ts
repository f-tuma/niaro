import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CHAT_SEARCH_MAX_LIMIT,
  CHAT_SEARCH_MAX_MATCHES,
  CHAT_SEARCH_MAX_QUERY,
  CHAT_SEARCH_PROFILE,
  ChatSearchPageSchema,
  type ChatSearchMatch,
  type ChatSearchPage,
  type ChatSearchRole,
  type SearchRanges,
} from "../../packages/protocol/chat-search";
import type { Scope } from "../../packages/protocol";
import { CHAT_SEARCH_FTS, CHAT_SEARCH_FTS_SQL } from "./chat-search-schema";

/**
 * Full-text search over the person's chats: SQLite FTS5 over the chat name,
 * the person's messages and the assistant's final answer of each turn.
 *
 * The index follows `public_conversation(_message)` through triggers, so
 * every write path keeps it in step without knowing about it: removing a
 * message or deleting a chat removes its index rows in the same statement,
 * and deleting a chat also rewrites the FTS index (`optimize`) so none of
 * its words stays in a segment; a stored, changed or renamed chat is marked
 * and re-indexed (in JS, where text is folded) before the next search of
 * that person and in bounded batches at startup. Archive state is read live
 * from the directory, so archiving and restoring change no index rows.
 */

const scopeKey = (scope: Scope) =>
  JSON.stringify([
    scope.connectionId,
    scope.serverId,
    scope.userId,
    scope.workspaceId,
  ]);
/** One FTS token per person, so the index filters by owner itself. */
const scopeToken = (key: string) =>
  `s${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;

/* ------------------------------------------------------------------------ */
/* Text                                                                      */

/** Case, accents and compatibility forms don't matter ("Schůzka" = "schuzka"). */
export function fold(text: string) {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

/**
 * The folded text and, for each of its UTF-16 units, the index of the
 * original character it came from (plus the end), so matches found in the
 * folded text highlight the original.
 */
export function foldWithOffsets(text: string) {
  let folded = "";
  const offsets: number[] = [];
  let index = 0;
  for (const char of text) {
    const part = fold(char);
    for (let i = 0; i < part.length; i++) offsets.push(index);
    folded += part;
    index += char.length;
  }
  offsets.push(index);
  return { folded, offsets };
}

/** Readable text of a Markdown answer: no markup, one line. */
export function plainText(markdown: string) {
  return markdown
    .replace(/```[^\n]*\n?/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|~~|`)/g, "")
    .replace(/(^|[\s(])[*_]([^\s*_][^*_]*?)[*_](?=[\s).,!?:;]|$)/gm, "$1$2")
    .replace(/\|/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const WORD = /[\p{L}\p{N}]+/gu;
const words = (folded: string) => folded.match(WORD) ?? [];

/** A searched word, or several in a row ("a quoted phrase"). */
type Term =
  | { kind: "word"; word: string; prefix: boolean }
  | { kind: "phrase"; words: string[] };

/**
 * Czech words change their ending ("schůzka", "schůzku", "schůzky"): a long
 * word also matches what starts with it less its final vowels.
 */
const stem = (word: string) => {
  if (word.length < 5 || /\d/.test(word)) return word;
  const cut = word.replace(/[aeiouy]+$/, "");
  return cut.length >= 4 ? cut : word;
};

/**
 * Words are all required; "quotes" keep words together; the last word also
 * matches as a prefix (the person is still typing it). At most 12 terms.
 */
export function parseQuery(query: string): Term[] {
  const terms: Term[] = [];
  const parts = query.split('"');
  // An unclosed quote is just text.
  const closed = parts.length % 2 === 1;
  parts.forEach((part, index) => {
    const quoted = index % 2 === 1 && (closed || index < parts.length - 1);
    const found = words(fold(part));
    if (quoted && found.length > 1)
      terms.push({ kind: "phrase", words: found });
    else if (quoted)
      for (const word of found)
        terms.push({ kind: "word", word, prefix: false });
    else
      for (const word of found) {
        const stemmed = stem(word);
        terms.push({ kind: "word", word: stemmed, prefix: stemmed !== word });
      }
  });
  const last = terms.at(-1);
  // Still typing the last word: it matches what starts with it.
  if (last?.kind === "word" && !/["\s]$/.test(query) && last.word.length >= 2)
    last.prefix = true;
  return terms.slice(0, 12);
}

const quote = (word: string) => `"${word.replace(/"/g, '""')}"`;
/** The FTS5 expression for the terms, inside one person's rows. */
function matchExpression(token: string, terms: Term[]) {
  return [
    `scope : ${quote(token)}`,
    ...terms.map((term) =>
      term.kind === "phrase"
        ? `body : ${quote(term.words.join(" "))}`
        : `body : ${quote(term.word)}${term.prefix ? "*" : ""}`,
    ),
  ].join(" AND ");
}

/** Where the terms occur in a text, as ordered, merged ranges of it. */
export function findRanges(text: string, terms: Term[]): SearchRanges {
  const { folded, offsets } = foldWithOffsets(text);
  const tokens = [...folded.matchAll(WORD)].map((m) => ({
    word: m[0],
    start: offsets[m.index]!,
    end: offsets[m.index + m[0].length]!,
  }));
  const found: [number, number][] = [];
  const hit = (token: string, word: string, prefix: boolean) =>
    prefix ? token.startsWith(word) : token === word;
  tokens.forEach((token, index) => {
    for (const term of terms) {
      if (term.kind === "word") {
        if (hit(token.word, term.word, term.prefix))
          found.push([token.start, token.end]);
      } else if (
        term.words.every((word, i) => tokens[index + i]?.word === word)
      )
        found.push([token.start, tokens[index + term.words.length - 1]!.end]);
    }
  });
  found.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: [number, number][] = [];
  for (const [start, end] of found) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else if (end > start) merged.push([start, end]);
  }
  return merged.slice(0, 32);
}

const SNIPPET = 180;
const LEAD = 48;
/** A short excerpt around the densest matches, with ranges into it. */
export function snippetOf(text: string, terms: Term[]) {
  const plain = plainText(text) || text.replace(/\s+/g, " ").trim();
  const ranges = findRanges(plain, terms);
  if (plain.length <= SNIPPET) return { snippet: plain, ranges };
  // The window that holds the most matches, starting a little before one.
  let best = 0;
  let bestCount = 0;
  ranges.forEach(([start], index) => {
    const count = ranges.filter(
      ([s, e], i) => i >= index && s >= start && e <= start + SNIPPET - LEAD,
    ).length;
    if (count > bestCount) {
      best = index;
      bestCount = count;
    }
  });
  let start = ranges.length ? Math.max(0, ranges[best]![0] - LEAD) : 0;
  if (start > 0) {
    // Start at a word, and never cut a highlighted word.
    const space = plain.indexOf(" ", start);
    if (space !== -1 && space < (ranges[best]?.[0] ?? start + 16))
      start = space + 1;
  }
  let end = Math.min(plain.length, start + SNIPPET);
  if (end < plain.length) {
    const space = plain.lastIndexOf(" ", end);
    if (space > start + SNIPPET / 2) end = space;
  }
  while (plain[start] === " ") start++;
  while (end > start && plain[end - 1] === " ") end--;
  const lead = start > 0 ? "…" : "";
  const snippet = `${lead}${plain.slice(start, end)}${end < plain.length ? "…" : ""}`;
  const inside: [number, number][] = [];
  for (const [s, e] of ranges) {
    const from = Math.max(s, start) - start + lead.length;
    const to = Math.min(e, end) - start + lead.length;
    if (to > from) inside.push([from, to]);
  }
  return { snippet, ranges: inside };
}

/* ------------------------------------------------------------------------ */
/* Index                                                                     */

type MessageRow = {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt?: string;
  resultType?: string;
};
const parseMessage = (payload: string): MessageRow | undefined => {
  try {
    const value = JSON.parse(payload) as Record<string, unknown>;
    if (typeof value.id !== "string" || typeof value.text !== "string")
      return undefined;
    if (value.role !== "user" && value.role !== "assistant") return undefined;
    const result = value.result as { type?: unknown } | undefined;
    return {
      id: value.id,
      role: value.role,
      text: value.text,
      createdAt:
        typeof value.createdAt === "string" ? value.createdAt : undefined,
      resultType: typeof result?.type === "string" ? result.type : undefined,
    };
  } catch {
    return undefined;
  }
};

/**
 * What of a chat is searchable: every message of the person and the last
 * answer of the assistant in each turn (a turn runs from one of the
 * person's messages to the next). Interim notes, tool outputs and contact
 * lists (which show no text) are left out.
 */
export function searchableMessages(messages: MessageRow[]) {
  const kept: MessageRow[] = [];
  let answer: MessageRow | undefined;
  for (const message of messages) {
    if (message.role === "user") {
      if (answer) kept.push(answer);
      answer = undefined;
      if (message.text.trim()) kept.push(message);
    } else if (message.text.trim() && message.resultType !== "crm.contacts")
      answer = message;
  }
  if (answer) kept.push(answer);
  return kept;
}

/** Rate limit per person: a typing search sends a few reads a second. */
class SearchLimit {
  private hits = new Map<string, number[]>();
  constructor(
    private now: () => number,
    private perWindow = 40,
    private windowMs = 10_000,
  ) {}
  take(key: string) {
    const now = this.now();
    const recent = (this.hits.get(key) ?? []).filter(
      (at) => at > now - this.windowMs,
    );
    if (recent.length >= this.perWindow) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 5000)
      for (const [other, times] of this.hits)
        if (!times.some((at) => at > now - this.windowMs))
          this.hits.delete(other);
    return true;
  }
}

export class ChatSearchUnavailable extends Error {
  constructor() {
    super("chat_search_unavailable");
  }
}
export class ChatSearchRateLimited extends Error {
  constructor() {
    super("chat_search_rate_limited");
  }
}

/** Bumped when what is indexed changes; a new version re-indexes all chats. */
const INDEX_VERSION = "1";
/** Chats re-indexed at startup; the rest wait for their person's search. */
const STARTUP_BATCH = 2000;
/** Matching messages ranked per search; enough for any person's history. */
const RANKED = 4000;

export class ChatSearchIndex {
  readonly available: boolean;
  private limit: SearchLimit;
  constructor(
    private db: DatabaseSync,
    private now: () => number,
  ) {
    this.limit = new SearchLimit(now);
    this.available = this.install();
  }
  /** Tables and triggers; false when this SQLite has no FTS5. */
  private install() {
    try {
      // Exactly this text: database vetting tools accept only this table.
      if (
        !this.db
          .prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?")
          .get(CHAT_SEARCH_FTS)
      )
        this.db.exec(CHAT_SEARCH_FTS_SQL);
    } catch {
      return false;
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS chat_search_doc (
        id INTEGER PRIMARY KEY,
        scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
        message_id TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('title','user','assistant')),
        UNIQUE(scope_key,conversation_id,message_id)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS chat_search_dirty (
        scope_key TEXT NOT NULL, conversation_id TEXT NOT NULL,
        PRIMARY KEY(scope_key,conversation_id)
      ) STRICT, WITHOUT ROWID;
      -- Triggers are re-created at every start, so they always match this code.
      DROP TRIGGER IF EXISTS chat_search_doc_removed;
      DROP TRIGGER IF EXISTS chat_search_message_added;
      DROP TRIGGER IF EXISTS chat_search_message_changed;
      DROP TRIGGER IF EXISTS chat_search_message_removed;
      DROP TRIGGER IF EXISTS chat_search_chat_added;
      DROP TRIGGER IF EXISTS chat_search_chat_renamed;
      DROP TRIGGER IF EXISTS chat_search_chat_deleted;
      DROP TRIGGER IF EXISTS chat_search_chat_removed;
      -- Trigger statements say how a conflict resolves without clauses of
      -- their own: the statement that fires them (often an upsert) would
      -- override them.
      CREATE TRIGGER chat_search_doc_removed AFTER DELETE ON chat_search_doc BEGIN
        DELETE FROM chat_search_fts WHERE rowid=old.id;
      END;
      CREATE TRIGGER chat_search_message_added AFTER INSERT ON public_conversation_message BEGIN
        INSERT INTO chat_search_dirty SELECT new.scope_key,new.conversation_id WHERE NOT EXISTS (SELECT 1 FROM chat_search_dirty WHERE scope_key=new.scope_key AND conversation_id=new.conversation_id);
      END;
      CREATE TRIGGER chat_search_message_changed AFTER UPDATE ON public_conversation_message
        WHEN new.payload IS NOT old.payload BEGIN
        INSERT INTO chat_search_dirty SELECT new.scope_key,new.conversation_id WHERE NOT EXISTS (SELECT 1 FROM chat_search_dirty WHERE scope_key=new.scope_key AND conversation_id=new.conversation_id);
      END;
      CREATE TRIGGER chat_search_message_removed AFTER DELETE ON public_conversation_message BEGIN
        DELETE FROM chat_search_doc WHERE scope_key=old.scope_key AND conversation_id=old.conversation_id AND message_id=old.id;
        INSERT INTO chat_search_dirty SELECT old.scope_key,old.conversation_id WHERE NOT EXISTS (SELECT 1 FROM chat_search_dirty WHERE scope_key=old.scope_key AND conversation_id=old.conversation_id);
      END;
      CREATE TRIGGER chat_search_chat_added AFTER INSERT ON public_conversation BEGIN
        INSERT INTO chat_search_dirty SELECT new.scope_key,new.id WHERE NOT EXISTS (SELECT 1 FROM chat_search_dirty WHERE scope_key=new.scope_key AND conversation_id=new.id);
      END;
      CREATE TRIGGER chat_search_chat_renamed AFTER UPDATE OF title,custom_title ON public_conversation
        WHEN new.title IS NOT old.title OR new.custom_title IS NOT old.custom_title BEGIN
        INSERT INTO chat_search_dirty SELECT new.scope_key,new.id WHERE NOT EXISTS (SELECT 1 FROM chat_search_dirty WHERE scope_key=new.scope_key AND conversation_id=new.id);
      END;
      CREATE TRIGGER chat_search_chat_deleted AFTER UPDATE OF deleted ON public_conversation WHEN new.deleted<>0 AND old.deleted=0 BEGIN
        DELETE FROM chat_search_doc WHERE scope_key=new.scope_key AND conversation_id=new.id;
        INSERT INTO chat_search_fts(chat_search_fts) VALUES('optimize');
      END;
      CREATE TRIGGER chat_search_chat_removed AFTER DELETE ON public_conversation BEGIN
        DELETE FROM chat_search_doc WHERE scope_key=old.scope_key AND conversation_id=old.id;
        DELETE FROM chat_search_dirty WHERE scope_key=old.scope_key AND conversation_id=old.id;
        INSERT INTO chat_search_fts(chat_search_fts) VALUES('optimize');
      END;`);
    return true;
  }
  /**
   * Startup: a new index version marks every chat for indexing once, then a
   * bounded batch is indexed now. Idempotent: a restart indexes only what
   * is still marked.
   */
  migrate() {
    if (!this.available) return;
    const version = this.db
      .prepare("SELECT value FROM chat_search_meta WHERE key='version'")
      .get()?.value;
    if (version !== INDEX_VERSION) {
      this.db.exec(
        "INSERT OR IGNORE INTO chat_search_dirty SELECT scope_key,id FROM public_conversation WHERE deleted=0",
      );
      this.db
        .prepare(
          "INSERT INTO chat_search_meta VALUES('version',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        )
        .run(INDEX_VERSION);
    }
    this.flush(undefined, STARTUP_BATCH);
  }
  /** Re-indexes marked chats, of one person or anyone's; returns how many. */
  flush(key?: string, limit = Number.MAX_SAFE_INTEGER) {
    if (!this.available) return 0;
    const rows = (
      key === undefined
        ? this.db
            .prepare(
              "SELECT scope_key,conversation_id FROM chat_search_dirty LIMIT ?",
            )
            .all(limit)
        : this.db
            .prepare(
              "SELECT scope_key,conversation_id FROM chat_search_dirty WHERE scope_key=? LIMIT ?",
            )
            .all(key, limit)
    ).map((r) => [String(r.scope_key), String(r.conversation_id)] as const);
    for (const [scope, id] of rows) this.reindex(scope, id);
    return rows.length;
  }
  private reindex(key: string, id: string) {
    this.db
      .prepare(
        "DELETE FROM chat_search_doc WHERE scope_key=? AND conversation_id=?",
      )
      .run(key, id);
    this.db
      .prepare(
        "DELETE FROM chat_search_dirty WHERE scope_key=? AND conversation_id=?",
      )
      .run(key, id);
    const chat = this.db
      .prepare(
        "SELECT COALESCE(custom_title,title) AS title FROM public_conversation WHERE scope_key=? AND id=? AND deleted=0",
      )
      .get(key, id);
    if (!chat) return;
    const token = scopeToken(key);
    const doc = this.db.prepare(
      "INSERT INTO chat_search_doc(scope_key,conversation_id,message_id,role) VALUES(?,?,?,?) RETURNING id",
    );
    const fts = this.db.prepare(
      "INSERT INTO chat_search_fts(rowid,scope,body) VALUES(?,?,?)",
    );
    const add = (messageId: string, role: string, text: string) => {
      const body = fold(plainText(text));
      if (!words(body).length) return;
      const row = doc.get(key, id, messageId, role)!;
      fts.run(Number(row.id), token, body);
    };
    if (String(chat.title).trim()) add("", "title", String(chat.title));
    const messages = this.db
      .prepare(
        "SELECT payload FROM public_conversation_message WHERE scope_key=? AND conversation_id=? ORDER BY ordinal",
      )
      .all(key, id)
      .map((r) => parseMessage(String(r.payload)))
      .filter((m): m is MessageRow => !!m);
    for (const message of searchableMessages(messages))
      add(message.id, message.role, message.text);
  }

  /**
   * One page of the person's chats matching the query, best first: the
   * best message's relevance (FTS5 bm25), more matches, a matching name and
   * a recent change rank a chat higher.
   */
  search(
    scope: Scope,
    query: string,
    options: {
      after?: number;
      limit: number;
      includeArchived: boolean;
      archivedOnly: boolean;
      role?: ChatSearchRole;
    },
  ): ChatSearchPage {
    if (!this.available) throw new ChatSearchUnavailable();
    const key = scopeKey(scope);
    if (!this.limit.take(key)) throw new ChatSearchRateLimited();
    this.flush(key);
    const terms = parseQuery(query);
    const empty = ChatSearchPageSchema.parse({
      profile: CHAT_SEARCH_PROFILE,
      scope,
      results: [],
      nextAfter: null,
    });
    if (!terms.length) return empty;
    const rows = this.db
      .prepare(
        `SELECT d.conversation_id,d.message_id,d.role,bm25(chat_search_fts,0.0,1.0) AS rank,
          c.updated_at,c.read_only,COALESCE(c.custom_title,c.title) AS title
        FROM chat_search_fts JOIN chat_search_doc d ON d.id=chat_search_fts.rowid
        JOIN public_conversation c ON c.scope_key=d.scope_key AND c.id=d.conversation_id
        WHERE chat_search_fts MATCH ? AND d.scope_key=? AND c.deleted=0
          AND (?=1 OR c.read_only=0) AND (?=0 OR c.read_only=1)
          AND (? IS NULL OR d.role=?)
        ORDER BY rank LIMIT ${RANKED}`,
      )
      .all(
        matchExpression(scopeToken(key), terms),
        key,
        options.includeArchived || options.archivedOnly ? 1 : 0,
        options.archivedOnly ? 1 : 0,
        options.role ?? null,
        options.role ?? null,
      );
    type Chat = {
      id: string;
      title: string;
      updatedAt: string;
      archived: boolean;
      best: number;
      titleMatched: boolean;
      messages: { id: string; role: ChatSearchRole; rank: number }[];
    };
    const chats = new Map<string, Chat>();
    for (const row of rows) {
      const id = String(row.conversation_id);
      const rank = -Number(row.rank);
      const chat = chats.get(id) ?? {
        id,
        title: String(row.title),
        updatedAt: String(row.updated_at),
        archived: !!Number(row.read_only),
        best: 0,
        titleMatched: false,
        messages: [],
      };
      chats.set(id, chat);
      chat.best = Math.max(chat.best, rank);
      if (row.role === "title") chat.titleMatched = true;
      else
        chat.messages.push({
          id: String(row.message_id),
          role: row.role as ChatSearchRole,
          rank,
        });
    }
    const top = Math.max(...[...chats.values()].map((c) => c.best), 0) || 1;
    const now = this.now();
    const score = (chat: Chat) => {
      const ageDays = Math.max(
        0,
        (now - Date.parse(chat.updatedAt)) / 86_400_000,
      );
      return (
        (chat.best / top) * (1 + 0.15 * Math.log(1 + chat.messages.length)) +
        (chat.titleMatched ? 0.35 : 0) +
        0.4 * Math.exp(-ageDays / 30)
      );
    };
    const ranked = [...chats.values()]
      .map((chat) => ({ chat, score: score(chat) }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.chat.updatedAt.localeCompare(a.chat.updatedAt) ||
          a.chat.id.localeCompare(b.chat.id),
      );
    const start = options.after ?? 0;
    const page = ranked.slice(start, start + options.limit);
    const payload = this.db.prepare(
      "SELECT payload FROM public_conversation_message WHERE scope_key=? AND conversation_id=? AND id=?",
    );
    const results = page.map(({ chat }) => {
      const matches: ChatSearchMatch[] = [];
      for (const hit of chat.messages) {
        if (matches.length === CHAT_SEARCH_MAX_MATCHES) break;
        const row = payload.get(key, chat.id, hit.id);
        const message = row && parseMessage(String(row.payload));
        if (!message) continue;
        const { snippet, ranges } = snippetOf(message.text, terms);
        if (!snippet) continue;
        matches.push({
          messageId: message.id,
          role: message.role,
          ...(message.createdAt && !Number.isNaN(Date.parse(message.createdAt))
            ? { createdAt: message.createdAt }
            : {}),
          snippet: snippet.slice(0, 400),
          ranges: ranges.filter(([, end]) => end <= 400),
        });
      }
      const title = chat.title.slice(0, 160);
      return {
        conversation: {
          id: chat.id,
          title,
          updatedAt: chat.updatedAt,
          archived: chat.archived,
        },
        titleRanges: chat.titleMatched ? findRanges(title, terms) : [],
        matches,
        matchCount: chat.messages.length,
      };
    });
    return ChatSearchPageSchema.parse({
      ...empty,
      // A chat whose text changed under the index has nothing to show.
      results: results.filter(
        (r) => r.titleRanges.length > 0 || r.matches.length > 0,
      ),
      nextAfter:
        start + options.limit < ranked.length
          ? String(start + options.limit)
          : null,
    });
  }
}

/** A search request's parameters, strictly; `undefined` is a bad request. */
export function chatSearchRequest(params: URLSearchParams):
  | {
      query: string;
      options: {
        after?: number;
        limit: number;
        includeArchived: boolean;
        archivedOnly: boolean;
        role?: ChatSearchRole;
      };
    }
  | "unsupported"
  | undefined {
  const keys = [...params.keys()];
  const allowed = [
    "profile",
    "q",
    "after",
    "limit",
    "include",
    "state",
    "role",
  ];
  if (
    new Set(keys).size !== keys.length ||
    keys.some((key) => !allowed.includes(key))
  )
    return undefined;
  if (params.get("profile") !== CHAT_SEARCH_PROFILE) return "unsupported";
  const query = (params.get("q") ?? "").trim();
  const after = params.get("after");
  const limit = params.get("limit");
  const include = params.get("include");
  const state = params.get("state");
  const role = params.get("role");
  if (
    !query ||
    query.length > CHAT_SEARCH_MAX_QUERY ||
    (after !== null && !/^[1-9][0-9]{0,5}$/.test(after)) ||
    (limit !== null &&
      (!/^[1-9][0-9]?$/.test(limit) ||
        Number(limit) > CHAT_SEARCH_MAX_LIMIT)) ||
    (include !== null && include !== "archived") ||
    (state !== null && state !== "archived") ||
    (role !== null && role !== "user" && role !== "assistant")
  )
    return undefined;
  return {
    query,
    options: {
      ...(after ? { after: Number(after) } : {}),
      limit: limit ? Number(limit) : 10,
      includeArchived: include === "archived",
      archivedOnly: state === "archived",
      ...(role ? { role: role as ChatSearchRole } : {}),
    },
  };
}
