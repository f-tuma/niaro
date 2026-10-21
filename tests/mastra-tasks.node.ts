import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CommandSchema,
  SnapshotSchema,
  type WorkItem,
} from "../packages/protocol";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

async function pending(h: TrustHarness, id = "TEST-native-task") {
  h.onChat((body) =>
    toolResults(body).some(
      (result) => result.currentTurn && result.data?.contacts,
    )
      ? h.call("ask_user", { question: "Which day?" })
      : h.lookupScript(body),
  );
  const response = await h.send(
    "Prepare a meeting with Jane Test and ask which day.",
    { id },
  );
  assert.equal(response.status, "accepted");
  const work = response.snapshot.workItems.find(
    (value) => value.native?.question,
  );
  assert(work?.native?.question);
  return work;
}
function answer(
  h: TrustHarness,
  work: WorkItem,
  id = "TEST-answer-task",
  extra: object = {},
) {
  const question = work.native!.question!;
  return h.execute(
    CommandSchema.parse({
      type: "message.send",
      commandId: id,
      idempotencyKey: id,
      conversationId: work.conversationId,
      text: "Tomorrow, please.",
      language: "en",
      context: {
        runtime: "mastra",
        workItemId: work.id,
        inputRequestId: question.id,
        expectedInputRevision: question.revision,
        ...extra,
      },
    }),
  );
}
const open = (
  h: TrustHarness,
  work: WorkItem,
  id = "TEST-open-task",
  revision = work.revision,
) =>
  h.execute(
    CommandSchema.parse({
      type: "task.open",
      commandId: id,
      idempotencyKey: id,
      conversationId: work.conversationId,
      workItemId: work.id,
      expectedWorkRevision: revision,
      language: "en",
    }),
  );

test("native Tasks preserve question identity after detour, empty chat and restart; selecting is passive and answering resumes the original run", async () => {
  const h = createTrustHarness();
  try {
    const work = await pending(h);
    const original = h.commandState();
    const initialSnapshot = h.workflow.snapshot(h.scope);
    const message = initialSnapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(message.workItemId, work.id);
    assert.equal(message.inputRequestId, work.native!.question!.id);
    const effects = h.network.length;
    h.onDecision((body) =>
      body.questions?.route.criteria.new_task ? "new_task" : undefined,
    );
    h.onChat(() => ({ content: "Prague." }));
    await h.send("What is the capital of Czechia?", {
      id: "TEST-side-task",
      session: "new",
    });
    assert.notEqual(h.commandState().runId, original.runId);
    await h.restart();
    const tasks = await h.runtime().tasks!();
    const saved = tasks.find((task) => task.id === work.id)!;
    assert.equal(saved.native?.question?.id, work.native!.question!.id);
    assert.equal(saved.native?.question?.revision, 1);
    h.workflow.syncNativeWork(h.scope, tasks);
    const requests = h.requests.length;
    const selected = await open(h, saved);
    assert.equal(selected.status, "accepted");
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, effects);
    h.onChat((body) => {
      assert(toolResults(body).some((result) => result.data?.contacts));
      return {
        content: "The original meeting request is now fully specified.",
      };
    });
    const completed = await answer(h, saved);
    assert.equal(completed.status, "accepted");
    assert.equal(h.commandState("TEST-answer-task").runId, original.runId);
    assert.equal(
      h.commandState("TEST-answer-task").threadId,
      original.threadId,
    );
    assert.equal(
      completed.snapshot.workItems.find((task) => task.id === work.id)?.status,
      "succeeded",
    );
    assert.equal(h.network.length, effects);
    const calls = h.requests.length;
    assert.equal((await answer(h, saved)).status, "accepted");
    assert.equal(h.requests.length, calls);
    assert.equal(
      (await answer(h, saved, "TEST-repeat-different")).status,
      "conflict",
    );
    assert.equal(h.requests.length, calls);
    SnapshotSchema.parse(completed.snapshot);
  } finally {
    await h.close();
  }
});

test("native question answers reject stale revision, wrong input and foreign task without model or service dispatch", async () => {
  const h = createTrustHarness();
  try {
    const work = await pending(h);
    const calls = h.requests.length,
      effects = h.network.length;
    for (const [id, extra] of [
      ["TEST-stale", { expectedInputRevision: 2 }],
      ["TEST-input-other", { inputRequestId: "TEST-other-input" }],
      ["TEST-task-other", { workItemId: "TEST-other-task" }],
    ] as const) {
      assert.equal((await answer(h, work, id, extra)).status, "conflict");
    }
    assert.equal(h.requests.length, calls);
    assert.equal(h.network.length, effects);
    assert.equal(
      (await open(h, work, "TEST-open-stale", work.revision + 1)).status,
      "conflict",
    );
  } finally {
    await h.close();
  }
});

test("permission and source expiry are rechecked before native task selection and explicit answer", async () => {
  for (const change of ["epoch", "expiry"] as const) {
    const h = createTrustHarness();
    try {
      const work = await pending(h),
        state = h.commandState();
      const calls = h.requests.length;
      if (change === "epoch") h.context.change(h.target.organizationId);
      else {
        const receipt = h.catalog.invocation(
          state.sources[0]!,
          h.scope.workspaceId,
          h.scope.userId,
        )!;
        receipt.completedAt = Date.now() - 31 * 60 * 1000;
        h.catalog.saveInvocation(receipt);
      }
      assert.notEqual((await open(h, work)).status, "accepted");
      assert.notEqual((await answer(h, work)).status, "accepted");
      assert.equal(h.requests.length, calls);
    } finally {
      await h.close();
    }
  }
});

test("native approval remains in Tasks after a new chat; opening never approves and stale approval cannot dispatch", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.writeScript);
    const response = await h.send("Create a meeting with Jane Test.", {
      id: "TEST-task-approval",
    });
    const work = response.snapshot.workItems.find(
      (value) => value.native?.action?.status === "awaiting_approval",
    )!;
    assert(work);
    const operationId = work.native!.action!.operationId;
    h.onChat(() => ({ content: "A new chat." }));
    await h.send("Start a new conversation.", {
      id: "TEST-chat-reset",
      session: "new",
    });
    await h.restart();
    const tasks = await h.runtime().tasks!();
    h.workflow.syncNativeWork(h.scope, tasks);
    const calls = h.requests.length,
      effects = h.network.length;
    assert.equal((await open(h, work)).status, "accepted");
    assert.equal(h.requests.length, calls);
    assert.equal(h.network.length, effects);
    const decision = (id: string, revision: number) =>
      h.execute(
        CommandSchema.parse({
          type: "service.resolve",
          commandId: id,
          idempotencyKey: id,
          conversationId: work.conversationId,
          workItemId: work.id,
          expectedWorkRevision: revision,
          operationId,
          approved: true,
          language: "en",
        }),
      );
    assert.equal(
      (await decision("TEST-stale-approval", work.revision + 1)).status,
      "conflict",
    );
    assert.equal(h.network.length, effects);
    h.onChat(() => ({ content: "The meeting was created." }));
    const completed = await decision("TEST-task-approve", work.revision);
    assert.equal(completed.status, "accepted");
    assert.equal(h.network.length, effects + 1);
    assert.equal(
      completed.snapshot.workItems.find((value) => value.id === work.id)
        ?.status,
      "succeeded",
    );
    const requestCount = h.requests.length;
    assert.equal(
      (await decision("TEST-task-approve", work.revision)).status,
      "accepted",
    );
    assert.equal(h.requests.length, requestCount);
    assert.equal(h.network.length, effects + 1);
  } finally {
    await h.close();
  }
});

test("two suspended native goals in the same session require selection; a selected goal survives restart and resumes without authorizing a write", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => h.call("ask_user", { question: "Which day?" }));
    const first = await h.send("Prepare the first meeting.", {
      id: "TEST-first-goal",
      session: "new",
    });
    const task = first.snapshot.workItems[0]!;
    const session = h.commandState("TEST-first-goal").conversationSession;
    assert(session);
    h.onDecision((body) =>
      body.questions?.route.criteria.new_task ? "new_task" : undefined,
    );
    await h.send("Prepare the second meeting.", {
      id: "TEST-second-goal",
    });
    assert.equal(
      h.commandState("TEST-second-goal").conversationSession,
      session,
    );
    assert.notEqual(h.commandState("TEST-second-goal").runId, task.id);
    h.onDecision((body) =>
      body.questions?.route.criteria.continue_work
        ? "continue_work"
        : undefined,
    );
    h.onChat(() => h.call("ask_user", { question: "Which task do you mean?" }));
    await h.send("Tomorrow.", { id: "TEST-ambiguous-answer" });
    assert(h.commandState("TEST-first-goal").pending);
    assert(h.commandState("TEST-second-goal").pending);
    assert.notEqual(h.commandState().runId, task.id);
    assert.notEqual(
      h.commandState("TEST-ambiguous-answer").runId,
      h.commandState("TEST-second-goal").runId,
    );
    const current = h.workflow
      .snapshot(h.scope)
      .workItems.find((work) => work.id === task.id)!;
    assert.equal((await open(h, current)).status, "accepted");
    await h.restart();
    h.onChat(() => ({ content: "The first meeting day has been specified." }));
    await h.send("Tomorrow.", { id: "TEST-selected-unbound-answer" });
    assert.equal(h.commandState("TEST-selected-unbound-answer").runId, task.id);
    assert(h.commandState("TEST-second-goal").pending);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("concurrent exact native answers attach at most once to the original question", async () => {
  const h = createTrustHarness();
  try {
    const task = await pending(h),
      question = task.native!.question!;
    h.onChat(() => ({ content: "The meeting day is now specified." }));
    const before = h.requests.filter((body) => body.messages).length;
    const runtime = h.runtime();
    const resume = (id: string) =>
      runtime.message(
        id,
        "Tomorrow.",
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        {
          conversationId: task.conversationId,
          task: {
            workItemId: task.id,
            inputRequestId: question.id,
            expectedInputRevision: 1,
          },
        },
      );
    const outcomes = await Promise.allSettled([
      resume("TEST-concurrent-a"),
      resume("TEST-concurrent-b"),
    ]);
    assert.equal(
      outcomes.filter((value) => value.status === "fulfilled").length,
      1,
    );
    assert.equal(
      outcomes.filter((value) => value.status === "rejected").length,
      1,
    );
    assert.equal(h.requests.filter((body) => body.messages).length, before + 1);
    assert.equal(h.network.length, 1); // The original contact lookup; no write.
    const tasks = await runtime.tasks!();
    h.workflow.syncNativeWork(h.scope, tasks);
    const cursor = h.workflow.snapshot(h.scope).cursor;
    h.workflow.syncNativeWork(h.scope, await runtime.tasks!());
    assert.equal(
      h.workflow.snapshot(h.scope).cursor,
      cursor,
      "passive refresh must not churn task events",
    );
  } finally {
    await h.close();
  }
});

test("an unknown native write stays unconfirmed in Tasks and never dispatches again after restart", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.writeScript);
    const response = await h.send("Create a meeting with Jane Test.", {
      id: "TEST-unknown-task",
    });
    const task = response.snapshot.workItems.find(
      (work) => work.native?.action?.status === "awaiting_approval",
    )!;
    const operationId = task.native!.action!.operationId;
    h.writeResponse = "lost";
    const command = CommandSchema.parse({
      type: "service.resolve",
      commandId: "TEST-unknown-approval",
      idempotencyKey: "TEST-unknown-approval",
      conversationId: task.conversationId,
      workItemId: task.id,
      expectedWorkRevision: task.revision,
      operationId,
      approved: true,
      language: "en",
    });
    const result = await h.execute(command);
    assert.equal(result.status, "accepted");
    const projected = result.snapshot.workItems.find(
      (work) => work.id === task.id,
    )!;
    assert.equal(projected.native?.action?.status, "unknown");
    assert.notEqual(projected.status, "succeeded");
    const effects = h.network.length,
      calls = h.requests.length;
    await h.restart();
    h.workflow.syncNativeWork(h.scope, await h.runtime().tasks!());
    assert.equal((await h.execute(command)).status, "accepted");
    assert.equal(h.network.length, effects);
    assert.equal(h.requests.length, calls);
    assert.notEqual(
      h.workflow.snapshot(h.scope).workItems.find((work) => work.id === task.id)
        ?.status,
      "succeeded",
    );
  } finally {
    await h.close();
  }
});

test("a native question projects its offered answers and an offered answer resumes the run", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) =>
      toolResults(body).some(
        (result) => result.currentTurn && result.data?.contacts,
      )
        ? h.call("ask_user", {
            question: "Which days suit you?",
            options: ["Monday", "Tuesday", "Wednesday"],
            multiple: true,
          })
        : h.lookupScript(body),
    );
    const response = await h.send(
      "Prepare a meeting with Jane Test and ask which days.",
      { id: "TEST-options-task" },
    );
    const work = response.snapshot.workItems.find(
      (value) => value.native?.question,
    );
    assert.deepEqual(work?.native?.question?.options, [
      "Monday",
      "Tuesday",
      "Wednesday",
    ]);
    assert.equal(work?.native?.question?.multiple, true);
    SnapshotSchema.parse(response.snapshot);
    const original = h.commandState();
    h.onChat(() => ({ content: "Monday and Wednesday work." }));
    const question = work!.native!.question!;
    const answered = await h.execute(
      CommandSchema.parse({
        type: "message.send",
        commandId: "TEST-options-answer",
        idempotencyKey: "TEST-options-answer",
        conversationId: work!.conversationId,
        text: "Monday, Wednesday",
        language: "en",
        context: {
          runtime: "mastra",
          workItemId: work!.id,
          inputRequestId: question.id,
          expectedInputRevision: question.revision,
        },
      }),
    );
    assert.equal(answered.status, "accepted");
    assert.equal(h.commandState("TEST-options-answer").runId, original.runId);
    assert.equal(
      answered.snapshot.workItems.find((task) => task.id === work!.id)?.native
        ?.question,
      undefined,
    );
  } finally {
    await h.close();
  }
});
