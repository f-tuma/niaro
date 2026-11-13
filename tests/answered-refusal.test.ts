// NIAR-308: a refusal the server answered in the chat shows only that answer.
import { credential, authInfo } from "./auth-fixtures";
import { ClientSession } from "../packages/client-core/session";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { messageCommand } from "../packages/client-core/commands";
import {
  chatOwnsError,
  errorShownByFailedMessage,
  selectFailedMessages,
} from "../packages/client-core/chat-view";
import { translate } from "../packages/i18n";

const memory = () => {
  const map = new Map<string, string>();
  return {
    getItem: async (k: string) => map.get(k) ?? null,
    setItem: async (k: string, v: string) => {
      map.set(k, v);
    },
  };
};
const response = (value: unknown, status = 200) =>
  ({
    ok: status < 300,
    status,
    json: async () => value,
    text: async () => JSON.stringify(value),
  }) as Response;

/** What the chat page and the phone app put into the red error line. */
const notice = (session: ClientSession, conversationId: string) => {
  const state = session.getSnapshot();
  return chatOwnsError(state, conversationId) &&
    !errorShownByFailedMessage(state)
    ? state.error
    : null;
};

/** The server's result for a turn ended by a 409, as model-service.ts stores it. */
function refusing(reply?: string, refuseFrom = 1) {
  const engine = new FixtureEngine();
  let posts = 0;
  const request: typeof fetch = async (url, init) => {
    if (String(url).endsWith("/auth/session")) return response(authInfo());
    if (init?.method === "POST" && ++posts < refuseFrom)
      return response(engine.execute(JSON.parse(String(init.body))));
    if (init?.method === "POST")
      return response(
        engine.execute(JSON.parse(String(init.body)), {
          decision: {
            kind: "reply",
            contactId: null,
            title: null,
            localStart: null,
            durationMinutes: null,
            reply: "",
          },
          expectedCursor: engine.snapshot().cursor,
          timeZone: "UTC",
          terminal: {
            status: "conflict",
            code: "revision_conflict",
            ...(reply ? { reply } : {}),
          },
        }),
      );
    return response(
      String(url).includes("events?") ? engine.events(0) : engine.snapshot(),
    );
  };
  const session = new ClientSession(
    "https://fixture/v1/a",
    memory(),
    credential(),
    request,
  );
  // Every error the session publishes, also the one before its retry sources are saved.
  const errors: (string | null)[] = [];
  session.subscribe(() => errors.push(session.getSnapshot().error));
  return Object.assign(session, { errors });
}

test("a refusal the server answered in the chat shows that answer and no second error", async () => {
  const reply = translate("cs")("memory_context_changed");
  const s = refusing(reply);
  const command = messageCommand("TEST barva", "cs", "TEST-memory-changed");
  try {
    await s.start(false);
    await s.send(command);
    const state = s.getSnapshot();
    // The words and the server's answer are in the chat.
    expect(
      state.store!.conversations[command.conversationId]!.messages.map(
        (message) => [message.role, message.text],
      ),
    ).toEqual([
      ["user", "TEST barva"],
      ["assistant", reply],
    ]);
    expect(state.pending).toBeNull();
    expect(selectFailedMessages(state, command.conversationId)).toEqual([]);
    // The answer is the reason: no error line repeats or contradicts it.
    expect(notice(s, command.conversationId)).toBeNull();
    expect(state.error).toBeNull();
    expect(s.errors).not.toContain("revision_conflict");
    // Same as after a reload.
    await s.sync();
    await s.refresh();
    expect(notice(s, command.conversationId)).toBeNull();
  } finally {
    s.stop();
  }
});

test("a refusal with no answer in the chat keeps its reason", async () => {
  const s = refusing();
  const command = messageCommand("TEST barva", "cs", "TEST-plain-conflict");
  try {
    await s.start(false);
    await s.send(command);
    const state = s.getSnapshot();
    expect(state.error).toBe("revision_conflict");
    // Shown once, on the failed message.
    expect(selectFailedMessages(state, command.conversationId)).toEqual([
      { command, error: "revision_conflict" },
    ]);
    expect(notice(s, command.conversationId)).toBeNull();
  } finally {
    s.stop();
  }
});

test("a stale approval the server answered in the chat shows that answer and no second error", async () => {
  const reply = translate("cs")("revision_conflict");
  const s = refusing(reply, 2);
  const message = messageCommand("TEST ahoj", "cs", "TEST-first");
  try {
    await s.start(false);
    await s.send(message);
    await s.send({
      type: "service.resolve",
      commandId: "TEST-resolve",
      idempotencyKey: "TEST-resolve",
      conversationId: message.conversationId,
      operationId: "op-1",
      approved: true,
      language: "cs",
    });
    const state = s.getSnapshot();
    expect(
      state.store!.conversations[message.conversationId]!.messages.at(-1),
    ).toMatchObject({ role: "assistant", text: reply });
    expect(state.error).toBeNull();
    expect(s.errors).not.toContain("revision_conflict");
  } finally {
    s.stop();
  }
});

test("a reused command id with other words keeps its error next to the first answer", async () => {
  const s = refusing(translate("cs")("memory_context_changed"));
  const first = messageCommand("TEST one", "cs", "TEST-reused");
  try {
    await s.start(false);
    await s.send(first);
    await s.send({ ...first, text: "TEST two" });
    expect(s.getSnapshot().error).toBe("idempotency_conflict");
  } finally {
    s.stop();
  }
});
