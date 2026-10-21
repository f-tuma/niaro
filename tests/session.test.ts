import { credential, authInfo } from "./auth-fixtures";
import { ClientSession } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { WorkItemSchema } from "../packages/protocol";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
} from "../packages/client-core/commands";
const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
};
test.each([
  "catalog_budget_exhausted",
  "catalog_model_required",
  "catalog_not_found",
])(
  "definitive server rejection %s releases pending input and preserves the cause",
  async (code) => {
    const e = new FixtureEngine();
    const storage = memory();
    let posts = 0;
    const request = authenticated(async (_url, init) => {
      if (init?.method === "POST") {
        posts++;
        return response({ error: code }, 429);
      }
      return response(e.snapshot());
    });
    const s = new ClientSession(
      "https://fixture/v1/a",
      storage,
      credential(),
      request,
    );
    try {
      await s.start(false);
      await s.send(messageCommand("A request", "en", "first"));
      expect(s.getSnapshot().error).toBe(code);
      expect(s.getSnapshot().commandStates.chat).toBe("rejected");
      expect(s.getSnapshot().pending).toBeNull();
      await s.refresh();
      expect(s.getSnapshot().error).toBe(code);
      await s.retry();
      expect(posts).toBe(1);
      await s.send(messageCommand("Another request", "en", "second"));
      expect(posts).toBe(2);
    } finally {
      s.stop();
    }
  },
);
test("a revision conflict releases input and its reason survives polling and refresh", async () => {
  const e = new FixtureEngine();
  const request = authenticated(async (url, init) =>
    response(
      init?.method === "POST"
        ? {
            commandId: "conflict",
            status: "conflict",
            code: "revision_conflict",
            snapshot: e.snapshot(),
          }
        : String(url).includes("events?")
          ? e.events(0)
          : e.snapshot(),
    ),
  );
  const s = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    request,
  );
  try {
    await s.start(false);
    await s.send(messageCommand("TEST expired source", "en", "conflict"));
    expect(s.getSnapshot().pending).toBeNull();
    expect(s.getSnapshot().error).toBe("revision_conflict");
    await s.sync();
    await s.refresh();
    expect(s.getSnapshot().error).toBe("revision_conflict");
  } finally {
    s.stop();
  }
});
const authenticated =
  (request: typeof fetch): typeof fetch =>
  async (url, init) =>
    String(url).endsWith("/auth/session")
      ? response(authInfo())
      : request(url, init);
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
test("explicit native retry uses the persisted original command and keeps one logical chat message", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const posts: unknown[] = [];
  const retryWork = WorkItemSchema.parse({
    id: "TEST-native-failed-work",
    revision: 1,
    conversationId: "conversation-1",
    title: "TEST failed request",
    context: "TEST failed",
    status: "failed",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    native: {
      runId: "TEST-native-failed-work",
      revision: 1,
      sourceCommandId: "TEST-original-failed-loop",
    },
    result: "TEST failed explanation",
    presentation: {
      type: "workflow.progress",
      version: 1,
      variant: "default",
    },
  });
  const withRetryWork = <T extends { snapshot: { workItems: unknown[] } }>(
    result: T,
  ) => {
    result.snapshot.workItems.push(retryWork);
    return result;
  };
  const request = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      const command = JSON.parse(String(init.body));
      posts.push(command);
      const result = withRetryWork(engine.execute(command, {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST assistant response",
        },
        terminal: {
          status: "rejected",
          code: "integration_unavailable",
          reply: "TEST assistant response",
        },
      }));
      return response(result, 202);
    }
    const snapshot = engine.snapshot();
    snapshot.workItems.push(retryWork);
    return response(
      String(url).includes("events?") ? engine.events(0) : snapshot,
    );
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    request,
  );
  try {
    await session.start(false);
    const original = messageCommand(
      "TEST retry this failed native task",
      "cs",
      "TEST-original-failed-loop",
    );
    await session.send(original);
    const failed =
      session.getSnapshot().store!.workItems["TEST-native-failed-work"]!;
    expect(session.canRetryNativeWork(failed, "conversation-1")).toBe(true);
    const retrySourcesKey = `agent-client.retry-sources.v1:${session.identityKey}`;
    const sourceBeforeRetry = JSON.parse(values.get(retrySourcesKey)!);
    expect(sourceBeforeRetry.commands).toEqual([original]);
    await session.retryNativeWork(failed, "conversation-1", {
      commandId: "TEST-retry-public",
      idempotencyKey: "TEST-retry-internal",
    });
    expect(posts).toHaveLength(2);
    expect(posts[1]).toMatchObject({
      commandId: "TEST-retry-public",
      idempotencyKey: "TEST-retry-internal",
      retryOf: "TEST-original-failed-loop",
      logicalMessageId: "TEST-original-failed-loop",
      text: original.text,
      language: original.language,
    });
    expect(
      engine
        .snapshot()
        .conversations[0]!.messages.filter(
          (message) =>
            message.role === "user" &&
            message.logicalMessageId === "TEST-original-failed-loop",
        ),
    ).toHaveLength(1);

    const reopened = new ClientSession(
      "https://fixture/v1/a",
      storage,
      credential(),
      request,
    );
    await reopened.start(false);
    expect(reopened.getRetrySource(original.commandId)).toEqual(original);
    reopened.stop();
  } finally {
    session.stop();
  }
});
test("a confirmed message keeps its receipt when retry source persistence fails", async () => {
  const engine = new FixtureEngine();
  const values = new Map<string, string>();
  let posts = 0;
  const address = "https://fixture/v1/a";
  const session = new ClientSession(
    address,
    {
      getItem: async (key) => values.get(key) ?? null,
      setItem: async (key, value) => {
        if (key === `agent-client.retry-sources.v1:${session.identityKey}`)
          throw Error("TEST source persistence failure");
        values.set(key, value);
      },
    },
    credential(),
    authenticated(async (_url, init) => {
      if (init?.method !== "POST") return response(engine.snapshot());
      posts++;
      const result = engine.execute(JSON.parse(String(init?.body)), {
        expectedCursor: engine.snapshot().cursor,
        timeZone: "UTC",
        decision: {
          kind: "reply",
          contactId: null,
          title: null,
          localStart: null,
          durationMinutes: null,
          reply: "TEST assistant response",
        },
        terminal: {
          status: "rejected",
          code: "integration_unavailable",
          reply: "TEST assistant response",
        },
      });
      result.snapshot.workItems.push(
        WorkItemSchema.parse({
          id: "TEST-native-failed-work",
          revision: 1,
          conversationId: "conversation-1",
          title: "TEST failed request",
          context: "TEST failed",
          status: "failed",
          inputRequestIds: [],
          actionProposalIds: [],
          operationIds: [],
          demo: false,
          native: {
            runId: "TEST-native-failed-work",
            revision: 1,
            sourceCommandId: "TEST-source-fail",
          },
          result: "TEST failed explanation",
          presentation: {
            type: "workflow.progress",
            version: 1,
            variant: "default",
          },
        }),
      );
      return response(result, 202);
    }),
  );
  try {
    await session.start(false);
    await session.send(
      messageCommand("TEST source cannot be saved", "en", "TEST-source-fail"),
    );
    expect(posts).toBe(1);
    expect(session.getSnapshot().commandStates.chat).toBe("rejected");
    expect(session.getSnapshot().pending).toMatchObject({
      commandId: "TEST-source-fail",
    });
    expect(session.getSnapshot().error).toBe("storage_error");
  } finally {
    session.stop();
  }
});
test("safe model errors retain the exact command for explicit retry and survive polling", async () => {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "model-error");
  let fail = true;
  const request: typeof fetch = authenticated(async (url, init) => {
    if (init?.method === "POST") {
      if (fail) return response({ error: "model_timeout" }, 503);
      return response(engine.execute(command), 202);
    }
    return response(
      String(url).includes("events?") ? engine.events(0) : engine.snapshot(),
    );
  });
  const session = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    request,
  );
  try {
    await session.start(false);
    await session.send(command);
    expect(session.getSnapshot().error).toBe("model_timeout");
    expect(session.getSnapshot().pending).toEqual(command);
    await session.sync();
    expect(session.getSnapshot().error).toBe("model_timeout");
    fail = false;
    await session.retry();
    expect(session.getSnapshot().pending).toBeNull();
    expect(engine.snapshot().workItems).toHaveLength(1);
  } finally {
    session.stop();
  }
});
test("uncertain delivery restores pending command, never auto-sends, retries same ID", async () => {
  const e = new FixtureEngine(),
    storage = memory();
  let sends = 0;
  let fail = true;
  const request = jest.fn(async (_url, init) => {
    if (init?.method === "POST") {
      sends++;
      const result = e.execute(JSON.parse(init.body as string));
      if (fail) {
        fail = false;
        throw new Error("response lost");
      }
      return response(result, 202);
    }
    return response(e.snapshot());
  }) as jest.MockedFunction<typeof fetch>;
  const first = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await first.start(false);
  await first.send(messageCommand("Choose Peter", "en", "command-1"));
  expect(first.getSnapshot().commandStates.chat).toBe("network_error");
  first.stop();
  const reopened = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await reopened.start(false);
  expect(sends).toBe(1);
  expect(reopened.getSnapshot().store?.workItems["work-1"]?.status).toBe(
    "waiting_input",
  );
  await reopened.retry();
  expect(sends).toBe(2);
  expect(e.snapshot().workItems).toHaveLength(1);
  expect(reopened.getSnapshot().pending).toBe(null);
  reopened.stop();
});
test("local sending does not resolve, duplicate clicks are gated", async () => {
  const e = new FixtureEngine();
  const input = e.execute(messageCommand("Choose Peter", "en", "start"))
    .snapshot.inputRequests[0]!;
  let resolveRequest!: (response: Response) => void;
  let markDelivery!: () => void;
  const delivered = new Promise<void>((resolve) => {
    markDelivery = resolve;
  });
  const request = jest.fn(async (_url, init) => {
    if (init?.method === "POST") {
      markDelivery();
      return new Promise<Response>((resolve) => {
        resolveRequest = resolve;
      });
    }
    return response(e.snapshot());
  }) as jest.MockedFunction<typeof fetch>;
  const s = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    authenticated(request),
  );
  await s.start(false);
  const command = answerCommand(input, "peter-novak", "answer");
  const promise = s.send(command);
  await Promise.resolve();
  expect(s.getSnapshot().commandStates[input.id]).toBe("sending");
  expect(s.getSnapshot().store?.inputRequests[input.id]?.status).toBe("open");
  await s.send(command);
  await delivered;
  expect(request).toHaveBeenCalledTimes(2);
  resolveRequest(response(e.execute(command), 202));
  await promise;
  expect(s.getSnapshot().store?.inputRequests[input.id]?.status).toBe(
    "resolved",
  );
  s.stop();
});

test("a confirmed answer remains accepted when saving its cache fails", async () => {
  const e = new FixtureEngine();
  const storage = memory();
  let failCache = false;
  const originalWrite = storage.setItem;
  storage.setItem = async (key, value) => {
    if (failCache && key.includes("snapshot")) throw new Error("disk full");
    await originalWrite(key, value);
  };
  const request = jest.fn(async (_url, init) =>
    response(
      init?.method === "POST"
        ? e.execute(JSON.parse(init.body as string))
        : e.snapshot(),
    ),
  ) as jest.MockedFunction<typeof fetch>;
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await s.start(false);
  failCache = true;
  await s.send(messageCommand("Choose Peter", "en", "confirmed"));
  expect(s.getSnapshot().commandStates.chat).toBe("accepted");
  expect(s.getSnapshot().pending).toBeNull();
  expect(s.getSnapshot().error).toBe("storage_error");
  expect(s.getSnapshot().status).toBe("online");
  s.stop();
});

test("failure to persist an unsent command never sends it or reports uncertain delivery", async () => {
  const e = new FixtureEngine();
  const storage = memory();
  storage.setItem = async (key) => {
    if (key.includes("command")) throw new Error("disk full");
  };
  const request = jest.fn(async () => response(e.snapshot()));
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await s.start(false);
  await s.send(messageCommand("Choose Peter", "en", "unsent"));
  expect(request).toHaveBeenCalledTimes(1);
  expect(s.getSnapshot().pending).toBeNull();
  expect(s.getSnapshot().commandStates.chat).toBe("idle");
  expect(s.getSnapshot().error).toBe("storage_error");
  s.stop();
});

test("disconnect during command persistence prevents a later POST from the old session", async () => {
  const e = new FixtureEngine();
  const storage = memory();
  let completeWrite!: () => void;
  let markWrite!: () => void;
  const writeStarted = new Promise<void>((resolve) => {
    markWrite = resolve;
  });
  const originalWrite = storage.setItem;
  storage.setItem = async (key, value) => {
    if (key.includes("command"))
      await new Promise<void>((resolve) => {
        completeWrite = resolve;
        markWrite();
      });
    await originalWrite(key, value);
  };
  const request = jest.fn(async () => response(e.snapshot()));
  const s = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await s.start(false);
  const pending = s.send(messageCommand("Choose Peter", "en", "stopped"));
  await writeStarted;
  s.stop();
  completeWrite();
  await pending;
  expect(request).toHaveBeenCalledTimes(1);
});

test("background event polling keeps a command rejection visible", async () => {
  const e = new FixtureEngine();
  const request = jest.fn(async (url, init) =>
    response(
      init?.method === "POST"
        ? e.execute(JSON.parse(init.body as string))
        : String(url).includes("events?")
          ? e.events(0)
          : e.snapshot(),
    ),
  ) as jest.MockedFunction<typeof fetch>;
  const s = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    authenticated(request),
  );
  await s.start(false);
  await s.send(messageCommand("Unknown demo phrase", "en", "rejected"));
  await s.sync();
  expect(s.getSnapshot().status).toBe("online");
  expect(s.getSnapshot().error).toBe("unsupported_phrase");
  expect(s.getSnapshot().pending).toBeNull();
  s.stop();
});

test("lost approval receipt retries the same operation after reconnect, never starts a second one", async () => {
  let clock = Date.UTC(2026, 8, 24);
  const e = new FixtureEngine("a", undefined, undefined, () => clock);
  e.execute(messageCommand("Choose Peter", "en", "approval-start"));
  e.execute(
    answerCommand(
      e.snapshot().inputRequests[0]!,
      "peter-novak",
      "approval-answer",
    ),
  );
  clock += 4000;
  e.tick();
  const proposal = e.snapshot().actionProposals[0]!;
  const storage = memory();
  let lost = true;
  let posts = 0;
  const request = jest.fn(async (_url, init) => {
    if (init?.method === "POST") {
      posts++;
      const result = e.execute(JSON.parse(init.body as string));
      if (lost) {
        lost = false;
        throw Error("receipt lost");
      }
      return response(result, 202);
    }
    return response(e.snapshot());
  }) as jest.MockedFunction<typeof fetch>;
  const first = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await first.start(false);
  const command = proposalDecision(proposal, "approve", "approval-command");
  await first.send(command);
  expect(first.getSnapshot().commandStates[proposal.id]).toBe("network_error");
  first.stop();
  const reopened = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    authenticated(request),
  );
  await reopened.start(false);
  expect(posts).toBe(1);
  expect(e.snapshot().operations).toHaveLength(1);
  expect(reopened.getSnapshot().pending).toEqual(command);
  await reopened.retry();
  expect(posts).toBe(2);
  expect(e.snapshot().operations).toHaveLength(1);
  expect(reopened.getSnapshot().pending).toBeNull();
  reopened.stop();
});
