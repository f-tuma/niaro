import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { createFixtureServer } from "../apps/fixture-server/http";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import { FixtureStorage } from "../apps/fixture-server/storage";
import type { Decision } from "../apps/fixture-server/decision";
import {
  AUTH_PROFILE,
  PROFILE,
  CONVERSATION_HISTORY_PROFILE,
  CONVERSATION_PROJECTION_PROFILE,
  CommandResultSchema,
  ConversationHistoryPageSchema,
  ConversationMessagePageSchema,
  CredentialSchema,
  CrmContactResultSchema,
  EventsResponseSchema,
  HumanTaskReferenceSchema,
  SnapshotSchema,
} from "../packages/protocol";
import { ServiceResultSchema } from "../packages/protocol/service-result";
import { ServiceConnectionCardSchema } from "../packages/protocol/service-oauth";
import { CardResultSchema } from "../packages/protocol/card-document";
import {
  MESSAGE_TIME_PROFILE,
  messageDeliveryPath,
} from "../packages/protocol/message-delivery";

const call = (
  port: number,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += String(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    req.setTimeout(4000, () => req.destroy(new Error(`TEST timeout ${path}`)));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

/** What a client from before message times and newer result types parses. */
const LegacyMessageSchema = z.strictObject({
  id: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string().min(1),
  logicalMessageId: z.string().optional(),
  replyToCommandId: z.string().optional(),
  workItemId: z.string().optional(),
  inputRequestId: z.string().optional(),
  result: z
    .union([
      CrmContactResultSchema,
      ServiceResultSchema,
      ServiceConnectionCardSchema,
      CardResultSchema,
    ])
    .optional(),
  humanTask: HumanTaskReferenceSchema.optional(),
});
const LegacyConversationsSchema = z.array(
  z.strictObject({
    id: z.string(),
    revision: z.number(),
    messages: z.array(LegacyMessageSchema),
  }),
);

const reply = (text: string): Decision => ({
  kind: "reply",
  contactId: null,
  localStart: null,
  title: null,
  durationMinutes: null,
  reply: text,
});

async function start(
  directory: string,
  decide?: () => Promise<Decision>,
  now?: () => number,
) {
  const server = createFixtureServer(directory, undefined, {
    ...(now ? { now } : {}),
    ...(decide ? { model: { timeZone: "UTC", decide } } : {}),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const pair = async (user: string) =>
    CredentialSchema.parse(
      (
        await call(port, "/v1/a/auth/pair", undefined, {
          authProfile: AUTH_PROFILE,
          profile: PROFILE,
          code: issuePairingCode(directory, user, "a"),
        })
      ).body,
    ).accessToken;
  return { server, port, pair };
}

const commands = `/v1/a/commands?chats=${CONVERSATION_PROJECTION_PROFILE}`;
const index = `/v1/a/conversations?profile=${CONVERSATION_HISTORY_PROFILE}`;
const details = (id: string) =>
  `/v1/a/conversations/messages?profile=${CONVERSATION_HISTORY_PROFILE}&conversationId=${id}`;
const send = (id: string, conversationId: string, text: string) => ({
  type: "message.send",
  commandId: id,
  idempotencyKey: id,
  conversationId,
  text,
  language: "en",
});

test("chats are renamed and deleted on the server for every client of the person, idempotently, leaving nothing readable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-http-"));
  const decide = jest.fn(async () => reply("TEST assistant answer"));
  const { server, port, pair } = await start(directory, decide);
  try {
    const phone = await pair("alice");
    const browser = await pair("alice");
    const bob = await pair("bob");
    const list = async (token: string) =>
      ConversationHistoryPageSchema.parse((await call(port, index, token)).body)
        .conversations;
    const create = {
      type: "conversation.create",
      conversationId: "chat-TEST-x",
      commandId: "TEST-create",
      idempotencyKey: "TEST-create",
    };
    expect((await call(port, commands, phone, create)).status).toBe(202);
    expect(
      (
        await call(
          port,
          commands,
          phone,
          send("TEST-1", "chat-TEST-x", "TEST private budget question"),
        )
      ).status,
    ).toBe(202);
    expect(
      (await list(browser)).find((c) => c.id === "chat-TEST-x")?.title,
    ).toBe("TEST private budget question");

    const rename = {
      type: "conversation.rename",
      conversationId: "chat-TEST-x",
      commandId: "TEST-rename",
      idempotencyKey: "TEST-rename",
      title: "Budget",
    };
    const renamed = await call(port, commands, phone, rename);
    expect(renamed.status).toBe(202);
    expect(CommandResultSchema.parse(renamed.body).code).toBe("accepted");
    // The same press again is its receipt; the same ids with another name are not.
    expect((await call(port, commands, phone, rename)).status).toBe(202);
    expect(
      CommandResultSchema.parse(
        (await call(port, commands, phone, { ...rename, title: "Other" })).body,
      ).code,
    ).toBe("idempotency_conflict");
    expect(
      (await list(browser)).find((c) => c.id === "chat-TEST-x")?.title,
    ).toBe("Budget");
    // A name is trimmed by the client; the server refuses an untrimmed one.
    expect(
      (
        await call(port, commands, phone, {
          ...rename,
          commandId: "TEST-rename-space",
          idempotencyKey: "TEST-rename-space",
          title: " Budget",
        })
      ).status,
    ).toBe(400);
    // Another person cannot name or delete this chat.
    for (const command of [
      { ...rename, commandId: "TEST-bob", idempotencyKey: "TEST-bob" },
      {
        type: "conversation.delete",
        conversationId: "chat-TEST-x",
        commandId: "TEST-bob-delete",
        idempotencyKey: "TEST-bob-delete",
      },
    ])
      expect(
        CommandResultSchema.parse(
          (await call(port, commands, bob, command)).body,
        ).code,
      ).toBe("unknown_context");
    expect(
      (await list(browser)).find((c) => c.id === "chat-TEST-x")?.title,
    ).toBe("Budget");
    // An empty name brings the server's title back.
    await call(port, commands, phone, {
      ...rename,
      commandId: "TEST-unname",
      idempotencyKey: "TEST-unname",
      title: "",
    });
    expect(
      (await list(browser)).find((c) => c.id === "chat-TEST-x")?.title,
    ).toBe("TEST private budget question");

    const before = SnapshotSchema.parse(
      (
        await call(
          port,
          `/v1/a/snapshot?chats=${CONVERSATION_PROJECTION_PROFILE}`,
          browser,
        )
      ).body,
    ).cursor;
    const remove = {
      type: "conversation.delete",
      conversationId: "chat-TEST-x",
      commandId: "TEST-delete",
      idempotencyKey: "TEST-delete",
    };
    const deleted = await call(port, commands, phone, remove);
    expect(deleted.status).toBe(202);
    expect(
      CommandResultSchema.parse(deleted.body).snapshot.conversations.some(
        (c) => c.id === "chat-TEST-x",
      ),
    ).toBe(false);
    // Another client learns from the event log restarting: it needs a snapshot.
    expect(
      (
        await call(
          port,
          `/v1/a/events?after=${before}&chats=${CONVERSATION_PROJECTION_PROFILE}`,
          browser,
        )
      ).status,
    ).toBe(409);
    expect((await list(browser)).some((c) => c.id === "chat-TEST-x")).toBe(
      false,
    );
    expect((await call(port, details("chat-TEST-x"), browser)).status).toBe(
      404,
    );
    expect(
      SnapshotSchema.parse(
        (
          await call(
            port,
            `/v1/a/snapshot?conversationId=chat-TEST-x&chats=${CONVERSATION_PROJECTION_PROFILE}`,
            browser,
          )
        ).body,
      ).conversations.some((c) => c.id === "chat-TEST-x"),
    ).toBe(false);
    // A deleted chat cannot be continued, named or created again.
    const calls = decide.mock.calls.length;
    for (const command of [
      send("TEST-2", "chat-TEST-x", "TEST continue"),
      {
        ...rename,
        commandId: "TEST-rename-2",
        idempotencyKey: "TEST-rename-2",
      },
      {
        ...create,
        commandId: "TEST-create-2",
        idempotencyKey: "TEST-create-2",
      },
    ])
      expect(
        CommandResultSchema.parse(
          (await call(port, commands, browser, command)).body,
        ).code,
      ).toBe("unknown_context");
    expect(decide.mock.calls.length).toBe(calls);
    // Deleting again, from another client, is still a success.
    expect(
      (
        await call(port, commands, browser, {
          ...remove,
          commandId: "TEST-delete-2",
          idempotencyKey: "TEST-delete-2",
        })
      ).status,
    ).toBe(202);
    expect((await call(port, commands, phone, remove)).status).toBe(202);

    // Nothing the person or the assistant wrote stays in the database.
    const db = new DatabaseSync(join(directory, "workflow.sqlite"), {
      readOnly: true,
    });
    try {
      const everything = JSON.stringify(
        ["receipts", "events", "workflows", "public_conversation_message"].map(
          (table) => db.prepare(`SELECT * FROM ${table}`).all(),
        ),
      );
      expect(everything).not.toContain("TEST private budget question");
      expect(everything).not.toContain("TEST assistant answer");
      expect(everything).toContain("TEST-1");
    } finally {
      db.close();
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the main chat is emptied rather than retired; a chat with open work keeps its messages", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-main-"));
  const { server, port, pair } = await start(directory);
  try {
    const token = await pair("alice");
    const list = async () =>
      ConversationHistoryPageSchema.parse((await call(port, index, token)).body)
        .conversations;
    // The demo phrase opens a question (work waiting for input) in the chat.
    expect(
      (
        await call(
          port,
          commands,
          token,
          send("TEST-peter", "conversation-1", "Choose Peter"),
        )
      ).status,
    ).toBe(202);
    const remove = (id: string, key: string) => ({
      type: "conversation.delete",
      conversationId: id,
      commandId: key,
      idempotencyKey: key,
    });
    const busy = CommandResultSchema.parse(
      (await call(port, commands, token, remove("conversation-1", "TEST-d1")))
        .body,
    );
    expect(busy).toMatchObject({
      status: "rejected",
      code: "operation_in_progress",
    });
    expect((await list()).find((c) => c.id === "conversation-1")).toBeTruthy();
    // An unknown chat is not deleted.
    expect(
      CommandResultSchema.parse(
        (await call(port, commands, token, remove("chat-TEST-none", "TEST-d2")))
          .body,
      ).code,
    ).toBe("unknown_context");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
  // With a model: the main chat empties and takes the next message as new.
  const second = mkdtempSync(join(tmpdir(), "TEST-directory-main-model-"));
  const started = await start(second, async () => reply("TEST reply"));
  try {
    const token = await started.pair("alice");
    const list = async () =>
      ConversationHistoryPageSchema.parse(
        (await call(started.port, index, token)).body,
      ).conversations;
    await call(
      started.port,
      commands,
      token,
      send("TEST-m1", "conversation-1", "TEST first life"),
    );
    expect(
      (
        await call(started.port, commands, token, {
          type: "conversation.delete",
          conversationId: "conversation-1",
          commandId: "TEST-main-delete",
          idempotencyKey: "TEST-main-delete",
        })
      ).status,
    ).toBe(202);
    expect((await list()).some((c) => c.id === "conversation-1")).toBe(false);
    expect(
      ConversationMessagePageSchema.parse(
        (await call(started.port, details("conversation-1"), token)).body,
      ).messages,
    ).toEqual([]);
    expect(
      (
        await call(
          started.port,
          commands,
          token,
          send("TEST-m2", "conversation-1", "TEST second life"),
        )
      ).status,
    ).toBe(202);
    expect((await list()).find((c) => c.id === "conversation-1")?.title).toBe(
      "TEST second life",
    );
    expect(
      ConversationMessagePageSchema.parse(
        (await call(started.port, details("conversation-1"), token)).body,
      ).messages.map((m) => m.text),
    ).toEqual(["TEST second life", "TEST reply"]);
  } finally {
    await new Promise<void>((resolve) => started.server.close(() => resolve()));
    rmSync(second, { recursive: true, force: true });
  }
});

test("archiving and restoring are idempotent commands; the list filters by state, newest first; other people see nothing", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-archive-http-"));
  let now = Date.parse("2026-10-17T08:00:00.000Z");
  const { server, port, pair } = await start(
    directory,
    async () => reply("TEST answer"),
    () => (now += 1000),
  );
  try {
    const phone = await pair("alice");
    const bob = await pair("bob");
    const page = async (token: string, query = "") =>
      ConversationHistoryPageSchema.parse(
        (await call(port, `${index}${query}`, token)).body,
      ).conversations.map((c) => [c.id, c.readOnly]);
    for (const id of ["chat-TEST-1", "chat-TEST-2", "chat-TEST-3"]) {
      await call(port, commands, phone, {
        type: "conversation.create",
        conversationId: id,
        commandId: `TEST-create-${id}`,
        idempotencyKey: `TEST-create-${id}`,
      });
      await call(
        port,
        commands,
        phone,
        send(`TEST-send-${id}`, id, `TEST ${id}`),
      );
    }
    const archive = (id: string, key: string, token = phone) =>
      call(port, commands, token, {
        type: "conversation.archive",
        conversationId: id,
        commandId: key,
        idempotencyKey: key,
      });
    const archived = await archive("chat-TEST-1", "TEST-archive-1");
    expect(archived.status).toBe(202);
    expect(CommandResultSchema.parse(archived.body).code).toBe("accepted");
    expect(
      CommandResultSchema.parse(
        (await archive("chat-TEST-1", "TEST-archive-1")).body,
      ).code,
    ).toBe("accepted");
    // The same ids naming another chat are not the same press.
    expect(
      CommandResultSchema.parse(
        (await archive("chat-TEST-2", "TEST-archive-1")).body,
      ).code,
    ).toBe("idempotency_conflict");
    expect(
      CommandResultSchema.parse(
        (await archive("chat-TEST-1", "TEST-archive-bob", bob)).body,
      ).code,
    ).toBe("unknown_context");
    await archive("chat-TEST-3", "TEST-archive-3");
    expect(await page(phone, "&state=archived")).toEqual([
      ["chat-TEST-3", true],
      ["chat-TEST-1", true],
    ]);
    expect(await page(phone, "&state=active")).toEqual([
      ["chat-TEST-2", false],
      ["conversation-1", false],
    ]);
    // An older client's unfiltered list still has every chat, oldest first.
    expect((await page(phone)).map(([id]) => id)).toEqual([
      "conversation-1",
      "chat-TEST-1",
      "chat-TEST-2",
      "chat-TEST-3",
    ]);
    expect(await page(bob, "&state=archived")).toEqual([]);
    expect((await call(port, `${index}&state=gone`, phone)).status).toBe(400);
    const restore = await call(port, commands, phone, {
      type: "conversation.restore",
      conversationId: "chat-TEST-1",
      commandId: "TEST-restore-1",
      idempotencyKey: "TEST-restore-1",
    });
    expect(CommandResultSchema.parse(restore.body).code).toBe("accepted");
    expect((await page(phone, "&state=active"))[0]).toEqual([
      "chat-TEST-1",
      false,
    ]);
    const continued = await call(
      port,
      commands,
      phone,
      send("TEST-send-again", "chat-TEST-1", "TEST again"),
    );
    expect(CommandResultSchema.parse(continued.body).code).toBe("accepted");
    expect(
      ConversationMessagePageSchema.parse(
        (await call(port, details("chat-TEST-1"), phone)).body,
      ).messages.map((m) => m.text),
    ).toEqual(["TEST chat-TEST-1", "TEST answer", "TEST again", "TEST answer"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("message times and newer result types reach only the clients that ask; an old client still parses everything", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-delivery-http-"));
  const now = Date.parse("2026-10-17T08:30:00.000Z");
  // A stored chat with a result type newer than the baseline.
  const auth = new FixtureAuth(directory);
  const scope = {
    connectionId: "fixture-a",
    serverId: auth.serverId,
    userId: "alice",
    workspaceId: "a",
  };
  const storage = new FixtureStorage(directory, auth.serverId, () => now);
  storage.execute(scope, {
    type: "conversation.create",
    conversationId: "chat-TEST-skill",
    commandId: "TEST-skill-create",
    idempotencyKey: "TEST-skill-create",
  });
  storage.execute(
    scope,
    send("TEST-skill", "chat-TEST-skill", "TEST draft me a skill"),
    {
      decision: reply("TEST here is a draft skill."),
      expectedCursor: storage.snapshot(scope, "chat-TEST-skill").cursor,
      timeZone: "UTC",
      skillProposal: {
        type: "skill.proposal",
        version: 1,
        proposalId: "TEST-proposal",
        name: "TEST skill",
        description: "TEST description",
        preview: "TEST instructions",
        files: [],
        workspaceAllowed: false,
      },
    },
  );
  storage.close();
  const { server, port, pair } = await start(directory, undefined, () => now);
  try {
    const token = await pair("alice");
    const snapshotPath = `/v1/a/snapshot?conversationId=chat-TEST-skill&chats=${CONVERSATION_PROJECTION_PROFILE}`;
    // No declaration: a strict old parser reads the whole snapshot.
    const old = SnapshotSchema.parse(
      (await call(port, snapshotPath, token)).body,
    );
    const legacy = LegacyConversationsSchema.parse(old.conversations);
    const answer = legacy
      .find((c) => c.id === "chat-TEST-skill")!
      .messages.find((m) => m.role === "assistant")!;
    expect(answer.text).toBe("TEST here is a draft skill.");
    expect(answer).not.toHaveProperty("result");
    expect(
      LegacyConversationsSchema.parse(
        EventsResponseSchema.parse(
          (
            await call(
              port,
              `/v1/a/events?after=0&chats=${CONVERSATION_PROJECTION_PROFILE}`,
              token,
            )
          ).body,
        ).events.flatMap((e) =>
          e.type === "conversation.upserted" ? [e.entity] : [],
        ),
      ).length,
    ).toBeGreaterThan(0);
    // A client that names both gets both.
    const current = SnapshotSchema.parse(
      (
        await call(
          port,
          messageDeliveryPath(snapshotPath, {
            times: true,
            results: ["skill.proposal/1"],
          }),
          token,
        )
      ).body,
    );
    const messages = current.conversations.find(
      (c) => c.id === "chat-TEST-skill",
    )!.messages;
    expect(messages.map((m) => m.createdAt)).toEqual([
      "2026-10-17T08:30:00.000Z",
      "2026-10-17T08:30:00.000Z",
    ]);
    expect(messages[1]!.result?.type).toBe("skill.proposal");
    // Times without results, and an unknown declaration is ignored.
    const timed = SnapshotSchema.parse(
      (
        await call(
          port,
          `${snapshotPath}&messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}&results=bogus,x.y%2F99`,
          token,
        )
      ).body,
    ).conversations.find((c) => c.id === "chat-TEST-skill")!.messages[1]!;
    expect(timed.createdAt).toBe("2026-10-17T08:30:00.000Z");
    expect(timed.result).toBeUndefined();
    // History pages carry times only when asked; the old route stays strict.
    const plain = ConversationMessagePageSchema.parse(
      (await call(port, details("chat-TEST-skill"), token)).body,
    );
    expect(plain.messages.every((m) => m.createdAt === undefined)).toBe(true);
    const withTimes = ConversationMessagePageSchema.parse(
      (
        await call(
          port,
          messageDeliveryPath(details("chat-TEST-skill"), { times: true }),
          token,
        )
      ).body,
    );
    expect(withTimes.messages[0]!.createdAt).toBe("2026-10-17T08:30:00.000Z");
    expect(
      (await call(port, `${details("chat-TEST-skill")}&results=x`, token))
        .status,
    ).toBe(400);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
