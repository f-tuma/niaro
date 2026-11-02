import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { MemoryStore, type MemoryActor } from "../apps/server-identity/memory";
import {
  foldMemoryText,
  memoryQueryTerms,
  memoryScores,
  memoryTermsMatch,
  memoryTokens,
} from "../apps/server-identity/memory-ranking";
import { isSafeObservation } from "../apps/server-identity/profile-material";
import { MemorySettingsSchema } from "../packages/protocol/memory";
import {
  RANKING_MEMORIES,
  RANKING_QUERIES,
} from "./fixtures/memory-ranking-set";

const contents = RANKING_MEMORIES.map((memory) => memory.content);
/** Non-preference keys by descending score, ties by input order (the store breaks them by recency). */
function ranked(query: string) {
  const scores = memoryScores(query, contents);
  return RANKING_MEMORIES.map((memory, index) => ({
    memory,
    score: scores[index]!,
  }))
    .filter(({ memory, score }) => memory.kind !== "preference" && score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ memory }) => memory.key);
}

test("memory ranking folds accents and case, drops stop words and matches by prefix", () => {
  assert.equal(
    foldMemoryText("Schůzku ŘEDITEL Ďábel"),
    "schuzku reditel dabel",
  );
  assert.deepEqual(memoryTokens("Kdy mám schůzku s klientem?"), [
    "schuzku",
    "klientem",
  ]);
  assert.deepEqual(memoryTokens("What is the plan for the meeting?"), [
    "plan",
    "meeting",
  ]);
  // Czech inflection and English plurals share a five-character prefix.
  assert(memoryTermsMatch("schuzku", "schuzka"));
  assert(memoryTermsMatch("faktura", "faktury"));
  assert(memoryTermsMatch("invoice", "invoices"));
  // A shorter word of four or more characters matches as a whole prefix.
  assert(memoryTermsMatch("ukol", "ukoly"));
  assert(memoryTermsMatch("plan", "planem"));
  // Below the minimum, words must be equal; distinct stems stay apart.
  assert(!memoryTermsMatch("cr", "crm"));
  assert(!memoryTermsMatch("kontrola", "kontaktni"));
  assert(!memoryTermsMatch("contact", "contract"));
  assert.equal(
    memoryQueryTerms(
      Array.from({ length: 30 }, (_, i) => `slovo${i}`).join(" "),
    ).length,
    20,
  );
  assert.deepEqual(memoryQueryTerms("Schůzka schuzka SCHŮZKA"), ["schuzka"]);
});

test("memory ranking: fixed Czech and English set returns the expected leading results", () => {
  for (const { query, top, only } of RANKING_QUERIES) {
    const result = ranked(query);
    assert.deepEqual(result.slice(0, top.length), top, query);
    if (only) assert.equal(result.length, top.length, query);
  }
});

test("memory ranking is deterministic and independent of record order", () => {
  const query = "Mikulov Acme Cedar schůzka faktura porada smlouva meeting";
  const scores = memoryScores(query, contents);
  assert.deepEqual(memoryScores(query, contents), scores);
  const reversed = memoryScores(query, [...contents].reverse()).reverse();
  assert.deepEqual(reversed, scores);
  // Equal evidence ties exactly, so only the caller's tie-break decides.
  const tie = memoryScores("Cedar", [
    "TEST Cedar note one",
    "TEST Cedar note two",
  ]);
  assert.equal(tie[0], tie[1]);
  assert.deepEqual(
    memoryScores("", contents),
    contents.map(() => 0),
  );
  assert.deepEqual(memoryScores("Cedar", []), []);
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user (id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE agent_workspace (
      id TEXT PRIMARY KEY, organization_id TEXT NOT NULL REFERENCES organization(id)
    ) STRICT;
    INSERT INTO organization VALUES ('org-a');
    INSERT INTO user VALUES ('alice'),('bob');
    INSERT INTO agent_workspace VALUES ('workspace-a','org-a');`);
  let now = Date.parse("2026-10-01T08:00:00.000Z");
  const store = new MemoryStore(db, {
    secret: "NIARO TEST memory-ranking key",
    now: () => now,
  });
  const alice: MemoryActor = {
    organizationId: "org-a",
    workspaceId: "workspace-a",
    userId: "alice",
    canManageShared: false,
  };
  const settings = MemorySettingsSchema.parse({
    maxItems: 8,
    maxContextChars: 12_000,
  });
  return {
    db,
    store,
    alice,
    settings,
    advance: () => {
      now += 1_000;
    },
  };
}

test("memory search: preferences first, then BM25 top-8 with recency and id tie-breaks", async () => {
  const f = fixture();
  try {
    const ids = new Map<string, string>();
    let request = 0;
    for (const memory of RANKING_MEMORIES) {
      const saved = await f.store.remember(f.alice, {
        requestId: `ranking-${++request}`,
        content: memory.content,
        kind: memory.kind,
        scope: "private",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: f.settings,
      });
      ids.set(saved.id, memory.key);
      f.advance();
    }
    // Bob's matching record never reaches Alice's ranking.
    await f.store.remember(
      { ...f.alice, userId: "bob" },
      {
        requestId: "ranking-bob",
        content: "Schůzka s klientem Mikulov Wine, Bobova poznámka.",
        kind: "fact",
        scope: "private",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: f.settings,
      },
    );
    const search = async (query: string) =>
      (
        await f.store.search(f.alice, { query, settings: f.settings })
      ).items.map((item) => ids.get(item.id) ?? "foreign");
    // Preferences always lead, newest first when the query does not touch them.
    assert.deepEqual(await search("Kdy mám schůzku s klientem z Mikulova?"), [
      "pref-en",
      "pref-cs",
      "schuzka-mikulov",
      "schuzky-dodavatele",
      "faktury-mikulov",
    ]);
    // A preference the query matches outranks the other preference.
    assert.deepEqual((await search("bullet lists")).slice(0, 2), [
      "pref-en",
      "pref-cs",
    ]);
    assert.deepEqual((await search("odrážky česky")).slice(0, 2), [
      "pref-cs",
      "pref-en",
    ]);
    // Eight items at most; equal scores fall back to the newer record.
    const broad = "Mikulov Acme Cedar schůzka faktura porada smlouva meeting";
    const top8 = await search(broad);
    assert.deepEqual(top8, [
      "pref-en",
      "pref-cs",
      "faktury-mikulov",
      "schuzka-mikulov",
      "smlouvy",
      "cedar-budget",
      "ukoly-crm",
      "meeting-notes",
    ]);
    for (let i = 0; i < 3; i++) assert.deepEqual(await search(broad), top8);
    for (const { query, top } of RANKING_QUERIES)
      assert.deepEqual(
        (await search(query)).slice(2, 2 + Math.min(top.length, 6)),
        top.slice(0, 6),
        query,
      );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("ranking keeps no plaintext index: the identity database holds no memory text", async () => {
  const f = fixture();
  try {
    await f.store.remember(f.alice, {
      requestId: "ranking-disk",
      content: "Schůzka s klientem Mikulov Wine je domluvená na čtvrtek.",
      kind: "fact",
      scope: "private",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: f.settings,
    });
    const found = await f.store.search(f.alice, {
      query: "schůzku",
      settings: f.settings,
    });
    assert.equal(found.items.length, 1);
    const tables = f.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => String(row.name));
    assert(!tables.some((name) => /fts|index|token|ranking/i.test(name)));
    for (const name of tables)
      for (const row of f.db.prepare(`SELECT * FROM "${name}"`).all())
        assert(
          !/mikulov|schuzk|schůzk/i.test(JSON.stringify(row)),
          `plaintext in ${name}`,
        );
  } finally {
    await f.store.close();
    f.db.close();
  }
});

test("the documented never-kept categories are each refused by the learner's filter", () => {
  const guide = readFileSync(
    new URL("../docs/guides/memory.md", import.meta.url),
    "utf8",
  );
  const examples: Record<string, string[]> = {
    health: ["Has diabetes", "Bere léky na tlak"],
    "ethnic origin": ["Talks about TEST ethnic origin", "Etnický původ TEST"],
    "political opinions": [
      "Has strong political views",
      "Politické názory TEST",
    ],
    "religious or philosophical beliefs": [
      "Religious practice TEST",
      "Náboženství TEST",
    ],
    "trade union membership": [
      "Is a member of a trade union",
      "Platí příspěvky na odbory",
    ],
    "sex life or sexual orientation": [
      "Has TEST sexual orientation",
      "Sexuální orientace TEST",
    ],
    "biometric or genetic data": ["DNA profile is TEST", "Genetický test TEST"],
    "passwords and keys": ["Password is TEST-123", "Heslo k TEST"],
    "account, card and birth numbers": [
      "TEST card 4111 1111 1111 1111",
      "Účet 123456789/0800",
      "Rodné číslo 850101/1234",
    ],
  };
  for (const [category, texts] of Object.entries(examples)) {
    assert(guide.includes(category), `guide lists ${category}`);
    for (const text of texts)
      assert.equal(isSafeObservation(text), false, `${category}: ${text}`);
  }
});
