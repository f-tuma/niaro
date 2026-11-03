import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  canRetryPending,
  chatRequestFailed,
  runningChat,
} from "../packages/client-core/chat-view";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { REQUEST_INTERRUPTION_PROFILE } from "../packages/protocol/request-interruption";
import { authInfo, credential } from "./auth-fixtures";

/*
 * NIAR-279 follow-up and NIAR-280: the server dies or fails while an answer
 * runs and comes back. The phone reconnects by itself and checks the lost
 * outcome by itself: it posts the identical command once per check, only while
 * online, and the server answers from its receipt or takes it. The person sees
 * the request still working, never an "unconfirmed" card; only a failure the
 * server states, or checks that keep failing while the server answers, shows
 * the request as failed with Retry and Dismiss.
 */
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

type Mode = "up" | "down" | "broken";
type PostReply = "engine" | "model_unavailable" | "error500";

function server() {
  const engine = new FixtureEngine();
  let mode: Mode = "up";
  let postReply: PostReply = "engine";
  const posted: string[] = [];
  const interrupts: unknown[] = [];
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
      if (init?.method === "POST" && path.includes("/commands/interrupt?")) {
        const { command } = JSON.parse(String(init.body)) as {
          command: { commandId: string };
        };
        interrupts.push(command);
        const known = engine.replay(command);
        return response({
          profile: REQUEST_INTERRUPTION_PROFILE,
          scope: credential().scope,
          commandId: command.commandId,
          ...(known
            ? { status: "settled", result: known }
            : { status: "unknown", reason: "not_running" }),
        });
      }
      if (init?.method === "POST") {
        posted.push(String(init.body));
        if (holdNext) {
          holdNext = false;
          return new Promise<Response>((resolve, reject) => {
            hold = { resolve, reject };
          });
        }
        if (postReply === "model_unavailable")
          return response({ error: "model_unavailable" }, 503);
        if (postReply === "error500")
          return response({ error: "fixture_error" }, 500);
        return response(engine.execute(JSON.parse(String(init.body))));
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
    interrupts,
    reads,
    cache,
    setMode: (next: Mode) => {
      mode = next;
    },
    reply: (next: PostReply) => {
      postReply = next;
    },
    holdNextPost: () => {
      holdNext = true;
    },
    held: () => hold!,
  };
}

const messages = (engine: FixtureEngine, commandId: string, text: string) => {
  const all = engine.snapshot().conversations.flatMap((c) => c.messages);
  return {
    user: all.filter((m) => m.role === "user" && m.text === text),
    answers: all.filter(
      (m) => m.role === "assistant" && m.replyToCommandId === commandId,
    ),
  };
};
/**
 * What the chat shows: still working, with no delivery error and no Retry.
 * Offline, the only error is the connection itself (the header says Offline).
 */
const quiet = (state: ReturnType<ClientSession["getSnapshot"]>, id: string) =>
  state.deliveryCheck === "checking" &&
  (state.error === null ||
    (state.status === "offline" && state.error === "connection_failed")) &&
  !canRetryPending(state, id) &&
  !chatRequestFailed(state, id);

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test.each([
  ["before the server recorded it", false],
  ["after the server recorded it", true],
])(
  "an answer lost when the server dies %s is checked by itself after the server returns, with no card meanwhile and one message",
  async (_name, recorded) => {
    const s = server();
    const command = messageCommand("Choose Peter", "en", "TEST-lost");
    try {
      await s.session.start(true);
      s.holdNextPost();
      const sent = s.session.send(command);
      await jest.advanceTimersByTimeAsync(0);
      // The answer runs: Stop belongs here.
      expect(runningChat(s.session.getSnapshot())).toBe(command.conversationId);
      // The server dies mid-answer.
      if (recorded) s.engine.execute(command);
      s.setMode("down");
      s.held().reject(new TypeError("Network request failed"));
      await sent;
      let state = s.session.getSnapshot();
      expect(state.pending).toEqual(command);
      expect(runningChat(state)).toBeNull();
      // The words are not unsent, and nothing says the result is unconfirmed.
      expect(state.pending?.commandId).toBe(command.commandId);
      expect(state.failedMessages).toEqual([]);
      expect(quiet(state, command.conversationId)).toBe(true);
      // Two minutes without a server: offline, still quiet, nothing posted.
      await jest.advanceTimersByTimeAsync(120_000);
      state = s.session.getSnapshot();
      expect(state.status).toBe("offline");
      expect(quiet(state, command.conversationId)).toBe(true);
      expect(s.posted).toHaveLength(1);
      // The server is back: the phone reconnects and checks at once.
      s.setMode("up");
      await jest.advanceTimersByTimeAsync(31_000);
      state = s.session.getSnapshot();
      expect(state.status).toBe("online");
      expect(state.pending).toBeNull();
      expect(state.deliveryCheck).toBeNull();
      expect(state.error).toBeNull();
      expect(state.commandStates.chat).toBe("accepted");
      // Exactly one more POST, byte for byte the same command.
      expect(s.posted).toEqual([
        JSON.stringify(command),
        JSON.stringify(command),
      ]);
      const recordedMessages = messages(
        s.engine,
        command.commandId,
        "Choose Peter",
      );
      expect(recordedMessages.user).toHaveLength(1);
      expect(recordedMessages.answers).toHaveLength(1);
      // Settled for good: no further checks.
      await jest.advanceTimersByTimeAsync(60_000);
      expect(s.posted).toHaveLength(2);
    } finally {
      s.session.stop();
    }
  },
);

test("a dropped connection while the server stays up is checked at once and the answer appears", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-drop");
  try {
    await s.session.start(true);
    s.holdNextPost();
    const sent = s.session.send(command);
    await jest.advanceTimersByTimeAsync(0);
    s.engine.execute(command);
    s.held().reject(new TypeError("Network request failed"));
    await sent;
    expect(quiet(s.session.getSnapshot(), command.conversationId)).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);
    const state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(state.commandStates.chat).toBe("accepted");
    expect(s.posted).toEqual([
      JSON.stringify(command),
      JSON.stringify(command),
    ]);
    expect(
      messages(s.engine, command.commandId, "Choose Peter").answers,
    ).toHaveLength(1);
  } finally {
    s.session.stop();
  }
});

test("a server that answers every read with 500 keeps the phone offline and quiet; once fixed it checks the answer by itself", async () => {
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
    expect(s.session.getSnapshot().pending?.commandId).toBe(command.commandId);
    // Two minutes of a broken server: retries are spaced out, nothing posted.
    const before = s.reads.length;
    await jest.advanceTimersByTimeAsync(120_000);
    let state = s.session.getSnapshot();
    expect(state.status).toBe("offline");
    expect(quiet(state, command.conversationId)).toBe(true);
    expect(s.reads.length - before).toBeLessThan(15);
    expect(s.posted).toHaveLength(1);
    // Fixed: within the longest back-off the phone is online and has the answer.
    s.setMode("up");
    await jest.advanceTimersByTimeAsync(31_000);
    state = s.session.getSnapshot();
    expect(state.status).toBe("online");
    expect(state.error).toBeNull();
    expect(state.pending).toBeNull();
    expect(s.posted).toEqual([
      JSON.stringify(command),
      JSON.stringify(command),
    ]);
  } finally {
    s.session.stop();
  }
});

test("when the server says the request did not finish, the message shows as failed with Retry and Dismiss and is not posted again by itself", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-never");
  try {
    await s.session.start(true);
    s.reply("error500");
    // The first send ends without an outcome (the server never recorded it).
    await s.session.send(command);
    expect(quiet(s.session.getSnapshot(), command.conversationId)).toBe(true);
    // The check: the server states it could not run it.
    s.reply("model_unavailable");
    await jest.advanceTimersByTimeAsync(1_000);
    let state = s.session.getSnapshot();
    expect(state.deliveryCheck).toBe("failed");
    expect(state.error).toBe("model_unavailable");
    expect(chatRequestFailed(state, command.conversationId)).toBe(true);
    expect(s.posted).toHaveLength(2);
    // Failed stays failed: no automatic posts, through reconnects too.
    await jest.advanceTimersByTimeAsync(120_000);
    s.session.setActive(false);
    s.session.setActive(true);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(s.posted).toHaveLength(2);
    // Dismiss asks the server; never recorded, so the message is let go.
    expect(await s.session.discardPending()).toBe(true);
    state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(state.deliveryCheck).toBeNull();
    expect(s.interrupts).toEqual([command]);
    expect(
      messages(s.engine, command.commandId, "Choose Peter").user,
    ).toHaveLength(0);
    expect(s.posted.every((body) => body === JSON.stringify(command))).toBe(
      true,
    );
  } finally {
    s.session.stop();
  }
});

test("Retry of a failed message posts the identical command and the answer appears", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-retry");
  try {
    await s.session.start(true);
    s.reply("model_unavailable");
    await s.session.send(command);
    expect(
      chatRequestFailed(s.session.getSnapshot(), command.conversationId),
    ).toBe(true);
    s.reply("engine");
    await s.session.retry();
    const state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(state.commandStates.chat).toBe("accepted");
    expect(s.posted).toEqual([
      JSON.stringify(command),
      JSON.stringify(command),
    ]);
  } finally {
    s.session.stop();
  }
});

test("checks the server keeps failing while it answers reads are spaced out, one POST each, then the message shows as failed", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-stuck");
  try {
    await s.session.start(true);
    s.reply("error500");
    await s.session.send(command);
    // Five checks at about 0, 2, 4, 8 and 16 seconds; quiet throughout.
    const seen: number[] = [];
    for (let second = 0; second < 40; second++) {
      await jest.advanceTimersByTimeAsync(1_000);
      seen.push(s.posted.length);
      if (s.session.getSnapshot().deliveryCheck === "checking")
        expect(s.session.getSnapshot().error).toBeNull();
    }
    expect(s.posted).toHaveLength(6);
    expect(new Set(s.posted)).toEqual(new Set([JSON.stringify(command)]));
    // Spaced out: never two checks in the same or adjacent seconds after the first.
    const firstAt = seen.findIndex((n) => n >= 2);
    expect(firstAt).toBeLessThanOrEqual(1);
    expect(seen[firstAt + 1]).toBe(2);
    const state = s.session.getSnapshot();
    expect(state.deliveryCheck).toBe("failed");
    expect(state.error).toBeNull();
    expect(chatRequestFailed(state, command.conversationId)).toBe(true);
    await jest.advanceTimersByTimeAsync(120_000);
    expect(s.posted).toHaveLength(6);
  } finally {
    s.session.stop();
  }
});

test("a message kept from before a restart is checked by itself once the session starts", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-restart");
  try {
    s.engine.execute(command);
    s.cache.set(
      `agent-client.command.v2:${s.session.identityKey}`,
      JSON.stringify(command),
    );
    await s.session.start(true);
    expect(s.session.getSnapshot().pending).toEqual(command);
    expect(quiet(s.session.getSnapshot(), command.conversationId)).toBe(true);
    await jest.advanceTimersByTimeAsync(1_000);
    const state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(state.commandStates.chat).toBe("accepted");
    expect(s.posted).toEqual([JSON.stringify(command)]);
    expect(
      messages(s.engine, command.commandId, "Choose Peter").user,
    ).toHaveLength(1);
  } finally {
    s.session.stop();
  }
});

test("in the background nothing is checked; coming back checks at once", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-background");
  try {
    await s.session.start(true);
    s.session.setActive(false);
    s.reply("error500");
    await s.session.send(command);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.posted).toHaveLength(1);
    s.reply("engine");
    s.session.setActive(true);
    await jest.advanceTimersByTimeAsync(0);
    expect(s.session.getSnapshot().pending).toBeNull();
    expect(s.posted).toEqual([
      JSON.stringify(command),
      JSON.stringify(command),
    ]);
  } finally {
    s.session.stop();
  }
});

test("coming back to the foreground retries at once instead of waiting out the back-off", async () => {
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
  }
});
