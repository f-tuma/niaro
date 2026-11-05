import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CommandSchema } from "../packages/protocol";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

// NIAR-263: consecutive turns of a chat continue one native thread unless
// something the thread actually used was forgotten, revised, expired or
// became inaccessible.

const observe = (h: TrustHarness, statement: string) =>
  h.memoryStore.observe(
    h.memoryActor,
    {
      batchId: randomUUID(),
      expectedVersion: h.memoryStore.version(h.memoryActor),
      deadline: Date.now() + 120000,
      settings: h.memorySettings,
      add: [
        {
          statement,
          section: "projects",
          personal: false,
          sources: [
            {
              type: "chat",
              sourceId: randomUUID(),
              messageId: randomUUID(),
              at: new Date().toISOString(),
              digest: "a".repeat(64),
            },
          ],
        },
      ],
      refresh: [],
      update: [],
    },
    { observationSourceAccess: () => true },
  );
const remember = (
  h: TrustHarness,
  content: string,
  actor: TrustHarness["memoryActor"] = h.memoryActor,
) =>
  h.memoryStore.remember(actor, {
    requestId: randomUUID(),
    content,
    kind: "preference",
    source: { type: "user_note" },
    explicitIntent: true,
    settings: h.memorySettings,
  });
const newTopic = (body: { questions?: { route: { criteria: object } } }) =>
  body.questions?.route.criteria && "new_task" in body.questions.route.criteria
    ? "new_task"
    : undefined;

test("a learner observation between turns keeps the chat's thread", async () => {
  const h = createTrustHarness();
  try {
    await observe(h, "TEST works on the triangle project");
    h.onChat(() => ({ content: "TEST first answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-learner-1" });
    const prior = h.commandState();
    const version = h.memoryStore.version(h.memoryActor);
    await observe(h, "TEST also likes squares");
    assert.notEqual(h.memoryStore.version(h.memoryActor), version);
    h.onChat(() => ({ content: "TEST second answer" }));
    await h.send("And a square?", { id: "TEST-continuity-learner-2" });
    const next = h.commandState();
    assert.equal(next.threadId, prior.threadId);
    // The continued thread pins the version its used items were checked at.
    assert.equal(
      next.threadAuthority?.memoryVersion,
      h.memoryStore.version(h.memoryActor),
    );
  } finally {
    await h.close();
  }
});

test("the learner reconfirming a used observation keeps the thread", async () => {
  const h = createTrustHarness();
  try {
    const [seen] = (await observe(h, "TEST works on the triangle project"))
      .items;
    assert(seen);
    h.onChat(() => ({ content: "TEST first answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-refresh-1" });
    const prior = h.commandState();
    assert(prior.threadAuthority?.memoryMetadata?.items?.includes(seen.id));
    await h.memoryStore.observe(
      h.memoryActor,
      {
        batchId: randomUUID(),
        expectedVersion: h.memoryStore.version(h.memoryActor),
        deadline: Date.now() + 120000,
        settings: h.memorySettings,
        add: [],
        refresh: [
          {
            id: seen.id,
            revision: seen.revision,
            sources: [
              {
                type: "chat",
                sourceId: randomUUID(),
                messageId: randomUUID(),
                at: new Date().toISOString(),
                digest: "b".repeat(64),
              },
            ],
          },
        ],
        update: [],
      },
      { observationSourceAccess: () => true },
    );
    h.onChat(() => ({ content: "TEST second answer" }));
    await h.send("And a square?", { id: "TEST-continuity-refresh-2" });
    assert.equal(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("a save between turns, and the chat's own save, keep the thread", async () => {
  const h = createTrustHarness();
  try {
    let called = false;
    h.onChat(() => {
      if (called) return { content: "TEST saved it" };
      called = true;
      return h.call("memory_remember", {
        facts: [{ text: "I prefer tea", kind: "preference" }],
      });
    });
    await h.send("Remember that I prefer tea.", {
      id: "TEST-continuity-save-1",
    });
    const prior = h.commandState();
    const saved = (
      await h.memoryStore.list(h.memoryActor, { settings: h.memorySettings })
    ).find((item) => item.content === "I prefer tea");
    assert(saved);
    // The person's own words of this chat are not a dependency of its thread.
    assert.deepEqual(prior.threadAuthority?.memoryMetadata?.items, []);
    // Saved elsewhere (app or another chat), then the learner runs.
    await remember(h, "TEST prefers green tea in the morning");
    await observe(h, "TEST drinks tea");
    h.onChat(() => ({ content: "TEST next answer" }));
    await h.send("Try it again.", { id: "TEST-continuity-save-2" });
    assert.equal(h.commandState().threadId, prior.threadId);
    // Delete under the reply: the words stay in the chat, so does the thread.
    await h.memoryStore.forget(h.memoryActor, {
      requestId: randomUUID(),
      id: saved.id,
      revision: saved.revision,
    });
    h.onChat(() => ({ content: "TEST third answer" }));
    await h.send("And now?", { id: "TEST-continuity-save-3" });
    assert.equal(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("forgetting a memory the thread used starts a fresh thread without it", async () => {
  const h = createTrustHarness();
  try {
    const secret = "TEST private preference: quiet purple office";
    const item = await remember(h, secret);
    h.onChat(() => ({ content: "TEST you like a quiet office" }));
    await h.send("What is my saved preference?", {
      id: "TEST-continuity-forget-1",
    });
    const prior = h.commandState();
    assert(prior.threadAuthority?.memoryMetadata?.items?.includes(item.id));
    // An unrelated change first, so the version alone cannot decide.
    await observe(h, "TEST works on the office project");
    await h.memoryStore.forget(h.memoryActor, {
      requestId: randomUUID(),
      id: item.id,
      revision: item.revision,
    });
    const offset = h.requests.length;
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST fresh answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-forget-2" });
    assert.notEqual(h.commandState().threadId, prior.threadId);
    assert(!JSON.stringify(h.requests.slice(offset)).includes(secret));
  } finally {
    await h.close();
  }
});

test("a revised memory the thread used starts a fresh thread", async () => {
  const h = createTrustHarness();
  try {
    const item = await remember(h, "TEST prefers window seats");
    h.onChat(() => ({ content: "TEST window seat noted" }));
    await h.send("Which seat do I like?", { id: "TEST-continuity-revise-1" });
    const prior = h.commandState();
    await h.memoryStore.revise(
      h.memoryActor,
      {
        requestId: randomUUID(),
        id: item.id,
        revision: item.revision,
        content: "TEST prefers aisle seats",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: h.memorySettings,
      },
      () => {},
    );
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST fresh answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-revise-2" });
    assert.notEqual(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("another member's memory changes do not affect this person's thread", async () => {
  const h = createTrustHarness();
  try {
    const bob = { ...h.memoryActor, userId: "TEST-bob" };
    const theirs = await remember(h, "TEST Bob prefers coffee", bob);
    h.onChat(() => ({ content: "TEST first answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-member-1" });
    const prior = h.commandState();
    await remember(h, "TEST Bob also likes cake", bob);
    await h.memoryStore.forget(bob, {
      requestId: randomUUID(),
      id: theirs.id,
      revision: theirs.revision,
    });
    h.onChat(() => ({ content: "TEST second answer" }));
    await h.send("And a square?", { id: "TEST-continuity-member-2" });
    assert.equal(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("a policy change keeps a thread that used no service result", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST first answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-policy-1" });
    const prior = h.commandState();
    h.context.change(h.target.organizationId);
    h.onChat(() => ({ content: "TEST second answer" }));
    await h.send("And a square?", { id: "TEST-continuity-policy-2" });
    const next = h.commandState();
    assert.equal(next.threadId, prior.threadId);
    assert.notEqual(next.epoch, prior.epoch);
  } finally {
    await h.close();
  }
});

test("a policy change still rotates a thread that used a service result", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) =>
      toolResults(body).some((r) => r.currentTurn === true && r.data?.contacts)
        ? { content: "TEST contact found" }
        : h.lookupScript(body),
    );
    await h.send("Find Jane Test.", { id: "TEST-continuity-policy-read" });
    const prior = h.commandState();
    assert(prior.threadAuthority?.sources.length);
    h.context.change(h.target.organizationId);
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST fresh answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-policy-next" });
    assert.notEqual(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("retrying a failed turn continues the chat's thread", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST first answer" }));
    await h.send("Explain a triangle.", { id: "TEST-continuity-retry-1" });
    const prior = h.commandState();
    h.onChat(() => {
      const call = h.call("find_service", {});
      call.tool_calls[0]!.function.arguments = "{";
      return call;
    });
    const failed = CommandSchema.parse({
      type: "message.send",
      commandId: "TEST-continuity-retry-failed",
      idempotencyKey: "TEST-continuity-retry-failed",
      conversationId: "conversation-1",
      text: "And a square?",
      language: "en",
      timeZone: "UTC",
    });
    await h.execute(failed);
    assert.equal(h.commandState().trace?.status, "failed");
    await observe(h, "TEST studies geometry");
    let sawFirst = false;
    h.onChat((body) => {
      sawFirst ||= (body.messages ?? []).some(
        (message) =>
          message.role === "user" && message.content === "Explain a triangle.",
      );
      return { content: "TEST square answer" };
    });
    await h.execute(
      CommandSchema.parse({
        ...failed,
        commandId: "TEST-continuity-retry-again",
        idempotencyKey: "TEST-continuity-retry-again",
        logicalMessageId: failed.commandId,
        retryOf: failed.commandId,
      }),
    );
    const retried = h.commandState();
    assert.equal(retried.retryParentRunId !== undefined, true);
    assert.equal(retried.threadId, prior.threadId);
    assert(sawFirst, "the retry sees the chat's earlier turns");
  } finally {
    await h.close();
  }
});

// NIAR-263: earlier answers of the same chat stay visible to the model unless
// what they drew on was forgotten, revised, expired or became inaccessible.
const WITHHELD = "[Prior private response withheld]";
const assistantTexts = (body: {
  messages?: { role: string; content?: unknown }[];
}) =>
  (body.messages ?? [])
    .filter((message) => message.role === "assistant")
    .map((message) => JSON.stringify(message.content ?? ""));

test("an earlier answer stays visible next to unrelated saved memory", async () => {
  const h = createTrustHarness();
  try {
    await remember(h, "TEST prefers tea in the morning");
    await observe(h, "TEST works on the triangle project");
    h.onChat(() => ({ content: "5837" }));
    await h.send("Vymysli náhodné čtyřmístné číslo", {
      id: "TEST-visible-number-1",
      language: "cs",
    });
    const prior = h.commandState();
    // The saved memory reached the model, and is recorded with the answer.
    assert(prior.replyBasis?.items?.length);
    let seen: string[] = [];
    h.onChat((body) => {
      seen = assistantTexts(body);
      return { content: "Napsal jsem 5837." };
    });
    await h.send("Jaké číslo jsi napsal?", {
      id: "TEST-visible-number-2",
      language: "cs",
    });
    assert.equal(h.commandState().threadId, prior.threadId);
    assert(
      seen.some((text) => text.includes("5837")),
      JSON.stringify(seen),
    );
    assert(!seen.some((text) => text.includes(WITHHELD)));
  } finally {
    await h.close();
  }
});

test("an answer that drew on a memory the chat then forgot is withheld, later ones stay", async () => {
  const h = createTrustHarness();
  try {
    const secret = "TEST quiet purple office";
    const item = await remember(h, secret);
    h.onChat(() => ({ content: "TEST you like a quiet purple office" }));
    await h.send("What is my saved preference?", {
      id: "TEST-visible-forget-1",
    });
    const prior = h.commandState();
    assert(prior.replyBasis?.items?.includes(item.id));
    let forgot = false;
    h.onChat(() => {
      if (forgot) return { content: "TEST forgotten as asked" };
      forgot = true;
      return h.call("memory_forget", {
        id: item.id,
        revision: item.revision,
      });
    });
    await h.send(`Forget: ${secret}`, { id: "TEST-visible-forget-2" });
    const forgetting = h.commandState();
    assert.equal(forgetting.threadId, prior.threadId);
    // The item the turn itself forgot is no dependency of its own answer.
    assert(!forgetting.replyBasis?.items?.includes(item.id));
    let seen: string[] = [];
    h.onChat((body) => {
      seen = assistantTexts(body);
      return { content: "TEST next answer" };
    });
    await h.send("And now?", { id: "TEST-visible-forget-3" });
    assert.equal(h.commandState().threadId, prior.threadId);
    assert(
      !seen.some((text) => text.includes("quiet purple office")),
      JSON.stringify(seen),
    );
    assert(seen.some((text) => text.includes(WITHHELD)));
    assert(seen.some((text) => text.includes("TEST forgotten as asked")));
  } finally {
    await h.close();
  }
});

test("an answer built on a service read stays visible while access lasts and is withheld once revoked", async () => {
  const h = createTrustHarness();
  try {
    const email = "jane@example.test";
    h.onChat((body) =>
      toolResults(body).some((r) => r.currentTurn === true && r.data?.contacts)
        ? { content: `Jane Test email is ${email}.` }
        : h.lookupScript(body),
    );
    await h.send("Find Jane Test.", { id: "TEST-visible-crm-1" });
    const read = h.commandState();
    assert(read.operations.length);
    let seen: string[] = [];
    // A new topic: the read's result does not travel into this turn.
    h.onDecision(newTopic);
    h.onChat((body) => {
      seen = assistantTexts(body);
      return { content: "TEST second answer" };
    });
    await h.send("Thanks, and what is a triangle?", {
      id: "TEST-visible-crm-2",
    });
    assert.equal(h.commandState().threadId, read.threadId);
    assert.deepEqual(h.commandState().sources, []);
    assert(
      seen.some((text) => text.includes(email)),
      JSON.stringify(seen),
    );
    // A policy revision retires the read: its answer no longer reaches the
    // model, neither in a fresh thread's earlier messages nor in its history.
    h.context.change(h.target.organizationId);
    const offset = h.requests.length;
    h.onChat(() => ({ content: "TEST third answer" }));
    await h.send("What did you find?", { id: "TEST-visible-crm-3" });
    assert.notEqual(h.commandState().threadId, read.threadId);
    const later = JSON.stringify(h.requests.slice(offset));
    assert(!later.includes(email));
    // The public answer in between is still there.
    assert(later.includes("TEST second answer"));
  } finally {
    await h.close();
  }
});

test("a fresh thread starts with the earlier replies that pass, generated UI included", async () => {
  const h = createTrustHarness();
  try {
    const program =
      'root = Stack([orders])\norders = Metric("TESTORDERS", 340)';
    h.onChat(() => ({
      content: "Orders are up.\n\n```openui-lang\n" + program + "\n```",
    }));
    await h.send("How are orders?", { id: "TEST-visible-fresh-1" });
    const first = h.commandState();
    assert(first.answer?.ui, "the program was admitted");
    // Saved after the first answer, used by the second one only.
    const item = await remember(h, "TEST quiet purple office");
    h.onChat(() => ({
      content:
        "You like a quiet purple office.\n\n```openui-lang\n" +
        'root = Stack([office])\noffice = Metric("TESTOFFICE", 1)' +
        "\n```",
    }));
    await h.send("What is my saved preference?", {
      id: "TEST-visible-fresh-2",
    });
    const second = h.commandState();
    assert.equal(second.threadId, first.threadId);
    assert(second.answer?.ui);
    await h.memoryStore.forget(h.memoryActor, {
      requestId: randomUUID(),
      id: item.id,
      revision: item.revision,
    });
    const offset = h.requests.length;
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST fresh answer" }));
    await h.send("Explain a triangle.", { id: "TEST-visible-fresh-3" });
    const fresh = h.commandState();
    assert.notEqual(fresh.threadId, first.threadId);
    assert.deepEqual(
      fresh.earlier?.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    const later = JSON.stringify(h.requests.slice(offset));
    // The first answer and its program pass; the second drew on the forgotten
    // memory and is withheld, program included.
    assert(later.includes("Orders are up."));
    assert(later.includes("TESTORDERS"));
    assert(!later.includes("quiet purple office"));
    assert(!later.includes("TESTOFFICE"));
    assert(later.includes(WITHHELD));
    // Each earlier reply is checked again on the next turn.
    h.context.change(h.target.organizationId);
    h.onChat(() => ({ content: "TEST next answer" }));
    const nextOffset = h.requests.length;
    await h.send("And a square?", { id: "TEST-visible-fresh-4" });
    assert.equal(h.commandState().threadId, fresh.threadId);
    assert(JSON.stringify(h.requests.slice(nextOffset)).includes("TESTORDERS"));
  } finally {
    await h.close();
  }
});
