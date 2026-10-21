import { ClientSession, commandTarget } from "../packages/client-core/session";
import {
  PROCESS_EXECUTION_UNVERIFIED,
  processPendingRecoveryError,
} from "../packages/client-core/process-command-notice";
import {
  captureProcessStartTarget,
  captureProcessResolveTarget,
  processStartCommand,
  processResolveCommand,
} from "../packages/client-core/process-commands";
import { messageCommand } from "../packages/client-core/commands";
import { credential, authInfo } from "./auth-fixtures";
import {
  processApprovalFixture,
  approvalResponse as response,
} from "./helpers/process-approval-client";
import {
  processLaunchFixture,
  launchGate,
} from "./helpers/process-launch-client";

const copy = "savedProcessExecutionUnverified";
const conflict = () => response({ error: "process_start_conflict" }, 409);
const sessions: ClientSession[] = [];
const flush = async () => {
  for (let i = 0; i < 100; i++) await Promise.resolve();
};
const pendingKey = (session: ClientSession) =>
  "agent-client.command.v2:" + session.identityKey;
afterEach(() => sessions.splice(0).forEach((session) => session.stop()));

async function fixture(kind: "start" | "resolve") {
  const h =
    kind === "start" ? processLaunchFixture() : processApprovalFixture();
  const open = () => {
    const session = h.open();
    sessions.push(session);
    return session;
  };
  const session = open();
  await session.start(false);
  const pair =
    "cardFor" in h
      ? (() => {
          const entry = h.entries[0]!;
          const card = h.cardFor({
            processId: entry.processId,
            version: entry.version,
            artifactDigest: entry.artifactDigest,
            language: "en",
            origin: {
              type: "command",
              conversationId: "conversation-1",
              requestId: "TEST-conflict-start",
            },
          });
          const target = captureProcessStartTarget(
            session.address,
            credential().scope,
            entry,
            card,
          );
          return {
            target,
            command: processStartCommand(target, {
              commandId: "TEST-original-start",
              idempotencyKey: "TEST-original-start-key",
              input: { name: "  TEST original input\n" },
              language: "en",
            }),
          };
        })()
      : (() => {
          const target = captureProcessResolveTarget(
            session.getSnapshot().store!,
            "TEST-parent",
          );
          return {
            target,
            command: processResolveCommand(
              session.getSnapshot().store!,
              target,
              {
                commandId: "TEST-original-decision",
                idempotencyKey: "TEST-original-decision-key",
                approved: false,
                language: "en",
              },
            ),
          };
        })();
  const originalHandler = h.handlers.command;
  const setReply = (reply: () => Promise<Response> | Response) => {
    h.handlers.command = async () => reply();
  };
  const restoreReply = () => {
    h.handlers.command = originalHandler;
  };
  return { h, session, open, pair, setReply, restoreReply };
}

test.each(["start", "resolve"] as const)(
  "%s exact conflict changes only unknown explanation; two reopens are passive and later receipt settles the same bytes",
  async (kind) => {
    const f = await fixture(kind),
      key = pendingKey(f.session);
    let original = "";
    f.setReply(() => {
      original = f.h.cache.get(key)!;
      return conflict();
    });
    await f.session.send(f.pair.command, false, f.pair.target);
    const saved = JSON.parse(original);
    expect(f.h.cache.get(key)).toBe(
      JSON.stringify({ ...saved, error: PROCESS_EXECUTION_UNVERIFIED }),
    );
    expect(f.session.getSnapshot().processPending).toEqual({
      command: f.pair.command,
      target: f.pair.target,
      outcome: "unknown",
      error: PROCESS_EXECUTION_UNVERIFIED,
    });
    expect(
      f.session.getSnapshot().commandStates[commandTarget(f.pair.command)],
    ).toBe("network_error");
    expect(f.session.getSnapshot().processNotice).toBeNull();
    expect(
      processPendingRecoveryError(
        f.session.getSnapshot().processPending,
        f.session.getSnapshot().error,
      ),
    ).toBe(copy);
    await f.session.refresh();
    await f.session.sync();
    let owner = f.session;
    for (let i = 0; i < 2; i++) {
      owner.stop();
      owner = f.open();
      await owner.start(false);
      await owner.sync();
      expect(owner.getSnapshot().error).toBeNull();
      expect(owner.getSnapshot().processPending?.outcome).toBe("unknown");
      expect(
        processPendingRecoveryError(
          owner.getSnapshot().processPending,
          owner.getSnapshot().error,
        ),
      ).toBe(copy);
      expect(f.h.commands).toEqual([saved.serializedCommand]);
      expect(f.h.cache.get(key)).toBe(
        JSON.stringify({ ...saved, error: PROCESS_EXECUTION_UNVERIFIED }),
      );
    }
    f.restoreReply();
    await owner.retry();
    expect(f.h.commands).toEqual([
      saved.serializedCommand,
      saved.serializedCommand,
    ]);
    expect(owner.getSnapshot().pending).toBeNull();
    expect(f.h.cache.get(key)).toBe("null");
  },
);

const invalidReplies: [string, () => Response][] = [
  ...[200, 202, 400, 404, 406, 422, 429, 500].map(
    (status): [string, () => Response] => [
      "status " + status,
      () => response({ error: "process_start_conflict" }, status),
    ],
  ),
  ["another conflict", () => response({ error: "idempotency_conflict" }, 409)],
  ["unknown cause", () => response({ error: "process_unknown_failure" }, 409)],
  [
    "private marker",
    () => response({ error: PROCESS_EXECUTION_UNVERIFIED }, 409),
  ],
  ["i18n key", () => response({ error: copy }, 409)],
  [
    "foreign scope",
    () =>
      response(
        {
          error: "process_start_conflict",
          scope: { ...credential().scope, userId: "TEST-foreign" },
        },
        409,
      ),
  ],
  [
    "foreign command",
    () =>
      response(
        { error: "process_start_conflict", commandId: "TEST-foreign" },
        409,
      ),
  ],
  [
    "extra field",
    () => response({ error: "process_start_conflict", detail: "TEST" }, 409),
  ],
  ["array", () => response([{ error: "process_start_conflict" }], 409)],
  ["null", () => response(null, 409)],
  [
    "malformed JSON",
    () => ({ ...response(null, 409), text: async () => "{" }) as Response,
  ],
];
test.each(invalidReplies)(
  "%s does not claim an execution explanation",
  async (_name, reply) => {
    const f = await fixture("resolve");
    f.setReply(reply);
    await f.session.send(f.pair.command, false, f.pair.target);
    const state = f.session.getSnapshot();
    expect(state.processPending?.error).toBeNull();
    expect(state.processPending?.outcome).toBe("unknown");
    expect(state.error).toBe("network_error");
    expect(
      processPendingRecoveryError(state.processPending, state.error),
    ).not.toBe(copy);
    expect(
      JSON.parse(f.h.cache.get(pendingKey(f.session))!).serializedCommand,
    ).toBe(f.h.commands[0]);
  },
);

test.each(
  (["start", "resolve"] as const).flatMap((kind) =>
    [PROCESS_EXECUTION_UNVERIFIED, copy, "process_start_conflict"].map(
      (code) => [kind, code] as const,
    ),
  ),
)("%s thrown %s cannot mint presentation metadata", async (kind, code) => {
  const f = await fixture(kind);
  f.setReply(() => {
    throw Error(code);
  });
  await f.session.send(f.pair.command, false, f.pair.target);
  expect(f.session.getSnapshot().processPending?.error).toBeNull();
  expect(
    processPendingRecoveryError(
      f.session.getSnapshot().processPending,
      f.session.getSnapshot().error,
    ),
  ).not.toBe(copy);
});

test.each(
  (["start", "resolve"] as const).flatMap((kind) =>
    [false, true].map((committed) => [kind, committed] as const),
  ),
)(
  "%s rejected metadata write (committed=%s) is unknown, is not read back, and does not publish explanation",
  async (kind, committed) => {
    const f = await fixture(kind),
      key = pendingKey(f.session);
    const originalSet = f.h.cache.set.bind(f.h.cache),
      originalGet = f.h.cache.get.bind(f.h.cache);
    let original = "",
      reads = 0;
    f.setReply(() => {
      original = originalGet(key)!;
      reads = 0;
      return conflict();
    });
    f.h.cache.get = (entry) => {
      reads++;
      return originalGet(entry);
    };
    f.h.cache.set = (entry, value) => {
      if (
        entry === key &&
        JSON.parse(value).error === PROCESS_EXECUTION_UNVERIFIED
      ) {
        if (committed) originalSet(entry, value);
        throw Error("TEST explanation write rejected");
      }
      return originalSet(entry, value);
    };
    await f.session.send(f.pair.command, false, f.pair.target);
    expect(reads).toBe(0);
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(f.session.getSnapshot().processPending?.outcome).toBe("unknown");
    expect(f.session.getSnapshot().processPending?.error).toBeNull();
    expect(
      processPendingRecoveryError(
        f.session.getSnapshot().processPending,
        f.session.getSnapshot().error,
      ),
    ).toBe("storage_error");
    expect(f.h.commands).toHaveLength(1);
    expect(originalGet(key)).toBe(
      committed
        ? JSON.stringify({
            ...JSON.parse(original),
            error: PROCESS_EXECUTION_UNVERIFIED,
          })
        : original,
    );
  },
);

test.each(["start", "resolve"] as const)(
  "%s failed rewrite after durable explanation displays storage error and sends zero additional commands",
  async (kind) => {
    const f = await fixture(kind),
      key = pendingKey(f.session);
    f.setReply(conflict);
    await f.session.send(f.pair.command, false, f.pair.target);
    const original = f.h.cache.get(key),
      set = f.h.cache.set.bind(f.h.cache);
    f.h.cache.set = (entry, value) => {
      if (entry === key) throw Error("TEST retry rewrite rejected");
      return set(entry, value);
    };
    await f.session.retry();
    expect(f.h.commands).toHaveLength(1);
    expect(f.h.cache.get(key)).toBe(original);
    expect(f.session.getSnapshot().processPending?.error).toBe(
      PROCESS_EXECUTION_UNVERIFIED,
    );
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(
      processPendingRecoveryError(
        f.session.getSnapshot().processPending,
        f.session.getSnapshot().error,
      ),
    ).toBe("storage_error");
  },
);

function ownedApprovalFixture() {
  const h = processApprovalFixture();
  const handlers = {
    interrupt: async (_command: unknown): Promise<Response> => {
      throw Error("TEST interruption unavailable");
    },
    ordinary: async (): Promise<Response> => {
      throw Error("TEST D delivery lost");
    },
  };
  const interruptRequests: unknown[] = [];
  const request = jest.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/session")) return response(authInfo());
    if (path.endsWith("/processes/commands/interrupt")) {
      const command = JSON.parse(String(init?.body)).command;
      interruptRequests.push(command);
      return handlers.interrupt(command);
    }
    if (path.endsWith("/processes/commands")) {
      h.commands.push(String(init?.body));
      return h.handlers.command(JSON.parse(String(init?.body)));
    }
    if (path.endsWith("/commands")) return handlers.ordinary();
    if (path.endsWith("/snapshot")) return response(h.snapshot);
    if (path.endsWith("/events")) return response(h.snapshot, 409);
    throw Error("TEST unexpected request");
  }) as jest.MockedFunction<typeof fetch>;
  const session = new ClientSession(
    h.address,
    h.storage,
    credential(),
    request,
    undefined,
    undefined,
    false,
    { processApprovals: true },
  );
  sessions.push(session);
  return { ...h, session, handlers, interruptRequests, request };
}
async function approvalPair(session: ClientSession) {
  await session.start(false);
  const target = captureProcessResolveTarget(
    session.getSnapshot().store!,
    "TEST-parent",
  );
  return {
    target,
    command: processResolveCommand(session.getSnapshot().store!, target, {
      commandId: "TEST-owned-A",
      idempotencyKey: "TEST-owned-A-key",
      approved: true,
      language: "en",
    }),
  };
}

test.each(["stop", "invalidate"] as const)(
  "%s discards a late 409 without rewriting unknown bytes",
  async (cause) => {
    const h = ownedApprovalFixture(),
      pair = await approvalPair(h.session),
      gate = launchGate<Response>();
    // The shared handler is reached only after the original outbox write.
    const request = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (url, init) => {
      if (String(url).includes("/processes/commands?")) {
        h.commands.push(String(init?.body));
        return gate.promise;
      }
      if (
        cause === "invalidate" &&
        new URL(String(url)).pathname.endsWith("/snapshot")
      )
        return response({ error: "auth_expired" }, 401);
      return request(url, init);
    });
    const sending = h.session.send(pair.command, false, pair.target);
    await flush();
    const before = h.cache.get(pendingKey(h.session));
    if (cause === "stop") h.session.stop();
    else await h.session.refresh();
    gate.resolve(conflict());
    await sending;
    expect(h.cache.get(pendingKey(h.session))).toBe(before);
    expect(h.commands).toHaveLength(1);
    expect(h.session.getSnapshot().processPending?.error ?? null).toBeNull();
  },
);

test("explanation is not published before its owned unknown write completes", async () => {
  const h = ownedApprovalFixture(),
    pair = await approvalPair(h.session);
  const write = h.storage.setItem,
    saving = launchGate<void>();
  const request = h.request.getMockImplementation()!;
  h.request.mockImplementation(async (url, init) => {
    if (String(url).includes("/processes/commands?")) {
      h.commands.push(String(init?.body));
      return conflict();
    }
    return request(url, init);
  });
  h.storage.setItem = async (key, value) => {
    if (
      key === pendingKey(h.session) &&
      value !== "null" &&
      JSON.parse(value).error === PROCESS_EXECUTION_UNVERIFIED
    )
      await saving.promise;
    await write(key, value);
  };
  const sending = h.session.send(pair.command, false, pair.target);
  await flush();
  expect(h.session.getSnapshot().processPending?.error).toBeNull();
  expect(JSON.parse(h.cache.get(pendingKey(h.session))!).error).toBeNull();
  expect(h.commands).toHaveLength(1);
  saving.resolve();
  await sending;
  expect(h.session.getSnapshot().processPending?.error).toBe(
    PROCESS_EXECUTION_UNVERIFIED,
  );
});

test.each(["scope", "connection", "bytes"] as const)(
  "reopen rejects a %s damaged unknown marker instead of displaying internal copy",
  async (damage) => {
    const f = await fixture("resolve"),
      key = pendingKey(f.session);
    f.setReply(conflict);
    await f.session.send(f.pair.command, false, f.pair.target);
    const saved = JSON.parse(f.h.cache.get(key)!);
    if (damage === "scope") saved.target.scope.userId = "TEST-foreign";
    if (damage === "connection")
      saved.target.connectionKey = "https://foreign.test/v1/a";
    if (damage === "bytes") saved.serializedCommand += " ";
    f.h.cache.set(key, JSON.stringify(saved));
    f.session.stop();
    const reopened = f.open();
    await reopened.start(false);
    expect(reopened.getSnapshot().answerRecoveryBlocked).toBe(true);
    expect(reopened.getSnapshot().processPending).toBeNull();
    expect(
      processPendingRecoveryError(
        reopened.getSnapshot().processPending,
        reopened.getSnapshot().error,
      ),
    ).not.toBe(copy);
    expect(f.h.commands).toHaveLength(1);
  },
);

test.each(["interruption_failure", "settled_takeover"] as const)(
  "queued explanation loses ownership after %s",
  async (cause) => {
    const h = ownedApprovalFixture(),
      pair = await approvalPair(h.session);
    const delivered = launchGate<Response>(),
      saving = launchGate<void>();
    const request = h.request.getMockImplementation()!;
    h.request.mockImplementation(async (url, init) => {
      if (String(url).includes("/processes/commands?")) {
        h.commands.push(String(init?.body));
        return delivered.promise;
      }
      return request(url, init);
    });
    const sending = h.session.send(pair.command, false, pair.target);
    await flush();
    const key = pendingKey(h.session),
      old = h.cache.get(key),
      set = h.storage.setItem;
    let markerWrites = 0;
    h.storage.setItem = async (entry, value) => {
      if (entry.startsWith("agent-client.snapshot.v2:")) await saving.promise;
      if (
        entry === key &&
        value !== "null" &&
        JSON.parse(value).error === PROCESS_EXECUTION_UNVERIFIED
      )
        markerWrites++;
      await set(entry, value);
    };
    const refresh = h.session.refresh();
    await flush();
    delivered.resolve(conflict());
    await flush();
    if (cause === "settled_takeover") {
      h.handlers.interrupt = async () =>
        response({
          profile: "agent-process-execution/2",
          scope: credential().scope,
          commandId: pair.command.commandId,
          status: "settled",
          result: h.runtime(pair.command),
        });
    }
    const interruption = h.session.interruptPending();
    await flush();
    saving.resolve();
    await refresh;
    const settled = await interruption;
    await sending;
    expect(markerWrites).toBe(0);
    expect(h.commands).toHaveLength(1);
    if (cause === "interruption_failure") {
      expect(settled).toBe(false);
      expect(h.cache.get(key)).toBe(old);
      expect(h.session.getSnapshot().error).toBe("requestInterruptFailed");
    } else {
      expect(settled).toBe(true);
      const next = messageCommand("TEST D", "en", "TEST-D");
      await h.session.send(next);
      expect(h.cache.get(key)).toBe(JSON.stringify(next));
      expect(h.session.getSnapshot().pending).toEqual(next);
      expect(h.session.getSnapshot().processNotice).toBeNull();
    }
  },
);

test.each([PROCESS_EXECUTION_UNVERIFIED, copy])(
  "native notice for raw %s outranks presentation and keeps its real result",
  async (code) => {
    const h = processApprovalFixture(),
      session = h.open();
    sessions.push(session);
    const pair = await approvalPair(session);
    h.handlers.command = async (command) => {
      const value = h.runtime(command);
      return response(
        { ...value, process: { ...value.process, failure: { code } } },
        202,
      );
    };
    const write = h.storage.setItem;
    h.storage.setItem = async (key, value) => {
      if (key === pendingKey(session) && value === "null")
        throw Error("TEST known cleanup unavailable");
      await write(key, value);
    };
    await session.send(pair.command, false, pair.target);
    expect(session.getSnapshot().processPending?.outcome).toBe("accepted");
    expect(session.getSnapshot().processPending?.notice?.rawCode).toBe(code);
    expect(
      processPendingRecoveryError(
        session.getSnapshot().processPending,
        session.getSnapshot().error,
      ),
    ).not.toBe(copy);
    expect(h.commands).toHaveLength(1);
  },
);
