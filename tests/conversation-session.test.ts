import { ClientSession, commandTarget } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { authInfo, credential } from "./auth-fixtures";
import {
  CONVERSATION_HISTORY_PROFILE,
  type ConversationSummary,
} from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";

const summary = (id: string): ConversationSummary => ({
  id,
  revision: 1,
  title: `TEST ${id}`,
  createdAt: "2026-10-07T00:00:00.000Z",
  updatedAt: "2026-10-07T00:00:00.000Z",
  messageCount: 0,
  readOnly: false,
});
const response = (value: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(value),
  }) as Response;
const storage = () => ({
  getItem: jest.fn(async (_key: string) => null),
  setItem: jest.fn(async (_key: string, _value: string) => {}),
});
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

test("passive readers reuse authenticated transport and reject foreign scope, result cards and mixed revisions", async () => {
  const scope = credential().scope;
  let page: unknown = {
    profile: CONVERSATION_HISTORY_PROFILE,
    scope,
    conversations: [summary("TEST-A")],
    nextAfter: null,
  };
  const calls: { url: string; method: string }[] = [];
  const request = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET" });
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Authorization: `Bearer ${credential().accessToken}`,
        }),
      );
      if (url.includes("auth/session")) return response(authInfo());
      if (url.includes("snapshot"))
        return response(new FixtureEngine().snapshot());
      if (url.includes("conversations")) return response(page);
      throw Error("TEST unexpected request");
    },
  ) as typeof fetch;
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage(),
    credential(),
    request,
  );
  try {
    await session.start();
    expect((await session.readConversations()).conversations[0]!.id).toBe(
      "TEST-A",
    );
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    page = {
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: { ...scope, userId: "foreign" },
      conversations: [summary("TEST-A")],
      nextAfter: null,
    };
    await expect(session.readConversations()).rejects.toThrow("scope_mismatch");
    page = {
      profile: CONVERSATION_HISTORY_PROFILE,
      scope,
      conversation: summary("TEST-A"),
      messages: [],
      nextAfter: null,
    };
    await expect(session.readConversation("TEST-A", null, 2)).rejects.toThrow(
      "conversation_changed",
    );
    page = {
      profile: CONVERSATION_HISTORY_PROFILE,
      scope,
      conversation: summary("TEST-A"),
      messages: [
        {
          id: "TEST-message",
          role: "assistant",
          text: "TEST",
          result: {
            type: "crm.contacts",
            version: 1,
            source: "twenty",
            contacts: [],
            hasMore: false,
          },
        },
      ],
      nextAfter: null,
    };
    await expect(session.readConversation("TEST-A")).rejects.toThrow(
      "conversation_changed",
    );
  } finally {
    session.stop();
  }
});

test("selecting B while A is pending preserves the sole exact outbox and replay origin", async () => {
  const engine = new FixtureEngine();
  for (const id of ["TEST-A", "TEST-B"])
    engine.execute({
      type: "conversation.create",
      conversationId: id,
      commandId: `create-${id}`,
      idempotencyKey: `create-${id}`,
    });
  const delivery = gate<Response>();
  const writes = storage();
  const bodies: string[] = [];
  const request = jest.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/session")) return response(authInfo());
      if (url.includes("snapshot")) return response(engine.snapshot());
      if (url.includes("commands")) {
        bodies.push(String(init?.body));
        return delivery.promise;
      }
      throw Error("TEST unexpected request");
    },
  ) as typeof fetch;
  const session = new ClientSession(
    "https://fixture/v1/a",
    writes,
    credential(),
    request,
  );
  try {
    await session.start();
    const command = {
      ...messageCommand("TEST original A draft", "en", "TEST-A-send"),
      conversationId: "TEST-A",
    };
    const sent = session.send(command);
    for (let n = 0; n < 30 && !bodies.length; n++) await Promise.resolve();
    session.selectConversation("TEST-B");
    expect(session.getSnapshot().pending).toEqual(command);
    expect(bodies).toEqual([JSON.stringify(command)]);
    expect(
      writes.setItem.mock.calls.some(
        (call) => String(call[1]) === JSON.stringify(command),
      ),
    ).toBe(true);
    const result = engine.execute(command, {
      expectedCursor: engine.snapshot().cursor,
      timeZone: "UTC",
      decision: {
        kind: "reply",
        reply: "TEST reply A",
        title: null,
        contactId: null,
        localStart: null,
        durationMinutes: null,
      },
    });
    delivery.resolve(response(result, 202));
    await sent;
    expect(session.getSnapshot().pending).toBeNull();
    expect(session.getSnapshot().commandStates[commandTarget(command)]).toBe(
      "accepted",
    );
    expect(session.getSnapshot().store!.conversations["TEST-B"]).toBeDefined();
    expect(bodies).toHaveLength(1);
  } finally {
    session.stop();
  }
});

test("a stopped identity cannot return a late history page and old servers clearly report unavailable history", async () => {
  const pending = gate<Response>();
  let old = false;
  const request = jest.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("auth/session")) return response(authInfo());
    if (url.includes("snapshot"))
      return response(new FixtureEngine().snapshot());
    return old ? response({ error: "not_found" }, 404) : pending.promise;
  }) as typeof fetch;
  const session = new ClientSession(
    "https://fixture/v1/a",
    storage(),
    credential(),
    request,
  );
  await session.start();
  const read = session.readConversations();
  await Promise.resolve();
  session.stop();
  pending.resolve(
    response({
      profile: CONVERSATION_HISTORY_PROFILE,
      scope: credential().scope,
      conversations: [summary("TEST-A")],
      nextAfter: null,
    }),
  );
  await expect(read).rejects.toThrow("session_stopped");
  old = true;
  const next = new ClientSession(
    "https://fixture/v1/a",
    storage(),
    credential(),
    request,
  );
  try {
    await next.start();
    await expect(next.readConversations()).rejects.toThrow(
      "conversation_history_unavailable",
    );
  } finally {
    next.stop();
  }
});

describe("NIAR-308: a chat's creation that met a 502", () => {
  const setup = (
    failures: number,
    failWrite: (value: string) => boolean = () => false,
    recorded = false,
  ) => {
    const engine = new FixtureEngine();
    const stored = new Map<string, string>();
    const writes = {
      getItem: async (key: string) => stored.get(key) ?? null,
      setItem: async (key: string, value: string) => {
        if (failWrite(value)) throw Error("TEST quota");
        stored.set(key, value);
      },
    };
    const posts: string[] = [];
    let left = failures;
    const request = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("auth/session")) return response(authInfo());
      if (init?.method === "POST") {
        const command = JSON.parse(String(init.body));
        posts.push(command.type);
        if (left-- > 0) {
          // The server may have recorded it before the gateway lost the answer.
          if (recorded) engine.execute(command);
          return {
            ok: false,
            status: 502,
            text: async () => "<html>502 Bad Gateway</html>",
          } as Response;
        }
        return response(engine.execute(command), 202);
      }
      return response(
        url.includes("events?") ? engine.events(0) : engine.snapshot(),
      );
    }) as typeof fetch;
    const open = () =>
      new ClientSession("https://fixture/v1/a", writes, credential(), request);
    return { posts, open, stored };
  };
  const create = (id: string) => ({
    type: "conversation.create" as const,
    conversationId: `TEST-chat-${id}`,
    commandId: `TEST-create-${id}`,
    idempotencyKey: `TEST-create-${id}`,
  });

  test.each([false, true])(
    "is not kept: the next create and the message are sent (recorded: %s)",
    async (recorded) => {
      const { posts, open } = setup(1, undefined, recorded);
      const session = open();
      try {
        await session.start(false);
        const command = create("a");
        await session.send(command);
        const failed = session.getSnapshot();
        expect(failed.pending).toBeNull();
        expect(failed.commandStates[commandTarget(command)]).not.toBe(
          "accepted",
        );
        await session.send(create("a"));
        expect(
          session.getSnapshot().commandStates[commandTarget(command)],
        ).toBe("accepted");
        await session.send({
          ...messageCommand("TEST Najdi Jana", "cs", "TEST-message-a"),
          conversationId: command.conversationId,
        });
        expect(posts).toEqual([
          "conversation.create",
          "conversation.create",
          "message.send",
        ]);
      } finally {
        session.stop();
      }
    },
  );

  test("stays kept when its release cannot be saved", async () => {
    const { open } = setup(1, (value) => value === "null");
    const session = open();
    try {
      await session.start(false);
      const command = create("b");
      await session.send(command);
      expect(session.getSnapshot().pending).toEqual(command);
      expect(session.getSnapshot().commandStates[commandTarget(command)]).toBe(
        "network_error",
      );
    } finally {
      session.stop();
    }
  });

  test("that could not be stored keeps its storage error and is not sent", async () => {
    const { open, posts } = setup(0, (value) =>
      value.includes("conversation.create"),
    );
    const session = open();
    try {
      await session.start(false);
      await session.send(create("c"));
      expect(session.getSnapshot().error).toBe("storage_error");
      expect(posts).toEqual([]);
    } finally {
      session.stop();
    }
  });

  test("a kept message, unlike a kept creation, is restored at start", async () => {
    const { open, stored } = setup(0);
    const first = open();
    await first.start(false);
    await first.send(create("seed"));
    first.stop();
    const [key] = [...stored.keys()].filter((k) =>
      k.startsWith("agent-client.command.v2:"),
    );
    const message = {
      ...messageCommand("TEST Najdi Jana", "cs", "TEST-message-kept"),
      conversationId: "TEST-chat-seed",
    };
    stored.set(key!, JSON.stringify(message));
    const session = open();
    try {
      await session.start(false);
      expect(session.getSnapshot().pending).toMatchObject({
        commandId: message.commandId,
      });
    } finally {
      session.stop();
    }
  });

  test("stored from before a reload is ignored at start, so another chat sends", async () => {
    const { posts, open, stored } = setup(0);
    const first = open();
    await first.start(false);
    await first.send(create("seed"));
    first.stop();
    const [key] = [...stored.keys()].filter((k) =>
      k.startsWith("agent-client.command.v2:"),
    );
    expect(key).toBeDefined();
    stored.set(key!, JSON.stringify(create("old")));
    const session = open();
    try {
      await session.start(false);
      expect(session.getSnapshot().pending).toBeNull();
      const command = create("new");
      await session.send(command);
      expect(session.getSnapshot().commandStates[commandTarget(command)]).toBe(
        "accepted",
      );
      expect(posts).toEqual(["conversation.create", "conversation.create"]);
    } finally {
      session.stop();
    }
  });
});
