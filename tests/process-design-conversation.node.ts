import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { emptyDesignBrief } from "../packages/protocol/process-design";
import { IdentityError } from "../apps/server-identity/error";
import { ProcessDesignConversation } from "../apps/server-identity/process-design-conversation";
import {
  designConversationFixture,
  conversationSignal as signal,
} from "./helpers/process-design-conversation";

type Fixture = ReturnType<typeof designConversationFixture>;
const target = {
  organizationId: "TEST-design-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const brief = (purpose = "TEST lookup one configured record") => ({
  ...emptyDesignBrief(),
  purpose,
});
const count = (h: Fixture, table: string) =>
  Number(h.db.prepare("SELECT COUNT(*) AS count FROM " + table).get()!.count);
const adapter = (
  h: Fixture,
  options: Partial<
    ConstructorParameters<typeof ProcessDesignConversation>[5]
  > = {},
) =>
  new ProcessDesignConversation(
    h.db,
    h.store,
    h.registry,
    h.controller,
    h.plugins,
    { serverId: h.scope.serverId, ...options },
  );
const start = (h: Fixture) =>
  h.store.start(h.actor, {
    ...target,
    requestId: "TEST-start-design",
    serviceId: h.serviceId,
  }).sessionId;
const input = (
  h: Fixture,
  sessionId: string,
  requestId: string,
  text: string,
) => ({
  ...target,
  sessionId,
  requestId,
  revision: h.store.get(h.actor, sessionId).revision,
  modelId: h.modelId,
  text,
  language: "en" as const,
});
const read = (sessionId: string, requestId: string) => ({
  ...target,
  sessionId,
  requestId,
});
const isolated = async (run: (h: Fixture) => Promise<void>) => {
  const h = designConversationFixture();
  try {
    await run(h);
  } finally {
    await h.close();
  }
};
const nativeCounts = (h: Fixture) => {
  const db = new DatabaseSync(fileURLToPath(h.catalog.nativeStorageUrl));
  try {
    return db
      .prepare(
        "SELECT COUNT(*) AS count,COUNT(DISTINCT thread_id) AS threads FROM mastra_messages",
      )
      .get()!;
  } finally {
    db.close();
  }
};

test("native designer rejects a staged reply when the proposal changes before publication", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const owner = await h.nativeOwner();
    const prove = owner.proveRetired;
    let changed = false;
    owner.proveRetired = async (binding) => {
      if (!changed) {
        changed = true;
        h.store.update(h.actor, {
          ...target,
          sessionId,
          requestId: "TEST-human-concurrent-edit",
          revision: 1,
          brief: brief("TEST revised human purpose"),
          candidate: null,
        });
      }
      return prove(binding);
    };
    const command = input(
      h,
      sessionId,
      "TEST-stale-publish",
      "TEST original request",
    );
    await assert.rejects(
      conversation.message(h.context, command, signal()),
      /process_design_review_changed/,
    );
    const result = await conversation.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "process_design_review_changed");
    assert.equal(result.reply, null);
    assert.equal(result.userText, "TEST original request");
    assert.equal(h.modelCount(), 1);
    assert.equal(
      h.store.get(h.actor, sessionId).brief.purpose,
      "TEST revised human purpose",
    );
  });
});

test("native designer passive promotion preserves history and reports a changed proposal", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const command = input(
      h,
      sessionId,
      "TEST-stale-restart",
      "TEST retained user message",
    );
    const completed = await conversation.message(h.context, command, signal());
    assert.equal(completed.status, "completed");
    assert.equal(completed.requestRevision, command.revision);
    // Simulate loss of domain publication after actual native retirement, while
    // retaining its exact staged reply/digest and the real native retirement proof.
    h.db
      .prepare(
        "UPDATE agent_process_design_turn SET data=json_set(data,'$.status','running','$.reply',NULL) WHERE command_key=?",
      )
      .run(completed.turnId);
    h.store.update(h.actor, {
      ...target,
      sessionId,
      requestId: "TEST-human-after-crash",
      revision: 1,
      brief: brief("TEST updated after retirement"),
      candidate: null,
    });
    await h.reopen();
    const reopened = adapter(h);
    const result = await reopened.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(result.status, "failed");
    assert.equal(result.failure, "process_design_review_changed");
    assert.equal(result.reply, null);
    assert.equal(result.userText, "TEST retained user message");
    assert.equal(h.modelCount(), 1);
    assert.deepEqual(
      await reopened.message(h.context, command, signal()),
      result,
    );
  });
});

test("native designer preserves submitted and assistant Markdown whitespace and binds exact replay", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const text = "\n    TEST indented request\n";
    const reply = "\n    TEST indented assistant Markdown\n";
    h.onModel(() => ({ content: reply }));
    const command = input(h, sessionId, "TEST-whitespace", text);
    const result = await conversation.message(h.context, command, signal());
    assert.equal(result.status, "completed");
    assert.equal(result.userText, text);
    assert.equal(result.reply, reply);
    assert.deepEqual(
      await conversation.message(h.context, command, signal()),
      result,
    );
    await assert.rejects(
      conversation.message(
        h.context,
        { ...command, text: text.trim() },
        signal(),
      ),
      /process_design_command_conflict/,
    );
    assert.equal(h.modelCount(), 1);
  });
});

test("native designer abort preserves submitted text and exposes interruption without another dispatch", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const abort = new AbortController();
    h.onModelResponse(() => abort.abort());
    const command = input(
      h,
      sessionId,
      "TEST-abort",
      "TEST retained interrupted request",
    );
    const result = await conversation.message(h.context, command, abort.signal);
    assert.equal(result.status, "interrupted");
    assert.equal(result.failure, "process_design_interrupted");
    assert.equal(result.reply, null);
    assert.equal(result.userText, command.text);
    assert.deepEqual(
      await conversation.message(h.context, command, signal()),
      result,
    );
    assert.equal(h.modelCount(), 1);
    const root = h.db.prepare("SELECT id FROM agent_inference_run").get()!;
    assert.equal(
      h.catalog.inferenceBudget.summary(String(root.id)).unknownCalls,
      0,
    );
  });
});

test("native designer authorizes before tail proof and keeps new work busy until retirement is proved", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const owner = await h.nativeOwner();
    const prove = owner.proveRetired;
    let probes = 0;
    owner.proveRetired = async () => {
      probes++;
      return false;
    };
    const command = input(
      h,
      sessionId,
      "TEST-unproved",
      "TEST no premature publication",
    );
    const interrupted = await conversation.message(
      h.context,
      command,
      signal(),
    );
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.failure, "process_design_native_unsettled");
    assert.equal(interrupted.reply, null);
    assert.equal(interrupted.nativeSettled, false);
    const before = probes;
    h.switchActor();
    await assert.rejects(
      conversation.message(
        h.context,
        { ...command, requestId: "TEST-foreign-tail" },
        signal(),
      ),
      /process_design_not_found/,
    );
    assert.equal(probes, before);
    h.switchActor(h.actor.userId);
    await assert.rejects(
      conversation.message(
        h.context,
        { ...command, requestId: "TEST-tail-busy" },
        signal(),
      ),
      /process_design_busy/,
    );
    assert.deepEqual(
      await conversation.get(h.context, {
        ...target,
        sessionId,
        requestId: command.requestId,
      }),
      interrupted,
    );
    assert.equal(h.modelCount(), 1);
    owner.proveRetired = prove;
    const settled = await conversation.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(settled.status, "interrupted");
    assert.equal(settled.nativeSettled, true);
    const next = await conversation.message(
      h.context,
      { ...command, requestId: "TEST-after-proof" },
      signal(),
    );
    assert.equal(next.status, "completed");
    assert.equal(h.modelCount(), 2);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS n FROM agent_inference_run").get()!.n,
      1,
    );
  });
});

test("native designer blocks a new request after restart until interrupted native work is proved retired", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const original = adapter(h);
    const command = input(
      h,
      sessionId,
      "TEST-restart-unsettled",
      "TEST recover native work after restart",
    );
    const completed = await original.message(h.context, command, signal());
    assert.equal(completed.status, "completed");

    // Model a process crash after its durable reservation by restoring the row
    // to running before reopening. The new store marks it interrupted.
    h.db
      .prepare(
        "UPDATE agent_process_design_turn SET data=json_set(data,'$.status','running','$.reply',NULL,'$.candidateReply',NULL,'$.nativeStarted',json('true'),'$.nativeSettled',json('false')) WHERE command_key=?",
      )
      .run(completed.turnId);
    await h.reopen();
    const reopened = adapter(h);
    const owner = await h.nativeOwner();
    const prove = owner.proveRetired;
    owner.proveRetired = async () => false;

    await assert.rejects(
      reopened.message(
        h.context,
        { ...command, requestId: "TEST-after-restart-before-proof" },
        signal(),
      ),
      /process_design_busy/,
    );
    assert.equal(h.modelCount(), 1);

    const interrupted = await reopened.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.nativeSettled, false);

    owner.proveRetired = prove;
    const settled = await reopened.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(settled.status, "interrupted");
    assert.equal(settled.nativeSettled, true);

    const next = await reopened.message(
      h.context,
      { ...command, requestId: "TEST-after-restart-proof" },
      signal(),
    );
    assert.equal(next.status, "completed");
    assert.equal(h.modelCount(), 2);
  });
});

test("native designer clears a same-process reservation when pre-execution cancellation is passively settled", async () => {
  await isolated(async (h) => {
    const sessionId = start(h);
    const conversation = adapter(h);
    const owner = await h.nativeOwner();
    const prove = owner.proveRetired;
    owner.proveRetired = async () => false;
    const abort = new AbortController();
    const serial = h.context.serial;
    let serialCalls = 0;
    h.context.serial = <T>(run: () => T | Promise<T>) =>
      serial(async () => {
        if (++serialCalls === 2) abort.abort();
        return run();
      });

    const command = input(
      h,
      sessionId,
      "TEST-pre-execution-cancel",
      "TEST do not start native execution",
    );
    const interrupted = await conversation.message(
      h.context,
      command,
      abort.signal,
    );
    assert.equal(interrupted.status, "interrupted");
    assert.equal(interrupted.nativeSettled, false);
    h.context.serial = serial;

    const settled = await conversation.get(h.context, {
      ...target,
      sessionId,
      requestId: command.requestId,
    });
    assert.equal(settled.status, "interrupted");
    assert.equal(settled.nativeSettled, true);
    owner.proveRetired = prove;

    const next = await conversation.message(
      h.context,
      { ...command, requestId: "TEST-after-pre-execution-cancel" },
      signal(),
    );
    assert.equal(next.status, "completed");
    assert.equal(h.modelCount(), 1);
  });
});
const assertNoExecution = (h: Fixture) => {
  assert.equal(h.serviceCount(), 0);
  assert.equal(count(h, "agent_service_process"), 0);
  assert.equal(count(h, "agent_service_invocation"), 0);
};

test("native designer clarifies, drafts, corrects, and retains one isolated conversation", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    const clarification = {
      ...brief(),
      questions: [{ id: "result", text: "TEST which output is needed?" }],
    };
    let model = 0;
    h.onModel((body) => {
      const toolNames = (body.tools ?? []).map((tool) => tool.function.name);
      assert.deepEqual(toolNames.sort(), [
        "design_get_capability",
        "design_list_capabilities",
        "design_read_proposal",
        "design_update_proposal",
        "design_validate_proposal",
      ]);
      switch (++model) {
        case 1:
          return h.call("design_update_proposal", {
            revision: 1,
            brief: clarification,
            candidate: null,
          });
        case 2:
          return { content: "TEST which result should the process return?" };
        case 3:
          return h.call("design_list_capabilities", {});
        case 4:
          return h.call("design_get_capability", {
            serviceId: h.serviceId,
            actionId: h.actionId,
          });
        case 5:
          return h.call("design_update_proposal", {
            revision: 2,
            brief: brief(),
            candidate: h.workflow(),
          });
        case 6:
          return h.call("design_validate_proposal", {});
        case 7:
          return { content: "TEST draft ready for human review" };
        case 8:
          return h.call("design_update_proposal", {
            revision: 3,
            brief: brief("TEST corrected lookup purpose"),
            candidate: { ...h.workflow(), name: "TEST corrected workflow" },
          });
        default:
          return { content: "TEST correction remains a reviewable draft" };
      }
    });
    const first = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-clarify", "TEST design a lookup"),
      signal(),
    );
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.equal(first.revision, 2);
    assert.equal(h.store.get(h.actor, sessionId).candidate, null);
    assert.deepEqual(h.store.get(h.actor, sessionId).brief, clarification);
    const second = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-draft", "TEST return the lookup result"),
      signal(),
    );
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.equal(second.revision, 3);
    assert.equal(h.store.get(h.actor, sessionId).validation.valid, true);
    assert.deepEqual(h.store.get(h.actor, sessionId).blockers, []);
    const third = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-correct", "TEST use the corrected purpose"),
      signal(),
    );
    assert.equal(third.status, "completed", JSON.stringify(third));
    assert.equal(third.revision, 4);
    assert.equal(
      h.store.get(h.actor, sessionId).candidate?.name,
      "TEST corrected workflow",
    );
    assert.equal(model, 9);
    assert.equal(h.modelCount(), 9);
    // The journal projection is the only history; native Memory stays empty.
    assert.equal(Number(nativeCounts(h).count), 0);
    assert.equal(count(h, "agent_inference_run"), 1);
    assert.equal(count(h, "agent_inference_attempt"), 9);
    assert.equal(
      h.db
        .prepare(
          "SELECT COUNT(DISTINCT run_id) AS count FROM agent_inference_attempt",
        )
        .get()!.count,
      1,
    );
    const binding = JSON.parse(
      String(
        h.db
          .prepare(
            "SELECT data FROM agent_process_design_conversation WHERE session_id=?",
          )
          .get(sessionId)!.data,
      ),
    );
    const nativeMessages = await h.nativeMessages(
      binding.threadId,
      binding.resourceId,
    );
    // Proposal arguments never reach native Memory: the designer keeps no
    // native recall, and the current proposal is projected each turn.
    assert.deepEqual(nativeMessages, []);
    const wire = JSON.stringify(h.models());
    for (const configuredSecret of [
      "TEST-configured-key-never-project",
      "TEST-provider-key-never-project",
      "services.example.test",
      "models.example.test",
    ])
      assert(!wire.includes(configuredSecret));
    assertNoExecution(h);
  }));

test("native designer replay and reads remain passive across disk reopen", () =>
  isolated(async (h) => {
    let runtime = adapter(h);
    const sessionId = start(h);
    const body = input(
      h,
      sessionId,
      "TEST-passive",
      "TEST clarify the process",
    );
    h.onModel(() => ({ content: "TEST durable design clarification" }));
    const first = await runtime.message(h.context, body, signal());
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.deepEqual(await runtime.message(h.context, body, signal()), first);
    assert.deepEqual(
      await runtime.get(h.context, read(sessionId, body.requestId)),
      first,
    );
    assert.deepEqual(await runtime.list(h.context, { ...target, sessionId }), [
      first,
    ]);
    assert.equal(h.modelCount(), 1);
    await h.reopen();
    runtime = adapter(h);
    assert.deepEqual(
      await runtime.get(h.context, read(sessionId, body.requestId)),
      first,
    );
    assert.deepEqual(await runtime.message(h.context, body, signal()), first);
    assert.equal(h.modelCount(), 1);
    assert.equal(h.store.get(h.actor, sessionId).revision, 1);
    assertNoExecution(h);
  }));

test("native designer reprojects private domain history under fresh authority and keeps native recall opaque", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    const privateReply = "TEST-private-design-answer-do-not-recall";
    h.onModel(() => ({ content: privateReply }));
    const first = await runtime.message(
      h.context,
      input(
        h,
        sessionId,
        "TEST-private-first",
        "TEST explain proposal purpose",
      ),
      signal(),
    );
    assert.equal(first.status, "completed", JSON.stringify(first));
    const offset = h.modelCount();
    h.onModel(() => ({ content: "TEST fresh proposal answer" }));
    const next = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-private-next", "TEST inspect current proposal"),
      signal(),
    );
    assert.equal(next.status, "completed", JSON.stringify(next));
    const fresh = h.models().slice(offset);
    assert(
      JSON.stringify(fresh).includes(privateReply),
      "Authorized domain history is freshly projected",
    );
    assert(
      !fresh
        .flatMap((body) => body.messages ?? [])
        .some(
          (message) =>
            message.role === "assistant" &&
            message.content?.includes(privateReply),
        ),
      "Raw native assistant history stays opaque",
    );
    // Earlier turns reach the model once, through the journal projection,
    // never also as recalled native user messages.
    assert(
      !fresh
        .flatMap((body) => body.messages ?? [])
        .some(
          (message) =>
            message.role === "user" &&
            message.content?.includes("TEST explain proposal purpose"),
        ),
      "Prior user turns are not repeated as native messages",
    );
    assert.equal(Number(nativeCounts(h).count), 0);
    h.switchActor();
    await assert.rejects(
      runtime.get(h.context, read(sessionId, "TEST-private-first")),
      IdentityError,
    );
    await assert.rejects(
      runtime.list(h.context, { ...target, sessionId }),
      IdentityError,
    );
    await assert.rejects(
      runtime.message(
        h.context,
        input(
          h,
          sessionId,
          "TEST-private-forged",
          "TEST obtain another designer's history",
        ),
        signal(),
      ),
      IdentityError,
    );
    assert.equal(h.modelCount(), offset + 1);
    assertNoExecution(h);
  }));

test("native designer rejects malformed proposal tool arguments without mutating the proposal", () =>
  isolated(async (h) => {
    const runtime = adapter(h, {
      caps: { maxModelCalls: 2, maxTokens: 500_000, maxCostMicros: 10_000_000 },
    });
    const sessionId = start(h);
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? h.call("design_update_proposal", {
            revision: 1,
            brief: brief(),
            candidate: h.workflow(),
            organizationId: "TEST-forged-organization",
            acknowledged: true,
            accept: true,
          })
        : { content: "TEST unsupported tool arguments were rejected" },
    );
    const turn = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-malformed-tool", "TEST prepare a proposal"),
      signal(),
    );
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    assert.equal(h.store.get(h.actor, sessionId).revision, 1);
    assert.equal(h.store.get(h.actor, sessionId).candidate, null);
    assert.deepEqual(turn.toolReceipts, []);
    assert(JSON.stringify(h.models()).includes("invalid_arguments"));
    assertNoExecution(h);
  }));

test("native designer blank final text cannot become a completed public reply", () =>
  isolated(async (h) => {
    const runtime = adapter(h, {
      caps: { maxModelCalls: 2, maxTokens: 500_000, maxCostMicros: 10_000_000 },
    });
    const sessionId = start(h);
    h.onModel(() => ({ content: "   " }));
    const turn = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-blank-final", "TEST explain the proposal"),
      signal(),
    );
    assert.equal(turn.status, "failed", JSON.stringify(turn));
    assert.equal(turn.reply, null);
    assert(turn.failure);
    assert.equal(h.modelCount(), 2);
    assertNoExecution(h);
  }));

test("native designer cannot execute an invented business tool or accept command", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    let calls = 0;
    h.onModel(() => {
      switch (++calls) {
        case 1:
          return h.call("action_process_0", {
            name: "TEST forbidden business lookup",
          });
        case 2:
          return h.call("design_accept_proposal", {
            acknowledged: true,
            activate: true,
          });
        default:
          return { content: "TEST only a human can accept a design" };
      }
    });
    const turn = await runtime.message(
      h.context,
      input(
        h,
        sessionId,
        "TEST-invented-tools",
        "TEST try unsupported commands",
      ),
      signal(),
    );
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    assert.deepEqual(turn.toolReceipts, []);
    assert.equal(h.store.get(h.actor, sessionId).revision, 1);
    assert.equal(h.store.get(h.actor, sessionId).acceptedProcessId, null);
    assert.equal(h.modelCount(), 3);
    assertNoExecution(h);
  }));

test("native designer applies one model-call cap to all conversation turns", () =>
  isolated(async (h) => {
    const runtime = adapter(h, {
      caps: { maxModelCalls: 1, maxTokens: 500_000, maxCostMicros: 10_000_000 },
    });
    const sessionId = start(h);
    h.onModel(() => ({
      content: "TEST within the shared conversation budget",
    }));
    const first = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-cap-first", "TEST clarify the purpose"),
      signal(),
    );
    assert.equal(first.status, "completed", JSON.stringify(first));
    const second = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-cap-second", "TEST ask one more question"),
      signal(),
    );
    assert.equal(second.status, "failed", JSON.stringify(second));
    assert.equal(second.failure, "catalog_budget_exhausted");
    assert.equal(second.reply, null);
    assert.equal(h.modelCount(), 1);
    assert.equal(count(h, "agent_inference_run"), 1);
    assert.equal(count(h, "agent_inference_attempt"), 1);
    assertNoExecution(h);
  }));

test("native designer inference refuses observe policy and missing model price", async () => {
  for (const policy of [{ mode: "observe" as const }, { prices: [] }]) {
    await isolated(async (h) => {
      const runtime = adapter(h);
      const sessionId = start(h);
      h.setBudget(policy);
      let denied: unknown;
      try {
        denied = await runtime.message(
          h.context,
          input(h, sessionId, "TEST-budget-denial", "TEST clarify the draft"),
          signal(),
        );
      } catch (error) {
        assert(error instanceof IdentityError, String(error));
        denied = error;
      }
      if (!(denied instanceof IdentityError)) {
        assert.equal(
          (denied as { status: string }).status,
          "failed",
          JSON.stringify(denied),
        );
        assert.equal((denied as { reply: unknown }).reply, null);
      }
      assert.equal(h.modelCount(), 0);
      assert.equal(h.store.get(h.actor, sessionId).revision, 1);
      assertNoExecution(h);
    });
  }
});

test("native designer rechecks authority immediately before model dispatch", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    h.onModelDispatch(() => h.revoke());
    await assert.rejects(
      runtime.message(
        h.context,
        input(h, sessionId, "TEST-revoke-dispatch", "TEST clarify proposal"),
        signal(),
      ),
      IdentityError,
    );
    h.restore();
    const turn = await runtime.get(
      h.context,
      read(sessionId, "TEST-revoke-dispatch"),
    );
    assert.equal(turn.status, "failed", JSON.stringify(turn));
    assert.equal(turn.reply, null);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.store.get(h.actor, sessionId).revision, 1);
    assertNoExecution(h);
  }));

test("native designer revocation after model response prevents proposal update and reply publication", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    h.onModel(() =>
      h.call("design_update_proposal", {
        revision: 1,
        brief: brief(),
        candidate: h.workflow(),
      }),
    );
    h.onModelResponse(() => h.revoke());
    await assert.rejects(
      runtime.message(
        h.context,
        input(h, sessionId, "TEST-revoke-response", "TEST prepare the draft"),
        signal(),
      ),
      IdentityError,
    );
    h.restore();
    const turn = await runtime.get(
      h.context,
      read(sessionId, "TEST-revoke-response"),
    );
    assert.equal(turn.status, "failed", JSON.stringify(turn));
    assert.equal(turn.reply, null);
    assert.equal(h.modelCount(), 1);
    assert.equal(h.store.get(h.actor, sessionId).revision, 1);
    assert.equal(h.store.get(h.actor, sessionId).candidate, null);
    assertNoExecution(h);
  }));

test("native designer same request cannot dispatch concurrently and terminal replay stays passive", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const sessionId = start(h);
    const body = input(
      h,
      sessionId,
      "TEST-concurrent",
      "TEST explain the proposal",
    );
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.onModel(async () => {
      entered();
      await gate;
      return { content: "TEST once-only design answer" };
    });
    const pending = runtime.message(h.context, body, signal());
    await started;
    try {
      await assert.rejects(
        runtime.message(
          h.context,
          input(
            h,
            sessionId,
            "TEST-concurrent-different",
            "TEST competing proposal change",
          ),
          signal(),
        ),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "process_design_busy",
      );
      let concurrent: unknown;
      try {
        concurrent = await runtime.message(h.context, body, signal());
      } catch (error) {
        assert(error instanceof IdentityError, String(error));
        concurrent = error;
      }
      if (!(concurrent instanceof IdentityError))
        assert.equal(
          (concurrent as { status: string }).status,
          "running",
          JSON.stringify(concurrent),
        );
      assert.equal(h.modelCount(), 1);
    } finally {
      release();
    }
    const first = await pending;
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.deepEqual(await runtime.message(h.context, body, signal()), first);
    assert.equal(h.modelCount(), 1);
    assertNoExecution(h);
  }));

test("native designer charges unknown inference usage at its reservation and continues within caps", () =>
  isolated(async (h) => {
    const runtime = adapter(h, {
      // Two unknown holds (each its request's estimate plus 10,000 output,
      // about 41,000 tokens) fit; the next turn's larger request does not.
      caps: { maxModelCalls: 8, maxTokens: 100_000, maxCostMicros: 10_000_000 },
    });
    const sessionId = start(h);
    h.setModelUsage(undefined);
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? h.call("design_update_proposal", {
            revision: 1,
            brief: brief(),
            candidate: h.workflow(),
          })
        : { content: "TEST draft prepared" },
    );
    const turn = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-unknown-usage", "TEST prepare a draft"),
      signal(),
    );
    assert.equal(turn.status, "completed", JSON.stringify(turn));
    assert.equal(h.modelCount(), 2);
    assert.equal(h.store.get(h.actor, sessionId).revision, 2);
    const root = String(
      h.db.prepare("SELECT id FROM agent_inference_run").get()!.id,
    );
    const summary = h.catalog.inferenceBudget.summary(root);
    assert.equal(summary.unknownCalls, 2);
    // Each unknown attempt keeps its whole reservation, which is its own
    // request estimate plus the output ceiling, never the 100,000-token input
    // ceiling of the price.
    const reserved = h.db
      .prepare(
        "SELECT reserved_tokens FROM agent_inference_attempt WHERE run_id=?",
      )
      .all(root)
      .map((row) => Number(row.reserved_tokens));
    assert.equal(reserved.length, 2);
    assert(reserved.every((tokens) => tokens > 10_000 && tokens < 110_000));
    assert.equal(
      summary.accountedTokens,
      reserved.reduce((a, b) => a + b),
    );
    // A third reservation would exceed the 100,000-token cap.
    const next = await runtime.message(
      h.context,
      input(h, sessionId, "TEST-unknown-capped", "TEST refine the draft"),
      signal(),
    );
    assert.equal(next.status, "failed", JSON.stringify(next));
    assert.equal(next.failure, "catalog_budget_exhausted");
    assert.equal(h.modelCount(), 2);
    assertNoExecution(h);
  }));

test("native designer binds sessions to separate native threads and budget roots", () =>
  isolated(async (h) => {
    const runtime = adapter(h);
    const firstSession = start(h);
    const secondSession = h.store.start(h.actor, {
      ...target,
      requestId: "TEST-start-second-session",
      serviceId: h.serviceId,
    }).sessionId;
    h.onModel(() => ({ content: "TEST isolated design answer" }));
    const first = await runtime.message(
      h.context,
      input(
        h,
        firstSession,
        "TEST-session-one",
        "TEST first independent proposal",
      ),
      signal(),
    );
    const second = await runtime.message(
      h.context,
      input(
        h,
        secondSession,
        "TEST-session-two",
        "TEST second independent proposal",
      ),
      signal(),
    );
    assert.equal(first.status, "completed", JSON.stringify(first));
    assert.equal(second.status, "completed", JSON.stringify(second));
    assert.equal(Number(nativeCounts(h).count), 0);
    assert.equal(count(h, "agent_inference_run"), 2);
    assert.equal(h.modelCount(), 2);
    await assert.rejects(
      runtime.get(h.context, read(secondSession, "TEST-session-one")),
      (error: unknown) =>
        error instanceof IdentityError &&
        error.code === "process_design_command_conflict",
    );
    assert(
      !JSON.stringify(h.models()[1]).includes(
        "TEST first independent proposal",
      ),
    );
    assertNoExecution(h);
  }));
