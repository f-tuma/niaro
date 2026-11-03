import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  chatRequestFailed,
  commandRunning,
  errorShownByFailedMessage,
  runningChat,
  selectFailedMessages,
  selectPendingChatMessage,
} from "../packages/client-core/chat-view";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { authInfo, credential } from "./auth-fixtures";

/*
 * NIAR-286: sent words never go back to the composer. The owner's phone: a
 * message's answer was lost, the session's background check posted it again,
 * and the text came back into the composer with a spinning Send. The session
 * now keeps a message it took in its chat (still working, failed with Try
 * again, or answered), and a background check is not a running request.
 */
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;

type PostReply = "engine" | "error500" | "model_unavailable" | "refused";

function server() {
  const engine = new FixtureEngine();
  let reply: PostReply = "engine";
  let hold: { resolve(r: Response): void } | undefined;
  let holdNext = false;
  const posted: string[] = [];
  const cache = new Map<string, string>();
  const refused = (body: string) =>
    response({
      commandId: (JSON.parse(body) as { commandId: string }).commandId,
      status: "rejected",
      code: "unknown_context",
      snapshot: engine.snapshot(),
    });
  const answer = (body: string) =>
    reply === "model_unavailable"
      ? response({ error: "model_unavailable" }, 503)
      : reply === "error500"
        ? response({ error: "fixture_error" }, 500)
        : reply === "refused"
          ? refused(body)
          : response(engine.execute(JSON.parse(body)));
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      const path = String(url);
      if (path.endsWith("/auth/session")) return response(authInfo());
      if (init?.method === "POST") {
        const body = String(init.body);
        posted.push(body);
        if (holdNext) {
          holdNext = false;
          return new Promise<Response>((resolve) => {
            hold = { resolve };
          });
        }
        return answer(body);
      }
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
    {
      getItem: async (key) => cache.get(key) ?? null,
      setItem: async (key, value) => {
        cache.set(key, value);
      },
    },
    credential(),
    transport,
  );
  return {
    engine,
    session,
    posted,
    reply: (next: PostReply) => {
      reply = next;
    },
    holdNextPost: () => {
      holdNext = true;
    },
    releaseHeld: (body: string) => hold!.resolve(answer(body)),
  };
}

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

/** Send, lose the answer, and catch the background check's re-post in flight. */
async function lostAndChecking(s: ReturnType<typeof server>, id: string) {
  const command = messageCommand("Choose Peter", "en", id);
  await s.session.start(true);
  s.reply("error500");
  await s.session.send(command);
  let state = s.session.getSnapshot();
  expect(state.deliveryCheck).toBe("checking");
  expect(state.pending).toEqual(command);
  s.holdNextPost();
  await jest.advanceTimersByTimeAsync(1_000);
  state = s.session.getSnapshot();
  expect(s.posted).toEqual([JSON.stringify(command), JSON.stringify(command)]);
  // The re-post is on its way, yet nothing runs as far as the person sees:
  // Thinking with the message, no Stop, no Send-with-spinner.
  expect(state.commandStates.chat).toBe("sending");
  expect(state.deliveryCheck).toBe("checking");
  expect(runningChat(state)).toBeNull();
  expect(commandRunning(state, command)).toBe(false);
  expect(selectPendingChatMessage(state, command.conversationId)).toEqual({
    kind: "message",
    text: "Choose Peter",
  });
  expect(chatRequestFailed(state, command.conversationId)).toBe(false);
  return command;
}

test("the owner's sequence: lost answer, background check, then the server refuses it; the message stays in its chat as failed", async () => {
  const s = server();
  try {
    const command = await lostAndChecking(s, "TEST-refused");
    s.reply("refused");
    s.releaseHeld(JSON.stringify(command));
    await jest.advanceTimersByTimeAsync(0);
    const state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(selectFailedMessages(state, command.conversationId)).toEqual([
      { command, error: "unknown_context" },
    ]);
    // Settled: nothing more is posted by itself.
    await jest.advanceTimersByTimeAsync(60_000);
    expect(s.posted).toHaveLength(2);
    // Try again sends the same words as a new command; the answer comes.
    s.reply("engine");
    await s.session.retryFailedMessage(command.commandId, "TEST-again");
    const after = s.session.getSnapshot();
    expect(after.failedMessages).toEqual([]);
    expect(after.commandStates.chat).toBe("accepted");
    const sent = JSON.parse(s.posted[2]!) as typeof command;
    expect(sent).toEqual({
      ...command,
      commandId: "TEST-again",
      idempotencyKey: "TEST-again",
    });
  } finally {
    s.session.stop();
  }
});

test("a check answered with a model error shows the message as failed with Retry; nothing is kept as unsent", async () => {
  const s = server();
  try {
    const command = await lostAndChecking(s, "TEST-model");
    s.reply("model_unavailable");
    s.releaseHeld(JSON.stringify(command));
    await jest.advanceTimersByTimeAsync(0);
    const state = s.session.getSnapshot();
    expect(state.pending).toEqual(command);
    expect(state.deliveryCheck).toBe("failed");
    expect(chatRequestFailed(state, command.conversationId)).toBe(true);
    expect(state.failedMessages).toEqual([]);
  } finally {
    s.session.stop();
  }
});

test("checks that keep failing (no answer each time, as on a timeout) end as a failed message with Retry, never as unsent", async () => {
  const s = server();
  try {
    const command = await lostAndChecking(s, "TEST-timeout");
    s.releaseHeld(JSON.stringify(command));
    for (let second = 0; second < 40; second++) {
      await jest.advanceTimersByTimeAsync(1_000);
      const state = s.session.getSnapshot();
      if (state.deliveryCheck === "checking")
        expect(runningChat(state)).toBeNull();
    }
    const state = s.session.getSnapshot();
    expect(state.deliveryCheck).toBe("failed");
    expect(state.pending).toEqual(command);
    expect(chatRequestFailed(state, command.conversationId)).toBe(true);
    expect(state.failedMessages).toEqual([]);
  } finally {
    s.session.stop();
  }
});

test("a message the server refuses at once stays in its chat with its words and can be dismissed", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-once");
  try {
    await s.session.start(true);
    s.reply("refused");
    const delivery = s.session.send(command);
    // Taken at once: the composer can let the words go.
    expect(s.session.getSnapshot().pending).toEqual(command);
    await delivery;
    const state = s.session.getSnapshot();
    expect(state.pending).toBeNull();
    expect(selectFailedMessages(state, command.conversationId)).toEqual([
      { command, error: "unknown_context" },
    ]);
    // Its reason shows once, on the message; no notice repeats it.
    expect(state.error).toBe("unknown_context");
    expect(errorShownByFailedMessage(state)).toBe(true);
    s.session.dismissFailedMessage(command.commandId);
    expect(s.session.getSnapshot().failedMessages).toEqual([]);
    // Dismissed, its reason goes with it, also after a reconnect.
    expect(s.session.getSnapshot().error).toBeNull();
    await s.session.refresh();
    expect(s.session.getSnapshot().error).toBeNull();
    expect(s.posted).toHaveLength(1);
  } finally {
    s.session.stop();
  }
});

test("a message the session cannot take is not pending at once and is not kept as failed", async () => {
  const s = server();
  const first = messageCommand("Choose Peter", "en", "TEST-first");
  const second = messageCommand("Choose Mary", "en", "TEST-second");
  try {
    await s.session.start(true);
    s.holdNextPost();
    const running = s.session.send(first);
    await jest.advanceTimersByTimeAsync(0);
    const refused = s.session.send(second);
    expect(s.session.getSnapshot().pending).toEqual(first);
    await refused;
    const state = s.session.getSnapshot();
    expect(state.pending).toEqual(first);
    expect(state.failedMessages).toEqual([]);
    s.releaseHeld(JSON.stringify(first));
    await running;
  } finally {
    s.session.stop();
  }
});

test("an accepted message is never kept as failed", async () => {
  const s = server();
  const command = messageCommand("Choose Peter", "en", "TEST-fine");
  try {
    await s.session.start(true);
    await s.session.send(command);
    const state = s.session.getSnapshot();
    expect(state.commandStates.chat).toBe("accepted");
    expect(state.failedMessages).toEqual([]);
  } finally {
    s.session.stop();
  }
});
