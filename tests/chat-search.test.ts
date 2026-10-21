import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversationHistory } from "../apps/fixture-server/conversation-history";
import {
  ChatSearchIndex,
  ChatSearchRateLimited,
  chatSearchRequest,
  findRanges,
  parseQuery,
  plainText,
  searchableMessages,
  snippetOf,
} from "../apps/fixture-server/chat-search";
import { FixtureStorage } from "../apps/fixture-server/storage";
import {
  CHAT_SEARCH_PROFILE,
  ChatSearchPageSchema,
  chatSearchPath,
} from "../packages/protocol/chat-search";
import type { Conversation, Scope } from "../packages/protocol";

const alice: Scope = {
  connectionId: "fixture-a",
  serverId: "fixture-0123456789abcdef01234567",
  userId: "alice",
  workspaceId: "a",
};
const bob: Scope = { ...alice, userId: "bob" };
const aliceB: Scope = { ...alice, connectionId: "fixture-b", workspaceId: "b" };

type Message = Conversation["messages"][number];
const user = (id: string, text: string, createdAt?: string): Message => ({
  id,
  role: "user",
  text,
  ...(createdAt ? { createdAt } : {}),
});
const assistant = (id: string, text: string, extra = {}): Message => ({
  id,
  role: "assistant",
  text,
  ...extra,
});

const DAY = 86_400_000;
function setup(now = Date.parse("2026-10-17T08:00:00.000Z")) {
  const db = new DatabaseSync(":memory:");
  const clock = { now };
  const history = new ConversationHistory(db, () => clock.now);
  const search = new ChatSearchIndex(db, () => clock.now);
  search.migrate();
  let revision = 0;
  const save = (scope: Scope, id: string, messages: Message[]) =>
    history.save(scope, { id, revision: ++revision, messages });
  const find = (
    scope: Scope,
    query: string,
    options: Partial<Parameters<ChatSearchIndex["search"]>[2]> = {},
  ) =>
    ChatSearchPageSchema.parse(
      search.search(scope, query, {
        limit: 10,
        includeArchived: false,
        archivedOnly: false,
        ...options,
      }),
    );
  const ids = (scope: Scope, query: string, options = {}) =>
    find(scope, query, options).results.map((r) => r.conversation.id);
  return { db, clock, history, search, save, find, ids };
}

const fts = (db: DatabaseSync) =>
  db
    .prepare("SELECT block FROM chat_search_fts_data")
    .all()
    .map((r) => Buffer.from(r.block as Uint8Array).toString("latin1"))
    .join("|");

test("questions and final answers are indexed; interim notes and contact lists are not", () => {
  const kept = searchableMessages([
    { id: "u1", role: "user", text: "Najdi Petra" },
    { id: "a1", role: "assistant", text: "Hledám v CRM…" },
    {
      id: "a2",
      role: "assistant",
      text: "TEST contacts",
      resultType: "crm.contacts",
    },
    { id: "a3", role: "assistant", text: "Petr Novák je obchodník." },
    { id: "u2", role: "user", text: "Díky" },
    { id: "a4", role: "assistant", text: "Rádo se stalo" },
  ]);
  expect(kept.map((m) => m.id)).toEqual(["u1", "a3", "u2", "a4"]);

  const { save, ids, find } = setup();
  save(alice, "chat-1", [
    user("u1", "Kdy je porada?"),
    assistant("a1", "Hledám v kalendáři interim"),
    assistant("a2", "Porada je **zítra** v devět."),
  ]);
  expect(ids(alice, "interim")).toEqual([]);
  expect(ids(alice, "zitra")).toEqual(["chat-1"]);
  const hit = find(alice, "zitra").results[0]!;
  expect(hit.matches).toEqual([
    {
      messageId: "a2",
      role: "assistant",
      snippet: "Porada je zítra v devět.",
      ranges: [[10, 15]],
    },
  ]);
  // The title (the first request) counts too.
  expect(find(alice, "porada").results[0]!.titleRanges).toEqual([[7, 13]]);
});

test("accents and case are ignored, the last word matches as a prefix and Czech endings vary", () => {
  const { save, ids, find } = setup();
  save(alice, "chat-meeting", [
    user("u1", "Naplánuj SCHŮZKU s Petrem na čtvrtek"),
    assistant("a1", "Schůzka je naplánována."),
  ]);
  save(alice, "chat-other", [user("u2", "Pošli fakturu Alze")]);
  expect(ids(alice, "schuzka")).toEqual(["chat-meeting"]);
  expect(ids(alice, "Schůzka")).toEqual(["chat-meeting"]);
  expect(ids(alice, "ctvrt")).toEqual(["chat-meeting"]);
  expect(ids(alice, "ctvrt ")).toEqual([]);
  expect(ids(alice, "faktura")).toEqual(["chat-other"]);
  expect(ids(alice, "schuzka faktura")).toEqual([]);
  const { matches } = find(alice, "schuzka").results[0]!;
  // The person's own word is highlighted in its original spelling.
  const question = matches.find((m) => m.messageId === "u1")!;
  expect(question.ranges.map(([s, e]) => question.snippet.slice(s, e))).toEqual(
    ["SCHŮZKU"],
  );
});

test("quotes keep words together", () => {
  const { save, ids } = setup();
  save(alice, "chat-a", [user("u1", "objednat nový notebook pro Janu")]);
  save(alice, "chat-b", [user("u2", "nový telefon, notebook později")]);
  expect(ids(alice, "novy notebook").sort()).toEqual(["chat-a", "chat-b"]);
  expect(ids(alice, '"novy notebook"')).toEqual(["chat-a"]);
  expect(parseQuery('"nový notebook" pro')).toEqual([
    { kind: "phrase", words: ["novy", "notebook"] },
    { kind: "word", word: "pro", prefix: true },
  ]);
  // An unclosed quote is just text; FTS syntax is never taken from the query.
  expect(ids(alice, '"notebook')).toEqual(expect.arrayContaining(["chat-a"]));
  expect(ids(alice, "notebook (")).toHaveLength(2);
  expect(ids(alice, "notebook OR NEAR(x) *")).toEqual([]);
  expect(ids(alice, "!!!")).toEqual([]);
});

test("better and more recent matches rank first", () => {
  const { save, ids, clock } = setup();
  save(alice, "chat-old", [user("u1", "rozpočet na marketing")]);
  save(alice, "chat-dense", [
    user("u2", "Ahoj"),
    assistant("a2", "Rozpočet, rozpočet a zase rozpočet."),
  ]);
  save(alice, "chat-sparse", [
    user("u3", "Ahoj"),
    assistant(
      "a3",
      "V dlouhé odpovědi o mnoha věcech, lidech, plánech a termínech se jednou objeví i rozpočet, ale jen tak mimochodem mezi dalšími slovy.",
    ),
  ]);
  clock.now += 60 * DAY;
  save(alice, "chat-new", [user("u4", "rozpočet na vývoj")]);
  // Comparable relevance: the chat changed recently wins.
  expect(ids(alice, "rozpocet na")).toEqual(["chat-new", "chat-old"]);
  // Of equally old chats, the one more about it wins.
  const all = ids(alice, "rozpocet");
  expect(all.indexOf("chat-dense")).toBeLessThan(all.indexOf("chat-sparse"));
  expect(all[0]).toBe("chat-new");
});

test("results are paginated by chat", () => {
  const { save, find } = setup();
  for (let i = 0; i < 5; i++)
    save(alice, `chat-${i}`, [user(`u${i}`, `zpráva o projektu ${i}`)]);
  const first = find(alice, "projekt", { limit: 2 });
  expect(first.results).toHaveLength(2);
  expect(first.nextAfter).toBe("2");
  const rest = find(alice, "projekt", { limit: 10, after: 2 });
  expect(rest.results).toHaveLength(3);
  expect(rest.nextAfter).toBeNull();
  expect(
    new Set([...first.results, ...rest.results].map((r) => r.conversation.id))
      .size,
  ).toBe(5);
});

test("search never crosses people, workspaces or servers", () => {
  const { save, ids, find } = setup();
  save(alice, "chat-1", [user("u1", "tajná mzda Alice")]);
  save(bob, "chat-1", [user("u1", "tajná mzda Boba")]);
  save(aliceB, "chat-2", [user("u2", "tajná mzda ve druhém prostoru")]);
  expect(find(alice, "mzda").results[0]!.matches[0]!.snippet).toBe(
    "tajná mzda Alice",
  );
  expect(ids(alice, "boba")).toEqual([]);
  expect(ids(bob, "alice")).toEqual([]);
  expect(ids(aliceB, "mzda")).toEqual(["chat-2"]);
  expect(ids({ ...alice, serverId: "fixture-other" }, "mzda")).toEqual([]);
});

test("renaming, archiving, restoring and deleting keep the index in step", () => {
  const { db, history, save, ids, find } = setup();
  save(alice, "chat-1", [
    user("u1", "připrav prezentaci zelenina"),
    assistant("a1", "Hotovo, prezentace je připravena."),
  ]);
  history.rename(alice, "chat-1", "Kvartální report");
  expect(find(alice, "kvartalni").results[0]!.conversation.title).toBe(
    "Kvartální report",
  );
  history.rename(alice, "chat-1", "");
  expect(ids(alice, "kvartalni")).toEqual([]);

  history.archive(alice, "chat-1");
  expect(ids(alice, "prezentace")).toEqual([]);
  const archived = find(alice, "prezentace", { includeArchived: true });
  expect(archived.results[0]!.conversation.archived).toBe(true);
  expect(ids(alice, "prezentace", { archivedOnly: true })).toEqual(["chat-1"]);
  history.restore(alice, "chat-1");
  expect(ids(alice, "prezentace")).toEqual(["chat-1"]);
  expect(ids(alice, "prezentace", { archivedOnly: true })).toEqual([]);

  expect(ids(alice, "prezentace", { role: "user" })).toEqual(["chat-1"]);
  expect(
    find(alice, "prezentace", { role: "assistant" }).results[0]!.matches.map(
      (m) => m.messageId,
    ),
  ).toEqual(["a1"]);

  history.delete(alice, "chat-1", false);
  expect(ids(alice, "prezentace", { includeArchived: true })).toEqual([]);
  // No row and no word of the chat stays in the index.
  expect(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM chat_search_doc WHERE conversation_id='chat-1'",
      )
      .get()!.n,
  ).toBe(0);
  expect(fts(db)).not.toContain("zelenina");
  expect(fts(db)).not.toContain("prezentac");
});

test("a session archive is searchable as an archived chat", () => {
  const { history, ids, find } = setup();
  history.archiveRow(
    JSON.stringify([
      alice.connectionId,
      alice.serverId,
      alice.userId,
      alice.workspaceId,
    ]),
    7,
    Date.parse("2026-10-01T10:00:00.000Z"),
    [
      user("u1", "starý dotaz na dovolenou"),
      assistant("a1", "Dovolená je schválená."),
    ],
  );
  expect(ids(alice, "dovolena")).toEqual([]);
  const result = find(alice, "dovolena", { includeArchived: true }).results[0]!;
  expect(result.conversation).toMatchObject({
    id: "archived-7",
    archived: true,
  });
  expect(result.matchCount).toBe(2);
});

test("existing chats are indexed once at startup, in bounded batches", () => {
  const db = new DatabaseSync(":memory:");
  const now = () => Date.parse("2026-10-17T08:00:00.000Z");
  const history = new ConversationHistory(db, now);
  history.save(alice, {
    id: "chat-before",
    revision: 1,
    messages: [user("u1", "účetní uzávěrka před indexem")],
  });
  // An index from a server before search: no tables, no triggers yet.
  const search = new ChatSearchIndex(db, now);
  search.migrate();
  const page = search.search(alice, "uzaverka", {
    limit: 10,
    includeArchived: false,
    archivedOnly: false,
  });
  expect(page.results.map((r) => r.conversation.id)).toEqual(["chat-before"]);
  // Idempotent: another start finds nothing left to index.
  const again = new ChatSearchIndex(db, now);
  again.migrate();
  expect(again.flush()).toBe(0);
  expect(db.prepare("SELECT COUNT(*) AS n FROM chat_search_doc").get()!.n).toBe(
    2,
  );
});

test("the index lives in the workflow database and survives restarts", () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-chat-search-"));
  try {
    let storage = new FixtureStorage(directory, alice.serverId);
    storage.close();
    storage = new FixtureStorage(directory, alice.serverId);
    const page = storage.searchConversations(alice, "nic", {
      limit: 10,
      includeArchived: false,
      archivedOnly: false,
    });
    expect(page).toEqual({
      profile: CHAT_SEARCH_PROFILE,
      scope: alice,
      results: [],
      nextAfter: null,
    });
    storage.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a person's searches are rate limited", () => {
  const { find } = setup();
  for (let i = 0; i < 40; i++) find(alice, "x");
  expect(() => find(alice, "x")).toThrow(ChatSearchRateLimited);
  expect(() => find(bob, "x")).not.toThrow();
});

test("snippets are plain text around the best matches", () => {
  const long = `${"úvod ".repeat(60)}tady je **důležitá** schůzka s klientem ${"závěr ".repeat(60)}`;
  const terms = parseQuery("schuzka");
  const { snippet, ranges } = snippetOf(long, terms);
  expect(snippet.startsWith("…")).toBe(true);
  expect(snippet.endsWith("…")).toBe(true);
  expect(snippet.length).toBeLessThanOrEqual(200);
  expect(snippet).not.toContain("**");
  expect(ranges.map(([s, e]) => snippet.slice(s, e))).toEqual(["schůzka"]);
  expect(plainText("# Nadpis\n- [odkaz](https://x.test) a `kód`")).toBe(
    "Nadpis odkaz a kód",
  );
  expect(findRanges("Schůzka, schůzky!", parseQuery("schuzka"))).toEqual([
    [0, 7],
    [9, 16],
  ]);
});

test("requests are strict", () => {
  const parse = (query: string) =>
    chatSearchRequest(new URLSearchParams(query));
  expect(parse(chatSearchPath("schůzka", { limit: 5, role: "user" }))).toBe(
    undefined,
  );
  expect(
    parse(chatSearchPath("schůzka", { limit: 5, role: "user" }).slice(7)),
  ).toEqual({
    query: "schůzka",
    options: {
      limit: 5,
      includeArchived: false,
      archivedOnly: false,
      role: "user",
    },
  });
  const base = `profile=${CHAT_SEARCH_PROFILE}`;
  expect(parse(`${base}&q=%20%20`)).toBeUndefined();
  expect(parse(`${base}`)).toBeUndefined();
  expect(parse(`${base}&q=a&limit=21`)).toBeUndefined();
  expect(parse(`${base}&q=a&after=0`)).toBeUndefined();
  expect(parse(`${base}&q=a&other=1`)).toBeUndefined();
  expect(parse(`${base}&q=a&q=b`)).toBeUndefined();
  expect(parse(`${base}&q=${"a".repeat(201)}`)).toBeUndefined();
  expect(parse("profile=x&q=a")).toBe("unsupported");
  expect(parse(`${base}&q=a&state=archived&after=10`)).toEqual({
    query: "a",
    options: {
      after: 10,
      limit: 10,
      includeArchived: false,
      archivedOnly: true,
    },
  });
});

test("database vetting accepts the search index exactly as created, and no other virtual table", () => {
  const { ordinarySchema } = jest.requireActual<
    typeof import("../apps/server-identity/legacy-run-inventory")
  >("../apps/server-identity/legacy-run-inventory");
  const { db, save } = setup();
  save(alice, "chat-1", [user("u1", "obsah")]);
  expect(() =>
    ordinarySchema(db, { public_conversation: ["id"] }),
  ).not.toThrow();
  // The index's own tables are not ordinary tables to read data from.
  expect(() => ordinarySchema(db, { chat_search_fts_data: ["block"] })).toThrow(
    "database_invalid",
  );
  const other = new DatabaseSync(":memory:");
  other.exec(
    "CREATE VIRTUAL TABLE chat_search_fts USING fts5(scope, body, tokenize='porter')",
  );
  expect(() => ordinarySchema(other, {})).toThrow("database_invalid");
  const foreign = new DatabaseSync(":memory:");
  foreign.exec("CREATE VIRTUAL TABLE notes USING fts5(body)");
  expect(() => ordinarySchema(foreign, {})).toThrow("database_invalid");
  const orphan = new DatabaseSync(":memory:");
  orphan.exec(
    "CREATE TABLE 'chat_search_fts_data'(id INTEGER PRIMARY KEY, block BLOB)",
  );
  expect(() => ordinarySchema(orphan, {})).toThrow("database_invalid");
});
