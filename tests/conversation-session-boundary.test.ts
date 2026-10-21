import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FixtureStorage,
  type CommitStage,
} from "../apps/fixture-server/storage";
import { CommandSchema, type Command } from "../packages/protocol";
import { scopeFor } from "../packages/test-fixtures";
import { messageCommand } from "../packages/client-core/commands";
import { ModelService } from "../apps/fixture-server/model-service";
import type { Decision } from "../apps/fixture-server/decision";

const scope = scopeFor();
const fresh = (id: string) =>
  CommandSchema.parse({
    ...messageCommand(`TEST ${id}`, "en", id),
    session: "new",
  });
const reply = (storage: FixtureStorage, command: Command) =>
  storage.execute(scope, command, {
    expectedCursor: storage.snapshot(scope, command.conversationId).cursor,
    timeZone: "UTC",
    decision: {
      kind: "reply",
      reply: "TEST reply",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
    },
  });
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "TEST-session-boundary-"));
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));

test("committed reset survives empty chat, reload, missing receipt and exact retry without archiving newer messages", () => {
  let storage = new FixtureStorage(directory, scope.serverId);
  const command = fresh("TEST-reset");
  expect(storage.conversationSession(scope, "conversation-1")).toBeUndefined();
  storage.startSession(scope, "conversation-1", command);
  const token = storage.conversationSession(scope, "conversation-1");
  expect(token).toMatch(/^[a-f0-9]{64}$/);
  expect(storage.replay(scope, command)).toBeUndefined();
  reply(storage, messageCommand("TEST later message", "en", "TEST-later"));
  const before = storage.snapshot(scope);
  storage.close();
  storage = new FixtureStorage(directory, scope.serverId);
  try {
    expect(storage.conversationSession(scope, "conversation-1")).toBe(token);
    storage.startSession(scope, "conversation-1", command);
    expect(storage.snapshot(scope)).toEqual(before);
    expect(storage.sessions(scope)).toEqual([]);
    // Changed text or either reused identity cannot steal the original command's receipt.
    for (const fork of [
      { ...command, text: "TEST changed" },
      { ...command, commandId: "TEST-different-command" },
      { ...command, idempotencyKey: "TEST-different-idempotency" },
    ]) {
      expect(() => storage.startSession(scope, "conversation-1", fork)).toThrow(
        "idempotency_conflict",
      );
      expect(storage.replay(scope, command)).toBeUndefined();
      expect(storage.snapshot(scope)).toEqual(before);
      expect(storage.conversationSession(scope, "conversation-1")).toBe(token);
    }
    const { session: _session, ...ordinary } = command as Extract<
      Command,
      { type: "message.send" }
    >;
    for (const fork of [
      ordinary,
      { ...ordinary, commandId: "TEST-other-command" },
      { ...ordinary, idempotencyKey: "TEST-other-idempotency" },
      {
        type: "conversation.create" as const,
        commandId: command.commandId,
        idempotencyKey: command.idempotencyKey,
        conversationId: "TEST-fork-chat",
      },
    ]) {
      expect(() => storage.replay(scope, fork)).toThrow("idempotency_conflict");
      expect(() => storage.execute(scope, fork)).toThrow(
        "idempotency_conflict",
      );
      expect(storage.replay(scope, command)).toBeUndefined();
      expect(storage.snapshot(scope)).toEqual(before);
    }
    expect(reply(storage, command).status).toBe("accepted");
    expect(storage.sessions(scope)).toEqual([]);
    const completed = storage.snapshot(scope);
    expect(reply(storage, command).status).toBe("accepted");
    expect(storage.snapshot(scope)).toEqual(completed);
    // A genuinely new reset advances once and atomically archives the old transcript.
    storage.startSession(scope, "conversation-1", fresh("TEST-next-reset"));
    expect(storage.conversationSession(scope, "conversation-1")).not.toBe(
      token,
    );
    expect(storage.sessions(scope)).toHaveLength(1);
    expect(storage.snapshot(scope).conversations[0]!.messages).toEqual([]);
  } finally {
    storage.close();
  }
});

test.each<CommitStage>(["session", "before_commit", "after_commit"])(
  "%s reset failure keeps archive and generation at the same commit boundary",
  (stage) => {
    let armed = false;
    const writer = new FixtureStorage(
      directory,
      scope.serverId,
      Date.now,
      (at, change) => {
        if (armed && change === "command" && at === stage)
          throw Error("TEST injected reset failure");
      },
    );
    reply(writer, messageCommand("TEST old message", "en", "TEST-old"));
    const before = writer.snapshot(scope);
    const command = fresh("TEST-reset");
    armed = true;
    expect(() => writer.startSession(scope, "conversation-1", command)).toThrow(
      "TEST injected reset failure",
    );
    writer.close();
    const reopened = new FixtureStorage(directory, scope.serverId);
    try {
      if (stage === "after_commit") {
        expect(
          reopened.conversationSession(scope, "conversation-1"),
        ).toBeDefined();
        expect(reopened.sessions(scope)).toHaveLength(1);
        expect(reopened.snapshot(scope).conversations[0]!.messages).toEqual([]);
        reopened.startSession(scope, "conversation-1", command);
        expect(reopened.sessions(scope)).toHaveLength(1);
      } else {
        expect(
          reopened.conversationSession(scope, "conversation-1"),
        ).toBeUndefined();
        expect(reopened.sessions(scope)).toHaveLength(0);
        expect(reopened.snapshot(scope)).toEqual(before);
      }
    } finally {
      reopened.close();
    }
  },
);

test("session journal isolates every scope component and refuses unknown chats or spoofed generations", () => {
  const storage = new FixtureStorage(directory, scope.serverId);
  try {
    storage.startSession(scope, "conversation-1", fresh("TEST-reset"));
    for (const other of [{ ...scope, userId: "test-other" }, scopeFor("b")])
      expect(
        storage.conversationSession(other, "conversation-1"),
      ).toBeUndefined();
    for (const other of [
      { ...scope, connectionId: "TEST-foreign" },
      { ...scope, serverId: "TEST-foreign" },
    ])
      expect(() =>
        storage.conversationSession(other, "conversation-1"),
      ).toThrow("workspace mismatch");
    const unknown = {
      ...fresh("TEST-unknown"),
      conversationId: "TEST-unknown",
    };
    expect(() => storage.startSession(scope, "TEST-unknown", unknown)).toThrow(
      "catalog_conflict",
    );
    expect(storage.conversationSession(scope, "TEST-unknown")).toBeUndefined();
    expect(
      CommandSchema.safeParse({
        ...fresh("TEST-spoof"),
        conversationSession: "a".repeat(64),
      }).success,
    ).toBe(false);
  } finally {
    storage.close();
  }
});

test("busy or unauthorized new-session request cannot publish a boundary or archive active chat", async () => {
  const storage = new FixtureStorage(directory, scope.serverId);
  let started!: () => void;
  let finish!: (decision: Decision) => void;
  const inference = new Promise<void>((resolve) => {
    started = resolve;
  });
  const decision = new Promise<Decision>((resolve) => {
    finish = resolve;
  });
  const service = new ModelService(storage, {
    timeZone: "UTC",
    decide: async () => {
      started();
      return decision;
    },
  });
  try {
    reply(storage, messageCommand("TEST old message", "en", "TEST-old"));
    const pending = service.execute(
      scope,
      messageCommand("TEST running", "en", "TEST-running"),
      () => {},
      new AbortController().signal,
    );
    await inference;
    const before = storage.snapshot(scope);
    await expect(
      service.execute(
        scope,
        fresh("TEST-busy-reset"),
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("model_busy");
    expect(
      storage.conversationSession(scope, "conversation-1"),
    ).toBeUndefined();
    expect(storage.sessions(scope)).toEqual([]);
    expect(storage.snapshot(scope)).toEqual(before);
    finish({
      kind: "reply",
      reply: "TEST finished",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
    });
    expect((await pending).status).toBe("accepted");
    const completed = storage.snapshot(scope);
    await expect(
      service.execute(
        scope,
        fresh("TEST-unauthorized-reset"),
        () => {
          throw Error("TEST revoked");
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("TEST revoked");
    expect(
      storage.conversationSession(scope, "conversation-1"),
    ).toBeUndefined();
    expect(storage.sessions(scope)).toEqual([]);
    expect(storage.snapshot(scope)).toEqual(completed);
  } finally {
    storage.close();
  }
});
