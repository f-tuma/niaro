import { HumanTaskCommandQueue } from "../packages/client-core/human-task-command";
import { humanTaskFixture } from "../packages/test-fixtures/human-task";
import { sameScope } from "../packages/protocol";
import type {
  HumanTask,
  HumanTaskCommand,
} from "../packages/protocol/human-tasks";

const done: HumanTask = {
  ...humanTaskFixture,
  status: "done",
  resolution: { by: "user", reason: "", at: "2026-10-08T12:00:00.000Z" },
  revision: 2,
};
function fixture(owner = "TEST-owner-a", storage = new Map<string, string>()) {
  const ports = {
    identityKey: owner,
    storage: {
      getItem: jest.fn(async (key: string) => storage.get(key) ?? null),
      setItem: jest.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
    },
    uuid: jest.fn(() => "TEST-command-1"),
    owns: (task: HumanTask) => sameScope(task.scope, humanTaskFixture.scope),
    submit: jest.fn(async (_id: string, _command: HumanTaskCommand) => done),
    read: jest.fn(async (_id: string) => done),
  };
  return { queue: new HumanTaskCommandQueue(ports), ports, storage };
}
test("lost acknowledgment and remount retry the original persisted command even after the task has changed", async () => {
  const first = fixture();
  first.ports.submit.mockRejectedValueOnce(new Error("connection_lost"));
  const refresh = jest.fn(async () => {});
  await first.queue.decide(humanTaskFixture, "complete", refresh);
  const attempt = first.queue.getSnapshot().pending!;
  expect(JSON.parse(first.storage.get(first.queue.key)!).pending).toEqual(
    attempt,
  );
  expect(first.ports.read).not.toHaveBeenCalled();
  const restored = fixture("TEST-owner-a", first.storage);
  const reopened: HumanTask = {
    ...done,
    status: "open",
    resolution: null,
    revision: 3,
  };
  restored.ports.read.mockResolvedValue(reopened);
  await restored.queue.restore();
  await restored.queue.decide(
    { ...humanTaskFixture, revision: 10 },
    "remove",
    refresh,
  );
  expect(restored.ports.submit).not.toHaveBeenCalled();
  await restored.queue.retry(refresh);
  expect(restored.ports.submit).toHaveBeenCalledWith(
    humanTaskFixture.id,
    attempt.command,
  );
  expect(restored.ports.uuid).not.toHaveBeenCalled();
  expect(refresh).toHaveBeenCalledWith(reopened);
  expect(restored.queue.getSnapshot().pending).toBeNull();
  expect(JSON.parse(first.storage.get(first.queue.key)!).pending).toBeNull();
});
test("a receipt is not enough to clear recovery before current detail and list refresh succeed", async () => {
  const h = fixture();
  h.ports.read.mockRejectedValueOnce(new Error("connection_lost"));
  const refresh = jest.fn(async () => {
    throw new Error("list_failed");
  });
  await h.queue.decide(humanTaskFixture, "complete", refresh);
  const command = h.queue.getSnapshot().pending!.command;
  expect(refresh).not.toHaveBeenCalled();
  await h.queue.retry(refresh);
  expect(h.queue.getSnapshot().pending!.command).toEqual(command);
  expect(JSON.parse(h.storage.get(h.queue.key)!).pending.command).toEqual(
    command,
  );
  await h.queue.retry(async () => {});
  expect(h.queue.getSnapshot().pending).toBeNull();
  expect(h.ports.submit.mock.calls.map((call) => call[1])).toEqual([
    command,
    command,
    command,
  ]);
});
test("switching owner neither sends nor removes the previous owner's pending decision", async () => {
  const a = fixture();
  a.ports.submit.mockRejectedValue(new Error("connection_lost"));
  await a.queue.decide(humanTaskFixture, "complete", async () => {});
  const saved = a.storage.get(a.queue.key);
  const b = fixture("TEST-owner-b", a.storage);
  await b.queue.restore();
  await b.queue.retry(async () => {});
  expect(b.queue.getSnapshot().pending).toBeNull();
  expect(b.ports.submit).not.toHaveBeenCalled();
  expect(a.storage.get(a.queue.key)).toBe(saved);
  const back = fixture("TEST-owner-a", a.storage);
  await back.queue.restore();
  expect(back.queue.getSnapshot().pending).toEqual(
    a.queue.getSnapshot().pending,
  );
});
test("legacy decisions are preserved for review and never replayed into the new task model", async () => {
  const h = fixture();
  const legacy = {
    version: 1,
    owner: "TEST-owner-a",
    pending: {
      task: { ...humanTaskFixture, status: "active" },
      command: {
        profile: "niaro-human-tasks/1",
        commandId: "TEST-old-command",
        idempotencyKey: "TEST-old-command",
        expectedRevision: 2,
        decision: "complete",
      },
    },
  };
  h.storage.set(
    "agent-client.human-task-command.v1:TEST-owner-a",
    JSON.stringify(legacy),
  );
  await h.queue.restore();
  expect(h.queue.getSnapshot()).toEqual({
    phase: "uncertain",
    pending: null,
    error: "human_task_legacy_decision",
    legacyPending: {
      taskId: humanTaskFixture.id,
      title: humanTaskFixture.title,
      decision: "complete",
    },
  });
  expect(h.ports.submit).not.toHaveBeenCalled();
  expect(JSON.parse(h.storage.get(h.queue.legacyKey)!).pending).toEqual(
    legacy.pending,
  );
  await h.queue.acknowledgeLegacyDecision();
  expect(h.queue.getSnapshot()).toEqual({
    phase: "idle",
    pending: null,
    error: null,
  });
  expect(JSON.parse(h.storage.get(h.queue.legacyKey)!).pending).toBeNull();
  expect(JSON.parse(h.storage.get(h.queue.key)!).legacyReviewed).toBe(true);
  expect(h.ports.submit).not.toHaveBeenCalled();
  await h.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(h.ports.submit).toHaveBeenCalledTimes(1);
  expect(h.ports.submit.mock.calls[0]![1].profile).toBe("niaro-human-tasks/2");
});
test("a different owner cannot see or acknowledge another owner's legacy decision", async () => {
  const a = fixture();
  const key = "agent-client.human-task-command.v1:TEST-owner-a";
  a.storage.set(
    key,
    JSON.stringify({
      version: 1,
      owner: "TEST-owner-a",
      pending: {
        task: humanTaskFixture,
        command: { decision: "dismiss" },
      },
    }),
  );
  const b = fixture("TEST-owner-b", a.storage);
  await b.queue.restore();
  expect(b.queue.getSnapshot()).toEqual({
    phase: "idle",
    pending: null,
    error: null,
  });
  expect(a.storage.get(key)).not.toBeNull();
});
test("failed durable write prevents delivery and corrupt saved state prevents new decisions", async () => {
  const failed = fixture();
  failed.ports.storage.setItem.mockRejectedValueOnce(new Error("disk_full"));
  await failed.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(failed.ports.submit).not.toHaveBeenCalled();
  expect(failed.queue.getSnapshot().error).toBe("human_task_storage_failed");
  const corrupt = fixture();
  corrupt.storage.set(corrupt.queue.key, "broken");
  await corrupt.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(corrupt.ports.submit).not.toHaveBeenCalled();
  expect(corrupt.storage.get(corrupt.queue.key)).toBe("broken");
});
test("wrong owner receipt and stale current detail keep the exact original command", async () => {
  const h = fixture();
  h.ports.submit.mockResolvedValueOnce({
    ...done,
    scope: { ...done.scope, userId: "other-user" },
  });
  await h.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(h.queue.getSnapshot().error).toBe("human_task_receipt_invalid");
  expect(h.ports.read).not.toHaveBeenCalled();
  h.ports.read.mockResolvedValueOnce(humanTaskFixture);
  await h.queue.retry(async () => {});
  expect(h.queue.getSnapshot().error).toBe("human_task_receipt_invalid");
  expect(h.queue.getSnapshot().pending).not.toBeNull();
});
test.each([
  "human_task_revision_conflict",
  "human_task_transition_invalid",
  "human_task_conflict",
])(
  "a definitive %s reconciles a competing device's current task without automatically submitting a new decision",
  async (error) => {
    const h = fixture();
    h.ports.submit.mockRejectedValueOnce(new Error(error));
    const refresh = jest.fn(async () => {});
    await h.queue.decide(humanTaskFixture, "complete", refresh);
    expect(h.queue.getSnapshot()).toEqual({
      phase: "idle",
      pending: null,
      error: "human_task_changed",
    });
    expect(refresh).toHaveBeenCalledWith(done);
    expect(h.ports.submit).toHaveBeenCalledTimes(1);
    expect(h.ports.uuid).toHaveBeenCalledTimes(1);
    expect(JSON.parse(h.storage.get(h.queue.key)!).pending).toBeNull();
    await h.queue.retry(refresh);
    expect(h.ports.submit).toHaveBeenCalledTimes(1);
    h.ports.uuid.mockReturnValueOnce("TEST-command-2");
    const reopened: HumanTask = {
      ...done,
      revision: 3,
      status: "open",
      resolution: null,
    };
    h.ports.submit.mockResolvedValueOnce(reopened);
    h.ports.read.mockResolvedValueOnce(reopened);
    await h.queue.decide(done, "reopen", refresh);
    expect(h.ports.submit).toHaveBeenLastCalledWith(
      done.id,
      expect.objectContaining({
        commandId: "TEST-command-2",
        expectedRevision: 2,
        decision: "reopen",
      }),
    );
  },
);
test("a deleted task clears a definitive rejection only after confirming absence and refreshing the list", async () => {
  const h = fixture();
  h.ports.submit.mockRejectedValue(new Error("human_task_not_found"));
  h.ports.read.mockRejectedValue(new Error("human_task_not_found"));
  const refresh = jest.fn(async () => {});
  await h.queue.decide(humanTaskFixture, "complete", refresh);
  expect(refresh).toHaveBeenCalledWith(null);
  expect(h.queue.getSnapshot()).toEqual({
    phase: "idle",
    pending: null,
    error: "human_task_removed",
  });
  expect(JSON.parse(h.storage.get(h.queue.key)!).pending).toBeNull();
});
test("a definitive rejection with failed reconciliation keeps its exact payload until reconciliation succeeds", async () => {
  const h = fixture();
  h.ports.submit.mockRejectedValue(new Error("human_task_revision_conflict"));
  const refresh = jest.fn(async () => {});
  refresh.mockRejectedValueOnce(new Error("list_failed"));
  await h.queue.decide(humanTaskFixture, "complete", refresh);
  const attempt = h.queue.getSnapshot().pending!;
  expect(JSON.parse(h.storage.get(h.queue.key)!).pending).toEqual(attempt);
  await h.queue.retry(refresh);
  expect(h.ports.submit.mock.calls.map((call) => call[1])).toEqual([
    attempt.command,
    attempt.command,
  ]);
  expect(h.queue.getSnapshot().pending).toBeNull();
});
test("an old owner's held acknowledgment cannot clear a newer saved decision after returning to that owner", async () => {
  const old = fixture();
  let acknowledge!: (task: HumanTask) => void;
  const held = new Promise<HumanTask>((resolve) => {
    acknowledge = resolve;
  });
  old.ports.submit.mockReturnValueOnce(held);
  const oldFlight = old.queue.decide(
    humanTaskFixture,
    "complete",
    async () => {},
  );
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(old.ports.submit).toHaveBeenCalledTimes(1);
  const returned = fixture("TEST-owner-a", old.storage);
  await returned.queue.restore();
  await returned.queue.retry(async () => {});
  returned.ports.uuid.mockReturnValueOnce("TEST-command-2");
  returned.ports.submit.mockRejectedValueOnce(new Error("connection_lost"));
  await returned.queue.decide(done, "reopen", async () => {});
  const newer = returned.queue.getSnapshot().pending!;
  acknowledge(done);
  await oldFlight;
  expect(JSON.parse(old.storage.get(old.queue.key)!).pending).toEqual(newer);
  expect(returned.queue.getSnapshot().pending).toEqual(newer);
});
test("a held clear's storage comparison and write serialize with a newer controller's persistence", async () => {
  const old = fixture();
  let acknowledge!: (task: HumanTask) => void;
  old.ports.submit.mockReturnValueOnce(
    new Promise<HumanTask>((resolve) => {
      acknowledge = resolve;
    }),
  );
  const oldFlight = old.queue.decide(
    humanTaskFixture,
    "complete",
    async () => {},
  );
  for (let n = 0; n < 20; n++) await Promise.resolve();
  const returned = fixture("TEST-owner-a", old.storage);
  await returned.queue.restore();
  await returned.queue.retry(async () => {});
  let releaseRead!: () => void;
  const heldRead = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  old.ports.storage.getItem.mockImplementationOnce(async (key) => {
    await heldRead;
    return old.storage.get(key) ?? null;
  });
  acknowledge(done);
  for (let n = 0; n < 20; n++) await Promise.resolve();
  returned.ports.uuid.mockReturnValueOnce("TEST-command-2");
  returned.ports.submit.mockRejectedValueOnce(new Error("connection_lost"));
  const newFlight = returned.queue.decide(done, "reopen", async () => {});
  for (let n = 0; n < 20; n++) await Promise.resolve();
  expect(returned.ports.submit).toHaveBeenCalledTimes(1);
  releaseRead();
  await Promise.all([oldFlight, newFlight]);
  const newer = returned.queue.getSnapshot().pending!;
  expect(newer.command.commandId).toBe("TEST-command-2");
  expect(JSON.parse(old.storage.get(old.queue.key)!).pending).toEqual(newer);
});
test("a stale controller's preparation cannot overwrite a newer saved decision", async () => {
  const old = fixture();
  await old.queue.restore();
  const newer = fixture("TEST-owner-a", old.storage);
  newer.ports.uuid.mockReturnValueOnce("TEST-newer-command");
  newer.ports.submit.mockRejectedValueOnce(new Error("connection_lost"));
  await newer.queue.decide(humanTaskFixture, "complete", async () => {});
  const attempt = newer.queue.getSnapshot().pending!;
  await old.queue.decide(humanTaskFixture, "remove", async () => {});
  expect(old.ports.submit).not.toHaveBeenCalled();
  expect(JSON.parse(old.storage.get(old.queue.key)!).pending).toEqual(attempt);
  expect(old.queue.getSnapshot().pending).toEqual(attempt);
  expect(old.queue.getSnapshot().error).toBe(
    "human_task_saved_decision_changed",
  );
});
test("an old accept decision is preserved for review and blocks actions until acknowledged", async () => {
  const storage = new Map([
    [
      "agent-client.human-task-command.v1:TEST-owner-a",
      JSON.stringify({
        version: 1,
        owner: "TEST-owner-a",
        pending: {
          task: { ...humanTaskFixture, status: "proposed" },
          command: {
            profile: "niaro-human-tasks/1",
            commandId: "TEST-old",
            idempotencyKey: "TEST-old",
            expectedRevision: 1,
            decision: "accept",
          },
        },
      }),
    ],
  ]);
  const h = fixture("TEST-owner-a", storage);
  await h.queue.restore();
  expect(h.queue.getSnapshot()).toEqual({
    phase: "uncertain",
    pending: null,
    error: "human_task_legacy_decision",
    legacyPending: {
      taskId: humanTaskFixture.id,
      title: humanTaskFixture.title,
      decision: "accept",
    },
  });
  await h.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(h.ports.submit).not.toHaveBeenCalled();
  await h.queue.acknowledgeLegacyDecision();
  await h.queue.decide(humanTaskFixture, "complete", async () => {});
  expect(h.ports.submit).toHaveBeenCalledTimes(1);
  expect(h.ports.submit.mock.calls[0]![1].decision).toBe("complete");
});
