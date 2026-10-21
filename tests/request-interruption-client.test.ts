import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import { FixtureEngine } from "../apps/fixture-server/engine";
import type { CommandResult } from "../packages/protocol";
import {
  REQUEST_INTERRUPTION_PROFILE,
  RequestInterruptionRequestSchema,
} from "../packages/protocol/request-interruption";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { REPLY_CORRELATION_PROFILE } from "../packages/protocol/reply-correlation";
import { authInfo, credential } from "./auth-fixtures";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const gate = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
function fixture(ignoreAbort = false) {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "interrupted-C");
  const original = gate<Response>();
  const ack = gate<Response>();
  const delivered = gate<void>();
  const requestedInterruption = gate<void>();
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  let originalSignal: AbortSignal | undefined;
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("/auth/session")) return response(authInfo());
      if (String(url).includes("/commands/interrupt?")) {
        requestedInterruption.resolve();
        return ack.promise;
      }
      if (init?.method === "POST") {
        originalSignal = init.signal ?? undefined;
        if (!ignoreAbort)
          init.signal?.addEventListener("abort", () =>
            original.reject(new Error("aborted")),
          );
        delivered.resolve();
        return original.promise;
      }
      return response(engine.snapshot());
    },
  );
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage,
    credential(),
    transport,
  );
  const result = () => engine.execute(command);
  const settled = (result: CommandResult) => ({
    profile: REQUEST_INTERRUPTION_PROFILE,
    scope: credential().scope,
    commandId: command.commandId,
    status: "settled" as const,
    result,
  });
  return {
    session,
    engine,
    command,
    original,
    ack,
    delivered,
    requestedInterruption,
    transport,
    result,
    settled,
    cache,
    storage,
    signal: () => originalSignal!,
  };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each([false, true])(
  "ACK retires the original send, including ignored abort=%s",
  async (ignoreAbort) => {
    const f = fixture(ignoreAbort);
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await f.delivered.promise;
      const interruption = f.session.interruptPending();
      expect(f.session.interruptPending()).toBe(interruption);
      await f.requestedInterruption.promise;
      const result = f.result();
      f.ack.resolve(response(f.settled(result)));
      expect(await interruption).toBe(true);
      await send;
      expect(f.signal().aborted).toBe(true);
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().commandStates.chat).toBe("accepted");
      expect(f.session.getSnapshot().store?.cursor).toBe(
        result.snapshot.cursor,
      );
      const request = f.transport.mock.calls.find(([url]) =>
        String(url).includes("/commands/interrupt?"),
      )!;
      const path = new URL(String(request[0]));
      expect(path.searchParams.get("cards")).toBe(CARD_PROFILE);
      expect(path.searchParams.get("replies")).toBe(REPLY_CORRELATION_PROFILE);
      expect(
        RequestInterruptionRequestSchema.parse(
          JSON.parse(String(request[1]?.body)),
        ),
      ).toEqual({
        profile: REQUEST_INTERRUPTION_PROFILE,
        command: f.command,
      });
      if (ignoreAbort) f.original.resolve(response(result));
      await flush();
      expect(f.session.getSnapshot().error).toBeNull();
      expect(
        [...f.cache.entries()].find(([key]) => key.includes("command"))?.[1],
      ).toBe("null");
    } finally {
      f.session.stop();
    }
  },
);

test("the original result retires an interruption whose ACK is lost", async () => {
  const f = fixture(true);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await f.delivered.promise;
    const interruption = f.session.interruptPending();
    await f.requestedInterruption.promise;
    f.original.resolve(response(f.result()));
    expect(await interruption).toBe(true);
    await send;
    f.ack.reject(new Error("receipt lost"));
    await flush();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().error).toBeNull();
  } finally {
    f.session.stop();
  }
});

test.each(["lost", "not_running", "not_settled"])(
  "%s interruption retains the exact pending command and permits explicit interruption retry",
  async (reason) => {
    const f = fixture(true);
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await f.delivered.promise;
      const interruption = f.session.interruptPending();
      await f.requestedInterruption.promise;
      if (reason === "lost") f.ack.reject(new Error("receipt lost"));
      else
        f.ack.resolve(
          response({
            profile: REQUEST_INTERRUPTION_PROFILE,
            scope: credential().scope,
            commandId: f.command.commandId,
            status: "unknown",
            reason,
          }),
        );
      expect(await interruption).toBe(false);
      expect(f.signal().aborted).toBe(false);
      expect(f.session.getSnapshot().pending).toEqual(f.command);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      await f.session.refresh();
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      await f.session.send(messageCommand("New input", "en", "blocked-D"));
      expect(
        f.transport.mock.calls.filter(([, init]) => init?.method === "POST"),
      ).toHaveLength(2);
      expect(await f.session.interruptPending()).toBe(false);
      const bodies = f.transport.mock.calls.filter(([url]) =>
        String(url).includes("/commands/interrupt?"),
      );
      expect(bodies).toHaveLength(2);
      expect(bodies[0]![1]?.body).toBe(bodies[1]![1]?.body);
      f.original.resolve(response(f.result()));
      await send;
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().error).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test.each(["scope", "command", "result-scope", "result-command"])(
  "a mismatched %s ACK cannot retire the original flight",
  async (mismatch) => {
    const f = fixture(true);
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await f.delivered.promise;
      const interruption = f.session.interruptPending();
      await f.requestedInterruption.promise;
      const result = f.result();
      const ack = f.settled(result);
      if (mismatch === "scope") ack.scope = credential("b").scope;
      if (mismatch === "command") ack.commandId = "other";
      if (mismatch === "result-scope")
        ack.result = {
          ...result,
          snapshot: { ...result.snapshot, scope: credential("b").scope },
        };
      if (mismatch === "result-command")
        ack.result = { ...result, commandId: "other" };
      f.ack.resolve(response(ack));
      expect(await interruption).toBe(false);
      expect(f.signal().aborted).toBe(false);
      expect(f.session.getSnapshot().pending).toEqual(f.command);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      f.original.resolve(response(result));
      await send;
      expect(f.session.getSnapshot().pending).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test("new command state and cache survive the old transport and delayed outcome persistence", async () => {
  const f = fixture(true);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await f.delivered.promise;
    const cacheWrite = gate<void>();
    const originalWrite = f.storage.setItem;
    let blockCache = true;
    f.storage.setItem = async (key, value) => {
      if (blockCache && key.includes("snapshot")) {
        blockCache = false;
        await cacheWrite.promise;
      }
      await originalWrite(key, value);
    };
    const interruption = f.session.interruptPending();
    await f.requestedInterruption.promise;
    const oldResult = f.result();
    f.ack.resolve(response(f.settled(oldResult)));
    expect(await interruption).toBe(true);
    await send;
    const next = messageCommand("Choose Peter", "en", "new-D");
    const nextTransport = gate<Response>();
    f.transport.mockImplementation(async (_url, init) =>
      init?.method === "POST"
        ? nextTransport.promise
        : response(f.engine.snapshot()),
    );
    const nextSend = f.session.send(next);
    expect(f.session.getSnapshot().pending).toEqual(next);
    f.original.resolve(response(oldResult));
    await flush();
    expect(f.session.getSnapshot().pending).toEqual(next);
    expect(f.session.getSnapshot().commandStates.chat).toBe("sending");
    expect(f.session.getSnapshot().error).toBeNull();
    cacheWrite.resolve();
    await flush();
    expect(
      [...f.cache.entries()].find(([key]) => key.includes("command"))?.[1],
    ).toBe(JSON.stringify(next));
    nextTransport.resolve(response(f.engine.execute(next)));
    await nextSend;
    expect(f.session.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("a confirmed ACK remains accepted when its snapshot cache cannot be written", async () => {
  const f = fixture(true);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await f.delivered.promise;
    const originalWrite = f.storage.setItem;
    f.storage.setItem = async (key, value) => {
      if (key.includes("snapshot")) throw new Error("disk full");
      await originalWrite(key, value);
    };
    const interruption = f.session.interruptPending();
    await f.requestedInterruption.promise;
    const result = f.result();
    f.ack.resolve(response(f.settled(result)));
    expect(await interruption).toBe(true);
    await send;
    await flush();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().commandStates.chat).toBe("accepted");
    expect(f.session.getSnapshot().error).toBe("storage_error");
    expect(
      [...f.cache.entries()].find(([key]) => key.includes("command"))?.[1],
    ).toBe("null");
    f.original.resolve(response(result));
  } finally {
    f.session.stop();
  }
});

test("expired interruption authorization remains a barrier even if the old fetch ignores abort", async () => {
  const f = fixture(true);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await f.delivered.promise;
    const interruption = f.session.interruptPending();
    await f.requestedInterruption.promise;
    f.ack.resolve(response({ error: "auth_expired" }, 401));
    expect(await interruption).toBe(false);
    await send;
    expect(f.session.getSnapshot().status).toBe("unauthorized");
    await f.session.send(messageCommand("Choose Peter", "en", "denied-D"));
    f.original.resolve(response(f.result()));
    await flush();
    expect(f.session.getSnapshot().status).toBe("unauthorized");
    expect(f.session.getSnapshot().store).toBeNull();
    expect(
      [...f.cache.entries()].find(([key]) => key.includes("command"))?.[1],
    ).toBe(JSON.stringify(f.command));
  } finally {
    f.session.stop();
  }
});

test.each(["scope", "command"])(
  "a mismatched original %s result also preserves the pending barrier",
  async (mismatch) => {
    const f = fixture(true);
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await f.delivered.promise;
      const result = f.result();
      const invalid =
        mismatch === "scope"
          ? {
              ...result,
              snapshot: { ...result.snapshot, scope: credential("b").scope },
            }
          : { ...result, commandId: "foreign-command" };
      f.original.resolve(response(invalid));
      await send;
      expect(f.session.getSnapshot().pending).toEqual(f.command);
      expect(f.session.getSnapshot().commandStates.chat).toBe("network_error");
      const interruption = f.session.interruptPending();
      await f.requestedInterruption.promise;
      f.ack.resolve(response(f.settled(result)));
      expect(await interruption).toBe(true);
      expect(f.session.getSnapshot().pending).toBeNull();
    } finally {
      f.session.stop();
    }
  },
);

test("restored uncertain delivery can be interrupted without replaying or minting a new command", async () => {
  const f = fixture(true);
  try {
    const result = f.result();
    f.cache.set(
      `agent-client.command.v2:${f.session.identityKey}`,
      JSON.stringify(f.command),
    );
    await f.session.start(false);
    expect(f.session.getSnapshot().pending).toEqual(f.command);
    expect(f.session.getSnapshot().commandStates.chat).toBe("network_error");
    const interruption = f.session.interruptPending();
    await f.requestedInterruption.promise;
    f.ack.resolve(response(f.settled(result)));
    expect(await interruption).toBe(true);
    expect(f.session.getSnapshot().pending).toBeNull();
    const posts = f.transport.mock.calls.filter(
      ([, init]) => init?.method === "POST",
    );
    expect(posts).toHaveLength(1);
    expect(String(posts[0]![0])).toContain("/commands/interrupt?");
  } finally {
    f.session.stop();
  }
});
