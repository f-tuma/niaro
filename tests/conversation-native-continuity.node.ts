import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createTrustHarness, toolResults } from "./agent-trust/harness";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import { CommandSchema } from "../packages/protocol";
import { ClientSession, commandTarget } from "../packages/client-core/session";
import { processStartCommand } from "../packages/client-core/process-commands";
import {
  captureProcessAnswerTarget,
  processAnswerCommand,
} from "../packages/client-core/process-answers";
import { PROCESS_EXECUTION_PROFILE } from "../packages/protocol/process-execution";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { mobileHttpChildFixture } from "./helpers/process-mobile-http-child";

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

for (const kind of ["agent-1", "progressive-1"] as const) {
  for (const boundary of ["creation", "session"] as const) {
    test(`${boundary} boundary excludes unrelated unproved ${kind} history without losing native questions or A/B/A recall`, async () => {
      const h = createTrustHarness();
      const hash = (value: unknown) =>
        createHash("sha256").update(JSON.stringify(value)).digest("hex");
      const oldCommand = "TEST-old-unproved-command";
      const oldId = hash([
        h.scope.serverId,
        h.scope.workspaceId,
        h.scope.userId,
        oldCommand,
      ]);
      const oldGoal = "TEST PRIVATE UNRELATED LEGACY GOAL";
      const oldQuestion = "TEST PRIVATE UNRELATED LEGACY QUESTION";
      const now = new Date().toISOString();
      const old = {
        kind,
        commandId: oldCommand,
        text: oldGoal,
        language: "en",
        hash: hash([oldGoal, "en"]),
        epoch: h.context.epoch(h.target.organizationId),
        clock: { referenceNow: now },
        paused: true,
        answer: { reply: oldQuestion },
        ...(kind === "agent-1"
          ? {
              pendingCalls: [],
              operations: [],
              working: {
                conversationId: "conversation-1",
                goal: oldGoal,
                question: oldQuestion,
                sources: [],
                openedAt: now,
              },
            }
          : { pendingInput: true, carriedSteps: 0, steps: [] }),
      };
      const native = (commandId: string) => {
        const value = h.catalog
          .nativeTurns(h.scope.workspaceId, h.scope.userId)
          .map((raw) => DomainCommandSchema.parse(raw))
          .find((state) =>
            state.aliases.some((a) => a.commandId === commandId),
          );
        assert(value, "TEST original native command must be persisted");
        return value;
      };
      try {
        h.catalog.saveTurn(oldId, h.scope.workspaceId, h.scope.userId, old);
        assert.equal(
          h.workflow.legacyQuestionProof(h.scope, oldCommand),
          undefined,
        );
        const aId = boundary === "session" ? "conversation-1" : "TEST-chat-A";
        if (boundary === "creation")
          assert.equal((await h.execute(create(aId))).status, "accepted");
        else {
          const rejected = await h.execute(
            message("TEST-before-reset", aId, "TEST old answer"),
          );
          assert.equal(rejected.status, "conflict");
          assert.equal(h.requests.length, 0);
        }
        h.onChat(h.lookupScript);
        const result = await h.execute(
          CommandSchema.parse({
            ...message("TEST-A-first", aId, "TEST look up Jane Test"),
            ...(boundary === "session" ? { session: "new" } : {}),
          }),
        );
        assert.equal(result.status, "accepted", JSON.stringify(result));
        const first = native("TEST-A-first");
        assert.equal(first.legacyQuestion, undefined);
        if (boundary === "session") {
          assert.equal(
            first.conversationSession,
            h.workflow.conversationSession(h.scope, aId),
          );
          assert(first.conversationSession);
          await h.restart();
        }
        assert.equal(
          h.network.filter((r) => r.path.endsWith("/contacts")).length,
          1,
        );
        assert.equal(first.answer?.reply, "Contact found.");

        h.onChat(() =>
          h.call("ask_user", { question: "TEST native question A" }),
        );
        assert.equal(
          (
            await h.execute(
              message("TEST-A-question", aId, "TEST ask me a question"),
            )
          ).status,
          "accepted",
        );
        const question = native("TEST-A-question");
        assert.equal(question.pending?.kind, "question");
        assert.equal(question.threadId, first.threadId);

        assert.equal(
          (await h.execute(create("TEST-chat-B"))).status,
          "accepted",
        );
        h.onChat(() => ({ content: "TEST independent answer B" }));
        await h.execute(
          message("TEST-B-first", "TEST-chat-B", "TEST question B"),
        );
        const b = native("TEST-B-first");
        assert.notEqual(b.threadId, first.threadId);
        await h.restart();
        h.onChat((body) => {
          assert(
            !JSON.stringify(body.messages).includes(
              "TEST independent answer B",
            ),
          );
          return toolResults(body).some((r) => r.answered === true)
            ? { content: "TEST answered native question A" }
            : h.call("ask_user", { question: "TEST native question A" });
        });
        assert.equal(
          (await h.execute(message("TEST-A-answer", aId, "TEST answer A")))
            .status,
          "accepted",
        );
        const answered = native("TEST-A-answer");
        assert.equal(answered.runId, question.runId);
        assert.equal(answered.threadId, question.threadId);
        assert.equal(answered.answer?.reply, "TEST answered native question A");

        if (boundary === "creation") {
          const models = h.requests.length;
          const rejected = await h.execute(
            message(
              "TEST-old-chat-answer",
              "conversation-1",
              "TEST old answer",
            ),
          );
          assert.equal(rejected.status, "conflict");
          assert.equal(
            h.requests.length,
            models,
            "TEST missing proof still fails closed in unreset old chat",
          );
        }
        assert.deepEqual(
          h.catalog.turn(oldId, h.scope.workspaceId, h.scope.userId),
          old,
        );
        assert(!JSON.stringify(h.requests).includes(oldGoal));
        assert(!JSON.stringify(h.requests).includes(oldQuestion));
        assert.equal(
          h.network.length,
          1,
          "TEST only one explicit current read, no old replay or writes",
        );
      } finally {
        await h.close();
      }
    });
  }
}

test("failed first request after committed reset cannot resume a prior native question; old task cursor cannot replace current-session recall", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() =>
      h.call("ask_user", { question: "TEST OLD QUESTION CANARY" }),
    );
    assert.equal(
      (await h.send("TEST old request", { id: "TEST-old-native" })).status,
      "accepted",
    );
    const old = h.commandState("TEST-old-native");
    assert.equal(old.pending?.kind, "question");
    const reset = CommandSchema.parse({
      ...message("TEST-failed-reset", "conversation-1", "TEST new session"),
      session: "new",
    });
    h.workflow.startSession(h.scope, "conversation-1", reset);
    assert.equal(h.workflow.replay(h.scope, reset), undefined);
    const token = h.workflow.conversationSession(h.scope, "conversation-1");
    assert(token);
    await h.restart();
    const before = h.requests.length;
    h.onChat((body) => {
      assert(
        !JSON.stringify(body.messages).includes("TEST OLD QUESTION CANARY"),
      );
      return { content: "TEST new-session answer" };
    });
    assert.equal(
      (await h.send("TEST independent request", { id: "TEST-new-native" }))
        .status,
      "accepted",
    );
    const current = h.commandState("TEST-new-native");
    assert.notEqual(current.runId, old.runId);
    assert.notEqual(current.threadId, old.threadId);
    assert.equal(current.conversationSession, token);
    assert(h.requests.length > before);
    // Explicit older task selection is legal, but ordinary chat recall stays in its generation.
    h.catalog.selectTurn(
      old.runId,
      h.scope.workspaceId,
      h.scope.userId,
      h.scope.serverId,
    );
    await h.restart();
    h.onChat((body) => {
      assert(
        !JSON.stringify(body.messages).includes("TEST OLD QUESTION CANARY"),
      );
      assert(JSON.stringify(body.messages).includes("TEST new-session answer"));
      return { content: "TEST current-session follow-up" };
    });
    assert.equal(
      (await h.send("TEST follow up", { id: "TEST-follow-native" })).status,
      "accepted",
    );
    const follow = h.commandState("TEST-follow-native");
    assert.equal(follow.threadId, current.threadId);
    assert.equal(follow.conversationSession, token);
    assert.deepEqual(
      h.catalog.turn(old.runId, h.scope.workspaceId, h.scope.userId),
      old,
    );
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("delayed exact reset retry retains its own generation without displacing a newer session's recall", async () => {
  const h = createTrustHarness();
  try {
    const a = CommandSchema.parse({
      ...message("TEST-delayed-A", "conversation-1", "TEST delayed A"),
      session: "new",
    });
    h.workflow.startSession(h.scope, "conversation-1", a);
    const tokenA = h.workflow.conversationSession(h.scope, "conversation-1", a);
    assert(tokenA);
    h.onChat(() => ({ content: "TEST B ANSWER CANARY" }));
    assert.equal(
      (await h.send("TEST current B", { id: "TEST-current-B", session: "new" }))
        .status,
      "accepted",
    );
    const b = h.commandState("TEST-current-B");
    assert.notEqual(b.conversationSession, tokenA);
    const tokenB = h.workflow.conversationSession(h.scope, "conversation-1");
    await h.restart();
    h.onChat(() => ({ content: "TEST delayed A answer" }));
    assert.equal((await h.execute(a)).status, "accepted");
    const delayed = h.commandState("TEST-delayed-A");
    assert.equal(delayed.conversationSession, tokenA);
    assert.notEqual(delayed.threadId, b.threadId);
    assert.equal(
      h.workflow.conversationSession(h.scope, "conversation-1"),
      tokenB,
    );
    await h.restart();
    h.onChat((body) => {
      assert(JSON.stringify(body.messages).includes("TEST B ANSWER CANARY"));
      return { content: "TEST continued current B" };
    });
    assert.equal(
      (await h.send("TEST continue B", { id: "TEST-B-follow" })).status,
      "accepted",
    );
    assert.equal(h.commandState("TEST-B-follow").threadId, b.threadId);
    assert.equal(h.commandState("TEST-B-follow").conversationSession, tokenB);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("real native A/B/A execution keeps the authorized public chat's own thread and passive history never executes", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST public answer A" }));
    await h.execute(create("TEST-chat-A"));
    await h.execute(
      message("TEST-A-first", "TEST-chat-A", "TEST first question A"),
    );
    const a = h.commandState("TEST-A-first");
    h.onChat(() => ({ content: "TEST public answer B" }));
    await h.execute(create("TEST-chat-B"));
    await h.execute(
      message("TEST-B-first", "TEST-chat-B", "TEST first question B"),
    );
    const b = h.commandState("TEST-B-first");
    assert.notEqual(a.threadId, b.threadId);
    const requests = h.requests.length,
      network = h.network.length;
    const cursor = h.catalog.latestTurn(
      h.scope.workspaceId,
      h.scope.userId,
    )?.id;
    const list = h.workflow.conversations(h.scope);
    const history = h.workflow.conversationMessages(h.scope, "TEST-chat-A");
    assert(list.conversations.some((c) => c.id === "TEST-chat-A"));
    assert(history?.messages.some((m) => m.text === "TEST public answer A"));
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, network);
    assert.equal(
      h.catalog.latestTurn(h.scope.workspaceId, h.scope.userId)?.id,
      cursor,
    );
    let retainedA = false;
    h.onChat((body) => {
      const text = JSON.stringify(body.messages);
      retainedA = text.includes("TEST public answer A");
      assert(!text.includes("TEST public answer B"));
      return { content: "TEST A resumed answer" };
    });
    await h.execute(
      message("TEST-A-next", "TEST-chat-A", "TEST followup question A"),
    );
    assert.equal(h.commandState("TEST-A-next").threadId, a.threadId);
    assert(retainedA);
    const before = h.requests.length;
    await h.execute(create("TEST-chat-A"));
    assert.equal(
      h.requests.length,
      before,
      "new-chat replay must not invoke a model",
    );
    assert.equal(
      h.workflow.conversationMessages(h.scope, "TEST-chat-B")?.conversation
        .messageCount,
      2,
    );
    const invalid = await h.execute(
      message(
        "TEST-unknown-chat-command",
        "TEST-uncreated-chat",
        "TEST must not invoke model",
      ),
    );
    assert.equal(invalid.status, "rejected");
    assert.equal(
      h.requests.length,
      before,
      "uncreated public chat never invokes model or native continuation",
    );
  } finally {
    await h.close();
  }
});

test("real HTTP process admission hydrates an older authorized chat and rejects a read-only archive origin", async () => {
  const fixture = await mobileHttpChildFixture();
  let session: ClientSession | undefined;
  try {
    const setup = await fixture.configure({ questions: 1, writes: 0 });
    const values = new Map<string, string>();
    session = new ClientSession(
      setup.endpoint,
      {
        getItem: async (key) => values.get(key) ?? null,
        setItem: async (key, value) => {
          values.set(key, value);
        },
      },
      setup.credential,
      fetch,
      undefined,
      undefined,
      false,
      { processQuestions: true, processApprovals: true },
    );
    await session.start(false);
    for (let n = 0; n < 75; n++) {
      const command = create(`TEST-process-history-${n}`);
      await session.send(command);
      assert.equal(
        session.getSnapshot().commandStates[commandTarget(command)],
        "accepted",
      );
    }
    const old = "TEST-process-history-0";
    assert(
      !session.getSnapshot().store!.conversations[old],
      "older chat must actually be outside live projection",
    );
    const before = await fixture.inspect();
    const history = await session.readConversation(old);
    assert(!history.conversation.readOnly);
    session.selectConversation(old);
    await session.refresh();
    assert(session.getSnapshot().store!.conversations[old]);
    const inventory = await session.loadProcessInventory();
    const entry = inventory.processes.find(
      (p) => p.processId === setup.artifact.processId,
    );
    assert(entry?.availability === "ready");
    const prepare = async (conversationId: string, requestId: string) =>
      session!.prepareProcessInput(
        {
          processId: entry.processId,
          version: entry.version,
          artifactDigest: entry.artifactDigest,
          language: "en",
          origin: { type: "command", conversationId, requestId },
        },
        entry,
      );
    const target = await prepare(old, "TEST-old-process-origin");
    assert.equal(
      (await fixture.inspect()).modelCalls,
      before.modelCalls,
      "history/selection/form prepare are passive",
    );
    const start = processStartCommand(target, {
      commandId: "TEST-old-process-start",
      idempotencyKey: "TEST-old-process-start",
      language: "en",
      input: { name: "TEST old chat origin" },
    });
    await session.send(start, false, target);
    await session.refresh();
    assert.equal(
      session.getSnapshot().commandStates[commandTarget(start)],
      "accepted",
      JSON.stringify({
        error: session.getSnapshot().error,
        state: session.getSnapshot().commandStates,
      }),
    );
    assert(
      Object.values(session.getSnapshot().store!.workItems).some(
        (w) =>
          w.conversationId === old &&
          w.native?.process?.provenance.processId === setup.artifact.processId,
      ),
    );
    const work = Object.values(session.getSnapshot().store!.workItems).find(
      (w) => w.conversationId === old && w.native?.process?.question,
    );
    assert(work, "process must project its scripted real native question");
    const answerTarget = captureProcessAnswerTarget(
      session.getSnapshot().store!,
      work.id,
      old,
    );
    await session.send(
      processAnswerCommand(session.getSnapshot().store!, answerTarget, {
        commandId: "TEST-archive-source",
        idempotencyKey: "TEST-archive-source",
        language: "en",
        answer: "TEST create public archive source",
      }),
    );
    await session.refresh();
    assert(
      (await session.readConversation(old)).messages.some(
        (m) => m.text === "TEST create public archive source",
      ),
    );
    await session.send(
      CommandSchema.parse({
        ...message("TEST-archive-reset", old, "TEST new live public session"),
        session: "new",
      }),
    );
    let cursor: string | null = null,
      archive: string | undefined;
    do {
      const page = await session.readConversations(cursor);
      archive ??= page.conversations.find((c) => c.readOnly)?.id;
      cursor = page.nextAfter;
    } while (cursor && !archive);
    assert(archive, "production session:new must publish a read-only archive");
    const rejectedTarget = await prepare(
      archive,
      "TEST-archive-process-origin",
    );
    const rejected = processStartCommand(rejectedTarget, {
      commandId: "TEST-archive-process-start",
      idempotencyKey: "TEST-archive-process-start",
      language: "en",
      input: { name: "TEST forbidden archive origin" },
    });
    const modelBefore = (await fixture.inspect()).modelCalls;
    const response = await fetch(
      `${setup.endpoint}/processes/commands?profile=${encodeURIComponent(PROCESS_EXECUTION_PROFILE)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${setup.credential.accessToken}`,
        },
        body: JSON.stringify(rejected),
      },
    );
    assert.equal(response.status, 422);
    const denied = ProcessRuntimeResponseSchema.parse(
      await response.json(),
    ).admission;
    assert.equal(denied.status, "rejected");
    assert(
      denied.status === "rejected" &&
        denied.reason === "process_origin_changed",
    );
    assert.equal(
      (await fixture.inspect()).modelCalls,
      modelBefore,
      "read-only archive cannot launch privileged work",
    );
  } finally {
    session?.stop();
    await fixture.close();
  }
});
