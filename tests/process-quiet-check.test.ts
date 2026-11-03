import { ClientSession, commandTarget } from "../packages/client-core/session";
import {
  canRetryPending,
  processAnswerCardShown,
  processCommandWorking,
  selectPendingChatMessage,
} from "../packages/client-core/chat-view";
import {
  captureProcessStartTarget,
  processStartCommand,
} from "../packages/client-core/process-commands";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { emptySnapshot, processTaskQuestion } from "../packages/test-fixtures";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import type { ProcessAnswerCommand } from "../packages/protocol/process-questions";
import type { ProcessStartCommand } from "../packages/protocol/process-start";
import {
  processLaunchFixture,
  launchResponse as response,
} from "./helpers/process-launch-client";
import { credential, authInfo } from "./auth-fixtures";
import { en, cs } from "../packages/i18n";

/*
 * NIAR-284: the NIAR-280 silent check for processes. A start or an answer
 * whose response was lost is checked by the session itself: it posts the
 * identical saved bytes again, once per check, only while online, and the
 * server answers from its receipt. The person sees it working (no "not
 * confirmed", no Retry) and then simply sees the result. Only a failure the
 * client knows of shows Try again. Nothing starts or is answered twice: the
 * fake servers below record one admission or answer per command id and
 * answer a replay from that receipt, as the real server does.
 */

const sessions: ClientSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((session) => session.stop());
  jest.useRealTimers();
});

type Mode = "ok" | "dropAck" | "error500" | "hold";

/** Process starts with receipts: one admission per command id, replays answered from it. */
function startServer() {
  const h = processLaunchFixture();
  const admissions = new Map<string, string>();
  let mode: Mode = "ok";
  let release: (() => void) | undefined;
  const receipt = h.handlers.command;
  h.handlers.command = async (command: ProcessStartCommand) => {
    const body = JSON.stringify(command);
    const known = admissions.get(command.commandId);
    if (known !== undefined && known !== body)
      return response({ error: "idempotency_conflict" }, 409);
    // A 500 without a receipt records nothing.
    if (mode === "error500") return response({ error: "fixture_error" }, 500);
    if (known === undefined) admissions.set(command.commandId, body);
    const reply = await receipt(command);
    if (mode === "dropAck") {
      mode = "ok";
      throw Error("TEST start ACK lost after admission");
    }
    if (mode === "hold")
      return new Promise<Response>((resolve) => {
        release = () => resolve(reply);
      });
    return reply;
  };
  const open = () => {
    const session = h.open();
    sessions.push(session);
    return session;
  };
  const pair = (session: ClientSession) => {
    const entry = h.entries[0]!;
    const card = h.cardFor({
      processId: entry.processId,
      version: entry.version,
      artifactDigest: entry.artifactDigest,
      language: "en",
      origin: {
        type: "command",
        conversationId: "conversation-1",
        requestId: "TEST-quiet-start",
      },
    });
    const target = captureProcessStartTarget(
      session.address,
      credential().scope,
      entry,
      card,
    );
    const command = processStartCommand(target, {
      commandId: "TEST-quiet-start",
      idempotencyKey: "TEST-quiet-start-key",
      input: { name: "  TEST exact input\n" },
      language: "en",
    });
    return { target, command, bytes: JSON.stringify(command) };
  };
  return {
    h,
    open,
    pair,
    admissions,
    mode: (next: Mode) => {
      mode = next;
    },
    release: () => release?.(),
  };
}

/** Process answers with receipts: one recorded answer per command id. */
function answerServer() {
  const snapshot = emptySnapshot();
  const work = processTaskQuestion("en");
  snapshot.workItems.push(work);
  const cache = new Map<string, string>();
  const storage = {
    getItem: async (key: string) => cache.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      cache.set(key, value);
    },
  };
  const posts: string[] = [];
  const answers = new Map<string, string>();
  let mode: Mode | "modelUnavailable" = "ok";
  let offline = false;
  const receipt = (command: ProcessAnswerCommand) =>
    response(
      ProcessRuntimeResponseSchema.parse({
        profile: "agent-process-execution/2",
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
          runId: "TEST-process-run",
          parentRunId: work.id,
          createdAt: "2026-10-06T00:00:00.000Z",
        },
      }),
    );
  const transport: typeof fetch = async (url, init) => {
    if (offline) throw new TypeError("Network request failed");
    const path = new URL(String(url)).pathname;
    if (path.endsWith("/auth/session")) return response(authInfo());
    if (path.endsWith("/processes/commands")) {
      const body = String(init?.body);
      posts.push(body);
      const command = JSON.parse(body) as ProcessAnswerCommand;
      const known = answers.get(command.commandId);
      if (known !== undefined && known !== body)
        return response({ error: "idempotency_conflict" }, 409);
      if (mode === "modelUnavailable")
        return response({ error: "process_model_unavailable" }, 503);
      if (known === undefined) answers.set(command.commandId, body);
      if (mode === "dropAck") {
        mode = "ok";
        throw new TypeError("Network request failed");
      }
      return receipt(command);
    }
    if (path.endsWith("/snapshot")) return response(snapshot);
    if (path.endsWith("/events"))
      return response({ ...snapshot, events: [] }, 409);
    throw Error(`Unexpected request ${path}`);
  };
  const open = () => {
    const session = new ClientSession(
      "https://fixture.test/v1/a",
      storage,
      credential(),
      transport,
      undefined,
      undefined,
      false,
      { processQuestions: true },
    );
    sessions.push(session);
    return session;
  };
  const answer = (session: ClientSession) => {
    const store = session.getSnapshot().store!;
    return processAnswerCommand(
      store,
      captureProcessAnswerTarget(store, work.id),
      {
        commandId: "TEST-quiet-answer",
        idempotencyKey: "TEST-quiet-answer-key",
        answer: "  TEST my answer\n",
        language: "en",
      },
    );
  };
  return {
    open,
    answer,
    posts,
    answers,
    mode: (next: typeof mode) => {
      mode = next;
    },
    offline: (next: boolean) => {
      offline = next;
    },
  };
}

/** The person's view: working, with no error, no Retry and no card to act on. */
const quiet = (
  state: ReturnType<ClientSession["getSnapshot"]>,
  commandId: string,
) =>
  state.deliveryCheck === "checking" &&
  (state.error === null ||
    (state.status === "offline" && state.error === "connection_failed")) &&
  processCommandWorking(state, commandId) &&
  !canRetryPending(state);

const foreground = (session: ClientSession) => {
  session.setActive(false);
  session.setActive(true);
};

test("a start whose ACK was lost is checked by itself: one identical POST, one admission, and the start appears", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const session = s.open();
  await session.start(true);
  const { target, command, bytes } = s.pair(session);
  s.mode("dropAck");
  await session.send(command, false, target);
  let state = session.getSnapshot();
  expect(state.pending).toEqual(command);
  expect(state.processPending?.outcome).toBe("unknown");
  expect(quiet(state, command.commandId)).toBe(true);
  expect(s.h.commands).toEqual([bytes]);
  // The next poll checks it: the identical saved bytes, once.
  await jest.advanceTimersByTimeAsync(1500);
  state = session.getSnapshot();
  expect(state.pending).toBeNull();
  expect(state.processPending).toBeNull();
  expect(state.deliveryCheck).toBeNull();
  expect(state.error).toBeNull();
  expect(state.commandStates[commandTarget(command)]).toBe("accepted");
  expect(s.h.commands).toEqual([bytes, bytes]);
  expect(s.admissions.size).toBe(1);
  // Settled for good.
  await jest.advanceTimersByTimeAsync(60_000);
  foreground(session);
  await jest.advanceTimersByTimeAsync(1000);
  expect(s.h.commands).toHaveLength(2);
});

test("a start lost while the server is down stays quiet and unposted until the server returns, then one check starts it once", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const session = s.open();
  await session.start(true);
  const { target, command, bytes } = s.pair(session);
  s.h.offline(true);
  // The server went away mid-start: the POST never reached it.
  await session.send(command, false, target);
  expect(s.h.commands).toEqual([]);
  // Two minutes without the server: offline, still working, nothing posted.
  await jest.advanceTimersByTimeAsync(120_000);
  let state = session.getSnapshot();
  expect(state.status).toBe("offline");
  expect(quiet(state, command.commandId)).toBe(true);
  expect(s.h.commands).toEqual([]);
  s.h.offline(false);
  await jest.advanceTimersByTimeAsync(31_000);
  state = session.getSnapshot();
  expect(state.status).toBe("online");
  expect(state.pending).toBeNull();
  expect(state.commandStates[commandTarget(command)]).toBe("accepted");
  expect(s.h.commands).toEqual([bytes]);
  expect(s.admissions.size).toBe(1);
});

test("a start the server keeps failing without a receipt stays working: checks are spaced out, then wait for the foreground, and still start it once", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const session = s.open();
  await session.start(true);
  const { target, command, bytes } = s.pair(session);
  s.mode("error500");
  await session.send(command, false, target);
  expect(s.h.commands).toHaveLength(1);
  // The first check at once, then 2, 4, 8, 16 s apart: five failed checks.
  await jest.advanceTimersByTimeAsync(1500);
  expect(s.h.commands).toHaveLength(2);
  await jest.advanceTimersByTimeAsync(2500);
  expect(s.h.commands).toHaveLength(3);
  await jest.advanceTimersByTimeAsync(4500);
  expect(s.h.commands).toHaveLength(4);
  await jest.advanceTimersByTimeAsync(8500);
  expect(s.h.commands).toHaveLength(5);
  await jest.advanceTimersByTimeAsync(16_500);
  expect(s.h.commands).toHaveLength(6);
  // A process command never turns into a failure the person must handle:
  // it stays working and waits.
  let state = session.getSnapshot();
  expect(quiet(state, command.commandId)).toBe(true);
  await jest.advanceTimersByTimeAsync(300_000);
  expect(s.h.commands).toHaveLength(6);
  expect(quiet(session.getSnapshot(), command.commandId)).toBe(true);
  // Back in the foreground: one more check, which the fixed server takes.
  s.mode("ok");
  foreground(session);
  await jest.advanceTimersByTimeAsync(500);
  state = session.getSnapshot();
  expect(state.pending).toBeNull();
  expect(state.commandStates[commandTarget(command)]).toBe("accepted");
  expect(s.h.commands).toHaveLength(7);
  expect(new Set(s.h.commands)).toEqual(new Set([bytes]));
  expect(s.admissions.size).toBe(1);
});

test("a check never runs beside another request for the same start: one POST in flight at a time", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const session = s.open();
  await session.start(true);
  const { target, command } = s.pair(session);
  s.mode("dropAck");
  await session.send(command, false, target);
  s.mode("hold");
  await jest.advanceTimersByTimeAsync(1500);
  expect(s.h.commands).toHaveLength(2);
  // Ticks and foregrounds while the check waits for the server post nothing.
  await jest.advanceTimersByTimeAsync(20_000);
  foreground(session);
  await jest.advanceTimersByTimeAsync(1000);
  expect(s.h.commands).toHaveLength(2);
  expect(quiet(session.getSnapshot(), command.commandId)).toBe(true);
  s.release();
  await jest.advanceTimersByTimeAsync(100);
  expect(session.getSnapshot().pending).toBeNull();
  expect(s.admissions.size).toBe(1);
});

test("in the background nothing is checked; returning checks at once", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const session = s.open();
  await session.start(true);
  const { target, command } = s.pair(session);
  session.setActive(false);
  s.mode("dropAck");
  await session.send(command, false, target);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(s.h.commands).toHaveLength(1);
  session.setActive(true);
  await jest.advanceTimersByTimeAsync(100);
  expect(s.h.commands).toHaveLength(2);
  expect(session.getSnapshot().pending).toBeNull();
  expect(s.admissions.size).toBe(1);
});

test("a start kept from before a restart is checked by the reopened app, with no card, and starts once", async () => {
  jest.useFakeTimers();
  const s = startServer();
  const first = s.open();
  await first.start(false);
  const { target, command, bytes } = s.pair(first);
  s.mode("dropAck");
  await first.send(command, false, target);
  first.stop();
  const reopened = s.open();
  await reopened.start(true);
  expect(reopened.getSnapshot().pending).toEqual(command);
  await jest.advanceTimersByTimeAsync(1500);
  expect(reopened.getSnapshot().pending).toBeNull();
  expect(reopened.getSnapshot().commandStates[commandTarget(command)]).toBe(
    "accepted",
  );
  expect(s.h.commands).toEqual([bytes, bytes]);
  expect(s.admissions.size).toBe(1);
});

test("an answer whose ACK was lost shows as the person's message on its way, is checked by itself, and is answered once", async () => {
  jest.useFakeTimers();
  const s = answerServer();
  const session = s.open();
  await session.start(true);
  const command = s.answer(session);
  s.mode("dropAck");
  await session.send(command);
  let state = session.getSnapshot();
  expect(state.pending).toEqual(command);
  expect(quiet(state, command.commandId)).toBe(true);
  const attempt = state.answerAttempts[0]!;
  expect(attempt.outcome).toBe("unknown");
  expect(attempt.error).toBeNull();
  // No saved-answer card; the chat shows the answer being sent.
  expect(processAnswerCardShown(state, attempt)).toBe(false);
  expect(selectPendingChatMessage(state, command.conversationId)).toEqual({
    kind: "answer",
    text: command.answer,
  });
  await jest.advanceTimersByTimeAsync(1500);
  state = session.getSnapshot();
  expect(state.pending).toBeNull();
  expect(state.deliveryCheck).toBeNull();
  expect(state.commandStates[commandTarget(command)]).toBe("accepted");
  expect(state.answerAttempts[0]?.outcome).toBe("accepted");
  expect(s.posts).toEqual([JSON.stringify(command), JSON.stringify(command)]);
  expect(s.answers.size).toBe(1);
  await jest.advanceTimersByTimeAsync(60_000);
  expect(s.posts).toHaveLength(2);
});

test("an answer the server says it could not take shows as failed with Try again, is never resent by itself, and Try again sends it once", async () => {
  jest.useFakeTimers();
  const s = answerServer();
  const session = s.open();
  await session.start(true);
  const command = s.answer(session);
  s.mode("modelUnavailable");
  await session.send(command);
  let state = session.getSnapshot();
  expect(state.pending).toEqual(command);
  expect(state.deliveryCheck).toBe("failed");
  expect(state.error).toBe("process_model_unavailable");
  expect(processCommandWorking(state, command.commandId)).toBe(false);
  // The saved-answer card shows, with Try again, instead of a sending answer.
  expect(processAnswerCardShown(state, state.answerAttempts[0]!)).toBe(true);
  expect(selectPendingChatMessage(state, command.conversationId)).toBeNull();
  // Never resent by itself: not on polls, reconnects or foregrounds.
  await jest.advanceTimersByTimeAsync(60_000);
  s.offline(true);
  await jest.advanceTimersByTimeAsync(5000);
  s.offline(false);
  await jest.advanceTimersByTimeAsync(31_000);
  foreground(session);
  await jest.advanceTimersByTimeAsync(1000);
  expect(s.posts).toHaveLength(1);
  expect(session.getSnapshot().deliveryCheck).toBe("failed");
  // Try again posts the identical answer once.
  s.mode("ok");
  await session.retry();
  state = session.getSnapshot();
  expect(state.pending).toBeNull();
  expect(state.answerAttempts[0]?.outcome).toBe("accepted");
  expect(s.posts).toEqual([JSON.stringify(command), JSON.stringify(command)]);
  expect(s.answers.size).toBe(1);
});

test("the process delivery copy that asked the person to check is gone, in English and Czech", () => {
  for (const key of [
    "processesUnknown",
    "processesRetrySame",
    "savedProcessAnswerUnknown",
    "savedProcessApprovalUnknown",
    "savedProcessApprovalRetrySame",
  ]) {
    expect(Object.hasOwn(en, key)).toBe(false);
    expect(Object.hasOwn(cs, key)).toBe(false);
  }
  const all = [...Object.values(en), ...Object.values(cs)].join("\n");
  expect(all).not.toMatch(
    /may have started|Retry sends|možná spustil|Opakování odešle/,
  );
});
