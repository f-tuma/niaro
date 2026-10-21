import { FixtureEngine } from "../apps/fixture-server/engine";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  captureProcessNoticeOwner,
  selectProcessCommandNotice,
} from "../packages/client-core/process-command-notice";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
  isProcessAnswerConsumed,
} from "../packages/client-core/process-answers";
import {
  parseProcessAnswerAttempts,
  PROCESS_ANSWER_ATTEMPTS_LIMIT,
} from "../packages/client-core/process-answer-attempts";
import { WorkItemSchema, type Snapshot } from "../packages/protocol";
import {
  PROCESS_QUESTION_EXECUTION_PROFILE,
  type ProcessAnswerCommand,
} from "../packages/protocol/process-questions";
import {
  ProcessRuntimeResponseSchema,
  ProcessRuntimeInterruptRequestSchema,
  type ProcessRuntimeResponse,
} from "../packages/protocol/process-coordinator";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
} from "../packages/protocol/process-work";
import { authInfo, credential } from "./auth-fixtures";

const address = "https://fixture/v1/a";
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const gate = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
const work = (generation = "A", revision = 7) =>
  WorkItemSchema.parse({
    id: "TEST-parent",
    revision: 99 + revision,
    conversationId: "conversation-1",
    title: "TEST native question",
    context: "TEST awaiting text",
    status: "waiting_input",
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
        journalRevision: revision,
        detailsAvailable: true,
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
        receipts: [],
        question: {
          nodeId: "agent",
          childRunId: "TEST-child",
          toolCallId: `TEST-call-${generation}`,
          questionId: `TEST-question-${generation}`,
          questionRevision: 1,
          question: `TEST question ${generation}?`,
        },
      },
    },
  });
function runtimeResult(command: ProcessAnswerCommand): ProcessRuntimeResponse {
  return ProcessRuntimeResponseSchema.parse({
    profile: PROCESS_QUESTION_EXECUTION_PROFILE,
    scope: credential().scope,
    commandId: command.commandId,
    admission: {
      profile: "agent-process-start/1",
      status: "admitted",
      receiptId: "TEST-admission",
      intentId: "TEST-intent",
      commandId: "TEST-start",
      idempotencyKey: "TEST-start",
      commandDigest: "c".repeat(64),
      origin: {
        type: "command",
        conversationId: "conversation-1",
        requestId: "TEST-start",
      },
      processId: "TEST-process",
      version: 1,
      artifactDigest: "a".repeat(64),
      formDigest: "b".repeat(64),
      input: {},
      inputDigest: "d".repeat(64),
      compilerVersion: "niaro-native-workflow/3",
      runId: "TEST-run",
      parentRunId: "TEST-parent",
      createdAt: "2026-10-06T00:00:00.000Z",
    },
    process: {
      parentRunId: "TEST-parent",
      runId: "TEST-run",
      processId: "TEST-process",
      version: 1,
      revision: 8,
      status: "waiting",
      question: work("B", 8).native!.process!.question,
    },
  });
}
function fixture(questionCapable = true) {
  const engine = new FixtureEngine();
  let snapshot: Snapshot = { ...engine.snapshot(), workItems: [work()] };
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const sendStarted = gate<void>(),
    interruptStarted = gate<void>();
  const handlers = {
    send: async (command: ProcessAnswerCommand, _signal?: AbortSignal) =>
      response(runtimeResult(command)),
    interrupt: async (command: ProcessAnswerCommand) =>
      response(settled(command)),
    read: async () => response(snapshot),
  };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("/auth/session")) return response(authInfo());
      const path = new URL(String(url));
      if (path.pathname.endsWith("/processes/commands/interrupt")) {
        interruptStarted.resolve();
        const envelope = ProcessRuntimeInterruptRequestSchema.parse(
          JSON.parse(String(init?.body)),
        );
        return handlers.interrupt(envelope.command as ProcessAnswerCommand);
      }
      if (path.pathname.endsWith("/processes/commands")) {
        sendStarted.resolve();
        return handlers.send(
          JSON.parse(String(init?.body)),
          init?.signal ?? undefined,
        );
      }
      if (init?.method === "POST")
        return response(engine.execute(JSON.parse(String(init.body))));
      return handlers.read();
    },
  );
  const open = (enabled = questionCapable) =>
    new ClientSession(
      address,
      storage,
      credential(),
      transport,
      undefined,
      undefined,
      false,
      { processQuestions: enabled },
    );
  const session = open();
  const answer = (id = "TEST-answer-A") => {
    const store = session.getSnapshot().store!;
    return processAnswerCommand(
      store,
      captureProcessAnswerTarget(store, "TEST-parent"),
      {
        commandId: id,
        idempotencyKey: `${id}-key`,
        answer: "  TEST exact text\n",
        language: "cs",
      },
    );
  };
  return {
    session,
    open,
    answer,
    transport,
    handlers,
    sendStarted,
    interruptStarted,
    cache,
    storage,
    next: () => {
      snapshot = { ...snapshot, workItems: [work("B", 8)] };
    },
    replaceWork: (value: ReturnType<typeof work>) => {
      snapshot = {
        ...snapshot,
        cursor: snapshot.cursor + 1,
        workItems: [value],
      };
    },
    attemptsValue: () =>
      cache.get(
        `agent-client.process-answer-attempts.v1:${session.identityKey}`,
      ),
    snapshot: () => snapshot,
    pendingValue: () =>
      cache.get(`agent-client.command.v2:${session.identityKey}`),
  };
}
function settled(
  command: ProcessAnswerCommand,
  result = runtimeResult(command),
) {
  return {
    profile: PROCESS_QUESTION_EXECUTION_PROFILE,
    scope: credential().scope,
    commandId: command.commandId,
    status: "settled" as const,
    result,
  };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each(["failed", "unknown"] as const)(
  "accepted answer retains native %s status without claiming answer rejection",
  async (status) => {
    const f = fixture();
    f.handlers.send = async (command) => {
      const result = runtimeResult(command);
      return response({
        ...result,
        process: {
          ...result.process,
          status,
          question: undefined,
          failure: { code: "" },
        },
      });
    };
    try {
      await f.session.start(false);
      const owner = captureProcessNoticeOwner(f.session, {
        conversationId: "conversation-1",
        chatGeneration: 1,
        language: "cs",
      })!;
      const command = f.answer();
      await f.session.send(command, false, undefined, owner);
      expect(f.session.getSnapshot().error).toBeNull();
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("accepted");
      expect(f.session.getSnapshot().answerAttempts[0]?.command.answer).toBe(
        "  TEST exact text\n",
      );
      expect(
        selectProcessCommandNotice(f.session.getSnapshot(), owner).notice?.kind,
      ).toBe(status);
    } finally {
      f.session.stop();
    }
  },
);

test("accepted answer saving retry restores its original runtime cause with a new UI owner and no transport replay", async () => {
  const f = fixture(),
    write = f.storage.setItem;
  f.handlers.send = async (command) => {
    const result = runtimeResult(command);
    return response({
      ...result,
      process: {
        ...result.process,
        status: "unknown",
        question: undefined,
        failure: { code: "storage_error" },
      },
    });
  };
  try {
    await f.session.start(false);
    const owner = captureProcessNoticeOwner(f.session, {
      conversationId: "conversation-1",
      chatGeneration: 1,
      language: "cs",
    })!;
    f.storage.setItem = async (key, value) => {
      if (
        key.includes("process-answer-attempts") &&
        JSON.parse(value).attempts.some(
          (attempt: { outcome: string }) => attempt.outcome === "accepted",
        )
      )
        throw Error("TEST actual known answer persistence failure");
      return write(key, value);
    };
    const command = f.answer();
    await f.session.send(command, false, undefined, owner);
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(selectProcessCommandNotice(f.session.getSnapshot(), owner)).toEqual({
      notice: null,
      suppressError: false,
      localError: "storage_error",
    });
    f.storage.setItem = write;
    const currentOwner = { ...owner, chatGeneration: 2 };
    await f.session.retry(currentOwner);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(
      selectProcessCommandNotice(f.session.getSnapshot(), currentOwner).notice
        ?.kind,
    ).toBe("unknown");
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).includes("/processes/commands?"),
      ),
    ).toHaveLength(1);
  } finally {
    f.storage.setItem = write;
    f.session.stop();
  }
});

test.each([false, true])(
  "question projection negotiation is explicit: %s",
  async (enabled) => {
    const f = fixture(enabled);
    try {
      await f.session.start(false);
      const path = new URL(
        String(
          f.transport.mock.calls.find(([url]) =>
            String(url).includes("/snapshot?"),
          )![0],
        ),
      );
      expect(path.searchParams.get("tasks")).toBe(
        enabled ? PROCESS_QUESTION_WORK_PROFILE : PROCESS_WORK_PROFILE,
      );
      if (!enabled) {
        await expect(f.session.send(f.answer())).rejects.toThrow(
          "process_profile_unsupported",
        );
        expect(f.pendingValue()).toBeUndefined();
        expect(
          f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
        ).toHaveLength(0);
      }
    } finally {
      f.session.stop();
    }
  },
);

test("answer persists before delivery, owns an immutable exact copy, and refreshes projection after ACK", async () => {
  const f = fixture(),
    delivered = gate<Response>(),
    refreshed = gate<Response>();
  f.handlers.send = async (command) => {
    expect(f.pendingValue()).toBe(JSON.stringify(command));
    return delivered.promise;
  };
  try {
    await f.session.start(false);
    const command = f.answer(),
      expected = { ...command };
    const send = f.session.send(command);
    command.answer = "TEST caller mutation";
    await f.sendStarted.promise;
    const request = f.transport.mock.calls.find(([url]) =>
      String(url).includes("/processes/commands?"),
    )!;
    expect(JSON.parse(String(request[1]?.body))).toEqual(expected);
    expect(new URL(String(request[0])).searchParams.get("profile")).toBe(
      PROCESS_QUESTION_EXECUTION_PROFILE,
    );
    expect(new URL(String(request[0])).searchParams.has("tasks")).toBe(false);
    expect(
      f.session.getSnapshot().store?.workItems["TEST-parent"]?.native?.process
        ?.question?.questionId,
    ).toBe("TEST-question-A");
    expect(f.session.getSnapshot().store?.operations).toEqual({});
    f.handlers.read = async () => refreshed.promise;
    const runtime = runtimeResult(expected);
    runtime.process = {
      ...runtime.process!,
      status: "succeeded",
      output: { TEST: "runtime output is not a snapshot" },
    };
    delete runtime.process.question;
    delivered.resolve(response(runtime));
    await send;
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates[commandTarget(expected)]).toBe(
      "accepted",
    );
    expect(f.session.getSnapshot().store?.stale).toBe(true);
    expect(
      f.session.getSnapshot().store?.workItems["TEST-parent"]?.status,
    ).toBe("waiting_input");
    await expect(
      f.session.send({
        ...expected,
        commandId: "TEST-answer-new",
        idempotencyKey: "TEST-new-key",
      }),
    ).rejects.toThrow("process_question_changed");
    f.next();
    refreshed.resolve(response(f.snapshot()));
    await flush();
    expect(f.session.getSnapshot().store?.stale).toBe(false);
    expect(
      f.session.getSnapshot().store?.workItems["TEST-parent"]?.native?.process
        ?.question?.questionId,
    ).toBe("TEST-question-B");
  } finally {
    f.session.stop();
  }
});

test("lost answer response reopens without resend and explicitly retries exact A after B is projected", async () => {
  const f = fixture();
  f.handlers.send = async () => {
    f.next();
    throw new Error("TEST receipt lost");
  };
  await f.session.start(false);
  const command = f.answer();
  await f.session.send(command);
  expect(f.session.getSnapshot().pending).toEqual(command);
  expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
    "network_error",
  );
  f.session.stop();
  const reopened = f.open();
  try {
    await reopened.start(false);
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    expect(reopened.getSnapshot().pending).toEqual(command);
    expect(
      reopened.getSnapshot().store?.workItems["TEST-parent"]?.native?.process
        ?.question?.questionId,
    ).toBe("TEST-question-B");
    const changed = {
      ...command,
      questionId: "TEST-question-B",
      toolCallId: "TEST-call-B",
      expectedWorkRevision: 8,
    };
    await reopened.send(changed, true);
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    f.handlers.send = async (retry) => response(runtimeResult(retry));
    await reopened.retry();
    const posts = f.transport.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(2);
    expect(posts[0]![1]?.body).toBe(posts[1]![1]?.body);
    expect(reopened.getSnapshot().pending).toBeNull();
    expect(f.pendingValue()).toBe("null");
  } finally {
    reopened.stop();
  }
});

test.each([
  "generation",
  "question",
  "child",
  "tool",
  "node",
  "conversation",
  "stale",
])(
  "a NEW answer refuses a changed %s before persistence or transport",
  async (change) => {
    const f = fixture();
    try {
      await f.session.start(false);
      const command = f.answer(),
        store = f.session.getSnapshot().store!,
        current = store.workItems["TEST-parent"]!;
      const process = current.native!.process!;
      if (change === "generation") process.journalRevision!++;
      if (change === "question")
        process.question!.questionId = "TEST-question-B";
      if (change === "child") process.question!.childRunId = "TEST-child-B";
      if (change === "tool") process.question!.toolCallId = "TEST-call-B";
      if (change === "node") process.question!.nodeId = "other";
      if (change === "conversation")
        command.conversationId = "TEST-other-conversation";
      if (change === "stale") store.stale = true;
      await expect(f.session.send(command)).rejects.toThrow(
        "process_question_changed",
      );
      expect(f.pendingValue()).toBeUndefined();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(0);
    } finally {
      f.session.stop();
    }
  },
);

test.each([
  "scope",
  "command",
  "profile",
  "parent",
  "admission-parent",
  "conversation",
  "run",
  "version",
])(
  "mismatched original %s response preserves exact pending barrier",
  async (mismatch) => {
    const f = fixture();
    try {
      await f.session.start(false);
      const command = f.answer(),
        invalid = runtimeResult(command);
      if (mismatch === "scope") invalid.scope = credential("b").scope;
      if (mismatch === "command") invalid.commandId = "TEST-foreign-answer";
      if (mismatch === "profile") {
        invalid.profile = "agent-process-execution/1";
        delete invalid.process!.question;
      }
      if (mismatch === "parent")
        invalid.process!.parentRunId = "TEST-other-parent";
      if (
        mismatch === "admission-parent" &&
        invalid.admission.status === "admitted"
      )
        invalid.admission.parentRunId = "TEST-other-parent";
      if (mismatch === "conversation")
        invalid.admission.origin.conversationId = "TEST-other-conversation";
      if (mismatch === "run") invalid.process!.runId = "TEST-other-run";
      if (mismatch === "version") invalid.process!.version++;
      f.handlers.send = async () => response(invalid);
      await f.session.send(command);
      expect(f.session.getSnapshot().pending).toEqual(command);
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("network_error");
      expect(f.pendingValue()).toBe(JSON.stringify(command));
    } finally {
      f.session.stop();
    }
  },
);

test("settled process interruption retires shared owner and ignored late send cannot replace D", async () => {
  const f = fixture(),
    original = gate<Response>(),
    ack = gate<Response>(),
    next = gate<Response>();
  let originalSignal: AbortSignal | undefined;
  f.handlers.send = async (_command, signal) => {
    originalSignal = signal;
    return original.promise;
  };
  f.handlers.interrupt = async () => ack.promise;
  try {
    await f.session.start(false);
    const command = f.answer(),
      send = f.session.send(command);
    await f.sendStarted.promise;
    const interrupt = f.session.interruptPending();
    expect(f.session.interruptPending()).toBe(interrupt);
    await f.interruptStarted.promise;
    const request = f.transport.mock.calls.find(([url]) =>
      String(url).includes("/processes/commands/interrupt?"),
    )!;
    expect(new URL(String(request[0])).searchParams.get("profile")).toBe(
      PROCESS_QUESTION_EXECUTION_PROFILE,
    );
    expect(JSON.parse(String(request[1]?.body))).toEqual({
      profile: PROCESS_QUESTION_EXECUTION_PROFILE,
      command,
    });
    f.next();
    ack.resolve(response(settled(command)));
    expect(await interrupt).toBe(true);
    await send;
    await flush();
    expect(originalSignal?.aborted).toBe(true);
    const nextCommand = f.answer("TEST-answer-B");
    f.handlers.send = async () => next.promise;
    const nextSend = f.session.send(nextCommand);
    await flush();
    original.resolve(response(runtimeResult(command)));
    await flush();
    expect(f.session.getSnapshot().pending).toEqual(nextCommand);
    expect(
      f.session.getSnapshot().commandStates[commandTarget(nextCommand)],
    ).toBe("sending");
    expect(f.pendingValue()).toBe(JSON.stringify(nextCommand));
    next.resolve(response(runtimeResult(nextCommand)));
    await nextSend;
  } finally {
    f.session.stop();
  }
});

test.each([
  "scope",
  "command",
  "profile",
  "result-scope",
  "result-command",
  "parent",
  "conversation",
  "unknown",
  "lost",
])(
  "%s interruption cannot retire process answer or permit another command",
  async (mismatch) => {
    const f = fixture(),
      original = gate<Response>();
    let signal: AbortSignal | undefined;
    f.handlers.send = async (_command, supplied) => {
      signal = supplied;
      return original.promise;
    };
    try {
      await f.session.start(false);
      const command = f.answer(),
        send = f.session.send(command);
      await f.sendStarted.promise;
      const invalid = settled(command);
      if (mismatch === "scope") invalid.scope = credential("b").scope;
      if (mismatch === "command") invalid.commandId = "TEST-other-answer";
      if (mismatch === "result-scope")
        invalid.result.scope = credential("b").scope;
      if (mismatch === "result-command")
        invalid.result.commandId = "TEST-other-answer";
      if (mismatch === "parent")
        invalid.result.process!.parentRunId = "TEST-other-parent";
      if (mismatch === "conversation")
        invalid.result.admission.origin.conversationId =
          "TEST-other-conversation";
      f.handlers.interrupt = async () => {
        if (mismatch === "lost") throw new Error("TEST ACK lost");
        if (mismatch === "unknown")
          return response({
            ...invalid,
            status: "unknown",
            reason: "not_settled",
            result: undefined,
          });
        if (mismatch === "profile")
          return response({ ...invalid, profile: "agent-process-execution/1" });
        return response(invalid);
      };
      expect(await f.session.interruptPending()).toBe(false);
      expect(signal?.aborted).toBe(false);
      expect(f.session.getSnapshot().pending).toEqual(command);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      await f.session.refresh();
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      await f.session.send(messageCommand("TEST blocked", "en", "TEST-D"));
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(2);
      original.resolve(response(runtimeResult(command)));
      await send;
      expect(f.session.getSnapshot().pending).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test("normal answer result retires the interruption barrier even when ACK is lost", async () => {
  const f = fixture(),
    original = gate<Response>(),
    ack = gate<Response>();
  f.handlers.send = async () => original.promise;
  f.handlers.interrupt = async () => ack.promise;
  try {
    await f.session.start(false);
    const command = f.answer(),
      send = f.session.send(command);
    await f.sendStarted.promise;
    const interrupt = f.session.interruptPending();
    await f.interruptStarted.promise;
    original.resolve(response(runtimeResult(command)));
    expect(await interrupt).toBe(true);
    await send;
    ack.reject(new Error("TEST late ACK lost"));
    await flush();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().error).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("restored process answer interruption never replays answer delivery", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    const command = f.answer();
    f.cache.set(
      `agent-client.command.v2:${f.session.identityKey}`,
      JSON.stringify(command),
    );
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      expect(await reopened.interruptPending()).toBe(true);
      const posts = f.transport.mock.calls.filter(
        ([, init]) => init?.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(String(posts[0]![0])).toContain("/processes/commands/interrupt?");
      expect(reopened.getSnapshot().pending).toBeNull();
    } finally {
      reopened.stop();
    }
  } finally {
    f.session.stop();
  }
});

test.each([false, true])(
  "interruption during command persistence waits for write; failure=%s",
  async (fail) => {
    const f = fixture(),
      write = gate<void>(),
      writing = gate<void>(),
      original = gate<Response>();
    const setItem = f.storage.setItem;
    f.handlers.send = async () => original.promise;
    f.storage.setItem = async (key, value) => {
      if (key.includes("command")) {
        writing.resolve();
        await write.promise;
        if (fail) throw new Error("TEST disk full");
      }
      await setItem(key, value);
    };
    try {
      await f.session.start(false);
      const command = f.answer(),
        send = f.session.send(command);
      await writing.promise;
      const interrupt = f.session.interruptPending();
      await flush();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(0);
      write.resolve();
      expect(await interrupt).toBe(true);
      await send;
      await flush();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
        // The authoritative attempt already persisted before the compatibility
        // pending-key failure. Resolving that conservative unknown requires its
        // explicit interruption lookup; the answer itself is never delivered.
      ).toHaveLength(fail ? 1 : 2);
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("accepted");
      expect(f.session.getSnapshot().error).toBe(fail ? "storage_error" : null);
    } finally {
      f.session.stop();
    }
  },
);

test("stop during persistence resolves interruption and never posts the unsent answer", async () => {
  const f = fixture(),
    write = gate<void>(),
    writing = gate<void>(),
    setItem = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key.includes("command")) {
      writing.resolve();
      await write.promise;
    }
    await setItem(key, value);
  };
  await f.session.start(false);
  const send = f.session.send(f.answer());
  await writing.promise;
  const interrupt = f.session.interruptPending();
  f.session.stop();
  expect(await interrupt).toBe(false);
  write.resolve();
  await send;
  expect(
    f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(0);
});

test.each(["cache", "clear"])(
  "accepted answer remains accepted if %s persistence fails",
  async (failure) => {
    const f = fixture();
    try {
      await f.session.start(false);
      const command = f.answer(),
        setItem = f.storage.setItem;
      f.storage.setItem = async (key, value) => {
        if (
          (failure === "cache" && key.includes("snapshot")) ||
          (failure === "clear" && key.includes("command") && value === "null")
        )
          throw new Error("TEST disk full");
        await setItem(key, value);
      };
      await f.session.send(command);
      await flush();
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("accepted");
      expect(f.session.getSnapshot().error).toBe("storage_error");
      if (failure === "cache") expect(f.pendingValue()).toBe("null");
      else expect(f.pendingValue()).toBe(JSON.stringify(command));
    } finally {
      f.session.stop();
    }
  },
);

test.each([
  ["process_question_conflict", 409, true],
  ["model_timeout", 503, false],
  ["process_owner_unsettled", 503, false],
] as const)(
  "%s failure is visible and survives refresh",
  async (code, status, definitive) => {
    const f = fixture();
    f.handlers.send = async () => response({ error: code }, status);
    try {
      await f.session.start(false);
      const command = f.answer();
      await f.session.send(command);
      expect(f.session.getSnapshot().pending).toEqual(
        definitive ? null : command,
      );
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe(definitive ? "rejected" : "network_error");
      expect(f.session.getSnapshot().error).toBe(code);
      await f.session.refresh();
      expect(f.session.getSnapshot().error).toBe(code);
    } finally {
      f.session.stop();
    }
  },
);

test("canonical native failure remains visible when projection refresh fails", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    const command = f.answer(),
      result = runtimeResult(command);
    result.process = {
      ...result.process!,
      status: "failed",
      failure: { code: "TEST_native_failure" },
    };
    delete result.process.question;
    f.handlers.send = async () => response(result);
    f.handlers.read = async () => {
      throw new Error("TEST snapshot unavailable");
    };
    await f.session.send(command);
    await flush();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "accepted",
    );
    expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
    expect(f.session.getSnapshot().store?.stale).toBe(true);
    expect(f.session.getSnapshot().status).toBe("offline");
  } finally {
    f.session.stop();
  }
});

test.each(["invalid", "unreadable"])(
  "%s snapshot cache cannot hide a valid persisted answer on reopen",
  async (damage) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer();
    f.cache.set(
      `agent-client.command.v2:${f.session.identityKey}`,
      JSON.stringify(command),
    );
    f.cache.set(
      `agent-client.snapshot.v2:${f.session.identityKey}`,
      "TEST malformed cache",
    );
    if (damage === "unreadable") {
      const getItem = f.storage.getItem;
      f.storage.getItem = async (key) => {
        if (key.includes("snapshot")) throw new Error("TEST cache unreadable");
        return getItem(key);
      };
    }
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      expect(reopened.getSnapshot().pending).toEqual(command);
      expect(reopened.getSnapshot().error).toBe("storage_error");
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(0);
      await reopened.retry();
      expect(reopened.getSnapshot().pending).toBeNull();
    } finally {
      reopened.stop();
    }
  },
);

test.each([false, true])(
  "delayed old answer persistence cannot erase or report errors on pending B; failure=%s",
  async (fail) => {
    const f = fixture(),
      original = gate<Response>(),
      cacheWrite = gate<void>(),
      writing = gate<void>(),
      next = gate<Response>();
    f.handlers.send = async () => original.promise;
    try {
      await f.session.start(false);
      const command = f.answer(),
        send = f.session.send(command);
      await f.sendStarted.promise;
      const setItem = f.storage.setItem;
      let blockOnce = true;
      let cacheWrites = 0;
      f.storage.setItem = async (key, value) => {
        if (blockOnce && key.includes("snapshot")) {
          blockOnce = false;
          writing.resolve();
          await cacheWrite.promise;
        }
        if (key.includes("snapshot") && cacheWrites++ < 2 && fail)
          throw new Error("TEST old cache write failed");
        await setItem(key, value);
      };
      f.next();
      expect(await f.session.interruptPending()).toBe(true);
      await send;
      await writing.promise;
      await flush();
      const nextCommand = f.answer("TEST-answer-B");
      f.handlers.send = async () => next.promise;
      const nextSend = f.session.send(nextCommand);
      await flush();
      original.resolve(response(runtimeResult(command)));
      await flush();
      expect(f.session.getSnapshot().pending).toEqual(nextCommand);
      cacheWrite.resolve();
      await flush();
      expect(f.pendingValue()).toBe(JSON.stringify(nextCommand));
      expect(f.session.getSnapshot().error).toBeNull();
      expect(
        f.session.getSnapshot().commandStates[commandTarget(nextCommand)],
      ).toBe("sending");
      next.resolve(response(runtimeResult(nextCommand)));
      await nextSend;
    } finally {
      f.session.stop();
    }
  },
);

test("canonical process failure survives snapshot cache errors and later event polling failure", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    const command = f.answer(),
      result = runtimeResult(command),
      setItem = f.storage.setItem;
    result.process = {
      ...result.process!,
      status: "failed",
      failure: { code: "TEST_native_failure" },
    };
    delete result.process.question;
    f.handlers.send = async () => response(result);
    f.storage.setItem = async (key, value) => {
      if (key.includes("snapshot")) throw new Error("TEST cache write failed");
      await setItem(key, value);
    };
    await f.session.send(command);
    await flush();
    expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "accepted",
    );
    expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
    f.handlers.read = async () => {
      throw new Error("TEST events unavailable");
    };
    await f.session.sync();
    expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
    expect(f.session.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("failure rewriting an uncertain retry preserves its exact pending answer and interruption barrier", async () => {
  const f = fixture();
  f.handlers.send = async () => {
    throw new Error("TEST response lost");
  };
  try {
    await f.session.start(false);
    const command = f.answer();
    await f.session.send(command);
    const setItem = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (key.includes("command") && value !== "null")
        throw new Error("TEST disk full");
      await setItem(key, value);
    };
    await f.session.retry();
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "network_error",
    );
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(f.pendingValue()).toBe(JSON.stringify(command));
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(await f.session.interruptPending()).toBe(true);
    expect(f.session.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
  }
});

test.each(["accepted", "rejected"] as const)(
  "durable %s attempt reopens with original question, raw text, outcome and no resend",
  async (outcome) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer();
    if (outcome === "rejected")
      f.handlers.send = async () =>
        response({ error: "process_question_conflict" }, 409);
    await f.session.send(command);
    await flush();
    f.next();
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      const attempt = reopened.getSnapshot().answerAttempts[0]!;
      expect(attempt).toMatchObject({
        command,
        outcome,
        error: outcome === "rejected" ? "process_question_conflict" : null,
        target: {
          journalRevision: 7,
          question: {
            questionId: "TEST-question-A",
            question: "TEST question A?",
          },
        },
      });
      expect(Object.isFrozen(attempt)).toBe(true);
      expect(Object.isFrozen(attempt.target.question)).toBe(true);
      expect(Object.isFrozen(attempt.command)).toBe(true);
      expect(reopened.getSnapshot().pending).toBeNull();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
      await reopened.retry();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      reopened.stop();
    }
  },
);

test("unknown attempt preserves frozen A and exact Unicode/whitespace bytes after B; discard cannot release it", async () => {
  const f = fixture();
  f.handlers.send = async () => {
    f.next();
    throw Error("TEST response lost");
  };
  await f.session.start(false);
  const command = { ...f.answer(), answer: " \tTEST žluťoučký 🦊\r\n " };
  await f.session.send(command);
  f.session.stop();
  const reopened = f.open();
  try {
    await reopened.start(false);
    const attempt = reopened.getSnapshot().answerAttempts[0]!;
    expect(attempt.command).toEqual(command);
    expect(attempt.target.question.questionId).toBe("TEST-question-A");
    expect(attempt.target.question.question).toBe("TEST question A?");
    expect(attempt.outcome).toBe("unknown");
    expect(await reopened.discardProcessAnswerAttempt(command.commandId)).toBe(
      false,
    );
    expect(reopened.getSnapshot().pending).toEqual(command);
    f.handlers.send = async (retried) => {
      expect(JSON.stringify(retried)).toBe(JSON.stringify(command));
      return response(runtimeResult(retried));
    };
    await reopened.retry();
    expect(reopened.getSnapshot().answerAttempts[0]!.outcome).toBe("accepted");
    expect(reopened.getSnapshot().pending).toBeNull();
  } finally {
    reopened.stop();
  }
});

test("known durable ledger overrides stale same pending disk after clear failure", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer(),
    setItem = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key.includes("command.v2") && value === "null")
      throw Error("TEST clear failed");
    await setItem(key, value);
  };
  await f.session.send(command);
  await flush();
  expect(f.pendingValue()).toBe(JSON.stringify(command));
  f.session.stop();
  const reopened = f.open();
  try {
    await reopened.start(false);
    expect(reopened.getSnapshot().pending).toBeNull();
    expect(reopened.getSnapshot().answerAttempts[0]!.outcome).toBe("accepted");
    await reopened.retry();
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    reopened.stop();
  }
});

test.each([false, true])(
  "known ledger write failure holds pending; reject-after-commit=%s",
  async (committed) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer(),
      setItem = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (
        key.includes("process-answer-attempts") &&
        JSON.parse(value).attempts[0]?.outcome === "accepted"
      ) {
        if (committed) await setItem(key, value);
        throw Error("TEST outcome write rejected");
      }
      await setItem(key, value);
    };
    try {
      await f.session.send(command);
      expect(f.session.getSnapshot().answerAttempts[0]!.outcome).toBe(
        "accepted",
      );
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("accepted");
      expect(f.session.getSnapshot().pending).toEqual(
        committed ? null : command,
      );
      if (!committed) {
        expect(f.pendingValue()).toBe(JSON.stringify(command));
        expect(JSON.parse(f.attemptsValue()!).attempts[0].outcome).toBe(
          "unknown",
        );
        expect(await f.session.interruptPending()).toBe(false);
        f.storage.setItem = setItem;
        await f.session.retry();
        expect(f.session.getSnapshot().pending).toBeNull();
        expect(JSON.parse(f.attemptsValue()!).attempts[0].outcome).toBe(
          "accepted",
        );
      }
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      f.session.stop();
    }
  },
);

test("attempt is durable before delivery; ledger refusal cannot deliver or clear prior bytes", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer(),
    setItem = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key.includes("process-answer-attempts")) throw Error("TEST disk full");
    await setItem(key, value);
  };
  try {
    await f.session.send(command);
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    expect(f.pendingValue()).toBeUndefined();
    f.storage.setItem = setItem;
    f.handlers.send = async (delivered) => {
      const durable = parseProcessAnswerAttempts(
        f.attemptsValue()!,
        address,
        credential().scope,
      );
      expect(durable.attempts).toHaveLength(1);
      expect(durable.attempts[0]!.command).toEqual(delivered);
      expect(durable.attempts[0]!.target.question.question).toBe(
        "TEST question A?",
      );
      return response(runtimeResult(delivered));
    };
    await f.session.send(command);
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

function consumedWork(command: ProcessAnswerCommand) {
  const value = work("B", 8);
  value.native!.process!.answerHistory = [
    {
      commandId: command.commandId,
      questionId: command.questionId,
      answer: command.answer,
    },
  ];
  return value;
}

test.each([
  "command",
  "question",
  "text",
  "conversation",
  "run",
  "digest",
  "actor",
  "endpoint",
  "scope",
  "stale",
])(
  "canonical retirement refuses mismatched %s ownership or exact history",
  async (mismatch) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer(),
      target = captureProcessAnswerTarget(
        f.session.getSnapshot().store!,
        command.workItemId,
      );
    const value = consumedWork(command);
    if (mismatch === "command")
      value.native!.process!.answerHistory![0]!.commandId = "TEST-other";
    if (mismatch === "question")
      value.native!.process!.answerHistory![0]!.questionId = "TEST-other";
    if (mismatch === "text")
      value.native!.process!.answerHistory![0]!.answer = command.answer.trim();
    if (mismatch === "conversation")
      value.conversationId = "TEST-other-conversation";
    if (mismatch === "run")
      value.native!.process!.provenance.runId = "TEST-other";
    if (mismatch === "digest")
      value.native!.process!.provenance.artifactDigest = "b".repeat(64);
    if (mismatch === "actor")
      value.native!.process!.provenance.actorId = "TEST-other";
    const store = {
      ...f.session.getSnapshot().store!,
      workItems: { [value.id]: value },
    };
    if (mismatch === "endpoint") store.connectionKey = "https://TEST-other";
    if (mismatch === "scope") store.scope = credential("b").scope;
    if (mismatch === "stale") store.stale = true;
    try {
      expect(isProcessAnswerConsumed(store, target, command)).toBe(false);
    } finally {
      f.session.stop();
    }
  },
);

test.each(["accepted", "unknown"] as const)(
  "fresh canonical consumed %s retires text permanently even after history is archived",
  async (outcome) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer();
    if (outcome === "unknown")
      f.handlers.send = async () => {
        throw Error("TEST lost result");
      };
    await f.session.send(command);
    f.replaceWork(consumedWork(command));
    // Deliberately leave the old compatibility pending bytes; the empty durable
    // envelope must remain authoritative after canonical redaction and archival.
    const setItem = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (key.includes("command.v2") && value === "null")
        throw Error("TEST stale pending");
      await setItem(key, value);
    };
    f.cache.set(
      `agent-client.command.v2:${f.session.identityKey}`,
      JSON.stringify(command),
    );
    await f.session.refresh();
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.attemptsValue()).not.toContain(command.answer.trim());
    f.replaceWork(work("B", 9));
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      expect(reopened.getSnapshot().answerAttempts).toHaveLength(0);
      expect(reopened.getSnapshot().pending).toBeNull();
      await reopened.retry();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      reopened.stop();
    }
  },
);

test("stale cache history cannot retire original local text without fresh canonical evidence", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer();
  await f.session.send(command);
  await flush();
  const cacheKey = `agent-client.snapshot.v2:${f.session.identityKey}`;
  f.cache.set(
    cacheKey,
    JSON.stringify({ ...f.snapshot(), workItems: [consumedWork(command)] }),
  );
  f.handlers.read = async () => {
    throw Error("TEST offline");
  };
  f.session.stop();
  const reopened = f.open();
  try {
    await reopened.start(false);
    expect(reopened.getSnapshot().answerAttempts[0]!.command.answer).toBe(
      command.answer,
    );
    expect(reopened.getSnapshot().pending).toBeNull();
  } finally {
    reopened.stop();
  }
});

test("known discard is durable before stale pending cleanup and cannot resurrect on reopen", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer();
  await f.session.send(command);
  await flush();
  f.cache.set(
    `agent-client.command.v2:${f.session.identityKey}`,
    JSON.stringify(command),
  );
  expect(await f.session.discardProcessAnswerAttempt(command.commandId)).toBe(
    true,
  );
  expect(f.attemptsValue()).not.toContain(command.answer.trim());
  f.session.stop();
  const reopened = f.open();
  try {
    await reopened.start(false);
    expect(reopened.getSnapshot().answerAttempts).toHaveLength(0);
    expect(reopened.getSnapshot().pending).toBeNull();
  } finally {
    reopened.stop();
  }
});

test.each([
  "malformed",
  "unreadable",
  "foreign-scope",
  "foreign-endpoint",
  "unknown-property",
  "over-limit",
])(
  "%s ledger fails closed without exposing attempts or overwriting stored answers",
  async (damage) => {
    const f = fixture();
    await f.session.start(false);
    await f.session.send(f.answer());
    await flush();
    const key = `agent-client.process-answer-attempts.v1:${f.session.identityKey}`;
    let serialized = f.attemptsValue()!;
    const envelope = JSON.parse(serialized);
    if (damage === "malformed") serialized = "TEST malformed";
    if (damage === "foreign-scope") envelope.scope = credential("b").scope;
    if (damage === "foreign-endpoint")
      envelope.connectionKey = "https://TEST-foreign";
    if (damage === "unknown-property") envelope.businessAuthority = true;
    if (damage === "over-limit")
      envelope.attempts = Array.from(
        { length: PROCESS_ANSWER_ATTEMPTS_LIMIT + 1 },
        (_, index) => ({
          ...envelope.attempts[0],
          command: {
            ...envelope.attempts[0].command,
            commandId: `TEST-${index}`,
          },
        }),
      );
    if (!["malformed", "unreadable"].includes(damage))
      serialized = JSON.stringify(envelope);
    f.cache.set(key, serialized);
    if (damage === "unreadable") {
      const getItem = f.storage.getItem;
      f.storage.getItem = async (readKey) => {
        if (readKey === key) throw Error("TEST unreadable");
        return getItem(readKey);
      };
    }
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      expect(reopened.getSnapshot().answerAttempts).toHaveLength(0);
      expect(reopened.getSnapshot().error).toBe("storage_error");
      await reopened.send(f.answer("TEST-next"));
      expect(f.cache.get(key)).toBe(serialized);
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(1);
    } finally {
      reopened.stop();
    }
  },
);

test("unreadable authoritative ledger blocks every command despite missing legacy pending, then passive refresh restores exact retry", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer(),
    setItem = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (key.includes("command.v2") && value !== "null")
      throw Error("TEST compatibility write lost");
    await setItem(key, value);
  };
  await f.session.send(command);
  expect(f.pendingValue()).toBeUndefined();
  expect(JSON.parse(f.attemptsValue()!).pendingCommandId).toBe(
    command.commandId,
  );
  f.next();
  f.session.stop();
  const getItem = f.storage.getItem;
  let readFails = true;
  f.storage.getItem = async (key) => {
    if (readFails && key.includes("process-answer-attempts"))
      throw Error("TEST ledger unreadable");
    return getItem(key);
  };
  const reopened = f.open();
  try {
    await reopened.start(false);
    expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(true);
    expect(reopened.getSnapshot().pending).toBeNull();
    const durable = f.attemptsValue();
    await reopened.send(
      messageCommand("TEST blocked ordinary D", "en", "TEST-D"),
    );
    await reopened.retry();
    expect(await reopened.interruptPending()).toBe(false);
    expect(f.attemptsValue()).toBe(durable);
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    await reopened.refresh();
    expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(true);
    readFails = false;
    f.storage.setItem = setItem;
    await reopened.refresh();
    expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(false);
    expect(reopened.getSnapshot().pending).toEqual(command);
    expect(
      reopened.getSnapshot().answerAttempts[0]!.target.question.questionId,
    ).toBe("TEST-question-A");
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(0);
    await reopened.retry();
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    reopened.stop();
  }
});

test("retained attempts have a strict growth bound and explicit known discard frees capacity", async () => {
  const f = fixture();
  f.handlers.send = async () =>
    response({ error: "process_question_conflict" }, 409);
  await f.session.start(false);
  try {
    for (let index = 0; index < PROCESS_ANSWER_ATTEMPTS_LIMIT; index++)
      await f.session.send(f.answer(`TEST-${index}`));
    const saved = f.attemptsValue();
    await expect(f.session.send(f.answer("TEST-over-limit"))).rejects.toThrow(
      "process_answer_attempts_full",
    );
    expect(f.attemptsValue()).toBe(saved);
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(
      PROCESS_ANSWER_ATTEMPTS_LIMIT,
    );
    expect(await f.session.discardProcessAnswerAttempt("TEST-0")).toBe(true);
    await f.session.send(f.answer("TEST-over-limit"));
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(
      PROCESS_ANSWER_ATTEMPTS_LIMIT,
    );
  } finally {
    f.session.stop();
  }
});

test("another scoped session never reads or exposes original answer attempts", async () => {
  const f = fixture();
  await f.session.start(false);
  await f.session.send(f.answer());
  await flush();
  f.session.stop();
  const otherCredential = credential("b"),
    engine = new FixtureEngine("b");
  const getItem = jest.fn(f.storage.getItem);
  const scoped = new ClientSession(
    address,
    { ...f.storage, getItem },
    otherCredential,
    async (url) =>
      String(url).endsWith("/auth/session")
        ? response(authInfo(otherCredential))
        : response(engine.snapshot()),
    undefined,
    undefined,
    false,
    { processQuestions: true },
  );
  try {
    await scoped.start(false);
    expect(scoped.getSnapshot().answerAttempts).toHaveLength(0);
    expect(scoped.getSnapshot().pending).toBeNull();
    expect(
      getItem.mock.calls.every(([key]) => !key.includes(f.session.identityKey)),
    ).toBe(true);
  } finally {
    scoped.stop();
  }
});

test("canonical consumption retires old flight without aborting its resume and queues its clear before a listener immediately sends B", async () => {
  const f = fixture(),
    original = gate<Response>(),
    next = gate<Response>();
  let oldSignal: AbortSignal | undefined;
  f.handlers.send = async (_command, signal) => {
    oldSignal = signal;
    return original.promise;
  };
  await f.session.start(false);
  const command = f.answer(),
    send = f.session.send(command);
  await f.sendStarted.promise;
  f.replaceWork(consumedWork(command));
  let nextCommand: ProcessAnswerCommand | undefined,
    nextSend: Promise<void> | undefined;
  f.handlers.send = async () => next.promise;
  const unsubscribe = f.session.subscribe(() => {
    const state = f.session.getSnapshot();
    if (
      !nextCommand &&
      state.answerAttempts.length === 0 &&
      !state.pending &&
      state.store?.workItems["TEST-parent"]?.native?.process?.question
        ?.questionId === "TEST-question-B"
    ) {
      nextCommand = f.answer("TEST-listener-B");
      nextSend = f.session.send(nextCommand);
    }
  });
  try {
    await f.session.refresh();
    await send;
    await flush();
    expect(oldSignal?.aborted).toBe(false);
    expect(nextCommand).toBeDefined();
    expect(f.session.getSnapshot().pending).toEqual(nextCommand);
    expect(f.pendingValue()).toBe(JSON.stringify(nextCommand));
    original.resolve(response(runtimeResult(command)));
    await flush();
    expect(f.session.getSnapshot().pending).toEqual(nextCommand);
    next.resolve(response(runtimeResult(nextCommand!)));
    await nextSend;
  } finally {
    unsubscribe();
    f.session.stop();
  }
});

test("known discard queues pending clear before a listener's immediate B write", async () => {
  const f = fixture(),
    next = gate<Response>(),
    clearing = gate<void>(),
    release = gate<void>();
  await f.session.start(false);
  const command = f.answer(),
    setItem = f.storage.setItem;
  f.storage.setItem = async (key, value) => {
    if (
      key.includes("process-answer-attempts") &&
      JSON.parse(value).attempts[0]?.outcome === "accepted"
    )
      throw Error("TEST outcome write refused");
    await setItem(key, value);
  };
  await f.session.send(command);
  expect(f.session.getSnapshot().pending).toEqual(command);
  f.replaceWork(work("B", 8));
  await f.session.refresh();
  f.storage.setItem = async (key, value) => {
    if (key.includes("command.v2") && value === "null") {
      clearing.resolve();
      await release.promise;
    }
    await setItem(key, value);
  };
  f.handlers.send = async () => next.promise;
  let nextCommand: ProcessAnswerCommand | undefined,
    nextSend: Promise<void> | undefined;
  const unsubscribe = f.session.subscribe(() => {
    const state = f.session.getSnapshot();
    if (!nextCommand && state.answerAttempts.length === 0 && !state.pending) {
      nextCommand = f.answer("TEST-discard-listener-B");
      nextSend = f.session.send(nextCommand);
    }
  });
  try {
    const discard = f.session.discardProcessAnswerAttempt(command.commandId);
    await clearing.promise;
    expect(nextCommand).toBeDefined();
    expect(f.session.getSnapshot().pending).toEqual(nextCommand);
    release.resolve();
    expect(await discard).toBe(true);
    await flush();
    expect(f.pendingValue()).toBe(JSON.stringify(nextCommand));
    expect(
      f.session.getSnapshot().commandStates[commandTarget(nextCommand!)],
    ).toBe("sending");
    next.resolve(response(runtimeResult(nextCommand!)));
    await nextSend;
  } finally {
    unsubscribe();
    f.session.stop();
  }
});

test("maximum control-character and Unicode raw texts obey the same UTF-8 write/read bounds before dispatch", async () => {
  const f = fixture();
  const question = work();
  question.native!.process!.question!.question = "x" + "\u0000".repeat(1999);
  f.replaceWork(question);
  await f.session.start(false);
  f.handlers.send = async (command) => {
    const durable = parseProcessAnswerAttempts(
      f.attemptsValue()!,
      address,
      credential().scope,
    );
    expect(durable.attempts.at(-1)!.command.answer).toBe(command.answer);
    expect(durable.attempts.at(-1)!.target.question.question).toBe(
      question.native!.process!.question!.question,
    );
    return response({ error: "process_question_conflict" }, 409);
  };
  try {
    for (let index = 0; index < PROCESS_ANSWER_ATTEMPTS_LIMIT; index++) {
      const answer =
        index % 2 === 0
          ? "x" + "\u0000".repeat(3999)
          : "Ž" + "🦊".repeat(1999) + "\n";
      await f.session.send({ ...f.answer(`TEST-maximum-${index}`), answer });
    }
    expect(f.attemptsValue()!.length).toBeGreaterThan(600_000);
    const original = f.session.getSnapshot().answerAttempts;
    expect(
      parseProcessAnswerAttempts(
        f.attemptsValue()!,
        address,
        credential().scope,
      ).attempts,
    ).toEqual(original);
    f.session.stop();
    const reopened = f.open();
    try {
      await reopened.start(false);
      expect(reopened.getSnapshot().answerAttempts).toEqual(original);
      expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(false);
      expect(reopened.getSnapshot().pending).toBeNull();
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(PROCESS_ANSWER_ATTEMPTS_LIMIT);
    } finally {
      reopened.stop();
    }
  } finally {
    f.session.stop();
  }
});

test.each([
  "run",
  "process",
  "version",
  "digest",
  "admission",
  "origin-command",
])(
  "self-consistent foreign %s delivery envelope cannot acknowledge the frozen original run",
  async (mismatch) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer(),
      result = runtimeResult(command);
    if (result.admission.status !== "admitted")
      throw Error("TEST admitted fixture required");
    if (mismatch === "run") {
      result.admission.runId = "TEST-other-run";
      result.process!.runId = "TEST-other-run";
    }
    if (mismatch === "process") {
      result.admission.processId = "TEST-other-process";
      result.process!.processId = "TEST-other-process";
    }
    if (mismatch === "version") {
      result.admission.version++;
      result.process!.version++;
    }
    if (mismatch === "digest") result.admission.artifactDigest = "b".repeat(64);
    if (mismatch === "admission")
      result.admission.receiptId = "TEST-other-admission";
    if (mismatch === "origin-command")
      result.admission.commandId = "TEST-other-start";
    f.handlers.send = async () => response(result);
    try {
      await f.session.send(command);
      expect(f.session.getSnapshot().pending).toEqual(command);
      expect(f.session.getSnapshot().answerAttempts[0]!.outcome).toBe(
        "unknown",
      );
      expect(
        f.session.getSnapshot().answerAttempts[0]!.target.provenance.runId,
      ).toBe("TEST-run");
    } finally {
      f.session.stop();
    }
  },
);

test("concurrent initial refresh shares hydration and cannot let an old ledger load erase a new flight", async () => {
  const f = fixture(),
    reading = gate<void>(),
    loaded = gate<void>(),
    original = gate<Response>();
  const attemptsKey = `agent-client.process-answer-attempts.v1:${f.session.identityKey}`;
  f.cache.set(
    attemptsKey,
    JSON.stringify({
      version: 1,
      connectionKey: address,
      scope: credential().scope,
      attempts: [],
      pendingCommandId: null,
    }),
  );
  const getItem = f.storage.getItem;
  let ledgerReads = 0;
  f.storage.getItem = async (key) => {
    const captured = await getItem(key);
    if (key === attemptsKey) {
      ledgerReads++;
      reading.resolve();
      await loaded.promise;
    }
    return captured;
  };
  f.handlers.send = async () => original.promise;
  const first = f.session.start(false);
  await reading.promise;
  const second = f.session.refresh();
  await flush();
  expect(f.session.getSnapshot().status).toBe("connecting");
  expect(
    f.transport.mock.calls.filter(([url]) =>
      String(url).includes("/snapshot?"),
    ),
  ).toHaveLength(0);
  await f.session.send(messageCommand("TEST too early", "en", "TEST-early-D"));
  expect(
    f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(0);
  let command: ProcessAnswerCommand | undefined,
    send: Promise<void> | undefined;
  const unsubscribe = f.session.subscribe(() => {
    if (!command && f.session.getSnapshot().status === "online") {
      command = f.answer();
      send = f.session.send(command);
    }
  });
  try {
    loaded.resolve();
    await Promise.all([first, second]);
    await f.sendStarted.promise;
    expect(ledgerReads).toBe(1);
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(1);
    original.reject(Error("TEST original response lost"));
    await send;
    await f.session.send(
      messageCommand("TEST blocked later D", "en", "TEST-later-D"),
    );
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(
      f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    unsubscribe();
    f.session.stop();
  }
});

test.each([false, true])(
  "fresh exact consumption clears only the current unknown delivery error; failed interruption=%s",
  async (interruptionFailed) => {
    const f = fixture();
    await f.session.start(false);
    const command = f.answer();
    f.handlers.send = async () => {
      throw Error("TEST lost delivery response");
    };
    await f.session.send(command);
    expect(f.session.getSnapshot().error).toBe("network_error");
    if (interruptionFailed) {
      f.handlers.interrupt = async () => {
        throw Error("TEST lost interruption response");
      };
      expect(await f.session.interruptPending()).toBe(false);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
    }
    try {
      f.replaceWork(consumedWork(command));
      await f.session.refresh();
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
      expect(
        f.session.getSnapshot().commandStates[commandTarget(command)],
      ).toBe("accepted");
      expect(f.session.getSnapshot().error).toBeNull();
      // A later refresh proves the private command rejection was cleared too.
      await f.session.refresh();
      expect(f.session.getSnapshot().error).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test("canonical consumption of a known accepted pending attempt preserves its native failure", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer(),
    result = runtimeResult(command),
    setItem = f.storage.setItem;
  result.process = {
    ...result.process!,
    status: "failed",
    failure: { code: "TEST_native_failure" },
  };
  delete result.process.question;
  f.handlers.send = async () => response(result);
  f.storage.setItem = async (key, value) => {
    if (
      key.includes("process-answer-attempts") &&
      JSON.parse(value).attempts[0]?.outcome === "accepted"
    )
      throw Error("TEST known outcome persistence failure");
    await setItem(key, value);
  };
  await f.session.send(command);
  expect(f.session.getSnapshot().pending).toEqual(command);
  expect(f.session.getSnapshot().answerAttempts[0]!.outcome).toBe("accepted");
  expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
  f.storage.setItem = setItem;
  const canonical = consumedWork(command);
  canonical.status = "failed";
  canonical.native!.process!.status = "failed";
  canonical.native!.process!.journalStatus = "failed";
  delete canonical.native!.process!.question;
  f.replaceWork(canonical);
  try {
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
    expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
    await f.session.refresh();
    expect(f.session.getSnapshot().error).toBe("TEST_native_failure");
  } finally {
    f.session.stop();
  }
});

test("schema-valid empty native diagnostic still settles an acknowledged answer once", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer(),
    result = runtimeResult(command);
  result.process = {
    ...result.process!,
    status: "failed",
    failure: { code: "" },
  };
  delete result.process.question;
  f.handlers.send = async () => response(result);
  try {
    await f.session.send(command);
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "accepted",
    );
    expect(f.session.getSnapshot().answerAttempts[0]?.outcome).toBe("accepted");
    expect(f.session.getSnapshot().answerAttempts[0]?.error).toBeNull();
    expect(f.session.getSnapshot().answerAttempts[0]?.command.answer).toBe(
      command.answer,
    );
    await f.session.retry();
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).includes("/processes/commands?"),
      ),
    ).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test("failed canonical redaction retains unknown error ownership until a later durable retirement", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer();
  f.handlers.send = async () => {
    throw Error("TEST lost response");
  };
  await f.session.send(command);
  expect(f.session.getSnapshot().error).toBe("network_error");
  const setItem = f.storage.setItem;
  let fail = true;
  f.storage.setItem = async (key, value) => {
    if (
      fail &&
      key.includes("process-answer-attempts") &&
      JSON.parse(value).attempts.length === 0
    ) {
      fail = false;
      throw Error("TEST redaction failed before commit");
    }
    return setItem(key, value);
  };
  f.replaceWork(consumedWork(command));
  try {
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().answerAttempts[0]?.outcome).toBe("accepted");
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
    expect(f.session.getSnapshot().error).toBeNull();
    await f.session.refresh();
    expect(f.session.getSnapshot().error).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("Retry saving settles the consumed original delivery error before subsequent redaction", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer();
  f.handlers.send = async () => {
    throw Error("TEST lost response");
  };
  await f.session.send(command);
  const setItem = f.storage.setItem;
  let fail = true;
  f.storage.setItem = async (key, value) => {
    if (
      fail &&
      key.includes("process-answer-attempts") &&
      JSON.parse(value).attempts.length === 0
    ) {
      fail = false;
      throw Error("TEST first retirement write failed");
    }
    return setItem(key, value);
  };
  f.replaceWork(consumedWork(command));
  try {
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toEqual(command);
    await f.session.retry();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().error).toBeNull();
    await f.session.refresh();
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
    expect(f.session.getSnapshot().error).toBeNull();
    await f.session.refresh();
    expect(f.session.getSnapshot().error).toBeNull();
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).includes("/processes/commands?"),
      ),
    ).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test("durable discard settles the consumed original delivery error after a failed redaction", async () => {
  const f = fixture();
  await f.session.start(false);
  const command = f.answer();
  f.handlers.send = async () => {
    throw Error("TEST lost response");
  };
  await f.session.send(command);
  expect(f.session.getSnapshot().error).toBe("network_error");
  const setItem = f.storage.setItem;
  let fail = true;
  f.storage.setItem = async (key, value) => {
    if (
      fail &&
      key.includes("process-answer-attempts") &&
      JSON.parse(value).attempts.length === 0
    ) {
      fail = false;
      throw Error("TEST first retirement write failed");
    }
    return setItem(key, value);
  };
  f.replaceWork(consumedWork(command));
  try {
    await f.session.refresh();
    expect(f.session.getSnapshot().pending).toEqual(command);
    expect(f.session.getSnapshot().answerAttempts[0]?.outcome).toBe("accepted");
    expect(await f.session.discardProcessAnswerAttempt(command.commandId)).toBe(
      true,
    );
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().answerAttempts).toHaveLength(0);
    expect(f.session.getSnapshot().error).toBeNull();
    await f.session.refresh();
    expect(f.session.getSnapshot().error).toBeNull();
    expect(
      f.transport.mock.calls.filter(([url]) =>
        String(url).includes("/processes/commands?"),
      ),
    ).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});
