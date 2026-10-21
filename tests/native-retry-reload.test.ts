import { credential, authInfo } from "./auth-fixtures";
import { ClientSession } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { WorkItemSchema } from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const authenticated =
  (request: typeof fetch): typeof fetch =>
  async (url, init) =>
    String(url).endsWith("/auth/session")
      ? response(authInfo())
      : request(url, init);

test("a committed native retry replays the exact attempt after reload without a duplicate message", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const original = messageCommand(
    "TEST find this person's open tasks",
    "cs",
    "TEST-original-native-command",
  );
  const failedWork = WorkItemSchema.parse({
    id: "TEST-native-failed-work",
    revision: 1,
    conversationId: "conversation-1",
    title: "TEST failed lookup",
    context: "TEST the lookup failed",
    status: "failed",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: "TEST-native-failed-work",
      revision: 1,
      sourceCommandId: original.commandId,
    },
    result: "TEST the request could not be completed",
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  });
  let serverSnapshot = engine.snapshot();
  let retryWasCommitted = false;
  const retryBodies: string[] = [];
  const retryResults: unknown[] = [];
  const request = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      const body = String(init.body);
      const command = JSON.parse(body);
      if (command.commandId === "TEST-original-native-command") {
        const result = engine.execute(command, {
          expectedCursor: engine.snapshot().cursor,
          timeZone: "UTC",
          decision: {
            kind: "reply",
            contactId: null,
            title: null,
            localStart: null,
            durationMinutes: null,
            reply: "TEST the first attempt failed",
          },
          terminal: {
            status: "rejected",
            code: "integration_unavailable",
            reply: "TEST the first attempt failed",
          },
        });
        serverSnapshot = result.snapshot;
        serverSnapshot.workItems.push(failedWork);
        return response({ ...result, snapshot: serverSnapshot }, 202);
      }

      retryBodies.push(body);
      const result = engine.execute(command, {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST the retry result",
        },
      });
      retryResults.push(result);
      serverSnapshot = { ...result.snapshot, workItems: [failedWork] };
      if (!retryWasCommitted) {
        retryWasCommitted = true;
        throw new Error("TEST response lost after server commit");
      }
      return response({ ...result, snapshot: serverSnapshot }, 202);
    }
    return response(
      String(url).includes("events?") ? engine.events(0) : serverSnapshot,
    );
  });

  const first = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  await first.start(false);
  await first.send(original);
  const failed = first.getSnapshot().store!.workItems[failedWork.id]!;
  await first.retryNativeWork(failed, "conversation-1", {
    commandId: "TEST-retry-attempt-public",
    idempotencyKey: "TEST-retry-attempt-internal",
  });
  expect(first.getSnapshot().commandStates.chat).toBe("network_error");
  expect(first.getSnapshot().pending).toMatchObject({
    commandId: "TEST-retry-attempt-public",
    idempotencyKey: "TEST-retry-attempt-internal",
    retryOf: original.commandId,
    logicalMessageId: original.commandId,
  });
  first.stop();

  const reopened = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    serverSnapshot = { ...serverSnapshot, workItems: [failedWork] };
    await reopened.start(false);
    expect(reopened.getSnapshot().pending).toMatchObject({
      commandId: "TEST-retry-attempt-public",
      retryOf: original.commandId,
    });
    expect(retryBodies).toHaveLength(1);
    await reopened.retry();
    expect(retryBodies).toHaveLength(2);
    expect(retryBodies[1]).toBe(retryBodies[0]);
    expect(retryResults[1]).toMatchObject({
      commandId: "TEST-retry-attempt-public",
      status: "accepted",
    });
    expect(reopened.getSnapshot().pending).toBeNull();
    const messages = engine
      .snapshot()
      .conversations[0]!.messages.filter(
        (message) =>
          message.role === "user" &&
          message.logicalMessageId === original.commandId,
      );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe(original.text);

    serverSnapshot = {
      ...serverSnapshot,
      workItems: [{ ...failedWork, status: "succeeded" as const }],
    };
    await reopened.refresh();
    const retrySourcesKey = [...values.keys()].find((key) =>
      key.includes("retry-sources.v1"),
    );
    expect(retrySourcesKey).toBeDefined();
    expect(JSON.parse(values.get(retrySourcesKey!)!).commands).toEqual([]);
  } finally {
    reopened.stop();
  }
});

test("successful ordinary chat text is omitted from retry-source storage", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const request = authenticated(async (_url, init) => {
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body));
      const result = engine.execute(command, {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST ordinary response",
        },
      });
      return response(result, 202);
    }
    return response(engine.snapshot());
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await session.start(false);
    await session.send(
      messageCommand("TEST a normal successful message", "en", "TEST-chat"),
    );
    // The snapshot cache is the product's chat-history store; this guards the
    // separate retry envelope from retaining ordinary successful messages.
    const retrySourceEntries = [...values.entries()].filter(([key]) =>
      key.includes("retry-sources.v1"),
    );
    expect(retrySourceEntries).toEqual([]);
  } finally {
    session.stop();
  }
});

test("a native source remains available after reload while its work is active", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const original = messageCommand(
    "TEST preserve this native work source",
    "en",
    "TEST-active-native-command",
  );
  const failedWork = WorkItemSchema.parse({
    id: "TEST-active-native-work",
    revision: 1,
    conversationId: "conversation-1",
    title: "TEST native work",
    context: "TEST pending native work",
    status: "failed",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: "TEST-active-native-work",
      revision: 1,
      sourceCommandId: original.commandId,
    },
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  });
  const activeWork = { ...failedWork, status: "running" as const };
  let serverSnapshot = engine.snapshot();
  const request = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      const result = engine.execute(JSON.parse(String(init.body)), {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST native work started",
        },
      });
      serverSnapshot = { ...result.snapshot, workItems: [activeWork] };
      return response({ ...result, snapshot: serverSnapshot }, 202);
    }
    return response(serverSnapshot);
  });
  const first = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  await first.start(false);
  await first.send(original);
  const retrySourceKey = [...values.keys()].find((key) =>
    key.includes("retry-sources.v1"),
  );
  expect(retrySourceKey).toBeDefined();
  expect(JSON.parse(values.get(retrySourceKey!)!).commands).toEqual([original]);
  first.stop();

  serverSnapshot = { ...serverSnapshot, workItems: [failedWork] };
  const reopened = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await reopened.start(false);
    expect(
      reopened.canRetryNativeWork(
        reopened.getSnapshot().store!.workItems[failedWork.id]!,
        "conversation-1",
      ),
    ).toBe(true);
  } finally {
    reopened.stop();
  }
});

test("retry sources keep more than 64 active and failed native items across reload", async () => {
  const engine = new FixtureEngine();
  const cred = credential();
  const commands = Array.from({ length: 70 }, (_, index) =>
    messageCommand(`TEST native source ${index}`, "en", `TEST-source-${index}`),
  );
  const workItems = commands.map((command, index) =>
    WorkItemSchema.parse({
      id: `TEST-native-work-${index}`,
      revision: 1,
      conversationId: "conversation-1",
      title: `TEST native work ${index}`,
      context: "TEST native work needs its original request",
      status: index % 2 === 0 ? "failed" : "running",
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      native: {
        runId: `TEST-native-work-${index}`,
        revision: 1,
        sourceCommandId: command.commandId,
      },
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    }),
  );
  let serverSnapshot = { ...engine.snapshot(), workItems };
  const values = new Map<string, string>();
  const retrySources = JSON.stringify({
    version: 1,
    connectionKey: "https://fixture/v1/a",
    scope: cred.scope,
    commands,
  });
  const storage = {
    getItem: async (key: string) =>
      key.includes("retry-sources.v1")
        ? (values.get(key) ?? retrySources)
        : (values.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const request = authenticated(async (url) =>
    response(
      String(url).includes("events?") ? engine.events(0) : serverSnapshot,
    ),
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    cred,
    request,
  );
  try {
    await session.start(false);
    for (const command of commands)
      expect(session.getRetrySource(command.commandId)).toEqual(command);
    session.stop();

    const reopened = new ClientSession(
      "https://fixture/v1/a",
      storage,
      cred,
      request,
    );
    try {
      await reopened.start(false);
      for (let index = 0; index < commands.length; index++) {
        const item = reopened.getSnapshot().store!.workItems[
          `TEST-native-work-${index}`
        ]!;
        expect(reopened.canRetryNativeWork(item, "conversation-1")).toBe(
          index % 2 === 0,
        );
      }
    } finally {
      reopened.stop();
    }
  } finally {
    session.stop();
  }
});

test("retry sources respect the byte budget and prioritize a new source and failed work", async () => {
  const engine = new FixtureEngine();
  const cred = credential();
  const makeCommand = (index: number) =>
    messageCommand("ě".repeat(4000), "cs", `TEST-large-source-${index}`);
  const byteLength = (value: string) => new TextEncoder().encode(value).length;
  const envelope = (commands: ReturnType<typeof makeCommand>[]) =>
    JSON.stringify({
      version: 1,
      connectionKey: "https://fixture/v1/a",
      scope: cred.scope,
      commands,
    });
  const commands: ReturnType<typeof makeCommand>[] = [];
  while (commands.length < 500) {
    const next = [...commands, makeCommand(commands.length)];
    if (byteLength(envelope(next)) >= 2_000_000) break;
    commands.push(next[next.length - 1]!);
  }
  expect(commands.length).toBeGreaterThan(64);
  expect(byteLength(envelope(commands))).toBeLessThan(2_000_000);
  const workItemFor = (command: ReturnType<typeof makeCommand>, index: number, status: "failed" | "running") =>
    WorkItemSchema.parse({
      id: `TEST-large-native-work-${index}`,
      revision: 1,
      conversationId: "conversation-1",
      title: `TEST native work ${index}`,
      context: "TEST native source retained for retry",
      status,
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      native: {
        runId: `TEST-large-native-work-${index}`,
        revision: 1,
        sourceCommandId: command.commandId,
      },
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    });
  const originalWorkItems = commands.map((command, index) =>
    workItemFor(command, index, index < 30 ? "failed" : "running"),
  );
  let serverSnapshot = { ...engine.snapshot(), workItems: originalWorkItems };
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) =>
      key.includes("retry-sources.v1")
        ? (values.get(key) ?? envelope(commands))
        : (values.get(key) ?? null),
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const request = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body));
      const result = engine.execute(command, {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST large source accepted",
        },
      });
      const newWork = workItemFor(command, originalWorkItems.length, "running");
      serverSnapshot = {
        ...result.snapshot,
        workItems: [...originalWorkItems, newWork],
      };
      return response({ ...result, snapshot: serverSnapshot }, 202);
    }
    return response(
      String(url).includes("events?") ? engine.events(0) : serverSnapshot,
    );
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    cred,
    request,
  );
  try {
    await session.start(false);
    const candidate = makeCommand(999);
    expect(byteLength(envelope([...commands, candidate]))).toBeGreaterThan(
      2_000_000,
    );
    await session.send(candidate);
    const saved = [...values.entries()].find(([key]) =>
      key.includes("retry-sources.v1"),
    )?.[1];
    expect(saved).toBeDefined();
    expect(byteLength(saved!)).toBeLessThan(2_000_000);
    const retained = JSON.parse(saved!).commands as typeof commands;
    const retainedIds = new Set(retained.map((command) => command.commandId));
    expect(retainedIds.has(candidate.commandId)).toBe(true);
    for (const command of commands.slice(0, 30))
      expect(retainedIds.has(command.commandId)).toBe(true);
    expect(commands.slice(30).some((command) => !retainedIds.has(command.commandId))).toBe(true);
  } finally {
    session.stop();
  }
});

test("a stale refresh cannot restore retry text after newer work succeeds", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  let releaseCleanup!: () => void;
  let cleanupStarted!: () => void;
  const cleanupStartedPromise = new Promise<void>((resolve) => {
    cleanupStarted = resolve;
  });
  const cleanupGate = new Promise<void>((resolve) => {
    releaseCleanup = resolve;
  });
  let blockCleanup = false;
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (
        blockCleanup &&
        key.includes("retry-sources.v1") &&
        JSON.parse(value).commands.length === 0
      ) {
        cleanupStarted();
        await cleanupGate;
      }
      values.set(key, value);
    },
  };
  const original = messageCommand(
    "TEST remove this completed native source",
    "en",
    "TEST-race-native-command",
  );
  const work = (status: "failed" | "succeeded") =>
    WorkItemSchema.parse({
      id: "TEST-race-native-work",
      revision: status === "failed" ? 1 : 2,
      conversationId: "conversation-1",
      title: "TEST native work",
      context: "TEST native work result",
      status,
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      native: {
        runId: "TEST-race-native-work",
        revision: status === "failed" ? 1 : 2,
        sourceCommandId: original.commandId,
      },
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    });
  let oldSnapshot = engine.snapshot();
  let refreshResponse: unknown | null = null;
  const request = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      const result = engine.execute(JSON.parse(String(init.body)), {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST native work failed",
        },
      });
      oldSnapshot = { ...result.snapshot, workItems: [work("failed")] };
      return response({ ...result, snapshot: oldSnapshot }, 202);
    }
    return response(refreshResponse ?? oldSnapshot);
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await session.start(false);
    await session.send(original);
    expect(
      [...values.entries()].some(
        ([key, value]) =>
          key.includes("retry-sources.v1") &&
          JSON.parse(value).commands.length === 1,
      ),
    ).toBe(true);
    const newerSnapshot = {
      ...oldSnapshot,
      cursor: oldSnapshot.cursor + 2,
      workItems: [work("succeeded")],
    };
    blockCleanup = true;
    refreshResponse = newerSnapshot;
    const successRefresh = session.refresh();
    await cleanupStartedPromise;

    // The older response arrives while successful-source cleanup is waiting on storage.
    refreshResponse = oldSnapshot;
    const staleRefresh = session.refresh();
    expect(
      session.getSnapshot().store!.workItems[work("succeeded").id]?.status,
    ).toBe("succeeded");
    releaseCleanup();
    await Promise.all([successRefresh, staleRefresh]);

    const retrySourcesKey = [...values.keys()].find((key) =>
      key.includes("retry-sources.v1"),
    );
    expect(retrySourcesKey).toBeDefined();
    expect(JSON.parse(values.get(retrySourcesKey!)!).commands).toEqual([]);
    expect(
      session.getSnapshot().store!.workItems[work("succeeded").id]?.status,
    ).toBe("succeeded");
  } finally {
    releaseCleanup();
    session.stop();
  }
});

test("a later refresh retries failed retry-source cleanup while retries stay blocked", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  let failCleanupOnce = false;
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (
        failCleanupOnce &&
        key.includes("retry-sources.v1") &&
        JSON.parse(value).commands.length === 0
      ) {
        failCleanupOnce = false;
        throw Error("TEST transient storage failure");
      }
      values.set(key, value);
    },
  };
  const original = messageCommand(
    "TEST source to remove after success",
    "en",
    "TEST-cleanup-retry-command",
  );
  const nativeWork = (status: "failed" | "succeeded") =>
    WorkItemSchema.parse({
      id: "TEST-cleanup-retry-work",
      revision: status === "failed" ? 1 : 2,
      conversationId: "conversation-1",
      title: "TEST cleanup work",
      context: "TEST cleanup result",
      status,
      inputRequestIds: [],
      actionProposalIds: [],
      operationIds: [],
      demo: false,
      native: {
        runId: "TEST-cleanup-retry-work",
        revision: status === "failed" ? 1 : 2,
        sourceCommandId: original.commandId,
      },
      presentation: {
        type: "workflow.progress",
        version: 1,
        variant: "default",
      },
    });
  let snapshot = engine.snapshot();
  const request = authenticated(async (_url, init) => {
    if (init?.method === "POST") {
      const result = engine.execute(JSON.parse(String(init.body)), {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST native work failed",
        },
      });
      snapshot = { ...result.snapshot, workItems: [nativeWork("failed")] };
      return response({ ...result, snapshot }, 202);
    }
    return response(snapshot);
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await session.start(false);
    await session.send(original);
    const retrySourcesKey = [...values.keys()].find((key) =>
      key.includes("retry-sources.v1"),
    )!;
    expect(JSON.parse(values.get(retrySourcesKey)!).commands).toHaveLength(1);

    snapshot = {
      ...snapshot,
      cursor: snapshot.cursor + 2,
      workItems: [nativeWork("succeeded")],
    };
    failCleanupOnce = true;
    await session.refresh();
    expect(JSON.parse(values.get(retrySourcesKey)!).commands).toHaveLength(1);
    expect(
      session.canRetryNativeWork(
        session.getSnapshot().store!.workItems[nativeWork("succeeded").id]!,
        "conversation-1",
      ),
    ).toBe(false);

    await session.refresh();
    expect(JSON.parse(values.get(retrySourcesKey)!).commands).toEqual([]);
  } finally {
    session.stop();
  }
});

test("a failed initial source save keeps the exact command in the outbox", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  let failSourceSaveOnce = true;
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      if (
        failSourceSaveOnce &&
        key.includes("retry-sources.v1") &&
        JSON.parse(value).commands.length === 1
      ) {
        failSourceSaveOnce = false;
        throw Error("TEST transient source save failure");
      }
      values.set(key, value);
    },
  };
  const original = messageCommand(
    "TEST preserve this command until its retry source is safe",
    "en",
    "TEST-outbox-before-source-command",
  );
  const failedWork = WorkItemSchema.parse({
    id: "TEST-outbox-before-source-work",
    revision: 1,
    conversationId: "conversation-1",
    title: "TEST native work failed",
    context: "TEST native work failure",
    status: "failed",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: "TEST-outbox-before-source-work",
      revision: 1,
      sourceCommandId: original.commandId,
    },
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  });
  let serverSnapshot = engine.snapshot();
  const postBodies: string[] = [];
  const request = authenticated(async (_url, init) => {
    if (init?.method === "POST") {
      const body = String(init.body);
      postBodies.push(body);
      const result = engine.execute(JSON.parse(body), {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST native failure with retry source",
        },
        terminal: {
          status: "rejected",
          code: "integration_unavailable",
          reply: "TEST native failure with retry source",
        },
      });
      serverSnapshot = { ...result.snapshot, workItems: [failedWork] };
      return response({ ...result, snapshot: serverSnapshot }, 202);
    }
    return response(serverSnapshot);
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await session.start(false);
    await session.send(original);
    expect(session.getSnapshot().pending).toEqual(original);
    const outboxKey = [...values.keys()].find((key) =>
      key.includes("command.v2"),
    )!;
    expect(JSON.parse(values.get(outboxKey)!)).toEqual(original);
    expect(postBodies).toHaveLength(1);

    await session.retry();
    expect(postBodies).toHaveLength(2);
    expect(postBodies[1]).toBe(postBodies[0]);
    expect(session.getSnapshot().pending).toBeNull();
    const retrySourcesKey = [...values.keys()].find((key) =>
      key.includes("retry-sources.v1"),
    )!;
    expect(JSON.parse(values.get(retrySourcesKey)!).commands).toEqual([
      original,
    ]);
  } finally {
    session.stop();
  }
});
