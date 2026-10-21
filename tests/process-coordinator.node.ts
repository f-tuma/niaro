import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { startFixture } from "./helpers/process-start";
import { scope, signal, admin, code } from "./helpers/service-process-runtime";
import { createProcessCoordinator } from "../apps/server-identity/process-coordinator";
import { ProcessResolveStore } from "../apps/server-identity/process-resolve-store";
import {
  NativeCommandRequests,
  personLane,
} from "../apps/server-identity/native-command-requests";
import {
  ProcessDefinitionSchema,
  type ProcessStep,
} from "../packages/protocol/service-processes";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";
import {
  ProcessRuntimeResponseSchema,
  type ProcessRuntimeResponse,
} from "../packages/protocol/process-coordinator";
import { processObject } from "./helpers/service-process";
import { ProcessStartStore } from "../apps/server-identity/process-start-store";
import { IdentityError } from "../apps/server-identity/error";
import { processAgent, callProcessTool } from "./helpers/service-process-agent";
import { nativeCatalogOwner } from "../apps/server-identity/mastra-runtime";
import { processDigest } from "../apps/server-identity/process-validation";
import {
  PROCESS_START_PROFILE,
  ProcessStartCommandSchema,
} from "../packages/protocol/process-start";

async function isolated(
  run: (
    h: ReturnType<typeof startFixture>,
    c: ReturnType<typeof createProcessCoordinator>,
    tracker: NativeCommandRequests,
    resolves: ProcessResolveStore,
  ) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-coordinator-"));
  const h = startFixture(join(root, "identity.sqlite"));
  const tracker = new NativeCommandRequests();
  const resolves = new ProcessResolveStore(h.db, h.starts);
  const c = createProcessCoordinator(
    h.controller,
    h.registry,
    h.starts,
    resolves,
    h.context,
    scope,
    admin.organizationId,
    tracker,
    { memory: h.memory },
  );
  try {
    await run(h, c, tracker, resolves);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
const origin = () => {};
const approval = (
  result: ProcessRuntimeResponse,
  id: string,
  approved = true,
) => {
  const state = result.process!;
  assert(state.approval);
  return {
    profile: PROCESS_EXECUTION_PROFILE,
    type: "service.resolve",
    commandId: id,
    idempotencyKey: id + "-key",
    conversationId: result.admission.origin.conversationId,
    workItemId: state.parentRunId,
    expectedWorkRevision: state.revision,
    operationId: state.approval.operationId,
    approved,
    language: "en",
  };
};
test("coordinator uses one admitted native parent and original inputs; passive reads and explicit replay never resend success", () =>
  isolated(async (h, c, tracker) => {
    const { command } = h.setup();
    const result = ProcessRuntimeResponseSchema.parse(
      await c.execute(command, signal(), origin),
    );
    assert.equal(result.process?.status, "succeeded");
    assert.equal(result.process?.output?.result, "TEST-result");
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.deepEqual(h.models(), []);
    assert.equal(tracker.activeScopes.size, 0);
    for (let i = 0; i < 3; i++)
      assert.deepEqual(await c.read(result.process!.parentRunId), result);
    assert.deepEqual(
      await c.execute(command, signal(), () => {
        throw Error("Replay must not remap origin");
      }),
      result,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.throws(() =>
      h.starts.forParent(
        admin,
        { ...scope, userId: "TEST-other" },
        result.process!.parentRunId,
      ),
    );
  }));
test("a meeting-origin process still pauses for approval before its external write", () =>
  isolated(async (h, _coordinator, tracker, resolves) => {
    const processId = h.activate(h.readWrite());
    const artifact = h.registry.version(admin, processId, 1);
    const meetingId = "11111111-1111-4111-8111-111111111111";
    const recordDigest = "c".repeat(64);
    const requestId = "TEST-meeting-write-origin";
    const selectedTask = {
      // Meeting tasks use the stable `meeting:<meeting id>:<index>` identity.
      id: `meeting:${meetingId}:0`,
      revision: 1,
    };
    const intent = h.starts.issue(
      admin,
      scope,
      {
        origin: {
          type: "meeting",
          conversationId: "conversation-1",
          requestId,
          meetingId,
          recordDigest,
          selectedTask,
          sourceBindings: { name: "summary" },
        },
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest: processDigest({
          requestId,
          inputSchema: artifact.definition.inputSchema,
        }),
        fields: {},
      },
      (issued) => {
        assert.equal(issued.origin.type, "meeting");
        assert.equal(issued.origin.recordDigest, recordDigest);
        assert.deepEqual(issued.origin.selectedTask, selectedTask);
      },
    );
    const command = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-meeting-write-start",
      idempotencyKey: "TEST-meeting-write-start-key",
      intentId: intent.intentId,
      conversationId: "conversation-1",
      language: "en",
      input: { name: "TEST meeting summary" },
    });
    const meetingCoordinator = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      tracker,
      {
        memory: h.memory,
        validateMeetingOrigin: (candidate) => {
          assert.equal(candidate.type, "meeting");
          assert.equal(candidate.recordDigest, recordDigest);
          assert.deepEqual(candidate.selectedTask, selectedTask);
        },
      },
    );
    const waiting = await meetingCoordinator.execute(command, signal(), origin);
    assert.equal(waiting.admission.origin.type, "meeting");
    assert.equal(waiting.process?.status, "waiting");
    assert(waiting.process?.approval);
    assert.deepEqual(
      h.counts(),
      [["GET", 1]],
      "the workflow may read the source but cannot write before approval",
    );

    const completed = await meetingCoordinator.execute(
      approval(waiting, "TEST-meeting-write-approve"),
      signal(),
      origin,
    );
    assert.equal(completed.process?.status, "succeeded");
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  }));
test("a meeting-origin approval is rejected if its selected task closes while waiting", () =>
  isolated(async (h, _coordinator, tracker, resolves) => {
    const processId = h.activate(h.readWrite());
    const artifact = h.registry.version(admin, processId, 1);
    const meetingId = "22222222-2222-4222-8222-222222222222";
    const recordDigest = "d".repeat(64);
    const requestId = "TEST-meeting-stale-approval-origin";
    const selectedTask = { id: `meeting:${meetingId}:0`, revision: 1 };
    let selectedTaskOpen = true;
    const intent = h.starts.issue(
      admin,
      scope,
      {
        origin: {
          type: "meeting",
          conversationId: "conversation-1",
          requestId,
          meetingId,
          recordDigest,
          selectedTask,
          sourceBindings: { name: "summary" },
        },
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest: processDigest({
          requestId,
          inputSchema: artifact.definition.inputSchema,
        }),
        fields: {},
      },
      () => {},
    );
    const command = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-meeting-stale-approval-start",
      idempotencyKey: "TEST-meeting-stale-approval-start-key",
      intentId: intent.intentId,
      conversationId: "conversation-1",
      language: "en",
      input: { name: "TEST meeting summary" },
    });
    const meetingCoordinator = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      tracker,
      {
        memory: h.memory,
        validateMeetingOrigin: (origin) => {
          if (
            origin.type !== "meeting" ||
            origin.selectedTask?.id !== selectedTask.id ||
            origin.recordDigest !== recordDigest ||
            !selectedTaskOpen
          )
            throw new IdentityError(409, "process_origin_changed");
        },
      },
    );
    const waiting = await meetingCoordinator.execute(command, signal(), origin);
    assert.equal(waiting.process?.status, "waiting");
    assert(waiting.process?.approval);
    assert.deepEqual(h.counts(), [["GET", 1]]);

    selectedTaskOpen = false;
    const decision = approval(waiting, "TEST-meeting-stale-approval");
    await assert.rejects(
      meetingCoordinator.execute(decision, signal(), origin),
      code("process_origin_changed"),
    );
    assert.equal(resolves.read(admin, scope, decision), undefined);
    assert.deepEqual(
      h.counts(),
      [["GET", 1]],
      "a task closed during the wait must block the exact external write",
    );
  }));
test("a meeting-origin approval rechecks its task at the external-action boundary", () =>
  isolated(async (h, _coordinator, tracker, resolves) => {
    const processId = h.activate(h.readWrite());
    const artifact = h.registry.version(admin, processId, 1);
    const meetingId = "33333333-3333-4333-8333-333333333333";
    const recordDigest = "e".repeat(64);
    const requestId = "TEST-meeting-racing-approval-origin";
    const selectedTask = { id: `meeting:${meetingId}:0`, revision: 1 };
    let selectedTaskOpen = true;
    let closeAtDispatch = false;
    h.onDispatch(() => {
      if (closeAtDispatch) selectedTaskOpen = false;
    });
    const intent = h.starts.issue(
      admin,
      scope,
      {
        origin: {
          type: "meeting",
          conversationId: "conversation-1",
          requestId,
          meetingId,
          recordDigest,
          selectedTask,
          sourceBindings: { name: "summary" },
        },
        processId,
        version: artifact.version,
        artifactDigest: artifact.digest,
        formDigest: processDigest({
          requestId,
          inputSchema: artifact.definition.inputSchema,
        }),
        fields: {},
      },
      () => {},
    );
    const command = ProcessStartCommandSchema.parse({
      profile: PROCESS_START_PROFILE,
      type: "process.start",
      commandId: "TEST-meeting-racing-approval-start",
      idempotencyKey: "TEST-meeting-racing-approval-start-key",
      intentId: intent.intentId,
      conversationId: "conversation-1",
      language: "en",
      input: { name: "TEST meeting summary" },
    });
    const meetingCoordinator = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      tracker,
      {
        memory: h.memory,
        validateMeetingOrigin: (origin) => {
          if (
            origin.type !== "meeting" ||
            origin.selectedTask?.id !== selectedTask.id ||
            origin.recordDigest !== recordDigest ||
            !selectedTaskOpen
          )
            throw new IdentityError(409, "process_origin_changed");
        },
      },
    );
    const waiting = await meetingCoordinator.execute(command, signal(), origin);
    assert.equal(waiting.process?.status, "waiting");
    assert.deepEqual(h.counts(), [["GET", 1]]);

    // Close the task after action preparation but immediately before the
    // transport's final `beforeDispatch` validation and provider start.
    closeAtDispatch = true;
    const decision = approval(waiting, "TEST-meeting-racing-approval");
    const result = await meetingCoordinator.execute(decision, signal(), origin);
    assert.equal(result.process?.status, "failed");
    assert.equal(result.process?.failure?.code, "process_origin_changed");
    assert(
      resolves.read(admin, scope, decision),
      "the exact approval is recorded",
    );
    assert.deepEqual(
      h.counts(),
      [["GET", 1]],
      "closing the selected task after approval but before dispatch must block the write",
    );
  }));
test("coordinator retirement passes the saved compiler identity to native proof", () =>
  isolated(async (h, c) => {
    const { command } = h.setup();
    const result = await c.execute(command, signal(), origin);
    assert(result.process);
    const owner = await nativeCatalogOwner(h.controller);
    const prove = owner.proveWorkflowRetired;
    const versions: string[] = [];
    owner.proveWorkflowRetired = async (input) => {
      versions.push(input.compilerVersion);
      return prove(input);
    };
    try {
      assert.equal(await c.retired(result.process.parentRunId), true);
      const journal = h.catalog.turn(
        result.process.parentRunId,
        scope.workspaceId,
        scope.userId,
      ) as { compilerVersion: string };
      assert.deepEqual(versions, [journal.compilerVersion]);
      assert.equal(journal.compilerVersion, "niaro-native-workflow/1");
    } finally {
      owner.proveWorkflowRetired = prove;
    }
  }));
test("approval A replay cannot approve B or replace its original command; terminal reads remain passive", () =>
  isolated(async (h, c) => {
    const initial = h.readWrite();
    assert(initial.kind === "workflow");
    const write = initial.steps.find((s) => s.id === "write");
    assert(write?.type === "action");
    const definition = ProcessDefinitionSchema.parse({
      ...initial,
      steps: initial.steps.flatMap<ProcessStep>((s) =>
        s.id === "write"
          ? [
              { ...write, next: "writeB" },
              {
                ...write,
                id: "writeB",
                input: {
                  name: { source: "step", stepId: "write", path: ["value"] },
                },
              },
            ]
          : s.type === "return"
            ? [
                {
                  ...s,
                  output: {
                    result: {
                      source: "step",
                      stepId: "writeB",
                      path: ["value"],
                    },
                  },
                },
              ]
            : [s],
      ),
    });
    const { command } = h.setup(definition);
    const a = await c.execute(command, signal(), origin);
    assert.equal(a.process?.status, "waiting");
    const commandA = approval(a, "TEST-A");
    const b = await c.execute(commandA, signal(), origin);
    assert.equal(b.process?.status, "waiting");
    assert.notEqual(
      b.process?.approval?.operationId,
      a.process?.approval?.operationId,
    );
    const before = h.catalog.turn(
      b.process!.parentRunId,
      scope.workspaceId,
      scope.userId,
    );
    const replay = await c.execute(commandA, signal(), origin);
    assert.deepEqual(replay, b);
    assert.deepEqual(
      h.catalog.turn(b.process!.parentRunId, scope.workspaceId, scope.userId),
      before,
    );
    const interruptedA = await c.interrupt(commandA);
    assert.equal(interruptedA.status, "settled");
    assert.equal(
      interruptedA.status === "settled" &&
        interruptedA.result.process?.approval?.operationId,
      b.process!.approval!.operationId,
    );
    assert.deepEqual(
      h.catalog.turn(b.process!.parentRunId, scope.workspaceId, scope.userId),
      before,
    );
    assert.deepEqual(await c.execute(commandA, signal(), origin), b);
    await assert.rejects(
      c.execute(
        {
          ...commandA,
          operationId: b.process!.approval!.operationId,
          expectedWorkRevision: b.process!.revision,
        },
        signal(),
        origin,
      ),
      code("idempotency_conflict"),
    );
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
    const done = await c.execute(approval(b, "TEST-B"), signal(), origin);
    assert.equal(done.process?.status, "succeeded");
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 2],
    ]);
    assert.equal(
      (await c.execute(commandA, signal(), origin)).process?.status,
      "succeeded",
    );
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 2],
    ]);
  }));
test("wrong revision, conversation, operation and namespace are rejected before decision or dispatch", () =>
  isolated(async (h, c) => {
    const { command } = h.setup(h.readWrite());
    const a = await c.execute(command, signal(), origin);
    const decide = approval(a, "TEST-approve");
    for (const changed of [
      { expectedWorkRevision: decide.expectedWorkRevision + 1 },
      { conversationId: "wrong" },
      { operationId: "TEST-foreign" },
    ])
      await assert.rejects(
        c.execute({ ...decide, ...changed }, signal(), origin),
        code("process_approval_conflict"),
      );
    await assert.rejects(
      c.execute(
        {
          ...decide,
          commandId: command.commandId,
          idempotencyKey: command.idempotencyKey,
        },
        signal(),
        origin,
      ),
      code("idempotency_conflict"),
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_resolve_command")
        .get()!.n,
      0,
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.equal(
      (await c.execute(decide, signal(), origin)).process?.status,
      "succeeded",
    );
  }));
test("legal fanout output retains successful metadata and explicitly omits oversized public output", () =>
  isolated(async (h, c) => {
    const keys = Array.from({ length: 20 }, (_, i) => "copy" + i);
    const definition = ProcessDefinitionSchema.parse({
      ...h.basic(),
      entry: "done",
      outputSchema: processObject(
        Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
      ),
      steps: [
        {
          id: "done",
          type: "return",
          output: Object.fromEntries(
            keys.map((k) => [k, { source: "input", path: ["name"] }]),
          ),
        },
      ],
    });
    const { command } = h.setup(definition);
    command.input.name = "x".repeat(4000);
    const result = await c.execute(command, signal(), origin);
    assert.equal(result.process?.status, "succeeded");
    assert.equal(result.process?.outputTruncated, true);
    assert.equal(result.process?.output, undefined);
    assert.deepEqual(await c.read(result.process!.parentRunId), result);
    assert.deepEqual(h.counts(), []);
    assert(
      Buffer.byteLength(
        JSON.stringify(
          h.catalog.turn(
            result.process!.parentRunId,
            scope.workspaceId,
            scope.userId,
          ),
        ),
      ) > 65536,
    );
  }));
test("shared tracker joins exact concurrent process commands and refuses conflicting payloads or a chat permit", () =>
  isolated(async (h, c, tracker) => {
    const { command } = h.setup();
    let release!: () => void;
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    h.onDispatch(async () => {
      entered();
      await hold;
    });
    const first = c.execute(command, signal(), origin);
    await started;
    const second = c.execute(command, signal(), origin);
    await assert.rejects(
      c.execute({ ...command, input: { name: "changed" } }, signal(), origin),
      code("idempotency_conflict"),
    );
    release();
    assert.deepEqual(await first, await second);
    assert.deepEqual(h.counts(), [["GET", 1]]);
    const nextProcess = h.activate(h.basic());
    const nextIntent = h.issue(nextProcess, "TEST-next-menu");
    const next = { command: { ...command, intentId: nextIntent.intentId } };
    next.command.commandId = "TEST-other";
    next.command.idempotencyKey = "TEST-other-key";
    tracker.activeScopes.add(personLane(scope));
    await assert.rejects(
      c.execute(next.command, signal(), origin),
      code("catalog_busy"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    tracker.activeScopes.clear();
  }));

test("explicit interruption between admission and dispatch stays cancelled on exact retry and a fresh coordinator", () =>
  isolated(async (h, c, tracker, resolves) => {
    const { command } = h.setup();
    let stop!: ReturnType<typeof c.interrupt>;
    await assert.rejects(
      c.execute(command, signal(), () => {
        stop = c.interrupt(command);
      }),
    );
    const interrupted = await stop;
    assert.equal(interrupted.status, "settled");
    assert(interrupted.status === "settled");
    assert.equal(interrupted.result.process?.status, "cancelled");
    assert.equal(interrupted.result.process?.revision, 2);
    assert.deepEqual(h.counts(), []);
    const fresh = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      new NativeCommandRequests(),
    );
    for (const adapter of [c, fresh]) {
      assert.deepEqual(
        await adapter.execute(command, signal(), origin),
        interrupted.result,
      );
      assert.equal((await adapter.interrupt(command)).status, "settled");
    }
    assert.deepEqual(h.counts(), []);
    assert.equal(tracker.activeScopes.size, 0);
    await assert.rejects(
      fresh.execute(
        { ...command, input: { name: "changed" } },
        signal(),
        origin,
      ),
      code("idempotency_conflict"),
    );
  }));

test("a bound approval interrupted before resume remains cancelled and cannot later dispatch its write", () =>
  isolated(async (h, c, tracker, resolves) => {
    const { command } = h.setup(h.readWrite());
    const waiting = await c.execute(command, signal(), origin);
    const decision = approval(waiting, "TEST-interrupted-approval");
    const original = resolves.bind.bind(resolves);
    let stop!: ReturnType<typeof c.interrupt>;
    resolves.bind = (...args: Parameters<typeof original>) => {
      const saved = original(...args);
      stop = c.interrupt(decision);
      return saved;
    };
    await assert.rejects(c.execute(decision, signal(), origin));
    resolves.bind = original;
    const cancelled = await stop;
    assert(cancelled.status === "settled");
    assert.equal(cancelled.result.process?.status, "cancelled");
    assert.equal(cancelled.result.process?.approval, undefined);
    assert.deepEqual(
      await c.execute(decision, signal(), origin),
      cancelled.result,
    );
    assert.equal(
      (await c.execute(command, signal(), origin)).process?.status,
      "cancelled",
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.equal(tracker.activeScopes.size, 0);
  }));

test("retirement remains private when read access is revoked and releases the scope for another authorized process", () =>
  isolated(async (h, _c, tracker) => {
    const { command, processId } = h.setup();
    const nextId = h.activate(h.basic());
    const nextIntent = h.issue(nextId, "TEST-new-menu");
    const denied = new Set<string>();
    const starts = new ProcessStartStore(h.db, scope.serverId, h.registry, {
      authorize: (a) => ({ ...a, role: "member" }),
      read: (_, id) => {
        if (denied.has(id)) throw new IdentityError(403, "identity_forbidden");
      },
    });
    const resolves = new ProcessResolveStore(h.db, starts);
    const c = createProcessCoordinator(
      h.controller,
      h.registry,
      starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      tracker,
    );
    h.onServiceResponse(() => {
      denied.add(processId);
    });
    await assert.rejects(
      c.execute(command, signal(), origin),
      code("identity_forbidden"),
    );
    const admitted = h.starts.read(
      admin,
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    assert(admitted.status === "admitted");
    await assert.rejects(
      c.read(admitted.parentRunId),
      code("identity_forbidden"),
    );
    assert.equal(tracker.activeScopes.size, 0);
    h.onServiceResponse(() => {});
    const next = {
      ...command,
      commandId: "TEST-new-start",
      idempotencyKey: "TEST-new-key",
      intentId: nextIntent.intentId,
    };
    assert.equal(
      (await c.execute(next, signal(), origin)).process?.status,
      "succeeded",
    );
    assert.deepEqual(h.counts(), [["GET", 2]]);
  }));

test("unknown stop identifiers and substituted recorded commands never start a process", () =>
  isolated(async (h, c) => {
    const { command } = h.setup();
    assert.equal((await c.interrupt(command)).status, "unknown");
    assert.deepEqual(h.counts(), []);
    const done = await c.execute(command, signal(), origin);
    await assert.rejects(
      c.interrupt({ ...command, input: { name: "changed" } }),
      code("idempotency_conflict"),
    );
    const known = await c.interrupt(command);
    assert(known.status === "settled");
    assert.deepEqual(known.result, done);
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("the ordinary chat approval path refuses both current and historical process operations", () =>
  isolated(async (h, c) => {
    const { createCatalogRuntime } = await import(
      "../apps/server-identity/catalog-runtime"
    );
    const { command } = h.setup(h.readWrite());
    const waiting = await c.execute(command, signal(), origin);
    const operationId = waiting.process!.approval!.operationId;
    const ordinary = createCatalogRuntime(
      h.controller,
      h.controller.transport,
      h.context,
      scope,
      admin.organizationId,
    );
    for (const linked of [true, false]) {
      if (!linked)
        h.db
          .prepare(
            "DELETE FROM agent_service_turn_operation WHERE operation_id=?",
          )
          .run(operationId);
      assert.equal(
        h.catalog.turnForOperation(operationId, scope.workspaceId, scope.userId)
          ?.id,
        waiting.process!.parentRunId,
      );
      await assert.rejects(
        ordinary.resolve(operationId, true, "en", signal()),
        code("process_command_required"),
      );
      await assert.rejects(
        ordinary.resolve(operationId, false, "en", signal()),
        code("process_command_required"),
      );
      assert.equal(
        h.catalog.invocation(operationId, scope.workspaceId, scope.userId)
          ?.status,
        "awaiting_approval",
      );
      assert.deepEqual(h.counts(), [["GET", 1]]);
    }
    assert.equal(
      (
        await c.execute(
          approval(waiting, "TEST-native-approve"),
          signal(),
          origin,
        )
      ).process?.status,
      "succeeded",
    );
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  }));

test("queued interruption cannot miss registration during the first authorization await", () =>
  isolated(async (h, c) => {
    const { command } = h.setup();
    const original = h.context.actor;
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => {
      entered = r;
    });
    const hold = new Promise<void>((r) => {
      release = r;
    });
    let first = true;
    h.context.actor = async (target) => {
      if (first) {
        first = false;
        entered();
        await hold;
      }
      return original(target);
    };
    const pending = c.execute(command, signal(), origin);
    const rejected = assert.rejects(pending);
    await started;
    const stop = c.interrupt(command);
    release();
    await rejected;
    assert.equal((await stop).status, "unknown");
    await assert.rejects(
      c.execute(command, signal(), origin),
      code("process_command_cancelled"),
    );
    assert.equal(
      h.db
        .prepare("SELECT count(*) AS n FROM agent_process_start_command")
        .get()!.n,
      0,
    );
    assert.deepEqual(h.counts(), []);
  }));

test("unknown write outcome remains canonical and exact retries or interruption never resend", () =>
  isolated(async (h, c) => {
    const { command } = h.setup(h.readWrite());
    const waiting = await c.execute(command, signal(), origin);
    const decide = approval(waiting, "TEST-uncertain-write");
    h.setMode("unknown");
    const unknown = await c.execute(decide, signal(), origin);
    assert.equal(unknown.process?.status, "unknown");
    assert.equal(
      unknown.process?.failure?.operationId,
      waiting.process!.approval!.operationId,
    );
    assert.deepEqual(await c.execute(decide, signal(), origin), unknown);
    const stopped = await c.interrupt(decide);
    assert(stopped.status === "settled");
    assert.deepEqual(stopped.result, unknown);
    assert.deepEqual(await c.execute(decide, signal(), origin), unknown);
    assert.equal(
      (await c.execute(command, signal(), origin)).process?.status,
      "unknown",
    );
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
  }));

test("the admission deadline survives human waiting and the approval cannot restart its clock", () =>
  isolated(async (h, c) => {
    const initial = h.readWrite();
    const { command } = h.setup(
      ProcessDefinitionSchema.parse({
        ...initial,
        limits: { ...initial.limits, maxDurationMs: 1500 },
      }),
    );
    const waiting = await c.execute(command, signal(), origin);
    assert.equal(waiting.process?.status, "waiting");
    const decision = approval(waiting, "TEST-late-approval");
    await new Promise((r) => setTimeout(r, 1600));
    await assert.rejects(c.execute(decision, signal(), origin));
    const failed = await c.execute(command, signal(), origin);
    assert.equal(failed.process?.status, "failed");
    assert.equal(failed.process?.failure?.code, "process_duration_exceeded");
    assert.equal(
      (await c.execute(decision, signal(), origin)).process?.failure?.code,
      "process_duration_exceeded",
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("current actor and changed catalog source are checked before a recorded decision resumes", () =>
  isolated(async (h, c) => {
    const { command } = h.setup(h.readWrite());
    const waiting = await c.execute(command, signal(), origin);
    const decision = approval(waiting, "TEST-revoked-approval");
    h.db
      .prepare("UPDATE agent_catalog SET revision=revision+1 WHERE id=?")
      .run(h.ids.readId);
    await assert.rejects(
      c.execute(decision, signal(), origin),
      code("process_sources_changed"),
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
    h.switchActor();
    await assert.rejects(
      c.execute(decision, signal(), origin),
      code("identity_forbidden"),
    );
    await assert.rejects(
      c.read(waiting.process!.parentRunId),
      code("identity_forbidden"),
    );
    await assert.rejects(c.interrupt(decision), code("identity_forbidden"));
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("fresh credentials retire an old failed delivery before exact retry without another dispatch", () =>
  isolated(async (h, _c, tracker, resolves) => {
    const { command } = h.setup();
    let valid = true;
    let proofAvailable = true;
    const prove = h.starts.retirementProof.bind(h.starts);
    h.starts.retirementProof = (...args: Parameters<typeof prove>) => {
      if (!proofAvailable)
        throw new IdentityError(503, "TEST-proof-unavailable");
      return prove(...args);
    };
    const oldContext = {
      ...h.context,
      validateRequest: () => {
        if (!valid) throw new IdentityError(401, "auth_expired");
      },
    };
    const old = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      oldContext,
      scope,
      admin.organizationId,
      tracker,
    );
    h.onServiceResponse(() => {
      valid = false;
      proofAvailable = false;
    });
    await assert.rejects(
      old.execute(command, signal(), origin),
      code("auth_expired"),
    );
    assert.equal(tracker.activeScopes.size, 1);
    proofAvailable = true;
    const original = h.starts.read(
      admin,
      scope,
      command.commandId,
      command.idempotencyKey,
    );
    assert(original.status === "admitted");
    const fresh = createProcessCoordinator(
      h.controller,
      h.registry,
      h.starts,
      resolves,
      h.context,
      scope,
      admin.organizationId,
      tracker,
    );
    assert.equal(
      (await fresh.read(original.parentRunId)).process?.status,
      "failed",
    );
    const retried = await Promise.all([
      fresh.execute(command, signal(), origin),
      fresh.execute(command, signal(), origin),
    ]);
    assert.equal(retried[0].process?.status, "failed");
    assert.deepEqual(retried[0], retried[1]);
    assert.equal(tracker.activeScopes.size, 0);
    assert.equal(Array.from(tracker.values()).length, 0);
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("saved-memory revocation blocks native agent approval through the coordinator before hydration", () =>
  isolated(async (h, c) => {
    const note = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-coordinator-memory",
      content: "TEST preference",
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    const { command } = h.setup(processAgent(h, "saved"));
    h.onModel(() => callProcessTool());
    const waiting = await c.execute(command, signal(), origin);
    assert.equal(waiting.process?.status, "waiting");
    assert.equal(h.models().length, 1);
    await h.memoryStore.forget(h.memoryActor, {
      requestId: "TEST-coordinator-forget",
      id: note.id,
      revision: note.revision,
    });
    await assert.rejects(
      c.execute(approval(waiting, "TEST-forgotten-approval"), signal(), origin),
      code("memory_context_changed"),
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("changed budget blocks an approved agent decision and its durable binding cannot be substituted", () =>
  isolated(async (h, c) => {
    const { command } = h.setup(processAgent(h));
    h.onModel(() => callProcessTool());
    const waiting = await c.execute(command, signal(), origin);
    const policy = h.catalog.inferenceBudget.policy(
      admin.organizationId,
      scope.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      scope.workspaceId,
      policy.revision,
      { ...policy.settings, mode: "observe", prices: [] },
    );
    await assert.rejects(
      c.execute(approval(waiting, "TEST-budget-approve"), signal(), origin),
      code("process_budget_policy_required"),
    );
    // An accepted immutable approval cannot change to rejection under the same operation.
    await assert.rejects(
      c.execute(
        approval(waiting, "TEST-budget-substitute", false),
        signal(),
        origin,
      ),
      code("process_approval_conflict"),
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("a first explicit decline after a budget change cancels without hydration or a write", () =>
  isolated(async (h, c) => {
    const { command } = h.setup(processAgent(h));
    h.onModel(() => callProcessTool());
    const waiting = await c.execute(command, signal(), origin);
    const policy = h.catalog.inferenceBudget.policy(
      admin.organizationId,
      scope.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      admin.organizationId,
      scope.workspaceId,
      policy.revision,
      { ...policy.settings, mode: "observe", prices: [] },
    );
    const declined = await c.execute(
      approval(waiting, "TEST-budget-decline", false),
      signal(),
      origin,
    );
    assert.equal(declined.process?.status, "cancelled");
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      (await c.execute(command, signal(), origin)).process?.status,
      "cancelled",
    );
  }));

test("abandoned revoked connections release global permits when owned native proof becomes available", () =>
  isolated(async (h, c, tracker, resolves) => {
    const { command, processId } = h.setup();
    const artifact = h.registry.version(admin, processId, 1);
    let proofAvailable = false;
    const prove = h.starts.retirementProof.bind(h.starts);
    h.starts.retirementProof = (...args: Parameters<typeof prove>) => {
      if (!proofAvailable)
        throw new IdentityError(503, "TEST-proof-unavailable");
      return prove(...args);
    };
    for (let i = 0; i < 2; i++) {
      const oldScope = { ...scope, connectionId: "TEST-abandoned-" + i };
      const requestId = "TEST-abandoned-origin-" + i;
      const intent = h.starts.issue(
        admin,
        oldScope,
        {
          origin: {
            type: "command",
            conversationId: command.conversationId,
            requestId,
          },
          processId,
          version: artifact.version,
          artifactDigest: artifact.digest,
          formDigest: artifact.digest,
          fields: {},
        },
        origin,
      );
      let valid = true;
      const context = {
        ...h.context,
        validateRequest: () => {
          if (!valid) throw new IdentityError(401, "auth_expired");
        },
      };
      const old = createProcessCoordinator(
        h.controller,
        h.registry,
        h.starts,
        resolves,
        context,
        oldScope,
        admin.organizationId,
        tracker,
      );
      h.onServiceResponse(() => {
        valid = false;
      });
      await assert.rejects(
        old.execute(
          {
            ...command,
            intentId: intent.intentId,
            commandId: requestId,
            idempotencyKey: requestId + "-key",
          },
          signal(),
          origin,
        ),
        // The lane is per person: their other credential waits for the
        // unsettled run instead of taking a second global slot.
        code(i === 0 ? "auth_expired" : "catalog_busy"),
      );
    }
    assert.equal(tracker.activeScopes.size, 1);
    proofAvailable = true;
    h.onServiceResponse(() => {});
    assert.equal(
      (await c.execute(command, signal(), origin)).process?.status,
      "succeeded",
    );
    assert.equal(tracker.activeScopes.size, 0);
    assert.equal(Array.from(tracker.values()).length, 0);
    assert.deepEqual(h.counts(), [["GET", 2]]);
  }));

test("a suspended checkpoint cannot retire a failed persistence tail until native memory settles", () =>
  isolated(async (h, c, tracker) => {
    const require = createRequire(
      join(process.cwd(), "apps/server-agent/package.json"),
    );
    const { Memory } = await import(
      require.resolve("@mastra/memory").replace(/\.cjs$/, ".js")
    );
    const settled = Memory.prototype.settled;
    const { command } = h.setup(processAgent(h));
    h.onModel(() => callProcessTool());
    Memory.prototype.settled = async () => {
      throw Error("TEST-persistence-tail");
    };
    try {
      const failed = await c.execute(command, signal(), origin);
      assert.equal(failed.process?.status, "failed");
      const admission = h.starts.read(
        admin,
        scope,
        command.commandId,
        command.idempotencyKey,
      );
      assert(admission.status === "admitted");
      const j = h.catalog.turn(
        admission.parentRunId,
        scope.workspaceId,
        scope.userId,
      ) as { agents: Record<string, { runId: string }> };
      const owner = await nativeCatalogOwner(h.controller);
      const child = Object.values(j.agents)[0];
      assert(child);
      assert.equal(owner.isSettled(child.runId), false);
      await assert.rejects(
        c.retired(admission.parentRunId),
        /TEST-persistence-tail/,
      );
      await tracker.retireOwned();
      assert.equal(tracker.activeScopes.size, 1);
      Memory.prototype.settled = settled;
      assert.equal(await c.retired(admission.parentRunId), true);
      assert.equal(owner.isSettled(child.runId), true);
      assert.equal(
        (await c.execute(command, signal(), origin)).process?.status,
        "failed",
      );
      assert.equal(tracker.activeScopes.size, 0);
      assert.equal(h.models().length, 1);
      assert.deepEqual(h.counts(), []);
    } finally {
      Memory.prototype.settled = settled;
    }
  }));

test("one person's web and app credentials share one lane per kind", () => {
  const web = { ...scope, connectionId: "TEST-web" };
  const app = { ...scope, connectionId: "TEST-app" };
  assert.equal(personLane(web), personLane(app));
  assert.equal(personLane(web, "hub"), personLane(app, "hub"));
  assert.notEqual(personLane(web), personLane(web, "hub"));
  assert.notEqual(
    personLane(web),
    personLane({ ...web, userId: "TEST-other" }),
  );
  const tracker = new NativeCommandRequests();
  const owner = {
    scope: web,
    profile: "process" as const,
    command: { commandId: "TEST-c", idempotencyKey: "TEST-k" },
    controller: new AbortController(),
    promise: Promise.resolve(),
    unsettled: true,
  };
  tracker.acquireScope(personLane(web, "hub"), owner);
  assert.throws(
    () => tracker.acquireScope(personLane(app, "hub"), undefined),
    code("catalog_busy"),
  );
  tracker.releaseOwner(owner);
  assert.equal(tracker.activeScopes.size, 0);
});
