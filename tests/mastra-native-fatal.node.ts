import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { LibSQLStore } from "@mastra/libsql";
import { DurableStepIds } from "@mastra/core/agent/durable";
import {
  createNativeAgentRuntime,
  type NativeAgentInput,
} from "@niaro/server-agent";
import {
  nativeCatalogOwner,
  NativeRunUnsettledError,
} from "../apps/server-identity/mastra-runtime";
import { IdentityError } from "../apps/server-identity/error";
import { LoopsStore } from "../apps/server-identity/loops";
import {
  CommandSchema,
  type Command,
  type Language,
} from "../packages/protocol";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

const sentinel = "TEST_PRIVATE_FATAL_PROVIDER_CREDENTIAL";
const malformed = (h: TrustHarness) => {
  const call = h.call("find_service", {});
  call.tool_calls[0]!.function.arguments = '{"private":"' + sentinel + '"';
  return call;
};
const command = (id: string, language: Language = "en"): Command =>
  CommandSchema.parse({
    type: "message.send",
    commandId: id,
    idempotencyKey: id,
    conversationId: "conversation-1",
    text: "TEST complete this request",
    language,
    timeZone: "UTC",
  });
const resource = (h: TrustHarness) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        h.scope.serverId,
        h.target.organizationId,
        h.scope.workspaceId,
        h.scope.userId,
      ]),
    )
    .digest("hex");

for (const language of ["en", "cs"] as const) {
  test(`native malformed provider JSON creates one safe ${language} failure and passive restart replay`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(() => malformed(h));
      const request =
        "TEST original human goal: find the right CRM contact and explain the result.\n" +
        "Please preserve this complete request in the run details. ".repeat(12);
      const original = CommandSchema.parse({
        ...command("TEST-fatal-" + language, language),
        text: request,
      });
      const result = await h.execute(original);
      assert.equal(result.status, "accepted");
      const messages = result.snapshot.conversations[0]!.messages;
      assert.equal(messages.filter((value) => value.role === "user").length, 1);
      assert.equal(
        messages.filter((value) => value.role === "assistant").length,
        1,
      );
      const reply = messages.at(-1)!;
      assert.equal(reply.replyToCommandId, original.commandId);
      assert.match(
        reply.text,
        language === "cs" ? /neplatnou odpověď/ : /invalid response/,
      );
      assert.doesNotMatch(JSON.stringify(result), new RegExp(sentinel));
      const state = h.commandState();
      assert.equal(state.trace?.status, "failed");
      assert.equal(state.terminalCandidate, "protocol");
      assert.equal(state.taskTracked, true);
      assert.deepEqual(state.operations, []);
      assert.equal(
        result.snapshot.workItems.find((work) => work.id === state.runId)
          ?.status,
        "failed",
      );
      const before = h.requests.length;
      assert.deepEqual(
        (await h.execute(original)).snapshot.conversations,
        result.snapshot.conversations,
      );
      await h.restart();
      assert.deepEqual(
        (await h.execute(original)).snapshot.conversations,
        result.snapshot.conversations,
      );
      h.db.exec(`
        ALTER TABLE agent_workspace ADD COLUMN name TEXT NOT NULL DEFAULT 'TEST workspace';
        ALTER TABLE user ADD COLUMN name TEXT NOT NULL DEFAULT 'TEST actor';
      `);
      const loops = new LoopsStore(h.db, h.catalog);
      const detail = loops.detail(h.target.organizationId, state.runId)!;
      const listed = loops.page({ organizationId: h.target.organizationId });
      assert.equal(detail.run.request, request);
      assert.equal(listed.entries[0]?.request, request);
      assert.match(
        detail.run.reply ?? "",
        language === "cs" ? /neplatnou odpověď/ : /invalid response/,
      );
      assert.equal(detail.nodes[0]?.details[0]?.value, request.slice(0, 2000));
      assert.doesNotMatch(JSON.stringify(detail), new RegExp(sentinel));
      assert.equal(h.requests.length, before);
      assert.equal(h.network.length, 0);
      await assert.rejects(
        h.runtime().recoverResult!({
          commandId: original.idempotencyKey,
          text: original.type === "message.send" ? original.text : "",
          language,
          requestHash: "TEST-wrong-hash",
        }),
        IdentityError,
      );
    } finally {
      await h.close();
    }
  });
}

for (const failure of ["envelope", "http"] as const) {
  test(`native ${failure} provider failure produces typed prose without provider diagnostics`, async () => {
    const h = createTrustHarness();
    try {
      h.onProviderResponse(() =>
        failure === "http"
          ? {
              status: 503,
              headers: {},
              text: JSON.stringify({ error: { message: sentinel } }),
            }
          : {
              status: 200,
              headers: {},
              text: JSON.stringify({
                choices: [{ message: { content: { token: sentinel } } }],
              }),
            },
      );
      const result = await h.execute(command("TEST-fatal-" + failure));
      assert.equal(result.status, "accepted");
      assert.match(
        result.snapshot.conversations[0]!.messages.at(-1)!.text,
        failure === "http" ? /model service failed/ : /invalid response/,
      );
      assert.equal(
        h.commandState().terminalCandidate,
        failure === "http" ? "provider" : "protocol",
      );
      assert(!JSON.stringify(h.commandState()).includes(sentinel));
      assert.equal(h.requests.length, 1);
      assert.equal(h.network.length, 0);
    } finally {
      await h.close();
    }
  });
}

for (const mixed of [false, true]) {
  test(`native fatal preserves ${mixed ? "confirmed and unknown writes" : "a confirmed write"} without redispatch`, async () => {
    const h = createTrustHarness({ writeApproval: "never" });
    let writes = 0;
    h.onWrite(() => {
      if (++writes === 2) h.writeResponse = "lost";
    });
    try {
      h.onChat((body) => {
        const results = toolResults(body).filter(
          (value) => value.currentTurn === true,
        );
        if (
          results.some((value) => value.status === "unknown") ||
          (!mixed && results.some((value) => value.data?.created))
        )
          return malformed(h);
        if (mixed && results.some((value) => value.data?.created))
          return h.call(h.tool("Create meeting"), {
            body: {
              attendee: "jane@example.test",
              start: "2026-10-02T12:00:00Z",
              end: "2026-10-02T12:30:00Z",
            },
          });
        return h.writeScript(body);
      });
      const original = command("TEST-fatal-writes-" + mixed);
      const result = await h.execute(original);
      const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
      assert.equal(result.status, "accepted");
      assert.match(reply.text, /invalid response/);
      assert.equal(
        reply.result?.type === "service.action" && reply.result.status,
        mixed ? "unknown" : "succeeded",
      );
      assert.equal(h.commandState().operations.length, mixed ? 2 : 1);
      assert.equal(
        h.commandState().trace?.status,
        mixed ? "unknown" : "failed",
      );
      if (mixed) assert.match(reply.text, /Confirmed completed actions:/);
      const requests = h.requests.length,
        effects = h.network.length;
      await h.restart();
      assert.deepEqual(
        (await h.execute(original)).snapshot.conversations,
        result.snapshot.conversations,
      );
      assert.equal(h.requests.length, requests);
      assert.equal(h.network.length, effects);
      assert.equal(writes, mixed ? 2 : 1);
    } finally {
      await h.close();
    }
  });
}

test("unproved fatal retirement retains the gate; exact retry and interruption share one passive finalization", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => malformed(h));
    const runtime = await nativeCatalogOwner(h.controller);
    const proof = runtime.isSettled;
    runtime.isSettled = () => false;
    const original = command("TEST-fatal-held");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    assert.equal(h.commandState().answer, undefined);
    assert.equal((await h.runtime().tasks!())[0]?.status, "waiting_system");
    await assert.rejects(h.execute(command("TEST-next-held")), /model_busy/);
    const requests = h.requests.length,
      effects = h.network.length;
    runtime.isSettled = proof;
    const [replayed, interrupted] = await Promise.all([
      h.execute(original),
      h.model.interrupt(h.scope, original, async (fn) => fn()),
    ]);
    assert.equal(replayed.status, "accepted");
    assert.equal(interrupted.status, "settled");
    assert.match(
      replayed.snapshot.conversations[0]!.messages.at(-1)!.text,
      /invalid response/,
    );
    assert.doesNotMatch(
      replayed.snapshot.conversations[0]!.messages.at(-1)!.text,
      /interrupted/i,
    );
    assert.equal(replayed.snapshot.conversations[0]!.messages.length, 2);
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, effects);
    h.onChat(() => ({ content: "TEST next request" }));
    assert.equal(
      (await h.execute(command("TEST-next-ready"))).status,
      "accepted",
    );
  } finally {
    await h.close();
  }
});

test("a generic native settlement timeout has no retirement proof and blocks fresh messages after reopen", async () => {
  const h = createTrustHarness();
  try {
    const runtime = await nativeCatalogOwner(h.controller);
    const execute = runtime.execute;
    runtime.execute = async () => {
      throw Error("niaro_native_checkpoint_settlement_timeout");
    };
    const original = command("TEST-no-retirement-proof");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.commandState().terminalCandidate, "execution");
    await assert.rejects(
      h.execute(command("TEST-next-no-proof")),
      /model_busy/,
    );
    runtime.execute = execute;
    await h.restart();
    const before = h.workflow.snapshot(h.scope);
    const requests = h.requests.length;
    const explicitRetry = CommandSchema.parse({
      ...command("TEST-new-retry-internal-key"),
      commandId: "TEST-new-retry-public-command",
      logicalMessageId: original.commandId,
      retryOf: original.commandId,
    });
    await assert.rejects(h.execute(explicitRetry), /model_busy/);
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, 0);
    await assert.rejects(
      h.execute({
        ...command("TEST-new-session-no-proof"),
        session: "new",
      } as Command),
      /model_busy/,
    );
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.requests.length, 0);
    const reopened = await nativeCatalogOwner(h.controller);
    assert.equal(
      await reopened.proveRetired({
        runId: h.commandState().runId,
        threadId: h.commandState().threadId,
        resourceId: resource(h),
      }),
      false,
    );
  } finally {
    await h.close();
  }
});

test("an answer prepared before fatal native retirement cannot publish success on restart", async () => {
  const h = createTrustHarness();
  try {
    const runtime = await nativeCatalogOwner(h.controller);
    const execute = runtime.execute;
    runtime.execute = async (input) => {
      await input.session.finalize("TEST pre-tail success");
      throw Error(sentinel);
    };
    const original = command("TEST-pre-tail-answer");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.commandState().answer, undefined);
    assert.equal((await h.runtime().tasks!())[0]?.status, "waiting_system");
    runtime.execute = execute;
    await h.restart();
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    await assert.rejects(
      h.execute(command("TEST-next-after-prepared")),
      /model_busy/,
    );
    assert.equal(
      h.workflow.snapshot(h.scope).conversations[0]!.messages.length,
      0,
    );
    assert.equal(h.requests.length, 1); // only the domain's checker for the prepared answer
  } finally {
    await h.close();
  }
});

test("domain failure survives loss before workflow commit and replay performs no model work", async () => {
  let lost = true;
  const h = createTrustHarness({
    checkpoint: (stage, change) => {
      if (lost && stage === "before_commit" && change === "command") {
        lost = false;
        throw Error("TEST workflow commit lost");
      }
    },
  });
  try {
    h.onChat(() => malformed(h));
    const original = command("TEST-domain-before-workflow");
    await assert.rejects(h.execute(original), /TEST workflow commit lost/);
    assert(h.commandState().answer);
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    const requests = h.requests.length;
    await h.restart();
    const replay = await h.execute(original);
    assert.equal(replay.status, "accepted");
    assert.equal(replay.snapshot.conversations[0]!.messages.length, 2);
    assert.equal(
      replay.snapshot.conversations[0]!.messages.at(-1)!.replyToCommandId,
      original.commandId,
    );
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("a revoked fatal candidate stays reserved across restart without publishing an answer", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      h.context.change(h.target.organizationId);
      return malformed(h);
    });
    const runtime = await nativeCatalogOwner(h.controller);
    const proof = runtime.isSettled;
    runtime.isSettled = () => false;
    const original = command("TEST-revoked-fatal");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.commandState().terminalCandidate, "protocol");
    assert.equal(h.commandState().answer, undefined);
    await assert.rejects(h.execute(command("TEST-revoked-next")), /model_busy/);
    runtime.isSettled = proof;
    // Storage proof is available after reopen; publication still validates epoch.
    await h.restart();
    const retry = await h.execute(original);
    assert.equal(retry.status, "rejected");
    assert.equal(h.commandState().answer, undefined);
    assert.equal(h.requests.length, 1);
  } finally {
    await h.close();
  }
});

test("a fatal missing suspension checkpoint never projects a resumable question", async () => {
  const h = createTrustHarness();
  try {
    const runtime = await nativeCatalogOwner(h.controller);
    const execute = runtime.execute;
    runtime.execute = async (input) => {
      await input.session.invoke(
        "ask_user",
        { question: "TEST missing checkpoint question" },
        { toolCallId: "TEST-missing-suspension", runId: input.runId },
      );
      throw Error("niaro_native_checkpoint_settlement_timeout");
    };
    const original = command("TEST-fatal-suspension");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    const task = (await h.runtime().tasks!())[0]!;
    assert.equal(task.status, "waiting_system");
    assert.equal(task.native?.question, undefined);
    runtime.execute = execute;
  } finally {
    await h.close();
  }
});

test("native storage retirement proof is exact and cannot substitute an unrelated thread", async () => {
  const h = createTrustHarness();
  let storage: LibSQLStore | undefined;
  try {
    h.onChat(() => malformed(h));
    await h.execute(command("TEST-bound-native-proof"));
    const state = h.commandState();
    const owner = await nativeCatalogOwner(h.controller);
    assert.equal(
      await owner.proveRetired({
        runId: state.runId,
        threadId: state.threadId,
        resourceId: resource(h),
      }),
      true,
    );
    assert.equal(
      await owner.proveRetired({
        runId: state.runId,
        threadId: "TEST-foreign-thread",
        resourceId: resource(h),
      }),
      false,
    );
    assert.equal(
      await owner.proveRetired({
        runId: "TEST-absent-run",
        threadId: state.threadId,
        resourceId: resource(h),
      }),
      false,
    );
    storage = new LibSQLStore({
      id: "TEST-fatal-marker-inspector",
      url: h.catalog.nativeStorageUrl,
    });
    await storage.init();
    const workflows = await storage.getStore("workflows");
    assert.equal(
      await workflows!.getWorkflowRunById({
        workflowName: DurableStepIds.AGENTIC_LOOP,
        runId: state.runId,
      }),
      null,
    );
    const marker = await workflows!.getWorkflowRunById({
      workflowName: "niaro-native-retirement-v1",
      runId: state.runId,
    });
    assert(marker);
    assert(!JSON.stringify(marker).includes(sentinel));
  } finally {
    await storage?.close();
    await h.close();
  }
});

test("a committed memory correction with a lost return is preserved by the safe native failure", async () => {
  const h = createTrustHarness();
  try {
    const old = "TEST prefers early meetings",
      replacement = "TEST prefers afternoon meetings";
    const saved = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-fatal-memory-seed",
      content: old,
      kind: "preference",
      scope: "private",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    const revise = h.memoryStore.revise.bind(h.memoryStore);
    let mutations = 0;
    h.memoryStore.revise = async (...args) => {
      mutations++;
      await revise(...args);
      throw Error(sentinel);
    };
    h.onChat((body) =>
      toolResults(body).some((value) => Array.isArray(value.items))
        ? h.call("memory_revise", {
            id: saved.id,
            revision: saved.revision,
            content: replacement,
          })
        : h.call("memory_search", { query: old }),
    );
    const original = CommandSchema.parse({
      ...command("TEST-fatal-memory"),
      text: `Revise memory: ${JSON.stringify(old)} -> ${JSON.stringify(replacement)}`,
    });
    const result = await h.execute(original);
    assert.equal(result.status, "accepted");
    assert.match(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /Confirmed memory changes were preserved/,
    );
    const state = h.commandState();
    assert.equal(state.memoryChanged, true);
    assert.equal(state.memoryReceipts.length, 1);
    assert.equal(state.memoryReceipts[0]!.result.status, "active");
    assert.equal(state.trace?.status, "failed");
    assert.equal(mutations, 1);
    const requests = h.requests.length;
    await h.restart();
    assert.deepEqual(
      (await h.execute(original)).snapshot.conversations,
      result.snapshot.conversations,
    );
    assert.equal(h.requests.length, requests);
    assert.equal(mutations, 1);
    assert(!JSON.stringify(state).includes(sentinel));
  } finally {
    await h.close();
  }
});

test("an invalid native approval suspension hides its approve action while preserving the canonical proposal", async () => {
  const h = createTrustHarness();
  try {
    const owner = await nativeCatalogOwner(h.controller),
      execute = owner.execute;
    owner.execute = async (input) => {
      await input.session.invoke(
        "find_actions",
        { service: "TEST Calendar and contacts", need: "create meeting" },
        { toolCallId: "TEST-expose-fatal-approval", runId: input.runId },
      );
      await input.session.invoke(
        h.tool("Create meeting"),
        {
          body: {
            attendee: "jane@example.test",
            start: "2026-10-02T12:00:00Z",
            end: "2026-10-02T12:30:00Z",
          },
        },
        { toolCallId: "TEST-invalid-fatal-approval", runId: input.runId },
      );
      throw Error("niaro_native_checkpoint_settlement_timeout");
    };
    await assert.rejects(
      h.execute(command("TEST-invalid-approval-checkpoint")),
      NativeRunUnsettledError,
    );
    const state = h.commandState();
    assert.equal(state.pending?.kind, "approval");
    assert.equal(
      h.catalog.invocation(
        state.operations[0]!,
        h.scope.workspaceId,
        h.scope.userId,
      )?.status,
      "awaiting_approval",
    );
    const task = (await h.runtime().tasks!())[0]!;
    assert.equal(task.status, "waiting_system");
    assert.equal(task.native?.action, undefined);
    await assert.rejects(
      h.execute(
        CommandSchema.parse({
          type: "service.resolve",
          commandId: "TEST-invalid-approval-decision",
          idempotencyKey: "TEST-invalid-approval-decision",
          conversationId: "conversation-1",
          operationId: state.operations[0],
          approved: true,
          language: "en",
        }),
      ),
      /model_busy/,
    );
    assert.equal(h.network.length, 0);
    owner.execute = execute;
  } finally {
    await h.close();
  }
});

for (const changed of ["payload", "idempotency"] as const) {
  test(`a changed ${changed} after restart cannot poison the exact native failure receipt`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(() => malformed(h));
      const owner = await nativeCatalogOwner(h.controller),
        proof = owner.isSettled;
      owner.isSettled = () => false;
      const original = CommandSchema.parse({
        ...command("TEST-distinct-idempotency"),
        commandId: "TEST-distinct-outer",
      });
      await assert.rejects(h.execute(original), NativeRunUnsettledError);
      owner.isSettled = proof;
      await h.restart();
      const before = h.workflow.snapshot(h.scope),
        requests = h.requests.length;
      const altered = CommandSchema.parse(
        changed === "payload"
          ? { ...original, text: "TEST changed text" }
          : { ...original, idempotencyKey: "TEST-altered-idempotency" },
      );
      await assert.rejects(
        h.execute(altered),
        (error: unknown) =>
          error instanceof IdentityError &&
          error.code === "idempotency_conflict",
      );
      assert.deepEqual(h.workflow.snapshot(h.scope), before);
      assert.equal(h.workflow.replay(h.scope, altered), undefined);
      const result = await h.execute(original);
      assert.equal(result.status, "accepted");
      assert.equal(
        result.snapshot.conversations[0]!.messages.at(-1)!.replyToCommandId,
        original.commandId,
      );
      assert.equal(h.requests.length, requests);
      assert.equal(h.network.length, 0);
    } finally {
      await h.close();
    }
  });
}

test("a memory persistence tail failure keeps the native reservation until passive proof succeeds", async () => {
  const h = createTrustHarness();
  const { Memory } = await import("@mastra/memory");
  const settled = Memory.prototype.settled;
  try {
    h.onChat(() => ({ content: "TEST prepared ordinary reply" }));
    Memory.prototype.settled = async () => {
      throw Error(sentinel);
    };
    const original = command("TEST-memory-tail-fatal");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.commandState().terminalCandidate, "execution");
    assert.equal(h.commandState().answer, undefined);
    assert.equal((await h.runtime().tasks!())[0]?.status, "waiting_system");
    await assert.rejects(
      h.execute(command("TEST-memory-tail-next")),
      /model_busy/,
    );
    assert(!JSON.stringify(h.commandState()).includes(sentinel));
    const requests = h.requests.length;
    Memory.prototype.settled = settled;
    const result = await h.execute(original);
    assert.equal(result.status, "accepted");
    assert.match(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /agent run failed/,
    );
    assert.equal(h.requests.length, requests);
  } finally {
    Memory.prototype.settled = settled;
    await h.close();
  }
});

test("native same-run reservation precedes asynchronous retirement marker persistence", async () => {
  const h = createTrustHarness();
  const owner = createNativeAgentRuntime(h.catalog.nativeStorageUrl);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let prepared = 0;
  try {
    const input: NativeAgentInput = {
      runId: "TEST-native-concurrent-reservation",
      threadId: "TEST-native-concurrent-thread",
      resourceId: "TEST-native-concurrent-resource",
      text: "TEST synthetic request",
      signal: new AbortController().signal,
      definitions: [],
      createModel: () => {
        throw Error("Unexpected native model dispatch");
      },
      session: {
        activeTools: () => [],
        state: {},
        save: async () => {},
        allowance: async () => {},
        invoke: async () => ({}),
        finalize: async () => ({ reply: "TEST" }),
        prepareModel: async () => {
          prepared++;
          await held;
          throw Error("TEST preparation stopped");
        },
      },
    };
    const first = owner.execute(input),
      duplicate = owner.execute(input);
    void first.catch(() => {});
    await assert.rejects(duplicate, /niaro_native_run_busy/);
    release();
    await assert.rejects(first, /TEST preparation stopped/);
    assert.equal(prepared, 1);
    assert.equal(
      await owner.proveRetired({
        runId: input.runId,
        threadId: input.threadId,
        resourceId: input.resourceId,
      }),
      true,
    );
  } finally {
    release();
    await owner.close();
    await h.close();
  }
});

test("a reopened fatal candidate wins interruption during its passive finalization", async () => {
  const h = createTrustHarness();
  let release!: () => void;
  try {
    h.onChat(() => malformed(h));
    const owner = await nativeCatalogOwner(h.controller),
      settled = owner.isSettled;
    owner.isSettled = () => false;
    const original = command("TEST-reopened-fatal-race");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    owner.isSettled = settled;
    await h.restart();
    const reopened = await nativeCatalogOwner(h.controller),
      proof = reopened.proveRetired;
    let reached!: () => void;
    const started = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    reopened.proveRetired = async (...args) => {
      reached();
      await hold;
      return proof(...args);
    };
    const requests = h.requests.length;
    const delivery = h.execute(original);
    await started;
    const interruption = h.model.interrupt(h.scope, original, async (fn) =>
      fn(),
    );
    release();
    const [result, acknowledgment] = await Promise.all([
      delivery,
      interruption,
    ]);
    assert.equal(result.status, "accepted");
    assert.equal(acknowledgment.status, "settled");
    assert.equal(h.commandState().trace?.status, "failed");
    assert.match(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /invalid response/,
    );
    assert.doesNotMatch(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /interrupted/i,
    );
    assert.equal(result.snapshot.conversations[0]!.messages.length, 2);
    assert.equal(h.requests.length, requests);
  } finally {
    release?.();
    await h.close();
  }
});

test("an immediate interruption of an unproved reopened retry cannot manufacture cancellation", async () => {
  const h = createTrustHarness();
  try {
    const owner = await nativeCatalogOwner(h.controller),
      execute = owner.execute;
    owner.execute = async () => {
      throw Error("niaro_native_checkpoint_settlement_timeout");
    };
    const original = command("TEST-early-reopened-interruption");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    owner.execute = execute;
    await h.restart();
    const before = h.workflow.snapshot(h.scope);
    const delivery = h.execute(original);
    void delivery.catch(() => {});
    const interrupted = await h.model.interrupt(h.scope, original, async (fn) =>
      fn(),
    );
    assert.equal(interrupted.status, "unknown");
    await assert.rejects(delivery, NativeRunUnsettledError);
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    assert.equal(h.commandState().answer, undefined);
    assert.equal(h.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("an immediate interruption cannot accept a changed durable outer command identity", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => malformed(h));
    const owner = await nativeCatalogOwner(h.controller),
      settled = owner.isSettled;
    owner.isSettled = () => false;
    const original = CommandSchema.parse({
      ...command("TEST-early-original-idem"),
      commandId: "TEST-early-original-outer",
    });
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    owner.isSettled = settled;
    await h.restart();
    const before = h.workflow.snapshot(h.scope),
      requests = h.requests.length;
    const altered = CommandSchema.parse({
      ...original,
      idempotencyKey: "TEST-early-altered-idem",
    });
    const delivery = h.execute(altered);
    void delivery.catch(() => {});
    const interrupted = await h.model.interrupt(h.scope, altered, async (fn) =>
      fn(),
    );
    assert.equal(interrupted.status, "unknown");
    await assert.rejects(
      delivery,
      (error: unknown) =>
        error instanceof IdentityError && error.code === "idempotency_conflict",
    );
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    const exact = await h.execute(original);
    assert.equal(exact.status, "accepted");
    assert.equal(h.requests.length, requests);
  } finally {
    await h.close();
  }
});

test("fatal approval continuation replay restores the exact decision after task revisions advance", async () => {
  let failCommit = false;
  const h = createTrustHarness({
    checkpoint: (stage, change) => {
      if (failCommit && stage === "before_commit" && change === "command") {
        failCommit = false;
        throw Error("TEST approval fatal commit lost");
      }
    },
  });
  try {
    h.onChat(h.writeScript);
    const proposal = await h.send("TEST create a meeting", {
      id: "TEST-fatal-approval-proposal",
    });
    const work = proposal.snapshot.workItems[0]!;
    const operationId = work.native!.action!.operationId;
    const decision = CommandSchema.parse({
      type: "service.resolve",
      commandId: "TEST-decision-outer",
      idempotencyKey: "TEST-decision-idem",
      conversationId: "conversation-1",
      language: "en",
      operationId,
      approved: true,
      workItemId: work.id,
      expectedWorkRevision: work.revision,
    });
    h.onChat(() => malformed(h));
    failCommit = true;
    await assert.rejects(
      h.execute(decision),
      /TEST approval fatal commit lost/,
    );
    const state = h.commandState("TEST-fatal-approval-proposal");
    assert.equal(state.terminalCandidate, "protocol");
    assert(
      state.aliases.some(
        (alias) =>
          alias.commandId === decision.idempotencyKey &&
          alias.outerCommandId === decision.commandId,
      ),
    );
    // Polling can advance workflow revision independently before exact recovery.
    h.workflow.syncNativeWork(h.scope, await h.runtime().tasks!());
    const requests = h.requests.length,
      effects = h.network.length;
    await h.restart();
    const recovered = await h.execute(decision);
    assert.equal(recovered.status, "accepted");
    const reply = recovered.snapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(reply.replyToCommandId, decision.commandId);
    assert.match(reply.text, /invalid response/);
    assert.equal(
      reply.result?.type === "service.action" && reply.result.status,
      "succeeded",
    );
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, effects);
    assert.equal(effects, 1);
    assert.deepEqual(
      (await h.execute(decision)).snapshot.conversations,
      recovered.snapshot.conversations,
    );
  } finally {
    await h.close();
  }
});

test("late card authority conflict cannot publish a safe fatal answer", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      h.context.validateRequest = () => {
        throw new IdentityError(409, "card_context_changed");
      };
      return malformed(h);
    });
    const result = await h.execute(command("TEST-late-card-fatal"));
    assert.equal(result.status, "conflict");
    assert.equal(h.commandState().answer, undefined);
    assert.equal(h.commandState().terminalCandidate, "protocol");
    assert(!JSON.stringify(result).includes("invalid response"));
    assert.equal(h.network.length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    h.context.validateRequest = undefined;
    await h.close();
  }
});

test("legacy proof message wrapper composes the supplied guard with the current owner method", async () => {
  const h = createTrustHarness();
  let supplied = 0;
  let lateOwner = 0;
  try {
    h.onChat(() => {
      h.context.validateRequest = function () {
        assert.equal(this, h.context);
        lateOwner++;
        throw new IdentityError(409, "card_context_changed");
      };
      return malformed(h);
    });
    await assert.rejects(
      h
        .runtime()
        .message(
          "TEST-composed-guard",
          "TEST complete this request",
          "en",
          [],
          new AbortController().signal,
          undefined,
          undefined,
          "UTC",
          {
            conversationId: "conversation-1",
            legacyQuestionProof: () => undefined,
            validateRequest: () => {
              supplied++;
            },
          },
        ),
    );
    assert(supplied > 0, "the supplied request guard remains active");
    assert(lateOwner > 0, "the current owner method retains its receiver");
    assert.equal(h.commandState("TEST-composed-guard").answer, undefined);
    assert.equal(h.network.length, 0);
    assert.equal(h.requests.length, 1);
  } finally {
    h.context.validateRequest = undefined;
    await h.close();
  }
});

test("legacy proof task window forwards a later owner guard at final publication", async () => {
  const h = createTrustHarness();
  try {
    const window = await h.runtime().taskWindow!(() => undefined);
    assert.equal(await h.context.serial(async () => window.validate()), true);
    h.context.validateRequest = function () {
      assert.equal(this, h.context);
      throw new IdentityError(409, "card_context_changed");
    };
    await assert.rejects(
      h.context.serial(async () => window.validate()),
      (error) =>
        error instanceof IdentityError && error.code === "card_context_changed",
    );
    assert.equal(h.requests.length, 0);
    assert.equal(h.network.length, 0);
  } finally {
    h.context.validateRequest = undefined;
    await h.close();
  }
});

test("proven retirement releases a reopened early-abort gate when old publication is revoked", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      h.context.change(h.target.organizationId);
      return malformed(h);
    });
    const owner = await nativeCatalogOwner(h.controller),
      settled = owner.isSettled;
    owner.isSettled = () => false;
    const original = command("TEST-retired-revoked-early-abort");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    owner.isSettled = settled;
    await h.restart();
    const requests = h.requests.length;
    const delivery = h.execute(original);
    void delivery.catch(() => {});
    const ack = await h.model.interrupt(h.scope, original, async (fn) => fn());
    assert.equal(ack.status, "settled");
    const result = await delivery;
    assert.equal(result.status, "accepted");
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.match(reply.text, /work context changed|permissions or/i);
    assert.match(reply.text, /unverified/);
    assert.doesNotMatch(reply.text, /stale success/);
    assert.equal(h.requests.length, requests);
    h.onChat(() => ({ content: "TEST current authorized request" }));
    assert.equal(
      (await h.execute(command("TEST-current-after-revoked-retirement")))
        .status,
      "accepted",
    );
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("an authority-only native rejection cannot release an unproved worker across reopen", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      h.context.change(h.target.organizationId);
      return { content: "TEST reply blocked by current epoch" };
    });
    const owner = await nativeCatalogOwner(h.controller),
      proof = owner.proveRetired;
    owner.proveRetired = async () => false;
    const original = command("TEST-authority-only-held");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    assert.equal(h.commandState().answer, undefined);
    assert.equal(h.commandState().terminalCandidate, "execution");
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    await assert.rejects(
      h.execute(command("TEST-authority-only-next")),
      /model_busy/,
    );
    owner.proveRetired = proof;
    await h.restart();
    const reopened = await nativeCatalogOwner(h.controller),
      reopenedProof = reopened.proveRetired;
    reopened.proveRetired = async () => false;
    const before = h.workflow.snapshot(h.scope),
      requests = h.requests.length;
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    await assert.rejects(
      h.execute({
        ...command("TEST-authority-held-new-session"),
        session: "new",
      } as Command),
      /model_busy/,
    );
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    assert.equal(h.requests.length, requests);
    reopened.proveRetired = reopenedProof;
    const recovered = await h.execute(original);
    assert.equal(recovered.status, "accepted");
    const reply = recovered.snapshot.conversations[0]!.messages.at(-1)!;
    assert.match(reply.text, /work context changed|permissions or/i);
    assert.match(reply.text, /unverified/);
    assert.doesNotMatch(reply.text, /TEST reply blocked by current epoch/);
    h.onChat(() => ({
      content: "TEST current authority is valid for a new task",
    }));
    assert.equal(
      (await h.execute(command("TEST-authority-only-current-task"))).status,
      "accepted",
    );
    assert.match(
      h.commandState(original.commandId).answer?.reply ?? "",
      /work context changed|permissions or/i,
    );
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("workflow publication rejection after passive retirement also releases the scope gate", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => malformed(h));
    const owner = await nativeCatalogOwner(h.controller),
      settled = owner.isSettled;
    owner.isSettled = () => false;
    const original = command("TEST-publication-after-retired");
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    owner.isSettled = settled;
    let guards = 0;
    h.context.validateRequest = () => {
      if (++guards >= 4) throw new IdentityError(409, "card_context_changed");
    };
    await assert.rejects(
      h.execute(original),
      (error: unknown) =>
        error instanceof IdentityError && error.code === "card_context_changed",
    );
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    assert(
      h.commandState().answer,
      "The domain answer was saved before workflow publication was refused",
    );
    assert.equal(guards, 4);
    h.context.validateRequest = undefined;
    h.onChat(() => ({ content: "TEST next current request" }));
    assert.equal(
      (await h.execute(command("TEST-next-after-publication-rejected"))).status,
      "accepted",
    );
    assert.equal(h.network.length, 0);
  } finally {
    h.context.validateRequest = undefined;
    await h.close();
  }
});

test("routing epoch change returns one safe terminal explanation after native retirement", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      h.context.change(h.target.organizationId);
      return { content: "TEST stale success must never be published" };
    });
    const original = command("TEST-routing-change-terminal");
    const result = await h.execute(original);
    assert.equal(result.status, "accepted");
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(reply.replyToCommandId, original.commandId);
    assert.match(reply.text, /work context changed|permissions or/i);
    assert.match(reply.text, /unverified/);
    assert.doesNotMatch(reply.text, /stale success must never be published/);
    const state = h.commandState(original.commandId);
    assert.equal(state.trace?.status, "failed");
    assert(state.trace?.finishedAt);
    assert(state.trace?.steps.every((step) => step.status !== "running"));
    assert.equal(state.answer?.reply, reply.text);
    const requests = h.requests.length;
    assert.deepEqual(
      (await h.execute(original)).snapshot.conversations,
      result.snapshot.conversations,
    );
    assert.equal(h.requests.length, requests, "Replay must not infer again");
    assert.equal(h.network.length, 0, "The test dispatches no service action");
  } finally {
    await h.close();
  }
});

test("revoked actor records only a terminal diagnostic and later replay explains without inference", async () => {
  const h = createTrustHarness();
  let revoked = false;
  try {
    const validActor = h.context.actor;
    const oldRuntime = h.runtime({
      ...h.context,
      actor: async (target) => {
        if (revoked) throw new IdentityError(403, "identity_forbidden");
        return validActor(target);
      },
    });
    const original = command("TEST-revoked-actor-terminal");
    h.onChat(() => {
      revoked = true;
      return malformed(h);
    });
    const owner = await nativeCatalogOwner(h.controller);
    owner.isSettled = () => false;
    await assert.rejects(
      h.model.execute(
        h.scope,
        original,
        () => {},
        new AbortController().signal,
        {
          tools: {
            has: () => false,
            invoke: async () => {
              throw Error("Unexpected legacy tool");
            },
          },
          run: (fn) => h.context.serial(async () => fn()),
          integrations: oldRuntime,
        },
      ),
      NativeRunUnsettledError,
    );
    assert.equal(h.commandState(original.commandId).trace?.status, "running");
    owner.isSettled = () => true;
    const ack = await h.model.interrupt(h.scope, original, async (fn) => fn());
    assert.equal(ack.status, "unknown");
    const state = h.commandState(original.commandId);
    assert.equal(state.answer, undefined);
    assert.notEqual(state.trace?.status, "running");
    assert(state.trace?.finishedAt);
    assert(state.trace?.steps.every((step) => step.status !== "running"));
    const requests = h.requests.length;
    revoked = false;
    const replay = await h.execute(original);
    assert.equal(replay.status, "accepted");
    assert.match(
      replay.snapshot.conversations[0]!.messages.at(-1)!.text,
      /could not be completed/,
    );
    assert.equal(h.requests.length, requests, "Recovery must be passive");
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("actor-denied restoration preserves committed memory in a scoped diagnostic hold", async () => {
  const h = createTrustHarness();
  const actor = h.context.actor;
  try {
    const old = "TEST actor-held early meetings",
      replacement = "TEST actor-held afternoon meetings";
    const saved = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-actor-held-memory-seed",
      content: old,
      kind: "preference",
      scope: "private",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    const revise = h.memoryStore.revise.bind(h.memoryStore);
    h.memoryStore.revise = async (...args) => {
      await revise(...args);
      h.context.actor = async () => {
        throw new IdentityError(403, "identity_forbidden");
      };
      throw Error(sentinel);
    };
    h.onChat((body) =>
      toolResults(body).some((value) => Array.isArray(value.items))
        ? h.call("memory_revise", {
            id: saved.id,
            revision: saved.revision,
            content: replacement,
          })
        : h.call("memory_search", { query: old }),
    );
    const owner = await nativeCatalogOwner(h.controller),
      proof = owner.proveRetired;
    owner.proveRetired = async () => false;
    const original = CommandSchema.parse({
      ...command("TEST-actor-held-memory"),
      text: `Revise memory: ${JSON.stringify(old)} -> ${JSON.stringify(replacement)}`,
    });
    await assert.rejects(h.execute(original), NativeRunUnsettledError);
    const state = h.commandState();
    assert.equal(state.terminalCandidate, "execution");
    assert.equal(state.answer, undefined);
    assert.equal(state.memoryChanged, true);
    assert.equal(state.memoryReceipts.length, 1);
    assert.equal(state.memoryReceipts[0]!.result.status, "active");
    assert(!JSON.stringify(state).includes(sentinel));
    assert.equal(h.workflow.replay(h.scope, original), undefined);
    h.context.actor = actor;
    owner.proveRetired = proof;
    await h.restart();
    const reopened = await nativeCatalogOwner(h.controller),
      reopenedProof = reopened.proveRetired;
    reopened.proveRetired = async () => false;
    const before = h.workflow.snapshot(h.scope),
      requests = h.requests.length;
    await assert.rejects(
      h.execute(command("TEST-actor-held-fresh")),
      /model_busy/,
    );
    assert.deepEqual(h.workflow.snapshot(h.scope), before);
    assert.equal(h.requests.length, requests);
    assert.deepEqual(h.commandState().memoryReceipts, state.memoryReceipts);
    reopened.proveRetired = reopenedProof;
    assert.equal((await h.execute(original)).status, "accepted");
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, 0);
  } finally {
    h.context.actor = actor;
    await h.close();
  }
});

for (const cleanup of ["interrupt", "fresh-access"] as const) {
  test(`proven native retirement releases a permanently revoked captured actor through ${cleanup}`, async () => {
    const h = createTrustHarness();
    try {
      let revoked = false;
      const validActor = h.context.actor;
      const oldRuntime = h.runtime({
        ...h.context,
        actor: async (target) => {
          if (revoked) throw new IdentityError(403, "identity_forbidden");
          return validActor(target);
        },
      });
      const original = command("TEST-captured-actor-" + cleanup);
      h.onChat(() => {
        revoked = true;
        return malformed(h);
      });
      const owner = await nativeCatalogOwner(h.controller),
        settled = owner.isSettled;
      owner.isSettled = () => false;
      await assert.rejects(
        h.model.execute(
          h.scope,
          original,
          () => {},
          new AbortController().signal,
          {
            tools: {
              has: () => false,
              invoke: async () => {
                throw Error("Unexpected legacy tool");
              },
            },
            run: (fn) => h.context.serial(async () => fn()),
            integrations: oldRuntime,
          },
        ),
        NativeRunUnsettledError,
      );
      owner.isSettled = settled;
      const requests = h.requests.length,
        before = h.workflow.snapshot(h.scope),
        inference = h.commandState(original.commandId).inference;
      if (cleanup === "interrupt") {
        const ack = await h.model.interrupt(h.scope, original, async (fn) =>
          fn(),
        );
        assert.equal(ack.status, "unknown");
        assert.deepEqual(h.workflow.snapshot(h.scope), before);
      }
      h.onChat(() => ({ content: "TEST new actor-authorized request" }));
      assert.equal(
        (await h.execute(command("TEST-current-captured-" + cleanup))).status,
        "accepted",
      );
      assert.equal(h.commandState(original.commandId).answer, undefined);
      assert.equal(h.commandState(original.commandId).inference, inference);
      assert.equal(h.workflow.replay(h.scope, original), undefined);
      assert.equal(h.requests.length, requests + 2);
      assert.equal(h.network.length, 0);
    } finally {
      await h.close();
    }
  });
}
