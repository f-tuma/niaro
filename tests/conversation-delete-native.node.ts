import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustHarness } from "./agent-trust/harness";
import { CommandSchema } from "../packages/protocol";

const create = (id: string) =>
  CommandSchema.parse({
    type: "conversation.create",
    conversationId: id,
    commandId: `create-${id}`,
    idempotencyKey: `create-${id}`,
  });
const message = (id: string, conversationId: string, text: string) =>
  CommandSchema.parse({
    type: "message.send",
    conversationId,
    commandId: id,
    idempotencyKey: id,
    text,
    language: "en",
    timeZone: "UTC",
  });
const remove = (id: string, conversationId: string) =>
  CommandSchema.parse({
    type: "conversation.delete",
    conversationId,
    commandId: id,
    idempotencyKey: id,
  });

test("deleting a chat forgets its native threads and the chat cannot be continued", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST PRIVATE ANSWER CANARY" }));
    assert.equal((await h.execute(create("chat-TEST-D"))).status, "accepted");
    assert.equal(
      (
        await h.execute(
          message("TEST-D-first", "chat-TEST-D", "TEST PRIVATE REQUEST CANARY"),
        )
      ).status,
      "accepted",
    );
    const first = h.commandState("TEST-D-first");
    assert((await h.nativeMessages(first.threadId)).length > 0);
    // Another chat keeps its own memory.
    assert.equal((await h.execute(create("chat-TEST-E"))).status, "accepted");
    h.onChat(() => ({ content: "TEST other chat answer" }));
    await h.execute(message("TEST-E-first", "chat-TEST-E", "TEST other chat"));
    const other = h.commandState("TEST-E-first");

    const deleted = await h.execute(remove("TEST-D-delete", "chat-TEST-D"));
    assert.equal(deleted.status, "accepted", JSON.stringify(deleted.code));
    assert.deepEqual(await h.nativeMessages(first.threadId), []);
    assert((await h.nativeMessages(other.threadId)).length > 0);

    const calls = h.requests.length;
    const continued = await h.execute(
      message("TEST-D-again", "chat-TEST-D", "TEST continue the deleted chat"),
    );
    assert.equal(continued.status, "rejected");
    assert.equal(continued.code, "unknown_context");
    assert.equal(h.requests.length, calls, "TEST no model call");
    assert.equal(
      (await h.execute(remove("TEST-D-delete-2", "chat-TEST-D"))).status,
      "accepted",
    );
    assert.equal(
      (
        await h.execute(
          CommandSchema.parse({
            ...create("chat-TEST-D"),
            commandId: "TEST-recreate",
            idempotencyKey: "TEST-recreate",
          }),
        )
      ).code,
      "unknown_context",
    );
  } finally {
    await h.close();
  }
});

test("the main chat starts a new native thread after deletion and never recalls the deleted one", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST MAIN ANSWER CANARY" }));
    assert.equal(
      (
        await h.execute(
          message("TEST-M-first", "conversation-1", "TEST MAIN REQUEST CANARY"),
        )
      ).status,
      "accepted",
    );
    const first = h.commandState("TEST-M-first");
    assert.equal(
      (await h.execute(remove("TEST-M-delete", "conversation-1"))).status,
      "accepted",
    );
    assert.deepEqual(await h.nativeMessages(first.threadId), []);
    await h.restart();
    h.onChat((body) => {
      const sent = JSON.stringify(body.messages);
      assert(!sent.includes("TEST MAIN REQUEST CANARY"));
      assert(!sent.includes("TEST MAIN ANSWER CANARY"));
      return { content: "TEST fresh answer" };
    });
    assert.equal(
      (
        await h.execute(
          message("TEST-M-second", "conversation-1", "TEST fresh request"),
        )
      ).status,
      "accepted",
    );
    assert.notEqual(h.commandState("TEST-M-second").threadId, first.threadId);
  } finally {
    await h.close();
  }
});

const directory = (
  type: "conversation.archive" | "conversation.restore",
  id: string,
  conversationId: string,
) =>
  CommandSchema.parse({
    type,
    conversationId,
    commandId: id,
    idempotencyKey: id,
  });

test("an archived chat keeps its native memory, takes no turns and continues after restore in a fresh thread with its visible history", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST ARCHIVED ANSWER" }));
    assert.equal((await h.execute(create("chat-TEST-A"))).status, "accepted");
    assert.equal(
      (
        await h.execute(
          message("TEST-A-first", "chat-TEST-A", "TEST ARCHIVED REQUEST"),
        )
      ).status,
      "accepted",
    );
    const first = h.commandState("TEST-A-first");
    const archived = await h.execute(
      directory("conversation.archive", "TEST-A-archive", "chat-TEST-A"),
    );
    assert.equal(archived.status, "accepted", JSON.stringify(archived.code));
    // Archiving forgets nothing; deleting would.
    assert((await h.nativeMessages(first.threadId)).length > 0);

    const calls = h.requests.length;
    const refused = await h.execute(
      message("TEST-A-while", "chat-TEST-A", "TEST while archived"),
    );
    assert.equal(refused.status, "rejected");
    assert.equal(refused.code, "unknown_context");
    assert.equal(h.requests.length, calls, "TEST no model call");

    assert.equal(
      (
        await h.execute(
          directory("conversation.restore", "TEST-A-restore", "chat-TEST-A"),
        )
      ).status,
      "accepted",
    );
    await h.restart();
    h.onChat(() => ({ content: "TEST continued answer" }));
    const before = h.requests.length;
    const continued = await h.execute(
      message("TEST-A-again", "chat-TEST-A", "TEST continue the restored chat"),
    );
    assert.equal(continued.status, "accepted", JSON.stringify(continued.code));
    const again = h.commandState("TEST-A-again");
    assert.notEqual(again.threadId, first.threadId);
    // The person's earlier request reaches the model as visible history.
    const sent = JSON.stringify(h.requests.slice(before));
    assert(sent.includes("TEST ARCHIVED REQUEST"));
    assert(sent.includes("TEST continue the restored chat"));
  } finally {
    await h.close();
  }
});
