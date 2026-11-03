import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  canRetryPending,
  heldForRecovery,
  runningChat,
} from "../packages/client-core/chat-view";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { authInfo, credential } from "./auth-fixtures";

/*
 * NIAR-279 follow-up: the server dies or fails while an answer runs and
 * comes back. The phone reconnects by itself, never resends on its own,
 * offers no Stop for a request that no longer runs, and an explicit Check
 * result settles the exact command without repeating a recorded one.
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

type Mode = "up" | "down" | "broken";

function server() {
  const engine = new FixtureEngine();
  let mode: Mode = "up";
  const posted: unknown[] = [];
  const reads: string[] = [];
  let hold: { resolve(r: Response): void; reject(e: Error): void } | undefined;
  let holdNext = false;
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      const path = String(url);
      if (mode === "down") throw new TypeError("Network request failed");
      if (path.endsWith("/auth/session")) return response(authInfo());
      if (init?.method === "POST") {
        const body: unknown = JSON.parse(String(init.body));
        posted.push(body);
        if (holdNext) {
          holdNext = false;
          return new Promise<Response>((resolve, reject) => {
            hold = { resolve, reject };
          });
        }
        return response(engine.execute(body));
      }
      reads.push(path);
      // The wedge NIAR-279 met on the phone: every read answered 500.
      if (mode === "broken") return response({ error: "fixture_error" }, 500);
      const after = /[?&]after=(\d+)/.exec(path)?.[1];
      if (after !== undefined) {
        const events = engine.events(Number(after));
        return events
          ? response(events)
          : response({ error: "snapshot_required" }, 409);
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
  return {
    engine,
    session,
    posted,
    reads,
    setMode: (next: Mode) => {
      mode = next;
    },
    holdNextPost: () => {
      holdNext = true;
    },
    held: () => hold!,
  };
}

const userMessages = (engine: FixtureEngine, text: string) =>
  engine
    .snapshot()
    .conversations.flatMap((c) => c.messages)
    .filter((m) => m.role === "user" && m.text === text);

test.each([
  ["before the server recorded it", false],
  ["after the server recorded it", true],
])(
  "an answer lost when the server dies %s: offline without Stop, back online by itself, Check result settles it once",
  async (_name, recorded) => {
    const s = server();
    const command = messageCommand("Choose Peter", "en", "TEST-lost");
    try {
      await s.session.start(false);
      s.holdNextPost();
      const sent = s.session.send(command);
      await flush();
      // The answer runs: Stop belongs here.
      expect(runningChat(s.session.getSnapshot())).toBe(command.conversationId);
      // The server dies mid-answer.
      if (recorded) s.engine.execute(command);
      s.setMode("down");
      s.held().reject(new TypeError("Network request failed"));
      await sent;
      let state = s.session.getSnapshot();
      expect(state.pending).toEqual(command);
      expect(state.commandStates.chat).toBe("network_error");
      expect(runningChat(state)).toBeNull();
      // The words are not unsent: the session keeps the exact command.
      expect(heldForRecovery(state, command)).toBe(true);
      await s.session.sync();
      expect(s.session.getSnapshot().status).toBe("offline");
      // The server is back: the next poll reconnects without any resend.
      s.setMode("up");
      await s.session.sync();
      state = s.session.getSnapshot();
      expect(state.status).toBe("online");
      expect(state.pending).toEqual(command);
      expect(canRetryPending(state, command.conversationId)).toBe(true);
      expect(s.posted).toHaveLength(1);
      // Check result posts the identical command; a recorded one is replayed.
      await s.session.retry();
      state = s.session.getSnapshot();
      expect(state.pending).toBeNull();
      expect(state.commandStates.chat).toBe("accepted");
      expect(s.posted).toEqual([command, command]);
      expect(userMessages(s.engine, "Choose Peter")).toHaveLength(1);
    } finally {
      s.session.stop();
    }
  },
);

test("a server that answers every read with 500 keeps the phone offline only until it recovers; polling reconnects without a resend", async () => {
  jest.useFakeTimers();
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-wedged");
  try {
    await s.session.start(true);
    s.holdNextPost();
    const sent = s.session.send(command);
    await jest.advanceTimersByTimeAsync(0);
    // The reads break while the answer still runs: offline, and Stop would do
    // nothing there (the clients hide it while offline).
    s.setMode("broken");
    await jest.advanceTimersByTimeAsync(1_000);
    expect(s.session.getSnapshot().status).toBe("offline");
    expect(runningChat(s.session.getSnapshot())).toBe(command.conversationId);
    s.held().resolve(response({ error: "fixture_error" }, 500));
    await jest.advanceTimersByTimeAsync(0);
    await sent;
    expect(runningChat(s.session.getSnapshot())).toBeNull();
    expect(heldForRecovery(s.session.getSnapshot(), command)).toBe(true);
    // Two minutes of a broken server: retries are spaced out, never resent.
    const before = s.reads.length;
    await jest.advanceTimersByTimeAsync(120_000);
    expect(s.session.getSnapshot().status).toBe("offline");
    expect(s.reads.length - before).toBeLessThan(15);
    expect(s.posted).toHaveLength(1);
    // Fixed: within the longest back-off the phone is online again.
    s.setMode("up");
    await jest.advanceTimersByTimeAsync(31_000);
    const state = s.session.getSnapshot();
    expect(state.status).toBe("online");
    expect(state.error).not.toBe("connection_failed");
    expect(state.pending).toEqual(command);
    expect(s.posted).toHaveLength(1);
  } finally {
    s.session.stop();
    jest.useRealTimers();
  }
});

test("coming back to the foreground retries at once instead of waiting out the back-off", async () => {
  jest.useFakeTimers();
  const s = server();
  try {
    await s.session.start(true);
    s.setMode("down");
    await jest.advanceTimersByTimeAsync(70_000);
    expect(s.session.getSnapshot().status).toBe("offline");
    s.session.setActive(false);
    s.setMode("up");
    s.session.setActive(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.session.getSnapshot().status).toBe("online");
  } finally {
    s.session.stop();
    jest.useRealTimers();
  }
});
