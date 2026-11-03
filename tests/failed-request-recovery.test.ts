import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  canRetryPending,
  runningChat,
} from "../packages/client-core/chat-view";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { REQUEST_INTERRUPTION_PROFILE } from "../packages/protocol/request-interruption";
import { authInfo, credential } from "./auth-fixtures";

/*
 * NIAR-279: a request that failed after delivery started is retained for an
 * exact retry. It no longer runs, so it is not stopped; the person retries it
 * or dismisses it, and the server decides whether dismissing is safe.
 */
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const flush = async () => {
  for (let i = 0; i < 25; i++) await Promise.resolve();
};
type Reply = Response | Error | Promise<Response>;

function fixture() {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "failed-C");
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const sends: Reply[] = [];
  const interrupts: Reply[] = [];
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("/auth/session")) return response(authInfo());
      const next = String(url).includes("/commands/interrupt?")
        ? interrupts.shift()
        : init?.method === "POST"
          ? sends.shift()
          : undefined;
      if (init?.method === "POST") {
        if (!next) throw new Error("unexpected POST");
        if (next instanceof Error) throw next;
        return next;
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
  const unknown = (reason: "not_running" | "not_settled") =>
    response({
      profile: REQUEST_INTERRUPTION_PROFILE,
      scope: credential().scope,
      commandId: command.commandId,
      status: "unknown",
      reason,
    });
  const settled = () =>
    response({
      profile: REQUEST_INTERRUPTION_PROFILE,
      scope: credential().scope,
      commandId: command.commandId,
      status: "settled",
      result: engine.execute(command),
    });
  const posts = (path: string) =>
    transport.mock.calls.filter(
      ([url, init]) =>
        init?.method === "POST" &&
        (path === "interrupt"
          ? String(url).includes("/commands/interrupt?")
          : !String(url).includes("/commands/interrupt?")),
    );
  const outbox = () =>
    [...cache.entries()].find(([key]) => key.includes("command"))?.[1];
  return {
    session,
    engine,
    command,
    sends,
    interrupts,
    unknown,
    settled,
    posts,
    outbox,
    cache,
  };
}

const failures: [string, () => Reply, string][] = [
  ...[
    "model_unavailable",
    "model_timeout",
    "model_invalid_response",
    "model_busy",
    "model_limit",
    "model_expired",
  ].map((code): [string, () => Reply, string] => [
    code,
    () => response({ error: code }, 503),
    code,
  ]),
  [
    "a 500 without a receipt",
    () => response({ error: "internal" }, 500),
    "network_error",
  ],
  [
    "a dropped connection",
    () => new Error("connection reset"),
    "network_error",
  ],
];

test.each(failures)(
  "after %s the request is kept for an exact retry but is no longer running",
  async (_name, failure, error) => {
    const f = fixture();
    try {
      await f.session.start(false);
      f.sends.push(failure());
      await f.session.send(f.command);
      const state = f.session.getSnapshot();
      expect(state.pending).toEqual(f.command);
      expect(state.commandStates.chat).toBe("network_error");
      expect(state.error).toBe(error);
      // Nothing runs, so nothing is there to stop; Retry is offered.
      expect(runningChat(state)).toBeNull();
      expect(canRetryPending(state, f.command.conversationId)).toBe(true);
      expect(f.outbox()).toBe(JSON.stringify(f.command));
    } finally {
      f.session.stop();
    }
  },
);

test.each(failures)(
  "after %s, Dismiss lets go of a request the server neither runs nor recorded",
  async (_name, failure) => {
    const f = fixture();
    try {
      await f.session.start(false);
      f.sends.push(failure());
      await f.session.send(f.command);
      // The deadlock: stopping a request that no longer runs is refused.
      f.interrupts.push(f.unknown("not_running"));
      expect(await f.session.interruptPending()).toBe(false);
      expect(f.session.getSnapshot().error).toBe("requestInterruptFailed");
      expect(f.session.getSnapshot().pending).toEqual(f.command);
      // Dismiss asks the server about the exact command and lets it go.
      f.interrupts.push(f.unknown("not_running"));
      expect(await f.session.discardPending()).toBe(true);
      const state = f.session.getSnapshot();
      expect(state.pending).toBeNull();
      expect(state.commandStates.chat).toBe("idle");
      expect(state.error).toBeNull();
      expect(canRetryPending(state)).toBe(false);
      await flush();
      expect(f.outbox()).toBe("null");
      // The failed command was sent once and never again.
      expect(f.posts("commands")).toHaveLength(1);
      const interrupt = JSON.parse(String(f.posts("interrupt")[1]![1]?.body));
      expect(interrupt).toEqual({
        profile: REQUEST_INTERRUPTION_PROFILE,
        command: f.command,
      });
      // The person can send again.
      const next = messageCommand("Choose Peter", "en", "next-D");
      f.sends.push(response(f.engine.execute(next)));
      await f.session.send(next);
      expect(f.session.getSnapshot().pending).toBeNull();
      expect(f.session.getSnapshot().commandStates.chat).toBe("accepted");
    } finally {
      f.session.stop();
    }
  },
);

test("Dismiss of a request the server did record shows its recorded outcome instead", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    f.sends.push(new Error("connection reset"));
    await f.session.send(f.command);
    f.interrupts.push(f.settled());
    expect(await f.session.discardPending()).toBe(true);
    const state = f.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(state.commandStates.chat).toBe("accepted");
    expect(state.error).toBeNull();
    expect(
      state.store?.conversations[f.command.conversationId]?.messages.some(
        (m) => m.role === "user" && m.text === "Choose Peter",
      ),
    ).toBe(true);
    expect(f.posts("commands")).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test.each([
  ["not_settled", () => fixture().unknown("not_settled")],
  ["a lost answer", () => new Error("connection reset")],
  ["a server error", () => response({ error: "internal" }, 500)],
] as [string, () => Reply][])(
  "when Dismiss cannot be confirmed (%s), the request stays with Retry and Dismiss",
  async (_name, answer) => {
    const f = fixture();
    try {
      await f.session.start(false);
      f.sends.push(response({ error: "model_unavailable" }, 503));
      await f.session.send(f.command);
      f.interrupts.push(answer());
      expect(await f.session.discardPending()).toBe(false);
      let state = f.session.getSnapshot();
      expect(state.pending).toEqual(f.command);
      expect(state.error).toBe("requestInterruptFailed");
      expect(runningChat(state)).toBeNull();
      expect(canRetryPending(state, f.command.conversationId)).toBe(true);
      expect(f.outbox()).toBe(JSON.stringify(f.command));
      // Dismiss can be asked again.
      f.interrupts.push(f.unknown("not_running"));
      expect(await f.session.discardPending()).toBe(true);
      expect(f.session.getSnapshot().pending).toBeNull();
      // Or, in a second session, Retry resends the exact same command.
      const g = fixture();
      try {
        await g.session.start(false);
        g.sends.push(response({ error: "model_unavailable" }, 503));
        await g.session.send(g.command);
        g.interrupts.push(answer());
        await g.session.discardPending();
        g.sends.push(response(g.engine.execute(g.command)));
        await g.session.retry();
        state = g.session.getSnapshot();
        expect(state.pending).toBeNull();
        expect(state.error).toBeNull();
        const bodies = g.posts("commands").map(([, init]) => init?.body);
        expect(bodies).toHaveLength(2);
        expect(bodies[1]).toBe(bodies[0]);
      } finally {
        g.session.stop();
      }
    } finally {
      f.session.stop();
    }
  },
);

test("a running request is stopped, not dismissed", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    let answer!: (value: Response) => void;
    f.sends.push(new Promise<Response>((resolve) => (answer = resolve)));
    const send = f.session.send(f.command);
    await flush();
    expect(f.session.getSnapshot().commandStates.chat).toBe("sending");
    expect(runningChat(f.session.getSnapshot())).toBe(f.command.conversationId);
    expect(await f.session.discardPending()).toBe(false);
    expect(f.posts("interrupt")).toHaveLength(0);
    expect(f.session.getSnapshot().pending).toEqual(f.command);
    answer(response(f.engine.execute(f.command)));
    await send;
    expect(f.session.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("a request restored from the outbox after a restart can be dismissed", async () => {
  const f = fixture();
  try {
    f.cache.set(
      `agent-client.command.v2:${f.session.identityKey}`,
      JSON.stringify(f.command),
    );
    await f.session.start(false);
    expect(f.session.getSnapshot().pending).toEqual(f.command);
    expect(runningChat(f.session.getSnapshot())).toBeNull();
    f.interrupts.push(f.unknown("not_running"));
    expect(await f.session.discardPending()).toBe(true);
    expect(f.session.getSnapshot().pending).toBeNull();
    await flush();
    expect(f.outbox()).toBe("null");
    expect(f.posts("commands")).toHaveLength(0);
  } finally {
    f.session.stop();
  }
});

test("Dismiss waits for the server while offline", async () => {
  const f = fixture();
  try {
    await f.session.start(false);
    f.sends.push(response({ error: "model_unavailable" }, 503));
    await f.session.send(f.command);
    f.session.stop();
    expect(await f.session.discardPending()).toBe(false);
    expect(f.posts("interrupt")).toHaveLength(0);
  } finally {
    f.session.stop();
  }
});
