import assert from "node:assert/strict";
import { test } from "node:test";
import { IdentityError } from "../apps/server-identity/error";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
  type ModelRequest,
} from "./agent-trust/harness";

const email = "jane@example.test";
const emailReply = `Jane Test email is ${email}.`;
const conversation = { conversationId: "conversation-1" };
const signal = () => new AbortController().signal;
const newTopic = (body: ModelRequest) =>
  body.questions?.route.criteria.new_task ? "new_task" : undefined;
const expire = (h: TrustHarness, id: string) => {
  const receipt = h.catalog.invocation(id, h.scope.workspaceId, h.scope.userId);
  assert(receipt);
  receipt.completedAt = Date.now() - 31 * 60 * 1000;
  h.catalog.saveInvocation(receipt);
};
const lookup = (h: TrustHarness) => {
  h.onChat((body) =>
    toolResults(body).some((r) => r.currentTurn === true && r.data?.contacts)
      ? { content: emailReply }
      : h.lookupScript(body),
  );
};
const direct = (
  h: TrustHarness,
  id: string,
  text: string,
  history: { role: "user" | "assistant"; text: string }[] = [],
) =>
  h
    .runtime()
    .message(
      id,
      text,
      "en",
      history,
      signal(),
      undefined,
      undefined,
      "UTC",
      conversation,
    );

test("ordinary public native assistant history remains available with an empty enabled memory plugin", async () => {
  const h = createTrustHarness();
  try {
    const publicReply = "A triangle has three sides.";
    h.onChat(() => ({ content: publicReply }));
    await h.send("Explain a triangle.", { id: "TEST-history-public" });
    const prior = h.commandState();
    let retained = false;
    h.onChat((body) => {
      retained = (body.messages ?? []).some(
        (message) =>
          message.role === "assistant" && message.content === publicReply,
      );
      return { content: "TEST another public answer" };
    });
    await h.send("What was the explanation?", {
      id: "TEST-history-public-followup",
    });
    assert(
      retained,
      "a server-marked public assistant answer remains in native short memory",
    );
    assert.equal(h.commandState().threadId, prior.threadId);
  } finally {
    await h.close();
  }
});

test("expired CRM authority rotates native history after read-derived write arguments", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    h.onChat((body) => {
      const receipts = toolResults(body).filter((r) => r.currentTurn === true);
      const read = receipts.find((r) => r.data?.contacts);
      if (!read) return h.lookupScript(body);
      if (!receipts.some((r) => r.data?.created))
        return h.call(h.tool("Create meeting"), {
          body: {
            attendee: read.data.contacts[0].email,
            start: "2026-10-01T12:00:00Z",
            end: "2026-10-01T12:30:00Z",
          },
        });
      return { content: `The meeting was created for ${email}.` };
    });
    await h.send("Find Jane Test and create a meeting with her.", {
      id: "TEST-history-write",
    });
    const prior = h.commandState();
    assert.equal(
      h.network.filter((r) => r.path.endsWith("/meetings")).length,
      1,
    );
    assert.equal(prior.threadAuthority?.sources.length, 1);
    const invocations = await h.nativeInvocations(prior.threadId);
    assert(
      invocations.some((call) => call.toolName === h.tool("Create meeting")),
    );
    for (const call of invocations.filter((call) =>
      call.toolName.startsWith("action_"),
    ))
      assert.deepEqual(
        call.args,
        {},
        "native conversation arguments are opaque",
      );
    expire(h, prior.sources[0]!);
    const offset = h.requests.length;
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST triangle answer" }));
    await h.send("New topic: explain a triangle.", {
      id: "TEST-history-fresh",
    });
    const next = h.commandState();
    assert.notEqual(next.threadId, prior.threadId);
    assert.deepEqual(next.sources, []);
    assert.deepEqual(next.threadAuthority?.sources, []);
    assert(!JSON.stringify(h.requests.slice(offset)).includes(email));
    assert.equal(
      h.network.filter((r) => r.path.endsWith("/meetings")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("source-only assistant copies cannot reach native models or Jev and intervening turns retain authority", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test and tell me her email.", {
      id: "TEST-history-read",
    });
    const read = h.commandState();
    h.onChat(() => ({ content: emailReply }));
    await h.send("What is her email?", { id: "TEST-history-derived" });
    const derived = h.commandState();
    assert.equal(
      derived.operations.length,
      0,
      "the derived copy has no new read",
    );
    assert.equal(derived.answer?.reply, emailReply);
    assert.equal(derived.threadId, read.threadId);
    assert.deepEqual(derived.sources, read.sources);
    const offset = h.requests.length;
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST public triangle explanation" }));
    await h.send("New topic: explain a triangle.", {
      id: "TEST-history-intervening",
    });
    const middle = h.commandState();
    assert.equal(
      middle.threadId,
      read.threadId,
      "valid history remains on its authorized thread",
    );
    assert.deepEqual(middle.sources, []);
    assert.deepEqual(middle.operations, []);
    assert.deepEqual(
      middle.threadAuthority?.sources,
      read.threadAuthority?.sources,
    );
    const payloads = h.requests.slice(offset);
    assert(
      payloads.some((body) => body.questions),
      "exercise actual Jev dispatch",
    );
    assert(
      !JSON.stringify(payloads).includes(email),
      "plain derived assistant history is excluded",
    );
    expire(h, read.sources[0]!);
    await h.send("Explain a square too.", {
      id: "TEST-history-after-intervening",
    });
    assert.notEqual(h.commandState().threadId, middle.threadId);
  } finally {
    await h.close();
  }
});

test("a public answer after a private read stays in native short memory while source authority remains cumulative", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", {
      id: "TEST-history-private-before-public",
    });
    const read = h.commandState();
    const publicReply = "Triangles have three sides and three angles.";
    h.onDecision(newTopic);
    h.onChat(() => ({ content: publicReply }));
    await h.send("New topic: explain a triangle.", {
      id: "TEST-history-public-after-private",
    });
    const middle = h.commandState();
    assert.deepEqual(middle.sources, []);
    assert.deepEqual(
      middle.threadAuthority?.sources,
      read.threadAuthority?.sources,
    );
    let retained = false;
    h.onChat((body) => {
      retained = (body.messages ?? []).some(
        (message) =>
          message.role === "assistant" && message.content === publicReply,
      );
      assert(!JSON.stringify(body.messages).includes(email));
      return { content: "TEST public followup" };
    });
    await h.send("What did you say about triangles?", {
      id: "TEST-history-retained-public-after-private",
    });
    assert(retained);
    assert.equal(h.commandState().threadId, middle.threadId);
    assert.deepEqual(
      h.commandState().threadAuthority?.sources,
      read.threadAuthority?.sources,
    );
  } finally {
    await h.close();
  }
});

test("unmapped pre-fix thread history rotates and unknown assistant history is excluded from Jev", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", { id: "TEST-history-legacy" });
    const prior = h.commandState();
    delete prior.threadAuthority;
    h.catalog.saveTurn(prior.runId, h.scope.workspaceId, h.scope.userId, prior);
    h.catalog.rememberTurn(prior.runId, h.scope.workspaceId, h.scope.userId);
    const offset = h.requests.length;
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST unrelated answer" }));
    await direct(h, "TEST-history-unmapped", "Explain a triangle.", [
      { role: "user", text: "Find Jane Test." },
      { role: "assistant", text: `Unmapped prior secret: ${email}` },
    ]);
    assert.notEqual(h.commandState().threadId, prior.threadId);
    assert(!JSON.stringify(h.requests.slice(offset)).includes(email));
  } finally {
    await h.close();
  }
});

test("inherited expiry during an active public turn blocks finalization and all subsequent dispatch", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", { id: "TEST-history-active-source" });
    const prior = h.commandState();
    h.onDecision(newTopic);
    let afterModel = 0;
    h.onChat(() => {
      expire(h, prior.sources[0]!);
      afterModel = h.requests.length;
      return { content: "TEST unsafe completed answer" };
    });
    await assert.rejects(
      direct(h, "TEST-history-active-expiry", "Explain a triangle."),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "catalog_conflict",
    );
    assert.equal(
      h.requests.length,
      afterModel,
      "no checker/model dispatch follows expiry",
    );
    assert.equal(h.commandState().answer, undefined);
  } finally {
    await h.close();
  }
});

test("expiry while Jev answers cannot publish the previously valid context", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", { id: "TEST-history-checker-source" });
    const prior = h.commandState();
    let afterChecker = 0;
    h.onDecision((body) => {
      if (body.questions?.route.criteria.complete) {
        expire(h, prior.sources[0]!);
        afterChecker = h.requests.length;
        return "complete";
      }
      return newTopic(body);
    });
    h.onChat(() => ({ content: "TEST public answer" }));
    await assert.rejects(
      direct(h, "TEST-history-checker-expiry", "Explain a triangle."),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "catalog_conflict",
    );
    assert(afterChecker > 0, "exercise the actual checker response boundary");
    assert.equal(h.requests.length, afterChecker);
    assert.equal(h.commandState().answer, undefined);
  } finally {
    await h.close();
  }
});

test("committed reads survive lost source projections and remain pinned across later turns", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", { id: "TEST-history-lost-source" });
    const prior = h.commandState();
    const sourceId = prior.sources[0]!;
    assert(prior.operations.includes(sourceId));
    prior.sources = [];
    assert(prior.threadAuthority);
    prior.threadAuthority.sources = [];
    h.catalog.saveTurn(prior.runId, h.scope.workspaceId, h.scope.userId, prior);
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST public answer" }));
    await h.send("Explain a triangle.", {
      id: "TEST-history-lost-source-next",
    });
    const next = h.commandState();
    assert.equal(next.threadId, prior.threadId);
    assert.deepEqual(next.sources, []);
    assert.deepEqual(next.threadAuthority?.sources, [sourceId]);
    expire(h, sourceId);
    await h.send("Explain a square.", {
      id: "TEST-history-lost-source-expired",
    });
    assert.notEqual(h.commandState().threadId, next.threadId);
  } finally {
    await h.close();
  }
});

test("pending question preserves exact native thread and denies stale authority before attach", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) =>
      toolResults(body).some((r) => r.currentTurn === true && r.data?.contacts)
        ? h.call("ask_user", { question: "What time should I use?" })
        : h.lookupScript(body),
    );
    await direct(
      h,
      "TEST-history-pending",
      "Find Jane Test and ask me the meeting time.",
    );
    const prior = h.commandState();
    assert.equal(prior.pending?.kind, "question");
    const before = JSON.stringify(await h.nativeMessages(prior.threadId));
    expire(h, prior.sources[0]!);
    const offset = h.requests.length;
    await assert.rejects(
      direct(h, "TEST-history-pending-answer", "At noon."),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "catalog_conflict",
    );
    assert.equal(h.requests.length, offset);
    assert.equal(h.commandState().threadId, prior.threadId);
    assert.equal(h.commandState().runId, prior.runId);
    assert.equal(
      JSON.stringify(await h.nativeMessages(prior.threadId)),
      before,
    );
  } finally {
    await h.close();
  }
});

test("answered clarification survives restart and alias replay without restoring its native transcript input", async () => {
  const h = createTrustHarness();
  try {
    const goal =
      "Prepare a meeting with Jane Test; find her contact and ask which day.";
    const question = "Which day should the meeting be?";
    h.onChat((body) =>
      toolResults(body).some((result) => result.data?.contacts)
        ? h.call("ask_user", { question })
        : h.lookupScript(body),
    );
    await direct(h, "TEST-history-question-before-restart", goal);
    const prior = h.commandState();
    assert.equal(prior.pending?.question, question);
    const questionId = prior.pending!.toolCallId;
    await h.restart();
    let received: ModelRequest | undefined;
    h.onChat((body) => {
      received = body;
      return { content: "TEST Jane's meeting should be tomorrow." };
    });
    const resumed = await direct(h, "TEST-history-question-answer", "Tomorrow");
    assert.equal(resumed?.reply, "TEST Jane's meeting should be tomorrow.");
    assert(received);
    const wire = JSON.stringify(received.messages);
    assert(wire.includes(goal));
    assert(wire.includes(question));
    assert(wire.includes("Tomorrow"));
    assert(
      toolResults(received).some(
        (result) => result.data?.contacts?.[0]?.email === email,
      ),
    );
    const answered = h.commandState();
    assert.deepEqual(answered.answeredQuestion, {
      toolCallId: questionId,
      question,
    });
    assert.equal(answered.threadId, prior.threadId);
    assert.equal(answered.runId, prior.runId);
    assert.equal(
      h.network.length,
      1,
      "resuming a clarification does not repeat its read",
    );
    const nativeQuestion = (await h.nativeInvocations(prior.threadId)).find(
      (call) => call.toolCallId === questionId,
    );
    assert(nativeQuestion);
    assert.deepEqual(
      nativeQuestion.args,
      {},
      "business InputRequest metadata preserves transcript privacy",
    );
    const beforeReplay = h.requests.length;
    await h.restart();
    const retry = await direct(h, "TEST-history-question-answer", "Tomorrow");
    assert.deepEqual(retry, resumed);
    assert.deepEqual(
      h.commandState().answeredQuestion,
      answered.answeredQuestion,
    );
    assert.equal(h.requests.length, beforeReplay);
    h.onDecision(newTopic);
    h.onChat((body) => {
      assert(!JSON.stringify(body.messages).includes(question));
      return { content: "TEST new public topic" };
    });
    await direct(h, "TEST-history-question-unrelated", "Explain a triangle.");
    assert.equal(h.commandState().answeredQuestion, undefined);
    assert.equal(h.network.length, 1);
  } finally {
    await h.close();
  }
});

test("a full valid authority manifest rotates before another task instead of dropping dependencies", async () => {
  const h = createTrustHarness();
  try {
    lookup(h);
    await h.send("Find Jane Test.", { id: "TEST-history-bound" });
    const prior = h.commandState();
    const receipt = h.catalog.invocation(
      prior.sources[0]!,
      h.scope.workspaceId,
      h.scope.userId,
    )!;
    assert(prior.threadAuthority);
    prior.threadAuthority.sources = Array.from({ length: 225 }, (_, n) => {
      const id = `TEST-history-bound-source-${n}`;
      h.catalog.saveInvocation({ ...receipt, id });
      return id;
    });
    h.catalog.saveTurn(prior.runId, h.scope.workspaceId, h.scope.userId, prior);
    h.onDecision(newTopic);
    h.onChat(() => ({ content: "TEST public answer" }));
    await h.send("Explain a triangle.", { id: "TEST-history-bound-new" });
    assert.notEqual(h.commandState().threadId, prior.threadId);
    assert.deepEqual(h.commandState().threadAuthority?.sources, []);
    assert.equal(
      h.catalog.turn(prior.runId, h.scope.workspaceId, h.scope.userId) &&
        prior.threadAuthority.sources.length,
      225,
    );
  } finally {
    await h.close();
  }
});

for (const erasure of ["forget", "opt-out"] as const)
  test(`a memory-derived plain reply rotates after ${erasure} and never enters Jev history`, async () => {
    const h = createTrustHarness();
    try {
      const secret = "TEST private preference: quiet purple office";
      const item = await h.memoryStore.remember(h.memoryActor, {
        requestId: "TEST-history-memory-seed",
        content: secret,
        kind: "preference",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: h.memorySettings,
      });
      h.onChat((body) => {
        assert(JSON.stringify(body.messages).includes(secret));
        return { content: secret };
      });
      await h.send("What is my saved preference?", {
        id: "TEST-history-memory",
      });
      const prior = h.commandState();
      assert.equal(prior.operations.length, 0);
      assert.equal(
        prior.threadAuthority?.memoryVersion,
        h.memoryStore.version(h.memoryActor),
      );
      if (erasure === "forget")
        await h.memoryStore.forget(h.memoryActor, {
          requestId: "TEST-history-memory-forget",
          id: item.id,
          revision: item.revision,
        });
      else
        h.memoryStore.setOptOut(h.memoryActor, {
          requestId: "TEST-history-memory-optout",
          optOut: true,
        });
      const offset = h.requests.length;
      h.onDecision(newTopic);
      h.onChat(() => ({ content: "TEST fresh public answer" }));
      await h.send("Explain a triangle.", { id: "TEST-history-memory-new" });
      assert.notEqual(h.commandState().threadId, prior.threadId);
      assert(!JSON.stringify(h.requests.slice(offset)).includes(secret));
    } finally {
      await h.close();
    }
  });

test("own memory correction advances inherited thread authority atomically and safely continues", async () => {
  const h = createTrustHarness();
  try {
    const previous = "TEST old private preference";
    const corrected = "TEST corrected private preference";
    const item = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-history-revise-seed",
      content: previous,
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    h.onChat(() => ({ content: previous }));
    await h.send("What is my preference?", {
      id: "TEST-history-before-revise",
    });
    const prior = h.commandState();
    h.onChat((body) => {
      const results = toolResults(body);
      if (results.some((result) => result.replan === true))
        return { content: "TEST memory correction saved" };
      const items = results.flatMap((result) => result.items ?? []);
      if (!items.some((found) => found.id === item.id))
        return h.call("memory_search", { query: previous });
      return h.call("memory_revise", {
        id: item.id,
        revision: item.revision,
        content: corrected,
      });
    });
    const reply = await direct(
      h,
      "TEST-history-own-revise",
      `Revise memory: ${JSON.stringify(previous)} -> ${JSON.stringify(corrected)}`,
    );
    assert.equal(reply?.reply, "TEST memory correction saved");
    const revised = h.commandState();
    assert.equal(revised.threadId, prior.threadId);
    assert.equal(revised.memoryReceipts.length, 1);
    assert.equal(revised.memoryVersion, 2);
    assert.equal(revised.threadAuthority?.memoryVersion, 2);
    assert.equal(h.memoryStore.version(h.memoryActor), 2);
  } finally {
    await h.close();
  }
});

test("own committed memory correction clears answered question metadata before the next model step", async () => {
  const h = createTrustHarness();
  try {
    const previous = "TEST old private preference";
    const corrected = "TEST corrected private preference";
    const question =
      "TEST outdated question: should I continue with the old preference?";
    const item = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-history-question-revise-seed",
      content: previous,
      kind: "preference",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    h.onChat(() => h.call("ask_user", { question }));
    await direct(
      h,
      "TEST-history-question-revise-open",
      "Review my preference and ask how to continue.",
    );
    const prior = h.commandState();
    assert.equal(prior.pending?.question, question);
    await h.restart();
    let sawQuestion = false;
    let freshAfterCommit = false;
    h.onChat((body) => {
      const results = toolResults(body);
      const wire = JSON.stringify(body.messages);
      if (results.some((result) => result.replan === true)) {
        assert(
          !wire.includes(question),
          "the old question cannot survive its authorized generation change",
        );
        freshAfterCommit = true;
        return { content: "TEST corrected preference saved" };
      }
      sawQuestion ||= wire.includes(question);
      const items = results.flatMap((result) => result.items ?? []);
      if (!items.some((found) => found.id === item.id))
        return h.call("memory_search", { query: previous });
      return h.call("memory_revise", {
        id: item.id,
        revision: item.revision,
        content: corrected,
      });
    });
    const answer = await direct(
      h,
      "TEST-history-question-revise-answer",
      `Revise memory: ${JSON.stringify(previous)} -> ${JSON.stringify(corrected)}`,
    );
    assert.equal(answer?.reply, "TEST corrected preference saved");
    assert(
      sawQuestion,
      "the genuine continuation starts with the authorized question",
    );
    assert(freshAfterCommit);
    const state = h.commandState();
    assert.equal(state.runId, prior.runId);
    assert.equal(state.threadId, prior.threadId);
    assert.equal(state.answeredQuestion, undefined);
    assert.equal(state.memoryReceipts.length, 1);
    assert.equal(state.threadAuthority?.memoryVersion, 2);
    assert.equal(h.memoryStore.version(h.memoryActor), 2);
  } finally {
    await h.close();
  }
});
