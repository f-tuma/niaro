import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import type { Decision } from "../apps/fixture-server/decision";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import { messageCommand } from "../packages/client-core/commands";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  type Command,
} from "../packages/protocol";
import {
  MESSAGE_RESULTS,
  MESSAGE_TIME_PROFILE,
} from "../packages/protocol/message-delivery";

const reply: Decision = {
  kind: "reply",
  contactId: null,
  localStart: null,
  title: null,
  durationMinutes: null,
  reply: "TEST answer",
};
const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

test("clients rename and delete chats on the server; the other client re-reads its list; times reach only the client that asks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-directory-client-"));
  const server = createFixtureServer(directory, undefined, {
    model: { timeZone: "UTC", decide: async () => reply },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`;
  const urls: string[] = [];
  const request = ((input: RequestInfo | URL, init?: RequestInit) => {
    urls.push(String(input));
    return fetch(input, init);
  }) as typeof fetch;
  const credential = async () =>
    CredentialSchema.parse(
      await (
        await fetch(`${address}/auth/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authProfile: AUTH_PROFILE,
            profile: PROFILE,
            code: issuePairingCode(directory, "alice", "a"),
          }),
        })
      ).json(),
    );
  const browser = new ClientSession(
    address,
    memory(),
    await credential(),
    request,
    undefined,
    undefined,
    false,
    { messageTimes: true, messageResults: MESSAGE_RESULTS },
  );
  const phone = new ClientSession(address, memory(), await credential());
  try {
    await browser.start(false);
    await phone.start(false);
    const create: Command = {
      type: "conversation.create",
      conversationId: "chat-TEST-client",
      commandId: "TEST-client-create",
      idempotencyKey: "TEST-client-create",
    };
    browser.selectConversation("chat-TEST-client");
    await browser.send(create);
    assert.equal(
      browser.getSnapshot().commandStates[commandTarget(create)],
      "accepted",
    );
    await browser.send({
      ...messageCommand("TEST question", "en", "TEST-client-message"),
      conversationId: "chat-TEST-client",
    });
    const timed =
      browser.getSnapshot().store!.conversations["chat-TEST-client"]!.messages;
    assert.equal(timed.length, 2);
    assert(timed.every((m) => !!m.createdAt));
    assert(
      urls.some(
        (url) =>
          url.includes("/commands?") &&
          url.includes(
            `messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}`,
          ) &&
          url.includes("results=crm.contacts%2F1,"),
      ),
    );
    phone.selectConversation("chat-TEST-client");
    await phone.refresh();
    const plain =
      phone.getSnapshot().store!.conversations["chat-TEST-client"]!.messages;
    assert.deepEqual(
      plain.map((m) => m.text),
      ["TEST question", "TEST answer"],
    );
    assert(!plain.some((m) => m.createdAt));
    assert(
      (await browser.readConversation("chat-TEST-client")).messages[0]!
        .createdAt,
    );
    assert.equal(
      (await phone.readConversation("chat-TEST-client")).messages[0]!.createdAt,
      undefined,
    );

    await browser.renameConversation("chat-TEST-client", "  Plán  ", "TEST-r1");
    assert.equal(
      (await phone.readConversations()).conversations.find(
        (c) => c.id === "chat-TEST-client",
      )?.title,
      "Plán",
    );
    await assert.rejects(
      browser.renameConversation("chat-TEST-missing", "x", "TEST-r2"),
      /conversation_not_found/,
    );

    const seen = phone.getDirectoryVersion();
    const versions: number[] = [];
    const unsubscribe = phone.subscribe(() =>
      versions.push(phone.getDirectoryVersion()),
    );
    await browser.deleteConversation("chat-TEST-client", "TEST-d1");
    assert.equal(
      browser.getSnapshot().store!.conversations["chat-TEST-client"],
      undefined,
    );
    await phone.sync();
    unsubscribe();
    assert.equal(phone.getDirectoryVersion(), seen + 1);
    assert(versions.includes(seen + 1));
    assert(
      !(await phone.readConversations()).conversations.some(
        (c) => c.id === "chat-TEST-client",
      ),
    );
    // The phone still had it open; it cannot continue it.
    await phone.send({
      ...messageCommand("TEST after", "en", "TEST-client-after"),
      conversationId: "chat-TEST-client",
    });
    assert.equal(phone.getSnapshot().commandStates.chat, "rejected");
  } finally {
    browser.stop();
    phone.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("clients archive and restore chats for every device; an older server's list is filtered here", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "TEST-directory-archive-client-"),
  );
  const server = createFixtureServer(directory, undefined, {
    model: { timeZone: "UTC", decide: async () => reply },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`;
  const credential = async () =>
    CredentialSchema.parse(
      await (
        await fetch(`${address}/auth/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            authProfile: AUTH_PROFILE,
            profile: PROFILE,
            code: issuePairingCode(directory, "alice", "a"),
          }),
        })
      ).json(),
    );
  // A server from before the filter rejects the unknown parameter.
  const filtered: string[] = [];
  const older = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes("&state=")) {
      filtered.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_payload" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    return fetch(input, init);
  }) as typeof fetch;
  const browser = new ClientSession(address, memory(), await credential());
  const phone = new ClientSession(address, memory(), await credential(), older);
  const id = "chat-TEST-archive";
  try {
    await browser.start(false);
    await phone.start(false);
    browser.selectConversation(id);
    await browser.send({
      type: "conversation.create",
      conversationId: id,
      commandId: "TEST-archive-create",
      idempotencyKey: "TEST-archive-create",
    });
    await browser.send({
      ...messageCommand("TEST keep this", "en", "TEST-archive-message"),
      conversationId: id,
    });
    const listed = async (
      session: ClientSession,
      state: "active" | "archived",
    ) =>
      (
        await session.readConversations(null, undefined, state)
      ).conversations.map((c) => c.id);
    assert((await listed(browser, "active")).includes(id));

    const seen = phone.getDirectoryVersion();
    await browser.archiveConversation(id, "TEST-a1");
    assert.equal(browser.getSnapshot().store!.conversations[id], undefined);
    await phone.sync();
    assert.equal(phone.getDirectoryVersion(), seen + 1);
    assert.deepEqual(await listed(browser, "archived"), [id]);
    assert(!(await listed(browser, "active")).includes(id));
    // The phone's server filter is unavailable: it filters each page itself.
    assert.deepEqual(await listed(phone, "archived"), [id]);
    assert(!(await listed(phone, "active")).includes(id));
    assert.equal(filtered.length, 1, "TEST asks the older server only once");
    const page = await phone.readConversation(id);
    assert.equal(page.conversation.readOnly, true);
    assert.deepEqual(
      page.messages.map((m) => m.text),
      ["TEST keep this", "TEST answer"],
    );
    phone.selectConversation(id);
    await phone.send({
      ...messageCommand("TEST into the archive", "en", "TEST-archive-after"),
      conversationId: id,
    });
    assert.equal(phone.getSnapshot().commandStates.chat, "rejected");

    await phone.restoreConversation(id, "TEST-r1");
    await browser.sync();
    assert((await listed(browser, "active")).includes(id));
    assert.deepEqual(await listed(browser, "archived"), []);
    await browser.send({
      ...messageCommand("TEST continue", "en", "TEST-archive-continue"),
      conversationId: id,
    });
    assert.equal(browser.getSnapshot().commandStates.chat, "accepted");
    assert.deepEqual(
      (await browser.readConversation(id)).messages.map((m) => m.text),
      ["TEST keep this", "TEST answer", "TEST continue", "TEST answer"],
    );
    await assert.rejects(
      browser.archiveConversation("chat-hub-TEST", "TEST-a-hub"),
      /conversation_not_found/,
    );
  } finally {
    browser.stop();
    phone.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
