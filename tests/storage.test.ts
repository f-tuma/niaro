import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FixtureStorage,
  acquireServerLock,
  type CommitStage,
} from "../apps/fixture-server/storage";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  messageCommand,
  answerCommand,
} from "../packages/client-core/commands";
import type { Scope } from "../packages/protocol";

const scope: Scope = {
  connectionId: "fixture-a",
  serverId: "test-server",
  userId: "alice",
  workspaceId: "a",
};
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-sqlite-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
const command = messageCommand("Choose Peter", "en", "start");
function legacy(user = "alice") {
  const dir = join(directory, "authenticated", user);
  mkdirSync(dir, { recursive: true });
  const engine = new FixtureEngine("a", undefined, undefined, () => 10_000, {
    ...scope,
    userId: user,
  });
  engine.execute(command);
  engine.execute(
    answerCommand(engine.snapshot().inputRequests[0]!, "peter-novak", "answer"),
  );
  const file = join(dir, "a.json");
  writeFileSync(file, JSON.stringify(engine.data));
  return { file, engine };
}

test.each<CommitStage>(["state", "events", "receipts", "before_commit"])(
  "%s failure rolls back every table and never exposes partial state",
  (stage) => {
    let armed = false;
    let observer: FixtureStorage;
    const writer = new FixtureStorage(
      directory,
      scope.serverId,
      undefined,
      (at, change) => {
        if (armed && change === "command" && at === stage) {
          expect(observer.snapshot(scope).workItems).toHaveLength(0);
          expect(observer.events(scope, 0)?.events).toHaveLength(0);
          throw new Error("injected write failure");
        }
      },
    );
    observer = new FixtureStorage(directory, scope.serverId);
    try {
      armed = true;
      expect(() => writer.execute(scope, command)).toThrow(
        "injected write failure",
      );
      expect(writer.snapshot(scope).cursor).toBe(0);
      armed = false;
      expect(writer.execute(scope, command).snapshot.workItems).toHaveLength(1);
      expect(observer.execute(scope, command).snapshot).toEqual(
        writer.snapshot(scope),
      );
    } finally {
      observer.close();
      writer.close();
    }
  },
);

test("failure after commit leaves a durable receipt and replayable events", () => {
  const store = new FixtureStorage(
    directory,
    scope.serverId,
    undefined,
    (stage, change) => {
      if (stage === "after_commit" && change === "command")
        throw new Error("reply lost");
    },
  );
  expect(() => store.execute(scope, command)).toThrow("reply lost");
  const committed = store.snapshot(scope);
  store.close();
  const reopened = new FixtureStorage(directory, scope.serverId);
  try {
    expect(reopened.execute(scope, command).snapshot).toEqual(committed);
    expect(reopened.events(scope, 0)?.events).toHaveLength(committed.cursor);
    expect(reopened.events(scope, committed.cursor)?.events).toEqual([]);
    expect(reopened.events(scope, committed.cursor + 1)).toBeNull();
    expect(reopened.execute(scope, { ...command, text: "changed" }).code).toBe(
      "idempotency_conflict",
    );
  } finally {
    reopened.close();
  }
});

test("independent connections reload state under the writer lock and isolate full scopes", () => {
  const a = new FixtureStorage(directory, scope.serverId);
  const b = new FixtureStorage(directory, scope.serverId);
  try {
    a.execute(scope, command);
    expect(b.execute(scope, command).snapshot.workItems).toHaveLength(1);
    b.execute(scope, messageCommand("Choose Peter", "en", "second"));
    expect(a.snapshot(scope).workItems.map((w) => w.id)).toEqual([
      "work-1",
      "work-2",
    ]);
    for (const other of [
      { ...scope, userId: "bob" },
      { ...scope, workspaceId: "b", connectionId: "fixture-b" },
    ]) {
      expect(b.snapshot(other).workItems).toHaveLength(0);
      expect(b.execute(other, command).snapshot.workItems[0]?.id).toBe(
        "work-1",
      );
    }
    expect(() => a.execute({ ...scope, serverId: "foreign" }, command)).toThrow(
      "workspace mismatch",
    );
    expect(statSync(join(directory, "workflow.sqlite")).mode & 0o777).toBe(
      0o600,
    );
  } finally {
    a.close();
    b.close();
  }
});

test("authenticated JSON imports once with receipts, events and scheduled work; anonymous files stay unadopted", () => {
  const { file, engine } = legacy();
  const original = readFileSync(file, "utf8");
  writeFileSync(join(directory, "b.json"), "anonymous data is not parsed");
  let store = new FixtureStorage(directory, scope.serverId, () => 14_000);
  expect(store.snapshot(scope)).toEqual(engine.snapshot());
  expect(store.events(scope, 0)?.events).toEqual(engine.data.events);
  expect(store.execute(scope, command).snapshot).toEqual(engine.snapshot());
  store.tick();
  const advanced = store.snapshot(scope);
  expect(advanced.actionProposals).toHaveLength(1);
  store.close();
  expect(readFileSync(file, "utf8")).toBe(original);
  // An archived source is never re-applied, even if damaged after successful import.
  writeFileSync(file, "stale or damaged legacy file");
  store = new FixtureStorage(directory, scope.serverId);
  try {
    expect(store.snapshot(scope)).toEqual(advanced);
  } finally {
    store.close();
  }
});

test("invalid account aborts the entire import and can be repaired without deleting the database", () => {
  const alice = legacy();
  const bob = legacy("bob");
  const valid = readFileSync(bob.file, "utf8");
  writeFileSync(
    bob.file,
    JSON.stringify({ ...bob.engine.data, events: alice.engine.data.events }),
  );
  expect(() => new FixtureStorage(directory, scope.serverId)).toThrow(
    "event log",
  );
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  expect(db.prepare("SELECT count(*) AS n FROM workflows").get()?.n).toBe(0);
  expect(
    db.prepare("SELECT * FROM metadata WHERE key='legacy_imported'").get(),
  ).toBeUndefined();
  db.close();
  writeFileSync(bob.file, valid);
  const repaired = new FixtureStorage(directory, scope.serverId);
  try {
    expect(repaired.snapshot(scope)).toEqual(alice.engine.snapshot());
    expect(repaired.snapshot({ ...scope, userId: "bob" })).toEqual(
      bob.engine.snapshot(),
    );
  } finally {
    repaired.close();
  }
  expect(() => new FixtureStorage(directory, "different-server")).toThrow(
    "identity mismatch",
  );
});

test("SQLite rejects conflicting receipt identities during migration instead of silently dropping them", () => {
  const { file, engine } = legacy();
  engine.data.receipts.push({
    ...engine.data.receipts[0]!,
    command: { ...command, commandId: "another-id" },
  });
  writeFileSync(file, JSON.stringify(engine.data));
  expect(() => new FixtureStorage(directory, scope.serverId)).toThrow(/UNIQUE/);
});

test("expired event cursors require a snapshot while retained receipts still deduplicate", () => {
  const { file, engine } = legacy();
  // A long-lived source with a full, contiguous retained suffix.
  const event = engine.data.events.at(-1)!;
  engine.data.events = Array.from({ length: 1000 }, (_, n) => ({
    ...event,
    sequence: n + 101,
    eventId: `event-${n + 101}`,
  }));
  engine.data.snapshot.cursor = 1100;
  writeFileSync(file, JSON.stringify(engine.data));
  const store = new FixtureStorage(directory, scope.serverId);
  try {
    expect(store.events(scope, 99)).toBeNull();
    expect(store.events(scope, 100)?.events).toHaveLength(1000);
    const next = store.execute(
      scope,
      messageCommand("Choose Peter", "en", "next"),
    );
    expect(
      store.events(scope, next.snapshot.cursor - 1000)?.events,
    ).toHaveLength(1000);
    expect(store.events(scope, 100)).toBeNull();
    expect(store.execute(scope, command).snapshot.cursor).toBe(
      next.snapshot.cursor,
    );
  } finally {
    store.close();
  }
});

test("server ownership cannot be shared and closing releases its OS lock", () => {
  const release = acquireServerLock(directory);
  expect(() => acquireServerLock(directory)).toThrow("already in use");
  release();
  acquireServerLock(directory)();
});

test("a busy writer leaves no partial command and can retry after the lock is released", () => {
  const store = new FixtureStorage(directory, scope.serverId);
  const blocker = new DatabaseSync(join(directory, "workflow.sqlite"));
  try {
    blocker.exec("BEGIN IMMEDIATE");
    expect(() => store.execute(scope, command)).toThrow(/locked/);
    expect(store.snapshot(scope).cursor).toBe(0);
    blocker.exec("ROLLBACK");
    expect(store.execute(scope, command).snapshot.workItems).toHaveLength(1);
  } finally {
    blocker.close();
    store.close();
  }
});

test("one failed worker account does not prevent other due work from progressing", () => {
  legacy();
  legacy("bob");
  let fail = true;
  const store = new FixtureStorage(
    directory,
    scope.serverId,
    () => 14_000,
    (stage, change) => {
      if (fail && stage === "state" && change === "tick") {
        fail = false;
        throw new Error("first worker fails");
      }
    },
  );
  const bob = { ...scope, userId: "bob" };
  try {
    expect(() => store.tick()).toThrow("worker transactions failed");
    expect(
      [store.snapshot(scope), store.snapshot(bob)].filter(
        (s) => s.actionProposals.length,
      ),
    ).toHaveLength(1);
    store.tick();
    expect(store.snapshot(scope).actionProposals).toHaveLength(1);
    expect(store.snapshot(bob).actionProposals).toHaveLength(1);
  } finally {
    store.close();
  }
});
