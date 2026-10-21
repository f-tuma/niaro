import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  ClientSession,
  commandTarget,
  type ClientSessionOptions,
} from "../packages/client-core/session";
import {
  captureProcessStartTarget,
  captureProcessResolveTarget,
  processStartCommand,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import { processCommandDigest } from "../packages/client-core/process-command-digest";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import {
  PROCESS_EXECUTION_PROFILE,
  type ProcessInputForm,
} from "../packages/protocol/process-execution";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../packages/protocol/process-questions";
import { WorkItemSchema, type Snapshot } from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";
import { authInfo, credential } from "./auth-fixtures";

const address = "https://fixture/v1/a";
const response = (value: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
function gate<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
function work(operation = "TEST-operation-A", revision = 7) {
  return WorkItemSchema.parse({
    id: "TEST-parent",
    revision: revision + 100,
    conversationId: "conversation-1",
    title: "TEST process approval",
    context: "TEST waiting",
    status: "waiting_approval",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
    native: {
      runId: "TEST-parent",
      revision,
      process: {
        kind: "service-process-1",
        status: "waiting",
        journalStatus: "waiting",
        detailsAvailable: true,
        approval: {
          nodeId:
            operation === "TEST-operation-A" ? "TEST-node-A" : "TEST-node-B",
          serviceId: "TEST-service",
          serviceRevision: 1,
          actionId: "TEST-action",
          actionRevision: 2,
          result: {
            type: "service.action",
            version: 1,
            operationId: operation,
            title: "TEST write",
            service: "TEST service",
            effect: "write",
            status: "awaiting_approval",
            fields: [],
            inputJson: JSON.stringify({
              value: operation,
              enabled: false,
              amount: 0,
            }),
            reviewTruncated: true,
            summary: "TEST summary",
          },
        },
        provenance: {
          runId: "TEST-run",
          processId: "TEST-process",
          version: 1,
          artifactDigest: "a".repeat(64),
          actorId: credential().scope.userId,
          conversationId: "conversation-1",
          commandId: "TEST-start",
          admissionId: "TEST-admission",
        },
        receipts: [
          {
            operationId: operation,
            title: "TEST write",
            service: "TEST service",
            effect: "write",
            status: "awaiting_approval",
            summary: "TEST summary",
          },
        ],
      },
    },
  });
}
function fixture(options: ClientSessionOptions = { processQuestions: true }) {
  const engine = new FixtureEngine();
  let snapshot: Snapshot = { ...engine.snapshot(), workItems: [work()] };
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const form: ProcessInputForm = {
    profile: "agent-process-input/1",
    scope: credential().scope,
    language: "cs",
    processId: "TEST-process",
    version: 1,
    artifactDigest: "a".repeat(64),
    name: "TEST process",
    description: "TEST description",
    kind: "workflow",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    },
    origin: {
      type: "command",
      conversationId: "conversation-1",
      requestId: "TEST-menu",
    },
  };
  const card = {
    form,
    formDigest: processCommandDigest(form),
    intent: {
      intentId: "TEST-intent",
      origin: form.origin,
      processId: form.processId,
      version: form.version,
      artifactDigest: form.artifactDigest,
      formDigest: processCommandDigest(form),
      inputSchema: form.inputSchema,
      fields: {},
      createdAt: "2026-10-06T00:00:00.000Z",
    },
  };
  const startTarget = captureProcessStartTarget(
    address,
    credential().scope,
    {
      availability: "ready",
      processId: form.processId,
      version: form.version,
      artifactDigest: form.artifactDigest,
      kind: form.kind,
      name: form.name,
      description: form.description,
      inputSchema: form.inputSchema,
    },
    card,
  );
  const start = processStartCommand(startTarget, {
    commandId: "TEST-start",
    idempotencyKey: "TEST-start-key",
    input: { name: "  TEST exact input\n" },
    language: "cs",
  });
  const supportsQuestions =
    options.processQuestions || options.processApprovals;
  const profile = supportsQuestions
    ? PROCESS_QUESTION_EXECUTION_PROFILE
    : PROCESS_EXECUTION_PROFILE;
  const runtime = (command = start) =>
    ProcessRuntimeResponseSchema.parse({
      profile,
      scope: credential().scope,
      commandId: command.commandId,
      admission: {
        profile: "agent-process-start/1",
        status: "admitted",
        receiptId: "TEST-admission",
        intentId: start.intentId,
        commandId: start.commandId,
        idempotencyKey: start.idempotencyKey,
        commandDigest: processCommandDigest(start),
        origin: form.origin,
        processId: form.processId,
        version: form.version,
        artifactDigest: form.artifactDigest,
        formDigest: card.formDigest,
        input: start.input,
        inputDigest: processCommandDigest(start.input),
        compilerVersion: supportsQuestions
          ? "niaro-native-workflow/3"
          : "niaro-native-workflow/2",
        runId: "TEST-run",
        parentRunId: "TEST-parent",
        createdAt: "2026-10-06T00:00:00.000Z",
      },
      process: {
        parentRunId: "TEST-parent",
        runId: "TEST-run",
        processId: form.processId,
        version: form.version,
        revision: 8,
        status: "waiting",
        approval: { nodeId: "writeB", operationId: "TEST-operation-B" },
      },
    });
  const started = gate<void>();
  const interruptStarted = gate<void>();
  const handlers = {
    send: async (command: typeof start) => response(runtime(command), 202),
    interrupt: async (command: typeof start) =>
      response({
        profile,
        scope: credential().scope,
        commandId: command.commandId,
        status: "settled",
        result: runtime(command),
      }),
    read: async () => response(snapshot),
  };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      const path = new URL(String(url));
      if (path.pathname.endsWith("/auth/session")) return response(authInfo());
      if (path.pathname.endsWith("/processes/commands/interrupt")) {
        interruptStarted.resolve();
        return handlers.interrupt(JSON.parse(String(init?.body)).command);
      }
      if (path.pathname.endsWith("/processes/commands")) {
        started.resolve();
        return handlers.send(JSON.parse(String(init?.body)));
      }
      if (init?.method === "POST")
        return response(engine.execute(JSON.parse(String(init.body))));
      if (path.pathname.endsWith("/events"))
        return response(engine.events(Number(path.searchParams.get("after"))));
      return handlers.read();
    },
  );
  const open = (opts = options) =>
    new ClientSession(
      address,
      storage,
      credential(),
      transport,
      undefined,
      undefined,
      false,
      opts,
    );
  const session = open();
  const pendingKey = `agent-client.command.v2:${session.identityKey}`;
  const attemptsKey = `agent-client.process-answer-attempts.v1:${session.identityKey}`;
  const resolve = () => {
    const store = session.getSnapshot().store!;
    const target = captureProcessResolveTarget(store, "TEST-parent");
    return {
      target,
      command: processResolveCommand(store, target, {
        commandId: "TEST-resolve-A",
        idempotencyKey: "TEST-resolve-A-key",
        approved: true,
        language: "cs",
      }),
    };
  };
  const posts = () =>
    transport.mock.calls.filter(([, init]) => init?.method === "POST");
  const seedAnswers = (outcome?: "accepted" | "unknown") => {
    let attempts: unknown[] = [];
    if (outcome) {
      const question = work();
      question.status = "waiting_input";
      question.native!.process!.receipts = [];
      delete question.native!.process!.approval;
      question.native!.process!.journalRevision = 7;
      question.native!.process!.question = {
        nodeId: "agent",
        childRunId: "TEST-child",
        toolCallId: "TEST-call",
        questionId: "TEST-question",
        questionRevision: 1,
        question: "TEST saved question?",
      };
      const store = {
        ...session.getSnapshot().store!,
        workItems: { "TEST-parent": question },
      };
      const target = captureProcessAnswerTarget(store, "TEST-parent");
      const command = processAnswerCommand(store, target, {
        commandId: "TEST-saved-answer",
        idempotencyKey: "TEST-saved-answer-key",
        answer: "  TEST saved text\n",
        language: "cs",
      });
      attempts = [{ target, command, outcome, error: null }];
    }
    cache.set(
      attemptsKey,
      JSON.stringify({
        version: 1,
        connectionKey: address,
        scope: credential().scope,
        attempts,
        pendingCommandId: outcome === "unknown" ? "TEST-saved-answer" : null,
      }),
    );
  };
  return {
    session,
    open,
    storage,
    cache,
    start,
    startTarget,
    resolve,
    runtime,
    handlers,
    started,
    interruptStarted,
    transport,
    posts,
    pendingKey,
    seedAnswers,
    next: () => {
      snapshot = { ...snapshot, workItems: [work("TEST-operation-B", 8)] };
    },
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each([{ processExecution: true }, { processQuestions: true }])(
  "start has explicit transport profile and immutable legacy body: %j",
  async (opts) => {
    const f = fixture(opts);
    const delivered = gate<Response>();
    const refreshed = gate<Response>();
    f.handlers.send = async () => delivered.promise;
    try {
      await f.session.start(false);
      const command = JSON.parse(JSON.stringify(f.start));
      const target = JSON.parse(JSON.stringify(f.startTarget));
      const sending = f.session.send(command, false, target);
      command.input.name = "TEST caller changed";
      target.card.intent.version = 2;
      await f.started.promise;
      const [url, init] = f.posts()[0]!;
      expect(new URL(String(url)).searchParams.get("profile")).toBe(
        opts.processQuestions
          ? PROCESS_QUESTION_EXECUTION_PROFILE
          : PROCESS_EXECUTION_PROFILE,
      );
      expect(new URL(String(url)).searchParams.has("tasks")).toBe(false);
      expect(String(init?.body)).toBe(JSON.stringify(f.start));
      const pending = JSON.parse(f.cache.get(f.pendingKey)!);
      expect(pending.serializedCommand).toBe(init?.body);
      expect(pending.target).toEqual(f.startTarget);
      f.handlers.read = async () => refreshed.promise;
      delivered.resolve(response(f.runtime(), 200));
      await sending;
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().store?.stale).toBe(true);
      expect(
        f.session.getSnapshot().store?.workItems["TEST-parent"]?.status,
      ).toBe("waiting_approval");
      expect(f.session.getSnapshot().commandStates[f.start.intentId]).toBe(
        "accepted",
      );
      expect(f.cache.get(f.pendingKey)).toBe("null");
    } finally {
      f.session.stop();
      refreshed.resolve(response(new FixtureEngine().snapshot()));
    }
  },
);

test("profile-free resolve remains ordinary and process execution requires opt-in and proof", async () => {
  const f = fixture({});
  try {
    await f.session.start(false);
    await expect(f.session.send(f.start, false, f.startTarget)).rejects.toThrow(
      "process_profile_unsupported",
    );
    const { command } = f.resolve();
    const { profile: _profile, ...ordinary } = command;
    await f.session.send(ordinary);
    expect(String(f.posts()[0]![0])).toContain("/commands?");
    expect(String(f.posts()[0]![0])).not.toContain("/processes/");
  } finally {
    f.session.stop();
  }
  const enabled = fixture();
  try {
    await enabled.session.start(false);
    await expect(enabled.session.send(enabled.start)).rejects.toThrow(
      "process_command_changed",
    );
    expect(enabled.posts()).toHaveLength(0);
  } finally {
    enabled.session.stop();
  }
});

test("resolve uses journal generation and its response can expose B without approving B", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    const { command, target } = f.resolve();
    expect(command.expectedWorkRevision).toBe(7);
    await f.session.send(command, false, target);
    expect(JSON.parse(String(f.posts()[0]![1]?.body)).profile).toBe(
      PROCESS_EXECUTION_PROFILE,
    );
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates[command.operationId]).toBe(
      "accepted",
    );
    expect(f.posts()).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test("approval opt-in negotiates work/3 and the existing question-aware execution transport", async () => {
  const f = fixture({ processApprovals: true });
  try {
    await f.session.start(false);
    const reads = f.transport.mock.calls.filter(([url]) =>
      new URL(String(url)).pathname.endsWith("/snapshot"),
    );
    expect(reads.length).toBeGreaterThan(0);
    expect(
      reads.every(
        ([url]) =>
          new URL(String(url)).searchParams.get("tasks") ===
          "agent-process-work/3",
      ),
    ).toBe(true);
    const { command, target } = f.resolve();
    await f.session.send(command, false, target);
    expect(new URL(String(f.posts()[0]![0])).searchParams.get("profile")).toBe(
      PROCESS_QUESTION_EXECUTION_PROFILE,
    );
    expect(f.session.getSnapshot().commandStates[command.operationId]).toBe(
      "accepted",
    );
  } finally {
    f.session.stop();
  }
});

test("a historical saved approval without the new review still retries A exactly while B is current", async () => {
  const f = fixture({ processApprovals: true });
  let reopened: ClientSession | undefined;
  try {
    await f.session.start(false);
    const pair = f.resolve();
    f.handlers.send = async () => {
      throw Error("TEST lost original acknowledgement");
    };
    await f.session.send(pair.command, false, pair.target);
    const saved = JSON.parse(f.cache.get(f.pendingKey)!);
    delete saved.target.approval;
    f.cache.set(f.pendingKey, JSON.stringify(saved));
    const original = String(f.posts()[0]![1]?.body);
    f.session.stop();
    f.next();
    reopened = f.open();
    await reopened.start(false);
    await reopened.sync();
    expect(reopened.getSnapshot().pending).toEqual(pair.command);
    expect(f.posts()).toHaveLength(1);
    f.handlers.send = async (command) => response(f.runtime(command), 202);
    await reopened.retry();
    expect(f.posts()).toHaveLength(2);
    expect(String(f.posts()[1]![1]?.body)).toBe(original);
    expect(reopened.getSnapshot().pending).toBeNull();
  } finally {
    reopened?.stop();
    f.session.stop();
  }
});

test("valid HTTP 422 rejected admission settles delivery with its frozen receipt", async () => {
  const f = fixture();
  f.handlers.send = async () => {
    const admitted = f.runtime().admission;
    const rejected = {
      profile: f.runtime().profile,
      scope: credential().scope,
      commandId: f.start.commandId,
      admission: {
        profile: admitted.profile,
        status: "rejected",
        receiptId: admitted.receiptId,
        intentId: admitted.intentId,
        commandId: admitted.commandId,
        idempotencyKey: admitted.idempotencyKey,
        commandDigest: admitted.commandDigest,
        origin: admitted.origin,
        processId: admitted.processId,
        version: admitted.version,
        artifactDigest: admitted.artifactDigest,
        formDigest: admitted.formDigest,
        createdAt: admitted.createdAt,
        reason: "process_active_version_changed",
      },
    };
    return response(rejected, 422);
  };
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates[f.start.intentId]).toBe(
      "rejected",
    );
    expect(f.session.getSnapshot().error).toBe(
      "process_active_version_changed",
    );
    expect(f.cache.get(f.pendingKey)).toBe("null");
  } finally {
    f.session.stop();
  }
});

test.each(["start", "resolve"] as const)(
  "%s lost delivery restores exact proof and bytes, waits for explicit retry, and ignores B",
  async (kind) => {
    const f = fixture();
    let reopened: ClientSession | undefined;
    try {
      await f.session.start(false);
      const pair =
        kind === "start"
          ? { command: f.start, target: f.startTarget }
          : f.resolve();
      f.handlers.send = async () => {
        throw Error("TEST response lost after delivery");
      };
      await f.session.send(pair.command, false, pair.target);
      const serialized = f.cache.get(f.pendingKey)!;
      const body = String(f.posts()[0]![1]?.body);
      f.session.stop();
      f.next();
      reopened = f.open();
      await reopened.start(false);
      await reopened.sync();
      expect(f.posts()).toHaveLength(1);
      expect(f.cache.get(f.pendingKey)).toBe(serialized);
      expect(reopened.getSnapshot().pending).toEqual(pair.command);
      f.handlers.send = async (command) => response(f.runtime(command), 202);
      await reopened.retry();
      expect(f.posts()).toHaveLength(2);
      expect(String(f.posts()[1]![1]?.body)).toBe(body);
      expect(reopened.getSnapshot().pending).toBeNull();
    } finally {
      f.session.stop();
      reopened?.stop();
    }
  },
);

test.each([
  "wrong_scope",
  "wrong_command",
  "wrong_profile",
  "wrong_intent",
  "wrong_form",
  "wrong_input",
  "wrong_parent",
  "error_json",
  "malformed",
])("%s cannot retire the frozen pending start", async (damage) => {
  const f = fixture();
  f.handlers.send = async () => {
    const value = JSON.parse(JSON.stringify(f.runtime()));
    if (damage === "wrong_scope") value.scope.userId = "TEST-other";
    if (damage === "wrong_command") value.commandId = "TEST-other";
    if (damage === "wrong_profile") value.profile = PROCESS_EXECUTION_PROFILE;
    if (damage === "wrong_intent") value.admission.intentId = "TEST-other";
    if (damage === "wrong_form") value.admission.formDigest = "f".repeat(64);
    if (damage === "wrong_input") value.admission.input.name = "TEST-other";
    if (damage === "wrong_parent") value.process.parentRunId = "TEST-other";
    if (damage === "error_json")
      return response({ error: "process_unrecognized_result" }, 422);
    if (damage === "malformed") return response({ profile: "broken" });
    return response(value);
  };
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    expect(f.session.getSnapshot().pending).toEqual(f.start);
    expect(f.session.getSnapshot().commandStates[f.start.intentId]).toBe(
      "network_error",
    );
    const saved = JSON.parse(f.cache.get(f.pendingKey)!);
    expect(saved.outcome).toBe("unknown");
    expect(saved.serializedCommand).toBe(JSON.stringify(f.start));
    expect(saved.target).toEqual(f.startTarget);
  } finally {
    f.session.stop();
  }
});

test.each(["known_marker", "clear"])(
  "%s storage failure preserves acknowledged ownership and Retry never posts again",
  async (failure) => {
    const f = fixture();
    const write = f.storage.setItem;
    let failing = true;
    f.storage.setItem = async (key, value) => {
      if (
        failing &&
        key === f.pendingKey &&
        (failure === "clear"
          ? value === "null"
          : value !== "null" && JSON.parse(value).outcome === "accepted")
      )
        throw Error("TEST failed local acknowledgement persistence");
      await write(key, value);
    };
    try {
      await f.session.start(false);
      await f.session.send(f.start, false, f.startTarget);
      expect(f.session.getSnapshot().pending).toEqual(f.start);
      expect(f.session.getSnapshot().commandStates[f.start.intentId]).toBe(
        "accepted",
      );
      expect(f.session.getSnapshot().error).toBe("storage_error");
      if (failure === "clear") {
        const durable = JSON.parse(f.cache.get(f.pendingKey)!);
        expect(durable.outcome).toBe("accepted");
      }
      await f.session.refresh();
      expect(f.session.getSnapshot().store?.stale).toBe(false);
      failing = false;
      await f.session.retry();
      expect(f.posts()).toHaveLength(1);
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.cache.get(f.pendingKey)).toBe("null");
      expect(f.session.getSnapshot().error).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test("storage-only retry preserves a real native failure after a fresh projection", async () => {
  const f = fixture();
  const write = f.storage.setItem;
  f.handlers.send = async () => {
    const result = f.runtime();
    result.process = {
      ...result.process!,
      status: "failed",
      failure: { code: "process_node_failed" },
    };
    return response(result, 202);
  };
  f.storage.setItem = async (key, value) => {
    if (key === f.pendingKey && value === "null")
      throw Error("TEST clear failed");
    await write(key, value);
  };
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    await f.session.refresh();
    expect(f.session.getSnapshot().error).toBe("process_node_failed");
    f.storage.setItem = write;
    await f.session.retry();
    expect(f.posts()).toHaveLength(1);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().error).toBe("process_node_failed");
  } finally {
    f.session.stop();
  }
});

test.each([false, true])(
  "valid empty native failure diagnostic acknowledges start; failed known persistence=%s never resends",
  async (failStorage) => {
    const f = fixture();
    f.handlers.send = async () => {
      const result = f.runtime();
      result.process = {
        ...result.process!,
        status: "failed",
        failure: { code: "" },
      };
      expect(ProcessRuntimeResponseSchema.safeParse(result).success).toBe(true);
      return response(result, 202);
    };
    const write = f.storage.setItem;
    if (failStorage)
      f.storage.setItem = async (key, value) => {
        if (
          key === f.pendingKey &&
          value !== "null" &&
          JSON.parse(value).outcome === "accepted"
        )
          throw Error("TEST failed known-marker persistence");
        await write(key, value);
      };
    try {
      await f.session.start(false);
      await f.session.send(f.start, false, f.startTarget);
      expect(f.session.getSnapshot().commandStates[f.start.intentId]).toBe(
        "accepted",
      );
      expect(f.session.getSnapshot().error).toBe(
        failStorage ? "storage_error" : null,
      );
      f.storage.setItem = write;
      await f.session.retry();
      expect(f.posts()).toHaveLength(1);
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().error).toBeNull();
      expect(f.cache.get(f.pendingKey)).toBe("null");
    } finally {
      f.session.stop();
    }
  },
);

test.each([false, true])(
  "valid empty native failure diagnostic acknowledges saved answer; failed known persistence=%s never resends",
  async (failStorage) => {
    const f = fixture();
    let reopened: ClientSession | undefined;
    f.handlers.send = async (command) => {
      const result = f.runtime(command);
      result.process = {
        ...result.process!,
        status: "failed",
        failure: { code: "" },
      };
      return response(result, 202);
    };
    const write = f.storage.setItem;
    try {
      await f.session.start(false);
      f.seedAnswers("unknown");
      f.session.stop();
      if (failStorage)
        f.storage.setItem = async (key, value) => {
          if (
            key.includes("process-answer-attempts") &&
            JSON.parse(value).attempts.some(
              (attempt: { outcome: string }) => attempt.outcome === "accepted",
            )
          )
            throw Error("TEST failed known-answer persistence");
          await write(key, value);
        };
      reopened = f.open();
      await reopened.start(false);
      await reopened.retry();
      const attempt = reopened.getSnapshot().answerAttempts[0]!;
      expect(attempt.outcome).toBe("accepted");
      expect(attempt.error).toBeNull();
      expect(
        reopened.getSnapshot().commandStates[commandTarget(attempt.command)],
      ).toBe("accepted");
      f.storage.setItem = write;
      await reopened.retry();
      expect(f.posts()).toHaveLength(1);
      expect(reopened.getSnapshot().pending).toBeNull();
      expect(reopened.getSnapshot().answerAttempts[0]?.outcome).toBe(
        "accepted",
      );
    } finally {
      f.session.stop();
      reopened?.stop();
    }
  },
);

test("exact readback recognizes a known marker committed before storage rejects", async () => {
  const f = fixture();
  const write = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    await write(key, value);
    if (
      key === f.pendingKey &&
      value !== "null" &&
      JSON.parse(value).outcome === "accepted"
    )
      throw Error("TEST adapter rejected after commit");
  };
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.cache.get(f.pendingKey)).toBe("null");
    expect(f.posts()).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test("concurrent known retries share one local persistence tail and cannot erase D", async () => {
  const f = fixture();
  const write = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key === f.pendingKey && value === "null")
      throw Error("TEST initial clear failed");
    await write(key, value);
  };
  const saving = gate<void>();
  let writes = 0;
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    f.storage.setItem = async (key, value) => {
      if (
        key === f.pendingKey &&
        value !== "null" &&
        JSON.parse(value).outcome === "accepted"
      ) {
        writes++;
        await saving.promise;
      }
      await write(key, value);
    };
    const first = f.session.retry();
    expect(f.session.retry()).toBe(first);
    await flush();
    expect(writes).toBe(1);
    saving.resolve();
    await first;
    const next = messageCommand("TEST D", "en", "TEST-D");
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && !String(url).includes("/processes/"))
        throw Error("TEST D response lost");
      return original(url, init);
    });
    await f.session.send(next);
    await flush();
    expect(f.cache.get(f.pendingKey)).toBe(JSON.stringify(next));
    expect(f.session.getSnapshot().pending).toEqual(next);
    expect(f.session.getSnapshot().processNotice).toBeNull();
  } finally {
    saving.resolve();
    f.session.stop();
  }
});

test("failed uncertain retry rewrite retains original proof and does not post", async () => {
  const f = fixture();
  f.handlers.send = async () => {
    throw Error("TEST original response lost");
  };
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    const exact = f.cache.get(f.pendingKey);
    const write = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (key === f.pendingKey) throw Error("TEST rewrite unavailable");
      await write(key, value);
    };
    await f.session.retry();
    expect(f.posts()).toHaveLength(1);
    expect(f.cache.get(f.pendingKey)).toBe(exact);
    expect(f.session.getSnapshot().pending).toEqual(f.start);
    expect(f.session.getSnapshot().error).toBe("storage_error");
  } finally {
    f.session.stop();
  }
});

test("Retry during initial acknowledgement cleanup shares its tail and cannot clear listener-created D", async () => {
  const f = fixture();
  const write = f.storage.setItem;
  const clearEntered = gate<void>();
  const clearReleased = gate<void>();
  let markers = 0;
  let clears = 0;
  f.storage.setItem = async (key, value) => {
    if (key === f.pendingKey) {
      if (value === "null") {
        clears++;
        clearEntered.resolve();
        await clearReleased.promise;
      } else if (JSON.parse(value).outcome === "accepted") markers++;
    }
    await write(key, value);
  };
  const next = messageCommand("TEST D", "en", "TEST-D");
  let nextSend: Promise<void> | undefined;
  let armed = false;
  const unsubscribe = f.session.subscribe(() => {
    if (armed && !f.session.getSnapshot().pending) {
      armed = false;
      nextSend = f.session.send(next);
    }
  });
  const original = f.transport.getMockImplementation()!;
  f.transport.mockImplementation(async (url, init) => {
    if (init?.method === "POST" && !String(url).includes("/processes/"))
      throw Error("TEST D response lost");
    return original(url, init);
  });
  try {
    await f.session.start(false);
    const sending = f.session.send(f.start, false, f.startTarget);
    await clearEntered.promise;
    const retrying = f.session.retry();
    expect(f.session.retry()).toBe(retrying);
    await flush();
    expect(markers).toBe(1);
    armed = true;
    clearReleased.resolve();
    await sending;
    await retrying;
    await nextSend;
    await flush();
    expect(clears).toBe(1);
    expect(markers).toBe(1);
    expect(f.session.getSnapshot().pending).toEqual(next);
    expect(f.cache.get(f.pendingKey)).toBe(JSON.stringify(next));
  } finally {
    unsubscribe();
    clearReleased.resolve();
    f.session.stop();
  }
});

test("known marker survives restart and retries cleanup without process delivery", async () => {
  const f = fixture();
  const write = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key === f.pendingKey && value === "null")
      throw Error("TEST clear failed");
    await write(key, value);
  };
  let reopened: ClientSession | undefined;
  try {
    await f.session.start(false);
    await f.session.send(f.start, false, f.startTarget);
    f.session.stop();
    f.storage.setItem = write;
    reopened = f.open();
    await reopened.start(false);
    expect(reopened.getSnapshot().commandStates[f.start.intentId]).toBe(
      "accepted",
    );
    await reopened.retry();
    expect(f.posts()).toHaveLength(1);
    expect(reopened.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
    reopened?.stop();
  }
});

test.each([undefined, "accepted"] as const)(
  "saved answer envelope outcome=%s coexists with a restored pending resolve",
  async (outcome) => {
    const f = fixture();
    let reopened: ClientSession | undefined;
    try {
      await f.session.start(false);
      f.seedAnswers(outcome);
      const { command, target } = f.resolve();
      f.handlers.send = async () => {
        throw Error("TEST lost response");
      };
      await f.session.send(command, false, target);
      f.session.stop();
      reopened = f.open();
      await reopened.start(false);
      expect(reopened.getSnapshot().pending).toEqual(command);
      expect(reopened.getSnapshot().answerAttempts).toHaveLength(
        outcome ? 1 : 0,
      );
      expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(false);
      expect(f.posts()).toHaveLength(1);
    } finally {
      f.session.stop();
      reopened?.stop();
    }
  },
);

test.each([undefined, "accepted"] as const)(
  "unreadable shared outbox blocks new commands despite answer envelope outcome=%s",
  async (outcome) => {
    const f = fixture();
    let reopened: ClientSession | undefined;
    try {
      await f.session.start(false);
      f.seedAnswers(outcome);
      f.session.stop();
      const read = f.storage.getItem;
      f.storage.getItem = async (key) => {
        if (key === f.pendingKey) throw Error("TEST shared outbox unreadable");
        return read(key);
      };
      reopened = f.open();
      await reopened.start(false);
      expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(true);
      await reopened.send(messageCommand("TEST must wait", "en", "TEST-new"));
      expect(f.posts()).toHaveLength(0);
      f.storage.getItem = read;
      await reopened.refresh();
      expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(false);
    } finally {
      f.session.stop();
      reopened?.stop();
    }
  },
);

test("unknown answer conclusively owns the outbox even when compatibility storage is unreadable", async () => {
  const f = fixture();
  let reopened: ClientSession | undefined;
  try {
    await f.session.start(false);
    f.seedAnswers("unknown");
    f.session.stop();
    const read = f.storage.getItem;
    f.storage.getItem = async (key) => {
      if (key === f.pendingKey) throw Error("TEST compatibility unreadable");
      return read(key);
    };
    reopened = f.open();
    await reopened.start(false);
    expect(reopened.getSnapshot().pending?.type).toBe("process.answer");
    expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(false);
    await reopened.send(f.start, false, f.startTarget);
    expect(f.posts()).toHaveLength(0);
  } finally {
    f.session.stop();
    reopened?.stop();
  }
});

test("legacy raw process command cannot infer missing proof from a new current approval", async () => {
  const f = fixture();
  try {
    f.cache.set(f.pendingKey, JSON.stringify(f.start));
    await f.session.start(false);
    await expect(f.session.retry()).rejects.toThrow("process_command_changed");
    expect(await f.session.interruptPending()).toBe(false);
    expect(f.posts()).toHaveLength(0);
    expect(f.cache.get(f.pendingKey)).toBe(JSON.stringify(f.start));
  } finally {
    f.session.stop();
  }
});

test("settled process interruption owns the same flight and late response cannot clear D", async () => {
  const f = fixture();
  const delivered = gate<Response>();
  const acknowledged = gate<Response>();
  f.handlers.send = async () => delivered.promise;
  f.handlers.interrupt = async () => acknowledged.promise;
  try {
    await f.session.start(false);
    const { command, target } = f.resolve();
    const sending = f.session.send(command, false, target);
    await f.started.promise;
    const interrupt = f.session.interruptPending();
    expect(f.session.interruptPending()).toBe(interrupt);
    await f.interruptStarted.promise;
    const request = JSON.parse(String(f.posts()[1]![1]?.body));
    expect(request.profile).toBe(PROCESS_QUESTION_EXECUTION_PROFILE);
    expect(request.command).toEqual(command);
    acknowledged.resolve(
      response({
        profile: PROCESS_QUESTION_EXECUTION_PROFILE,
        scope: credential().scope,
        commandId: command.commandId,
        status: "settled",
        result: f.runtime({ ...f.start, commandId: command.commandId }),
      }),
    );
    expect(await interrupt).toBe(true);
    await sending;
    const next = messageCommand("TEST D", "en", "TEST-D");
    // Ordinary D uses the same owner; its undelivered pending bytes must remain.
    const original = f.transport.getMockImplementation()!;
    f.transport.mockImplementation(async (url, init) => {
      if (init?.method === "POST" && !String(url).includes("/processes/"))
        throw Error("TEST D response lost");
      return original(url, init);
    });
    await f.session.send(next);
    delivered.resolve(
      response(f.runtime({ ...f.start, commandId: command.commandId })),
    );
    await flush();
    expect(f.session.getSnapshot().pending).toEqual(next);
    expect(f.cache.get(f.pendingKey)).toBe(JSON.stringify(next));
    expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "accepted",
    );
  } finally {
    f.session.stop();
    delivered.resolve(response(f.runtime()));
  }
});

test.each(["unknown", "wrong_parent", "wrong_scope"])(
  "%s interruption leaves the exact process barrier in place",
  async (damage) => {
    const f = fixture();
    const delivered = gate<Response>();
    f.handlers.send = async () => delivered.promise;
    f.handlers.interrupt = async () => {
      const result = f.runtime();
      if (damage === "wrong_parent") result.process!.parentRunId = "TEST-other";
      return response({
        profile: PROCESS_QUESTION_EXECUTION_PROFILE,
        scope:
          damage === "wrong_scope"
            ? { ...credential().scope, userId: "TEST-other" }
            : credential().scope,
        commandId: f.start.commandId,
        status: damage === "unknown" ? "unknown" : "settled",
        ...(damage === "unknown" ? { reason: "not_settled" } : { result }),
      });
    };
    try {
      await f.session.start(false);
      const sending = f.session.send(f.start, false, f.startTarget);
      await f.started.promise;
      expect(await f.session.interruptPending()).toBe(false);
      expect(f.session.getSnapshot().pending).toEqual(f.start);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      f.session.stop();
      await sending;
    } finally {
      f.session.stop();
      delivered.resolve(response(f.runtime()));
    }
  },
);
