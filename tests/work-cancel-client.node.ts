import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { ClientSession } from "../packages/client-core/session";
import {
  ConversationOpenWorkError,
  chatChangeError,
  openWorkKindKey,
  workCancelError,
} from "../packages/client-core/conversation-directory";
import {
  AUTH_PROFILE,
  PROFILE,
  CONVERSATION_PROJECTION_PROFILE,
  CredentialSchema,
} from "../packages/protocol";

const memory = () => {
  const values = new Map<string, string>();
  return {
    getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      values.set(key, value);
    },
  };
};

test("the client names a chat's open work, cancels it and deletes the chat with cancelOpenWork", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-work-cancel-client-"));
  const server = createFixtureServer(directory, undefined, {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`;
  const credential = CredentialSchema.parse(
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
  const post = (body: object) =>
    fetch(`${address}/commands?chats=${CONVERSATION_PROJECTION_PROFILE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${credential.accessToken}`,
      },
      body: JSON.stringify(body),
    });
  // Two demo questions in two chats.
  await post({
    type: "message.send",
    commandId: "TEST-peter",
    idempotencyKey: "TEST-peter",
    conversationId: "conversation-1",
    text: "Choose Peter",
    language: "en",
  });
  const session = new ClientSession(address, memory(), credential);
  try {
    await session.start(false);
    const store = () => session.getSnapshot().store!;
    const work = Object.values(store().workItems).find(
      (w) => w.conversationId === "conversation-1",
    )!;
    assert.equal(work.status, "waiting_input");

    const refusal = await session
      .deleteConversation("conversation-1", "TEST-delete-1")
      .then(
        () => assert.fail("TEST delete must be refused"),
        (error: unknown) => error,
      );
    assert(refusal instanceof ConversationOpenWorkError);
    assert.equal(chatChangeError(refusal), "chatOpenWork");
    assert.deepEqual(refusal.openWork, [
      { workItemId: work.id, title: work.title, kind: "question" },
    ]);
    assert.equal(openWorkKindKey("question"), "openWorkQuestion");

    await assert.rejects(
      session.cancelWork(
        { ...work, revision: work.revision + 1 },
        "en",
        "TEST-c1",
      ),
      (error: Error) =>
        error.message === "work_changed" &&
        workCancelError(error) === "workCancelChanged",
    );
    await assert.rejects(
      session.cancelWork({ ...work, id: "TEST-missing" }, "en", "TEST-c2"),
      /work_not_found/,
    );
    await session.cancelWork(work, "en", "TEST-c3");
    assert.equal(store().workItems[work.id]?.status, "cancelled");

    // A question in the main chat again, then delete with the flag.
    await post({
      type: "message.send",
      commandId: "TEST-peter-2",
      idempotencyKey: "TEST-peter-2",
      conversationId: "conversation-1",
      text: "Choose Peter",
      language: "en",
    });
    await session.refresh();
    await session.deleteConversation("conversation-1", "TEST-delete-2", {
      cancelOpenWork: true,
    });
    assert(
      Object.values(store().workItems)
        .filter((w) => w.conversationId === "conversation-1")
        .every((w) => w.status === "cancelled"),
    );
    assert.equal(workCancelError(new Error("work_busy")), "workCancelBusy");
  } finally {
    session.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
