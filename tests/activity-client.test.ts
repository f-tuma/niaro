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
