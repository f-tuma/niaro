import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import { IdentityError } from "../apps/server-identity/error";
import {
  AUTH_PROFILE,
  PROFILE,
  CONVERSATION_PROJECTION_PROFILE,
  OPEN_WORK_PROFILE,
  CommandResultSchema,
  CommandSchema,
  CredentialSchema,
  WorkItemSchema,
  type Snapshot,
  type WorkItem,
} from "../packages/protocol";

const scope = {
  connectionId: "fixture-a",
  serverId: "fixture-0123456789abcdef01234567",
  userId: "alice",
  workspaceId: "a",
};
const command = (value: object) => CommandSchema.parse(value);
const send = (id: string, conversationId: string, text: string) =>
  command({
    type: "message.send",
    commandId: id,
    idempotencyKey: id,
    conversationId,
    text,
    language: "en",
  });
const cancel = (id: string, work: WorkItem, revision = work.revision) =>
  command({
    type: "work.cancel",
    commandId: id,
    idempotencyKey: id,
    conversationId: work.conversationId,
    workItemId: work.id,
    expectedWorkRevision: revision,
    language: "en",
  });
const directory = (
  type: "conversation.delete" | "conversation.archive",
  id: string,
  conversationId: string,
  cancelOpenWork = false,
) =>
  command({
    type,
    commandId: id,
    idempotencyKey: id,
    conversationId,
    ...(cancelOpenWork ? { cancelOpenWork: true } : {}),
  });
const workIn = (snapshot: Snapshot, conversationId = "conversation-1") =>
  snapshot.workItems.filter((w) => w.conversationId === conversationId);

describe("fixture calendar work", () => {
  let root: string;
  let now: number;
  let storage: FixtureStorage;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "TEST-work-cancel-"));
    now = Date.parse("2026-10-17T08:00:00.000Z");
    storage = new FixtureStorage(root, scope.serverId, () => now);
  });
  afterEach(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("a waiting question ends cancelled; replays, stale and unknown targets are refused", () => {
    storage.execute(
      scope,
      send("TEST-peter", "conversation-1", "Choose Peter"),
    );
    const [work] = workIn(storage.snapshot(scope));
    expect(work?.status).toBe("waiting_input");
    // Stale revision: nothing changes.
    expect(
      storage.execute(scope, cancel("TEST-stale", work!, work!.revision + 1)),
    ).toMatchObject({ status: "conflict", code: "revision_conflict" });
    const done = storage.execute(scope, cancel("TEST-cancel", work!));
    expect(done).toMatchObject({ status: "accepted", code: "accepted" });
    const cancelled = done.snapshot.workItems.find((w) => w.id === work!.id)!;
    expect(cancelled.status).toBe("cancelled");
    expect(
      done.snapshot.inputRequests
        .filter((i) => i.workItemId === work!.id)
        .map((i) => i.status),
    ).toEqual(["cancelled"]);
    // The same press replays its receipt; a new press at the old revision is stale.
    expect(storage.execute(scope, cancel("TEST-cancel", work!)).status).toBe(
      "accepted",
    );
    expect(
      storage.execute(scope, cancel("TEST-cancel-again", work!)),
    ).toMatchObject({ status: "conflict", code: "revision_conflict" });
    // Already settled at the revision the person sees: a no-op.
    expect(
      storage.execute(scope, cancel("TEST-cancel-settled", cancelled)).status,
    ).toBe("accepted");
    expect(
      storage.execute(
        scope,
        command({
          type: "work.cancel",
          commandId: "TEST-unknown",
          idempotencyKey: "TEST-unknown",
          conversationId: "conversation-1",
          workItemId: "TEST-no-such-work",
          expectedWorkRevision: 1,
          language: "en",
        }),
      ),
    ).toMatchObject({ status: "rejected", code: "unknown_context" });
    // Another person's scope has no such work.
    expect(
      storage.execute(
        { ...scope, userId: "bob" },
        cancel("TEST-bob", cancelled),
      ),
    ).toMatchObject({ status: "rejected", code: "unknown_context" });
    // Nothing waits any more: the chat can be deleted.
    expect(
      storage.execute(
        scope,
        directory("conversation.delete", "TEST-delete", "conversation-1"),
      ).status,
    ).toBe("accepted");
  });

  test("a waiting approval is declined without any operation", () => {
    storage.execute(
      scope,
      send("TEST-peter", "conversation-1", "Choose Peter"),
    );
    const [asking] = workIn(storage.snapshot(scope));
    const input = storage
      .snapshot(scope)
      .inputRequests.find((i) => i.workItemId === asking!.id)!;
    expect(
      storage.execute(
        scope,
        command({
          type: "input.submit",
          commandId: "TEST-choose",
          idempotencyKey: "TEST-choose",
          conversationId: "conversation-1",
          workItemId: asking!.id,
          inputRequestId: input.id,
          expectedInputRevision: input.revision,
          answer: { selectedContactId: input.options[0]!.id },
        }),
      ).status,
    ).toBe("accepted");
    now += 10_000;
    storage.tick();
    const [work] = workIn(storage.snapshot(scope));
    expect(work?.status).toBe("waiting_approval");
    // Refused without the flag: the chat names what still waits.
    const refused = storage.execute(
      scope,
      directory("conversation.archive", "TEST-archive", "conversation-1"),
    );
    expect(refused).toMatchObject({
      status: "rejected",
      code: "operation_in_progress",
      openWork: [
        { workItemId: work!.id, title: work!.title, kind: "approval" },
      ],
    });
    const done = storage.execute(scope, cancel("TEST-decline", work!));
    expect(done.status).toBe("accepted");
    expect(done.snapshot.workItems.find((w) => w.id === work!.id)?.status).toBe(
      "cancelled",
    );
    expect(
      done.snapshot.actionProposals
        .filter((p) => p.workItemId === work!.id)
        .map((p) => p.status),
    ).toEqual(["rejected"]);
    expect(done.snapshot.operations).toEqual([]);
  });

  test("delete and archive with cancelOpenWork cancel the chat's work first, idempotently", () => {
    storage.execute(
      scope,
      send("TEST-peter", "conversation-1", "Choose Peter"),
    );
    const refused = storage.execute(
      scope,
      directory("conversation.delete", "TEST-delete-1", "conversation-1"),
    );
    expect(refused.code).toBe("operation_in_progress");
    expect(refused.openWork).toEqual([
      expect.objectContaining({ kind: "question" }),
    ]);
    // The refusal replays with the current list.
    expect(
      storage.execute(
        scope,
        directory("conversation.delete", "TEST-delete-1", "conversation-1"),
      ).openWork,
    ).toHaveLength(1);
    const deleted = storage.execute(
      scope,
      directory("conversation.delete", "TEST-delete-2", "conversation-1", true),
    );
    expect(deleted).toMatchObject({ status: "accepted" });
    expect(workIn(deleted.snapshot).map((w) => w.status)).toEqual([
      "cancelled",
    ]);
    expect(
      storage.execute(
        scope,
        directory(
          "conversation.delete",
          "TEST-delete-2",
          "conversation-1",
          true,
        ),
      ).status,
    ).toBe("accepted");

    storage.execute(
      scope,
      command({
        type: "conversation.create",
        conversationId: "chat-TEST-archive",
        commandId: "TEST-create",
        idempotencyKey: "TEST-create",
      }),
    );
    storage.execute(
      scope,
      send("TEST-peter-2", "chat-TEST-archive", "Choose Peter"),
    );
    expect(
      storage.execute(
        scope,
        directory(
          "conversation.archive",
          "TEST-archive",
          "chat-TEST-archive",
          true,
        ),
      ).status,
    ).toBe("accepted");
    expect(storage.conversationArchived(scope, "chat-TEST-archive")).toBe(true);
  });

  test("a native run that ended with an unconfirmed write no longer holds its chat", () => {
    const base = {
      id: "TEST-native-run",
      revision: 2,
      conversationId: "conversation-1",
      title: "TEST task",
      context: "TEST context",
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    };
    const action = {
      type: "service.action",
      version: 1,
      operationId: "TEST-op",
      service: "TEST service",
      title: "TEST write",
      effect: "write",
      status: "unknown",
      fields: [],
      inputJson: "{}",
      reviewTruncated: false,
      summary: "TEST unconfirmed",
    };
    const work = WorkItemSchema.parse({
      ...base,
      status: "waiting_system",
      native: { runId: "TEST-native-run", revision: 2, action },
    });
    storage.syncNativeWork(scope, [work], true);
    expect(
      storage.execute(
        scope,
        directory("conversation.delete", "TEST-delete", "conversation-1"),
      ).status,
    ).toBe("accepted");
    // The work stays visible for Tasks.
    expect(
      storage.snapshot(scope).workItems.some((w) => w.id === work.id),
    ).toBe(true);
  });
});

const call = (
  port: number,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += String(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error(`TEST timeout ${path}`)));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

test("over HTTP the open work list reaches only clients that ask for it; work.cancel is scoped to the person", async () => {
  const root = mkdtempSync(join(tmpdir(), "TEST-work-cancel-http-"));
  const server = createFixtureServer(root, undefined, {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const pair = async (user: string) =>
    CredentialSchema.parse(
      (
        await call(port, "/v1/a/auth/pair", undefined, {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(root, user, "a"),
        })
      ).body,
    ).accessToken;
  const commands = `/v1/a/commands?chats=${CONVERSATION_PROJECTION_PROFILE}`;
  const listed = `${commands}&work=${encodeURIComponent(OPEN_WORK_PROFILE)}`;
  try {
    const alice = await pair("alice");
    const bob = await pair("bob");
    await call(
      port,
      commands,
      alice,
      send("TEST-peter", "conversation-1", "Choose Peter"),
    );
    const plain = await call(
      port,
      commands,
      alice,
      directory("conversation.delete", "TEST-d1", "conversation-1"),
    );
    expect(plain.status).toBe(422);
    expect(plain.body).not.toHaveProperty("openWork");
    const asked = await call(
      port,
      listed,
      alice,
      directory("conversation.delete", "TEST-d2", "conversation-1"),
    );
    const refusal = CommandResultSchema.parse(asked.body);
    expect(refusal.openWork).toEqual([
      expect.objectContaining({ kind: "question" }),
    ]);
    const work = refusal.snapshot.workItems.find(
      (w) => w.id === refusal.openWork![0]!.workItemId,
    )!;
    // Bob cannot reach Alice's work.
    expect(
      (await call(port, commands, bob, cancel("TEST-bob", work))).status,
    ).toBe(422);
    const stale = await call(
      port,
      commands,
      alice,
      cancel("TEST-stale", work, work.revision + 1),
    );
    expect(stale.status).toBe(409);
    const done = await call(port, commands, alice, cancel("TEST-cancel", work));
    expect(done.status).toBe(202);
    expect(
      (
        await call(
          port,
          listed,
          alice,
          directory("conversation.delete", "TEST-d3", "conversation-1"),
        )
      ).status,
    ).toBe(202);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});

describe("process runs through the model service", () => {
  const processWork = (
    status: "waiting" | "cancelled",
    nativeRevision: number,
  ) =>
    WorkItemSchema.parse({
      id: "TEST-parent",
      revision: nativeRevision,
      conversationId: "conversation-1",
      title: "TEST process",
      context: "TEST waiting",
      status: status === "waiting" ? "waiting_approval" : "cancelled",
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
      native: {
        runId: "TEST-parent",
        revision: nativeRevision,
        process: {
          kind: "service-process-1",
          status,
          journalStatus: status,
          journalRevision: nativeRevision,
          detailsAvailable: true,
          provenance: {
            runId: "TEST-run",
            processId: "TEST-process",
            version: 1,
            artifactDigest: "a".repeat(64),
            actorId: scope.userId,
            conversationId: "conversation-1",
            commandId: "TEST-start",
            admissionId: "TEST-admission",
          },
          receipts: [],
        },
      },
    });
  let root: string;
  let storage: FixtureStorage;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "TEST-work-cancel-process-"));
    storage = new FixtureStorage(root, scope.serverId, () => Date.now());
    storage.syncNativeWork(scope, [processWork("waiting", 7)], true);
  });
  afterEach(() => {
    storage.close();
    rmSync(root, { recursive: true, force: true });
  });
  const access = (
    cancelProcessRun: (id: string, revision: number) => Promise<void>,
    current: () => WorkItem,
  ) => ({
    tools: {
      has: () => false,
      invoke: async () => {
        throw Error("TEST no legacy tool");
      },
    },
    run: async <T>(fn: () => T) => fn(),
    cancelProcessRun,
    integrations: {
      enabled: true,
      hasTurn: async () => false,
      taskWindow: async () => ({ items: [current()], validate: () => true }),
    } as never,
  });

  test("work.cancel and cancelOpenWork go through the process coordinator at its journal revision", async () => {
    const models = new ModelService(storage, undefined);
    let state = processWork("waiting", 7);
    const cancelled: [string, number][] = [];
    const runtime = access(
      async (id, revision) => {
        cancelled.push([id, revision]);
        state = processWork("cancelled", 8);
      },
      () => state,
    );
    const work = storage
      .snapshot(scope)
      .workItems.find((w) => w.id === "TEST-parent")!;
    const result = await models.execute(
      scope,
      cancel("TEST-process-cancel", work),
      () => {},
      new AbortController().signal,
      runtime,
    );
    expect(result).toMatchObject({ status: "accepted" });
    expect(cancelled).toEqual([["TEST-parent", 7]]);
    expect(
      result.snapshot.workItems.find((w) => w.id === "TEST-parent")?.status,
    ).toBe("cancelled");
  });

  test("a run still executing refuses without a receipt; the flag then cancels before deleting", async () => {
    const models = new ModelService(storage, undefined);
    let state = processWork("waiting", 7);
    let busy = true;
    const runtime = access(
      async () => {
        if (busy) throw new IdentityError(409, "process_command_in_progress");
        state = processWork("cancelled", 8);
      },
      () => state,
    );
    const work = storage
      .snapshot(scope)
      .workItems.find((w) => w.id === "TEST-parent")!;
    const refused = await models.execute(
      scope,
      cancel("TEST-busy", work),
      () => {},
      new AbortController().signal,
      runtime,
    );
    expect(refused).toMatchObject({
      status: "conflict",
      code: "operation_in_progress",
    });
    expect(storage.replay(scope, cancel("TEST-busy", work))).toBeUndefined();
    const plain = await models.execute(
      scope,
      directory("conversation.delete", "TEST-delete", "conversation-1"),
      () => {},
      new AbortController().signal,
      runtime,
    );
    expect(plain.openWork).toEqual([
      { workItemId: "TEST-parent", title: "TEST process", kind: "process" },
    ]);
    busy = false;
    const deleted = await models.execute(
      scope,
      directory("conversation.delete", "TEST-delete-2", "conversation-1", true),
      () => {},
      new AbortController().signal,
      runtime,
    );
    expect(deleted.status).toBe("accepted");
    expect(
      deleted.snapshot.workItems.find((w) => w.id === "TEST-parent")?.status,
    ).toBe("cancelled");
  });
});
