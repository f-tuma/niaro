import {
  AUTOMATIC_SPEECH_START_MS,
  ReplySpeech,
} from "../packages/client-core/speech";
import { followSpokenReply } from "../packages/client-core/automatic-speech";
import {
  ClientSession,
  commandTarget,
  type SessionState,
} from "../packages/client-core/session";
import {
  fromSnapshot,
  selectWorkMessageAnchors,
} from "../packages/client-core/store";
import { authInfo, credential } from "./auth-fixtures";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { messageCommand } from "../packages/client-core/commands";
import { CommandSchema, type Conversation } from "../packages/protocol";
import {
  nativeTaskApproval,
  nativeTaskQuestion,
} from "../packages/test-fixtures";

const conversation = (messages: Conversation["messages"]): Conversation => ({
  id: "conversation-1",
  revision: 1,
  messages,
});
const reply = (id: string, commandId?: string) => ({
  id,
  role: "assistant" as const,
  text: `TEST ${id}`,
  ...(commandId ? { replyToCommandId: commandId } : {}),
});
function setup() {
  const synthesize = jest.fn(async () => ({
    mimeType: "audio/wav" as const,
    base64: "AAAA",
  }));
  const playback = { start: jest.fn(async () => {}), stop: jest.fn() };
  return {
    player: new ReplySpeech(synthesize, playback),
    synthesize,
    playback,
  };
}

test("reads only the final response to its own voice command, once, including card summaries", async () => {
  const { player, synthesize } = setup();
  const complete = player.waitForReply("voice-command", "cs", "speech-request");
  const stored = conversation([
    reply("old"),
    reply("progress", "voice-command"),
    { ...reply("summary", "voice-command"), workItemId: "work" },
    reply("other-device", "other-command"),
  ]);
  await complete(stored);
  await complete(stored);
  expect(synthesize).toHaveBeenCalledTimes(1);
  expect(synthesize.mock.calls[0]).toEqual([
    expect.objectContaining({
      messageId: "summary",
      conversationId: "conversation-1",
      language: "cs",
    }),
    expect.anything(),
  ]);
});

test.each([
  "background",
  "mute",
  "navigation",
  "new microphone",
  "new typed command",
])("%s cancels a pending voice reply", async () => {
  const { player, synthesize } = setup();
  const complete = player.waitForReply("voice-command", "cs", "r");
  player.stop();
  await complete(conversation([reply("reply", "voice-command")]));
  expect(synthesize).not.toHaveBeenCalled();
});

test("new intent or manual playback replaces the old voice intent", async () => {
  const { player, synthesize } = setup();
  const old = player.waitForReply("old", "cs", "old-request");
  const next = player.waitForReply("new", "cs", "new-request");
  await old(conversation([reply("old-answer", "old")]));
  await next(conversation([reply("new-answer", "new")]));
  expect(synthesize).toHaveBeenCalledTimes(1);
  const later = player.waitForReply("later", "cs", "later-request");
  await player.play("conversation-1", "manual", "cs", "manual-request");
  await later(conversation([reply("later-answer", "later")]));
  expect(synthesize).toHaveBeenCalledTimes(2);
});

test("unrelated history, empty and oversized replies never initiate speech", async () => {
  const { player, synthesize } = setup();
  for (const text of ["", " ", "x".repeat(2001)]) {
    await player.waitForReply(
      "voice",
      "cs",
      "r",
    )(conversation([{ ...reply("m", "voice"), text }]));
  }
  await player.waitForReply(
    "voice",
    "cs",
    "r",
  )(conversation([reply("old"), reply("other", "typed")]));
  expect(synthesize).not.toHaveBeenCalled();
});

test("a removed or changed message stops synthesis and a late response cannot play", async () => {
  let resolve!: (audio: { mimeType: "audio/wav"; base64: string }) => void;
  const playback = { start: jest.fn(async () => {}), stop: jest.fn() };
  const player = new ReplySpeech(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
    playback,
  );
  const stored = conversation([reply("answer", "voice")]);
  const pending = player.waitForReply("voice", "cs", "r")(stored);
  player.reconcile({ [stored.id]: stored });
  expect(player.getSnapshot().phase).toBe("loading");
  player.reconcile({ [stored.id]: conversation([]) });
  resolve({ mimeType: "audio/wav", base64: "AAAA" });
  await pending;
  expect(player.getSnapshot().phase).toBe("idle");
  expect(playback.start).not.toHaveBeenCalled();
});

test("cancellation during loading publication prevents synthesis dispatch", async () => {
  const { player, synthesize } = setup();
  const unsubscribe = player.subscribe(() => {
    if (player.getSnapshot().phase === "loading") player.stop();
  });
  try {
    await player.waitForReply(
      "voice",
      "cs",
      "r",
    )(conversation([reply("answer", "voice")]));
    expect(synthesize).not.toHaveBeenCalled();
    expect(player.getSnapshot().phase).toBe("idle");
  } finally {
    unsubscribe();
    player.stop();
  }
});

test("server preserves command correlation on replay without annotating user messages", () => {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "voice");
  const first = engine.execute(command);
  const messages = first.snapshot.conversations[0]!.messages;
  expect(messages.filter((m) => m.role === "assistant").at(-1)).toMatchObject({
    replyToCommandId: "voice",
  });
  expect(
    messages.filter((m) => m.role === "user").every((m) => !m.replyToCommandId),
  ).toBe(true);
  expect(engine.execute(command).snapshot.conversations[0]!.messages).toEqual(
    messages,
  );
});

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function observableCommand() {
  const command = messageCommand("TEST reply", "cs", "voice");
  const snapshot = new FixtureEngine().snapshot();
  let state: SessionState = {
    answerAttempts: [],
    answerRecoveryBlocked: false,
    processPending: null,
    status: "online",
    pending: command,
    commandStates: { chat: "sending" },
    store: fromSnapshot("test", snapshot.scope, snapshot),
    error: null,
    activity: null,
    activityConnection: "waiting",
  };
  const listeners = new Set<() => void>();
  return {
    session: {
      getSnapshot: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    publish: (update: Partial<SessionState>) => {
      state = { ...state, ...update };
      for (const listener of listeners) listener();
    },
    accepted: () => {
      const stored = conversation([reply("answer", "voice")]);
      state = {
        ...state,
        pending: null,
        commandStates: { chat: "accepted" },
        store: { ...state.store!, conversations: { [stored.id]: stored } },
      };
      for (const listener of listeners) listener();
    },
    listeners,
  };
}

test("a long loop does not consume the audio startup deadline; release follows actual playback", async () => {
  jest.useFakeTimers();
  const command = observableCommand();
  let loaded!: () => void;
  const playback = {
    start: jest.fn(
      () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        }),
    ),
    stop: jest.fn(),
  };
  const player = new ReplySpeech(
    async () => ({ mimeType: "audio/wav", base64: "AAAA" }),
    playback,
  );
  const release = jest.fn();
  const cancel = followSpokenReply(
    command.session,
    "voice",
    "chat",
    player.waitForReply("voice", "cs", "r"),
    release,
  );
  try {
    jest.advanceTimersByTime(25000);
    await flush();
    expect(release).not.toHaveBeenCalled();
    expect(playback.start).not.toHaveBeenCalled();
    command.accepted();
    await flush();
    expect(playback.start).toHaveBeenCalledTimes(1);
    expect(player.getSnapshot().phase).toBe("loading");
    jest.advanceTimersByTime(AUTOMATIC_SPEECH_START_MS - 1);
    await flush();
    expect(release).not.toHaveBeenCalled();
    loaded();
    await flush();
    expect(player.getSnapshot().phase).toBe("playing");
    expect(release).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(AUTOMATIC_SPEECH_START_MS);
    expect(player.getSnapshot().phase).toBe("playing");
  } finally {
    cancel();
    player.stop();
    jest.useRealTimers();
  }
});

test("fallback releases text at eight seconds and cannot autoplay a late synthesis", async () => {
  jest.useFakeTimers();
  const command = observableCommand();
  let synthesized!: (value: { mimeType: "audio/wav"; base64: string }) => void;
  const synthesize = jest.fn(
    (_request, _signal) =>
      new Promise<{ mimeType: "audio/wav"; base64: string }>((resolve) => {
        synthesized = resolve;
      }),
  );
  const playback = { start: jest.fn(async () => {}), stop: jest.fn() };
  const player = new ReplySpeech(synthesize, playback);
  const release = jest.fn();
  followSpokenReply(
    command.session,
    "voice",
    "chat",
    player.waitForReply("voice", "cs", "r"),
    release,
  );
  try {
    command.accepted();
    jest.advanceTimersByTime(AUTOMATIC_SPEECH_START_MS);
    await flush();
    expect(release).toHaveBeenCalledTimes(1);
    expect(player.getSnapshot()).toMatchObject({
      phase: "error",
      error: "speech_start_timeout",
    });
    expect(synthesize.mock.calls[0]![1].aborted).toBe(true);
    synthesized({ mimeType: "audio/wav", base64: "AAAA" });
    await flush();
    expect(playback.start).not.toHaveBeenCalled();
  } finally {
    player.stop();
    jest.useRealTimers();
  }
});

test.each(["offline", "rejected", "network_error", "replacement", "cancel"])(
  "%s releases an observed reply without speech",
  async (reason) => {
    const command = observableCommand();
    const speak = jest.fn(async () => {});
    const release = jest.fn();
    const cancel = followSpokenReply(
      command.session,
      "voice",
      "chat",
      speak,
      release,
    );
    if (reason === "cancel") cancel();
    else if (reason === "replacement")
      command.publish({ pending: messageCommand("TEST", "cs", "other") });
    else if (reason === "offline") command.publish({ status: "offline" });
    else
      command.publish({
        pending:
          reason === "rejected" ? null : command.session.getSnapshot().pending,
        commandStates: {
          chat: reason === "rejected" ? "rejected" : "network_error",
        },
      });
    command.accepted();
    await flush();
    expect(speak).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(command.listeners.size).toBe(0);
  },
);

test.each(["en", "cs"] as const)(
  "%s native approval failure updates its card and speaks the decision reply once",
  async (language) => {
    const engine = new FixtureEngine();
    const work = nativeTaskApproval(language);
    const action = work.native!.action!;
    const submitted = "TEST create a meeting";
    const proposal = messageCommand(submitted, language, "TEST-proposal");
    const decision = {
      kind: "reply" as const,
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: "TEST Please approve this meeting.",
    };
    const prepared = engine.execute(proposal, {
      decision,
      expectedCursor: engine.snapshot().cursor,
      timeZone: "UTC",
      nativeReply: decision.reply,
      serviceResult: action,
      nativeWork: [work],
      workItemId: work.id,
    });
    const originalMessage =
      prepared.snapshot.conversations[0]!.messages.at(-1)!;
    const command = CommandSchema.parse({
      type: "service.resolve",
      commandId: "TEST-decision",
      idempotencyKey: "TEST-decision-receipt",
      conversationId: "conversation-1",
      language,
      operationId: action.operationId,
      approved: true,
      workItemId: work.id,
      expectedWorkRevision: work.revision,
    });
    const explanation =
      language === "cs"
        ? "TEST Požadavek se nepodařilo dokončit: odpověď modelu nebyla platná. Potvrzená schůzka byla zachována."
        : "TEST The request could not be completed: the model response was invalid. The confirmed meeting was preserved.";
    work.status = "failed";
    work.result = explanation;
    action.status = "succeeded";
    action.summary = "TEST confirmed meeting";
    const interpretation = {
      decision: { ...decision, reply: explanation },
      expectedCursor: engine.snapshot().cursor,
      timeZone: "UTC",
      nativeReply: explanation,
      serviceResult: action,
      resolvedServiceResult: action,
      nativeWork: [work],
      workItemId: work.id,
    };
    const response = (value: unknown) =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(value),
      }) as Response;
    let deliveries = 0;
    const request = (async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual(command);
        deliveries++;
        return response(engine.execute(command, interpretation));
      }
      return response(engine.snapshot());
    }) as typeof fetch;
    const cache = new Map<string, string>();
    const session = new ClientSession(
      "https://fixture/v1/a",
      {
        getItem: async (key) => cache.get(key) ?? null,
        setItem: async (key, value) => {
          cache.set(key, value);
        },
      },
      credential(),
      request,
    );
    const { player, synthesize } = setup();
    const release = jest.fn();
    try {
      await session.start(false);
      const delivered = session.send(command);
      followSpokenReply(
        session,
        command.commandId,
        commandTarget(command),
        player.waitForReply(command.commandId, language, "TEST-speech"),
        release,
      );
      await delivered;
      await flush();
      const state = session.getSnapshot();
      expect(state.pending).toBeNull();
      expect(state.commandStates[commandTarget(command)]).toBe("accepted");
      const messages = state.store!.conversations["conversation-1"]!.messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]!.text).toBe(submitted);
      expect(messages[1]).toMatchObject({
        id: originalMessage.id,
        text: explanation,
        replyToCommandId: command.commandId,
        result: {
          type: "service.action",
          operationId: action.operationId,
          status: "succeeded",
        },
      });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: originalMessage.id, language }),
        expect.any(AbortSignal),
      );
      expect(release).toHaveBeenCalledTimes(1);
      await session.refresh();
      await session.send(command);
      await flush();
      expect(deliveries).toBe(2);
      expect(
        session.getSnapshot().store!.conversations["conversation-1"]!.messages,
      ).toEqual(messages);
      expect(engine.data.receipts).toHaveLength(2);
      expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
      player.stop();
      session.stop();
    }
  },
);

test.each(["mute", "background", "navigation"])(
  "%s suppresses a queued response and releases its held text",
  async () => {
    const command = observableCommand();
    const { player, synthesize } = setup();
    const release = jest.fn();
    followSpokenReply(
      command.session,
      "voice",
      "chat",
      player.waitForReply("voice", "cs", "r"),
      release,
    );
    player.stop();
    command.accepted();
    await flush();
    expect(synthesize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  },
);

test("accepted publication begins synthesis before command delivery waits for local cache", async () => {
  const engine = new FixtureEngine();
  const command = messageCommand("Choose Peter", "en", "voice");
  const response = (value: unknown) =>
    ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(value),
    }) as Response;
  let blockCache = false;
  let finishCache!: () => void;
  const session = new ClientSession(
    "https://fixture/v1/a",
    {
      getItem: async () => null,
      setItem: async (key) => {
        if (blockCache && key.includes("snapshot"))
          await new Promise<void>((resolve) => {
            finishCache = resolve;
          });
      },
    },
    credential(),
    async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      return response(
        init?.method === "POST" ? engine.execute(command) : engine.snapshot(),
      );
    },
  );
  const { player, synthesize, playback } = setup();
  const release = jest.fn();
  try {
    await session.start(false);
    blockCache = true;
    const delivered = jest.fn();
    const delivery = session.send(command).then(delivered);
    followSpokenReply(
      session,
      "voice",
      "chat",
      player.waitForReply("voice", "en", "r"),
      release,
    );
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(playback.start).toHaveBeenCalledTimes(1);
    expect(player.getSnapshot().phase).toBe("playing");
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(release).toHaveBeenCalledTimes(1);
    expect(delivered).not.toHaveBeenCalled();
    finishCache();
    await delivery;
  } finally {
    player.stop();
    session.stop();
  }
});

test.each(["rejected", "conflict"] as const)(
  "%s with a correlated server explanation speaks that response once",
  async (status) => {
    const command = observableCommand();
    const { player, synthesize } = setup();
    const release = jest.fn();
    followSpokenReply(
      command.session,
      "voice",
      "chat",
      player.waitForReply("voice", "cs", "r"),
      release,
    );
    const stored = conversation([reply("failure-explanation", "voice")]);
    command.publish({
      pending: null,
      commandStates: { chat: status },
      store: {
        ...command.session.getSnapshot().store!,
        conversations: { [stored.id]: stored },
      },
    });
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: "failure-explanation" }),
      expect.any(AbortSignal),
    );
    expect(release).toHaveBeenCalledTimes(1);
    command.accepted();
    await flush();
    expect(synthesize).toHaveBeenCalledTimes(1);
    player.stop();
  },
);

test.each([
  ["en", false],
  ["cs", false],
  ["en", true],
  ["cs", true],
] as const)(
  "%s native failure with uncertain write=%s retains history and speaks once through delivery, polling and replay",
  async (language, uncertain) => {
    const engine = new FixtureEngine();
    const submitted = "TEST complete a CRM request";
    const command = messageCommand(submitted, language, "voice");
    const explanation =
      language === "cs"
        ? "TEST Požadavek se nepodařilo dokončit: odpověď modelu nebyla platná."
        : "TEST The request could not be completed: the model response was invalid.";
    const work = uncertain
      ? nativeTaskApproval(language)
      : nativeTaskQuestion(language);
    work.status = uncertain ? "waiting_system" : "failed";
    work.context = explanation;
    work.result = explanation;
    work.native!.question = undefined;
    if (work.native!.action) work.native!.action.status = "unknown";
    const before = engine.snapshot();
    const interpretation = {
      decision: {
        kind: "reply" as const,
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: explanation,
      },
      nativeReply: explanation,
      nativeWork: [work],
      workItemId: work.id,
      ...(work.native!.action ? { serviceResult: work.native!.action } : {}),
      expectedCursor: before.cursor,
      expectedConversationRevision: before.conversations[0]!.revision,
      timeZone: "UTC",
    };
    const cache = new Map<string, string>();
    const storage = {
      getItem: async (key: string) => cache.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        cache.set(key, value);
      },
    };
    const response = (value: unknown) =>
      ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(value),
      }) as Response;
    let deliveries = 0;
    const request = (async (url, init) => {
      if (String(url).endsWith("auth/session")) return response(authInfo());
      if (init?.method === "POST") {
        expect(JSON.parse(String(init.body))).toEqual(command);
        deliveries++;
        return response(engine.execute(command, interpretation));
      }
      return response(engine.snapshot());
    }) as typeof fetch;
    const session = new ClientSession(
      "https://fixture/v1/a",
      storage,
      credential(),
      request,
    );
    const { player, synthesize } = setup();
    const release = jest.fn();
    let reopened: ClientSession | undefined;
    try {
      await session.start(false);
      const delivered = session.send(command);
      followSpokenReply(
        session,
        "voice",
        "chat",
        player.waitForReply("voice", language, "r"),
        release,
      );
      await delivered;
      await flush();
      const state = session.getSnapshot();
      expect(state.pending).toBeNull();
      expect(state.commandStates.chat).toBe("accepted");
      const messages = state.store!.conversations["conversation-1"]!.messages;
      expect(messages.filter((m) => m.role === "user")).toEqual([
        expect.objectContaining({ text: submitted }),
      ]);
      expect(messages.at(-1)).toMatchObject({
        text: explanation,
        replyToCommandId: "voice",
      });
      expect(state.store!.workItems[work.id]).toMatchObject({
        status: uncertain ? "waiting_system" : "failed",
        result: explanation,
      });
      expect(
        selectWorkMessageAnchors(state.store!, "conversation-1").size,
      ).toBe(0);
      if (uncertain)
        expect(messages.at(-1)!.result).toMatchObject({
          type: "service.action",
          status: "unknown",
          operationId: work.native!.action!.operationId,
        });
      expect(synthesize).toHaveBeenCalledTimes(1);
      expect(synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ messageId: messages.at(-1)!.id, language }),
        expect.any(AbortSignal),
      );
      expect(release).toHaveBeenCalledTimes(1);
      await session.refresh();
      await session.send(command);
      await flush();
      expect(deliveries).toBe(2);
      expect(
        session.getSnapshot().store!.conversations["conversation-1"]!.messages,
      ).toEqual(messages);
      expect(engine.data.receipts).toHaveLength(1);
      expect(synthesize).toHaveBeenCalledTimes(1);
      session.stop();
      reopened = new ClientSession(
        "https://fixture/v1/a",
        storage,
        credential(),
        request,
      );
      await reopened.start(false);
      expect(reopened.getSnapshot().pending).toBeNull();
      expect(
        reopened.getSnapshot().store!.conversations["conversation-1"]!.messages,
      ).toEqual(messages);
      expect(deliveries).toBe(2);
      expect(synthesize).toHaveBeenCalledTimes(1);
    } finally {
      player.stop();
      session.stop();
      reopened?.stop();
    }
  },
);

test("spoken reply remains bound to its public chat when another chat has the same command correlation", async () => {
  const command = observableCommand();
  const speak = jest.fn(async (_conversation?: Conversation) => {});
  const release = jest.fn();
  followSpokenReply(
    command.session,
    "voice",
    "chat",
    speak,
    release,
    "TEST-chat-B",
  );
  const a = {
    ...conversation([reply("TEST-A-result", "voice")]),
    id: "conversation-1",
  };
  const b = {
    ...conversation([reply("TEST-B-result", "voice")]),
    id: "TEST-chat-B",
  };
  command.publish({
    pending: null,
    commandStates: { chat: "accepted" },
    store: {
      ...command.session.getSnapshot().store!,
      conversations: { [a.id]: a, [b.id]: b },
    },
  });
  await flush();
  expect(speak).toHaveBeenCalledTimes(1);
  expect(speak).toHaveBeenCalledWith(b);
  expect(release).toHaveBeenCalledTimes(1);
});
