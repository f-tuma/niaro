import { ClientSession } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  canRetryPending,
  chatOwnsError,
  runningChat,
} from "../packages/client-core/chat-view";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  ACTIVITY_PROFILE,
  TOOL_ACTIVITY_PROFILE,
  LEGACY_ACTIVITY_PROFILE,
} from "../packages/protocol/activity";
import {
  requestActivity,
  pluginActivity,
  workflowActivity,
} from "../packages/test-fixtures";
import { credential, authInfo } from "./auth-fixtures";
import type { AnswerStreamChunk } from "../packages/protocol/answer-stream";

const response = (value: unknown, status = 200) =>
  ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function setup(activityResponse?: Response | Promise<Response>) {
  const engine = new FixtureEngine(),
    post = gate<Response>();
  const command = messageCommand("Choose Peter", "en", "test-progress");
  const payload = {
    profile: ACTIVITY_PROFILE,
    scope: credential().scope,
    commandId: command.commandId,
    activity: requestActivity(),
  };
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      if (String(url).includes("activity?"))
        return activityResponse ?? response(payload);
      if (init?.method === "POST") return post.promise;
      return response(engine.snapshot());
    },
  );
  const storage = new Map<string, string>();
  const session = new ClientSession(
    "https://fixture/v1/a",
    {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
    },
    credential(),
    fetcher,
  );
  return { session, engine, command, payload, post, fetcher };
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("progress is transient and ends with command result without resubmitting", async () => {
  const f = setup();
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await jest.advanceTimersByTimeAsync(260);
    expect(f.session.getSnapshot().activity).toEqual(requestActivity());
    expect(f.session.getSnapshot().activityConnection).toBe("live");
    expect(f.engine.snapshot().operations).toEqual([]);
    f.post.resolve(response(f.engine.execute(f.command), 202));
    await send;
    expect(f.session.getSnapshot().activity).toBeNull();
    expect(f.session.getSnapshot().pending).toBeNull();
    const calls = f.fetcher.mock.calls.length;
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});
test("the answer's draft is read twice as often while it is written and ends with the stored reply", async () => {
  let draft: string | undefined = "TEST first";
  const f = setup();
  f.fetcher.mockImplementation(async (url, init) => {
    if (String(url).endsWith("auth/session")) return response(authInfo());
    if (String(url).includes("activity?"))
      return response({
        ...f.payload,
        activity: { ...requestActivity(), ...(draft ? { draft } : {}) },
      });
    if (init?.method === "POST") return f.post.promise;
    return response(f.engine.snapshot());
  });
  const reads = () =>
    f.fetcher.mock.calls.filter(([url]) => String(url).includes("activity?"))
      .length;
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await jest.advanceTimersByTimeAsync(260);
    expect(f.session.getSnapshot().activity?.draft).toBe("TEST first");
    draft = "TEST first draft";
    const before = reads();
    await jest.advanceTimersByTimeAsync(260);
    expect(reads()).toBe(before + 1);
    expect(f.session.getSnapshot().activity?.draft).toBe("TEST first draft");
    // Without a draft the usual pace returns.
    draft = undefined;
    await jest.advanceTimersByTimeAsync(260);
    const paced = reads();
    await jest.advanceTimersByTimeAsync(260);
    expect(reads()).toBe(paced);
    expect(f.session.getSnapshot().activity?.draft).toBeUndefined();
    f.post.resolve(response(f.engine.execute(f.command), 202));
    await send;
    // The stored reply replaces the draft in the same update.
    expect(f.session.getSnapshot().activity).toBeNull();
    expect(
      Object.values(f.session.getSnapshot().store!.conversations)
        .flatMap((conversation) => conversation.messages)
        .some(
          (message) =>
            message.role === "assistant" &&
            message.replyToCommandId === f.command.commandId,
        ),
    ).toBe(true);
  } finally {
    f.session.stop();
  }
});
test.each([ACTIVITY_PROFILE, TOOL_ACTIVITY_PROFILE, LEGACY_ACTIVITY_PROFILE])(
  "client requests enhanced progress and accepts %s",
  async (profile) => {
    const activity =
      profile === ACTIVITY_PROFILE
        ? workflowActivity({ step: 2, stage: "inputs" })
        : profile === TOOL_ACTIVITY_PROFILE
          ? pluginActivity("succeeded")
          : requestActivity();
    const f = setup(
      response({
        profile,
        scope: credential().scope,
        commandId: activity.commandId,
        activity,
      }),
    );
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await jest.advanceTimersByTimeAsync(260);
      expect(f.session.getSnapshot().activity).toEqual(activity);
      expect(
        f.fetcher.mock.calls.some(([url]) =>
          String(url).includes(
            `profile=${encodeURIComponent(ACTIVITY_PROFILE)}`,
          ),
        ),
      ).toBe(true);
      f.post.resolve(response(f.engine.execute(f.command), 202));
      await send;
    } finally {
      f.session.stop();
    }
  },
);

test.each(["scope", "command", "conversation", "unsupported"])(
  "%s progress cannot pollute command state or fail a successful request",
  async (error) => {
    const other = requestActivity();
    if (error === "conversation") other.conversationId = "foreign";
    const payload = {
      profile: ACTIVITY_PROFILE,
      scope: error === "scope" ? credential("b").scope : credential().scope,
      commandId: error === "command" ? "foreign" : other.commandId,
      activity: other,
    };
    const f = setup(response(payload, error === "unsupported" ? 404 : 200));
    try {
      await f.session.start(false);
      const send = f.session.send(f.command);
      await jest.advanceTimersByTimeAsync(260);
      expect(f.session.getSnapshot().activityConnection).toBe("unavailable");
      expect(f.session.getSnapshot().activity).toBeNull();
      expect(f.session.getSnapshot().error).toBeNull();
      f.post.resolve(response(f.engine.execute(f.command), 202));
      await send;
      expect(f.session.getSnapshot().commandStates.chat).toBe("accepted");
    } finally {
      f.session.stop();
    }
  },
);

test("late progress cannot resurrect a finished or stopped session", async () => {
  const progress = gate<Response>(),
    f = setup(progress.promise);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await jest.advanceTimersByTimeAsync(260);
    f.post.resolve(response(f.engine.execute(f.command), 202));
    await send;
    progress.resolve(response(f.payload));
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.session.getSnapshot().activity).toBeNull();
    expect(f.session.getSnapshot().pending).toBeNull();
  } finally {
    f.session.stop();
  }
});

test("lost command response stops live progress and preserves exact command for manual retry", async () => {
  const f = setup();
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await jest.advanceTimersByTimeAsync(260);
    f.post.resolve(response({ error: "model_timeout" }, 503));
    await send;
    expect(f.session.getSnapshot().activityConnection).toBe("unavailable");
    expect(f.session.getSnapshot().pending).toEqual(f.command);
    const calls = f.fetcher.mock.calls.length;
    await jest.advanceTimersByTimeAsync(2000);
    expect(f.fetcher).toHaveBeenCalledTimes(calls);
    expect(f.engine.snapshot().operations).toEqual([]);
  } finally {
    f.session.stop();
  }
});
test("a failed request's error and retry belong to the chat that sent it", async () => {
  const f = setup();
  const own = f.command.conversationId;
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await jest.advanceTimersByTimeAsync(260);
    expect(runningChat(f.session.getSnapshot())).toBe(own);
    f.post.resolve(response({ error: "model_timeout" }, 503));
    await send;
    const state = f.session.getSnapshot();
    expect(state.error).toBe("model_timeout");
    expect(state.commandConversationId).toBe(own);
    // Waiting for a retry is not running.
    expect(runningChat(state)).toBeNull();
    expect(chatOwnsError(state, own)).toBe(true);
    expect(chatOwnsError(state, "conversation-2")).toBe(false);
    expect(canRetryPending(state, own)).toBe(true);
    expect(canRetryPending(state, "conversation-2")).toBe(false);
  } finally {
    f.session.stop();
  }
});

/** An event-stream response whose chunks arrive as the test releases them. */
function streamResponse() {
  const encoder = new TextEncoder();
  let push!: (chunk: AnswerStreamChunk | "done" | null) => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      push = (chunk) => {
        if (chunk === null) controller.close();
        else
          controller.enqueue(
            encoder.encode(
              `data: ${chunk === "done" ? "[DONE]" : JSON.stringify(chunk)}\n\n`,
            ),
          );
      };
    },
  });
  const response = {
    ok: true,
    status: 200,
    headers: {
      get: (name: string) =>
        name.toLowerCase() === "content-type"
          ? "text/event-stream; charset=utf-8"
          : null,
    },
    body,
    text: async () => "",
  } as unknown as Response;
  return {
    response,
    push: (chunk: AnswerStreamChunk | "done" | null) => push(chunk),
  };
}
function streamingSetup(answer: Response | ((post: number) => Response)) {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "test-stream");
  const posts: RequestInit[] = [];
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      if (String(url).includes("activity?"))
        throw new Error("TEST polling is not used while streaming");
      if (init?.method === "POST") {
        posts.push(init);
        return typeof answer === "function" ? answer(posts.length - 1) : answer;
      }
      return response(engine.snapshot());
    },
  );
  const storage = new Map<string, string>();
  const session = new ClientSession(
    "https://fixture/v1/a",
    {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
    },
    credential(),
    fetcher,
    () => {},
    undefined,
    false,
    { stream: true },
  );
  return { session, engine, command, posts, fetcher };
}

test("a streamed answer publishes the draft and the steps as they arrive and ends exactly like the JSON response", async () => {
  jest.useRealTimers();
  const stream = streamResponse();
  const f = streamingSetup(stream.response);
  const plain = setup();
  try {
    await f.session.start(false);
    await plain.session.start(false);
    const send = f.session.send(f.command);
    // Past the client's 80 ms text interval.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
    await settle();
    expect(posts(f)).toHaveLength(1);
    expect((posts(f)[0]!.headers as Record<string, string>).Accept).toBe(
      "text/event-stream",
    );
    stream.push({ type: "start" });
    stream.push({
      type: "tool-input-start",
      toolCallId: "c1",
      toolName: "Search loans",
    });
    stream.push({
      type: "tool-input-available",
      toolCallId: "c1",
      toolName: "Search loans",
      input: { fields: [{ label: "Service", value: "TEST CRM" }] },
    });
    await settle();
    expect(f.session.getSnapshot().activityConnection).toBe("live");
    expect(f.session.getSnapshot().activitySteps).toEqual([
      {
        toolCallId: "c1",
        label: "Search loans",
        status: "running",
        input: [{ label: "Service", value: "TEST CRM" }],
        output: [],
      },
    ]);
    stream.push({
      type: "tool-output-available",
      toolCallId: "c1",
      output: {
        status: "succeeded",
        fields: [{ label: "Returned items", value: "71" }],
      },
    });
    stream.push({ type: "text-start", id: "t1" });
    stream.push({ type: "text-delta", id: "t1", delta: "Peter " });
    stream.push({ type: "text-delta", id: "t1", delta: "is chosen." });
    await settle();
    expect(f.session.getSnapshot().activity?.draft).toBe("Peter is chosen.");
    expect(f.session.getSnapshot().activitySteps?.[0]?.status).toBe(
      "succeeded",
    );
    expect(f.session.getSnapshot().activitySteps?.[0]?.output).toEqual([
      { label: "Returned items", value: "71" },
    ]);
    // The checker sent the reply back; the draft stays until the stored message lands.
    stream.push({ type: "text-end", id: "t1" });
    await settle();
    // The draft stays until the stored message replaces it: no flicker.
    expect(f.session.getSnapshot().activity?.draft).toBe("Peter is chosen.");
    // The result the JSON response would have carried.
    const result = f.engine.execute(f.command);
    stream.push({
      type: "data-niaro-result",
      data: { status: 202, body: result },
    });
    stream.push({ type: "finish" });
    stream.push("done");
    stream.push(null);
    await send;
    // The plain session gets the same result as JSON.
    const plainSend = plain.session.send(plain.command);
    plain.post.resolve(response(plain.engine.execute(plain.command), 202));
    await plainSend;
    const streamed = f.session.getSnapshot(),
      json = plain.session.getSnapshot();
    expect(streamed.activity).toBeNull();
    expect(streamed.activitySteps).toBeNull();
    expect(streamed.pending).toBeNull();
    expect(streamed.commandStates).toEqual(json.commandStates);
    expect(streamed.error).toBe(json.error);
    const texts = (state: typeof streamed) =>
      Object.values(state.store?.conversations ?? {}).map((conversation) =>
        conversation.messages.map((message) => [message.role, message.text]),
      );
    expect(texts(streamed)).toEqual(texts(json));
    expect(posts(f)).toHaveLength(1);
  } finally {
    f.session.stop();
    plain.session.stop();
  }
  function posts(x: ReturnType<typeof streamingSetup>) {
    return x.posts;
  }
});

test("a server that answers JSON to a streaming client is read as JSON, with polling", async () => {
  jest.useRealTimers();
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "test-stream-json");
  const polls: string[] = [];
  const result = engine.execute(command);
  const fetcher = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      if (String(url).includes("activity?")) {
        polls.push(String(url));
        return response({
          profile: ACTIVITY_PROFILE,
          scope: credential().scope,
          commandId: command.commandId,
          activity: null,
        });
      }
      if (init?.method === "POST") {
        const json = response(result, 202);
        return {
          ...json,
          headers: { get: () => "application/json" },
          body: null,
        } as unknown as Response;
      }
      return response(engine.snapshot());
    },
  );
  const storage = new Map<string, string>();
  const session = new ClientSession(
    "https://fixture/v1/a",
    {
      getItem: async (key) => storage.get(key) ?? null,
      setItem: async (key, value) => {
        storage.set(key, value);
      },
    },
    credential(),
    fetcher,
    () => {},
    undefined,
    false,
    { stream: true },
  );
  try {
    await session.start(false);
    await session.send(command);
    expect(session.getSnapshot().pending).toBeNull();
    expect(
      Object.values(session.getSnapshot().store?.conversations ?? {}).map(
        (conversation) => conversation.messages.map((message) => message.text),
      ),
    ).toEqual(
      result.snapshot.conversations.map((conversation) =>
        conversation.messages.map((message) => message.text),
      ),
    );
  } finally {
    session.stop();
  }
});

test("a stream that ends without its result leaves the command pending for a retry, without a second send", async () => {
  jest.useRealTimers();
  const stream = streamResponse();
  const f = streamingSetup(stream.response);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    await new Promise((resolve) => setTimeout(resolve, 20));
    stream.push({ type: "start" });
    stream.push({ type: "text-start", id: "t1" });
    stream.push({ type: "text-delta", id: "t1", delta: "Half" });
    stream.push(null);
    await send;
    expect(f.session.getSnapshot().pending).toEqual(f.command);
    expect(f.session.getSnapshot().commandStates).toEqual({
      chat: "network_error",
    });
    expect(f.posts).toHaveLength(1);
  } finally {
    f.session.stop();
  }
});

test("a streamed approval is shown before the stored result, and the decision streams the same way", async () => {
  jest.useRealTimers();
  const streams = [streamResponse(), streamResponse()];
  const f = streamingSetup((post) => streams[post]!.response);
  try {
    await f.session.start(false);
    const send = f.session.send(f.command);
    // Past the client's 80 ms text interval.
    const settle = () => new Promise((resolve) => setTimeout(resolve, 120));
    await settle();
    const approval = {
      toolCallId: "c1",
      operationId: "op-1",
      toolName: "Create meeting",
      service: "TEST Calendar",
      effect: "write" as const,
      input: { fields: [{ label: "attendee", value: "jane@example.test" }] },
      reviewTruncated: false,
    };
    streams[0]!.push({ type: "start" });
    streams[0]!.push({ type: "data-tool-call-approval", data: approval });
    await settle();
    expect(f.session.getSnapshot().activityApproval).toEqual(approval);
    expect(f.session.getSnapshot().pending).not.toBeNull();
    // The stored result takes over; the announcement ends with the run.
    streams[0]!.push({
      type: "data-niaro-result",
      data: { status: 202, body: f.engine.execute(f.command) },
    });
    streams[0]!.push({ type: "finish" });
    streams[0]!.push("done");
    streams[0]!.push(null);
    await send;
    expect(f.session.getSnapshot().activityApproval).toBeNull();
    expect(f.session.getSnapshot().pending).toBeNull();
    // The decision goes over a stream of its own, like the message did.
    const decision = f.session.send({
      type: "service.resolve",
      commandId: "test-resolve-1",
      idempotencyKey: "test-resolve-1",
      conversationId: f.command.conversationId,
      operationId: "op-1",
      approved: true,
      language: "en",
    });
    await settle();
    expect(f.posts).toHaveLength(2);
    expect((f.posts[1]!.headers as Record<string, string>).Accept).toBe(
      "text/event-stream",
    );
    expect(f.session.getSnapshot().commandStates["op-1"]).toBe("sending");
    streams[1]!.push({ type: "start" });
    streams[1]!.push({ type: "text-start", id: "t1" });
    streams[1]!.push({ type: "text-delta", id: "t1", delta: "Created." });
    await settle();
    expect(f.session.getSnapshot().activity?.draft).toBe("Created.");
    streams[1]!.push({ type: "text-end", id: "t1" });
    streams[1]!.push({
      type: "data-niaro-result",
      data: {
        status: 202,
        body: {
          commandId: "test-resolve-1",
          status: "accepted",
          code: "accepted",
          snapshot: f.engine.snapshot(),
        },
      },
    });
    streams[1]!.push({ type: "finish" });
    streams[1]!.push("done");
    streams[1]!.push(null);
    await decision;
    expect(f.session.getSnapshot().commandStates["op-1"]).toBe("accepted");
    expect(f.session.getSnapshot().activity).toBeNull();
    expect(f.session.getSnapshot().pending).toBeNull();
    expect(f.session.getSnapshot().error).toBeNull();
  } finally {
    f.session.stop();
  }
});
