import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import { LoopsStore } from "../apps/server-identity/loops";
import { loopActionDetails } from "../apps/server-identity/loop-action-details";
import type { StoredInvocation } from "../apps/server-identity/service-catalog";
import {
  finishLoopStep,
  finishLoopTrace,
  LoopTraceSchema,
  newLoopTrace,
  startLoopStep,
  toolOutcome,
} from "../apps/server-identity/loop-trace";
import {
  createTrustHarness,
  toolResults,
  type TrustHarness,
} from "./agent-trust/harness";

function saved(h: TrustHarness, commandId: string) {
  const turn = h.db
    .prepare("SELECT data FROM agent_service_turn")
    .all()
    .map((row) => DomainCommandSchema.parse(JSON.parse(String(row.data))))
    .find((value) => value.commandId === commandId);
  assert(turn, "The production turn journal must contain this command");
  assert(turn.trace, "New turns must include their operational trace");
  return { turn, trace: LoopTraceSchema.parse(turn.trace) };
}

function presentationStore(h: TrustHarness) {
  // Production diagnostic joins use display names; the trust harness keeps its
  // identity tables deliberately minimal until a presentation test needs them.
  for (const table of ["user", "agent_workspace"])
    if (
      !h.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .some((column) => column.name === "name")
    )
      h.db.exec(`ALTER TABLE ${table} ADD COLUMN name TEXT`);
  return new LoopsStore(h.db, h.catalog);
}

test("recorded loop orders model, tool and decision steps without request, result or credentials", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.lookupScript);
    await h.send("Find Jane Test in CRM", { id: "TEST-traced-read" });
    const { turn, trace } = saved(h, "TEST-traced-read");
    assert.equal(trace.status, "succeeded");
    assert(trace.finishedAt);
    assert(
      trace.steps.every((step) => step.finishedAt && step.status !== "running"),
    );
    const firstModel = trace.steps.findIndex((step) => step.kind === "model");
    const firstTool = trace.steps.findIndex((step) => step.kind === "tool");
    const firstDecision = trace.steps.findIndex(
      (step) => step.kind === "decision",
    );
    assert(
      firstModel >= 0 && firstModel < firstTool && firstTool < firstDecision,
    );
    assert.equal(
      trace.steps[firstModel]?.details.find((item) => item.label === "Model")
        ?.value,
      "TEST-agent",
      "Native model observer must preserve the actual selected model identifier",
    );
    assert(
      trace.steps.some(
        (step) =>
          step.label === "TEST Find contact" && step.status === "succeeded",
      ),
    );
    const discovery = trace.steps.find(
      (step) => step.tool?.name === "find_actions",
    );
    assert(
      discovery?.tool?.inputRecorded,
      "Native observer must record safe discovery inputs",
    );
    assert(
      discovery.tool.outputRecorded,
      "Native observer must preserve actual returned action names",
    );
    assert(
      trace.steps.some(
        (step) =>
          step.tool?.name.startsWith("action_") &&
          step.tool.outcome === "completed",
      ),
    );
    assert.equal(
      trace.steps.filter(
        (step) => step.kind === "model" || step.kind === "decision",
      ).length,
      turn.inference,
    );
    const encoded = JSON.stringify(trace);
    for (const secret of [
      "TEST-model-key",
      "TEST-service-key",
      "TEST-only-secret",
      "jane@example.test",
      "Jane Test",
      "Find Jane Test in CRM",
    ])
      assert(
        !encoded.includes(secret),
        `Operational trace must omit ${secret}`,
      );
    await h.restart();
    const requests = h.requests.length;
    await h.send("Find Jane Test in CRM", { id: "TEST-traced-read" });
    assert.equal(
      h.requests.length,
      requests,
      "Passive replay cannot rerun inference",
    );
    assert.deepEqual(saved(h, "TEST-traced-read").trace, trace);
  } finally {
    await h.close();
  }
});

test("asking the person closes the loop as waiting without recording the question body", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() =>
      h.call("ask_user", { question: "TEST private clarification body" }),
    );
    await h.send("Please ask me for missing details", {
      id: "TEST-traced-question",
    });
    const { turn, trace } = saved(h, "TEST-traced-question");
    assert.equal(turn.pending?.kind, "question");
    assert.equal(trace.status, "waiting");
    assert(trace.finishedAt);
    assert(
      trace.steps.some(
        (step) =>
          step.kind === "tool" &&
          step.label === "ask_user" &&
          step.status === "waiting",
      ),
    );
    assert(!JSON.stringify(trace).includes("TEST private clarification body"));
  } finally {
    await h.close();
  }
});

for (const approved of [true, false])
  test(`approval ${approved ? "execution" : "decline"} gets its own recorded outcome after waiting`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(h.writeScript);
      await h.send("Create a meeting for Jane Test", {
        id: "TEST-traced-approval",
      });
      const { turn, trace } = saved(h, "TEST-traced-approval");
      assert.equal(trace.status, "waiting");
      assert(turn.pending);
      const waiting = trace.steps.find(
        (step) =>
          step.kind === "tool" &&
          step.label === "TEST Create meeting" &&
          step.status === "waiting",
      );
      assert(
        waiting,
        "A confirmation request must not claim the write was performed",
      );
      assert.equal(
        h.network.filter((call) => call.path.endsWith("meetings")).length,
        0,
        "An approval card is a proposal; no write can happen before the human decides",
      );
      const firstCount = trace.steps.length;
      await h
        .runtime()
        .resolve(
          turn.pending!.operationId!,
          approved,
          "en",
          new AbortController().signal,
        );
      const resolved = saved(h, "TEST-traced-approval").trace;
      assert.deepEqual(
        resolved.steps.find((step) => step.id === waiting.id),
        waiting,
        "A later decision cannot rewrite the earlier observed waiting attempt",
      );
      assert(
        resolved.steps
          .slice(firstCount)
          .some(
            (step) =>
              step.kind === "tool" &&
              step.status === (approved ? "succeeded" : "cancelled"),
          ),
        "The human's decision and actual action outcome need a new operational step",
      );
      assert.equal(
        h.network.filter((call) => call.path.endsWith("meetings")).length,
        approved ? 1 : 0,
      );
      assert.equal(resolved.status, "succeeded");
      const requests = h.requests.length;
      await h
        .runtime()
        .resolve(
          turn.pending!.operationId!,
          approved,
          "en",
          new AbortController().signal,
        );
      assert.equal(h.requests.length, requests);
      assert.deepEqual(saved(h, "TEST-traced-approval").trace, resolved);
      assert.equal(
        h.network.filter((call) => call.path.endsWith("meetings")).length,
        approved ? 1 : 0,
        "A replay cannot invent another attempt or repeat the action",
      );
    } finally {
      await h.close();
    }
  });

test("failed inference publishes a safe terminal reply without persisting provider exception text", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => {
      throw new Error("TEST private provider exception Bearer TEST-secret");
    });
    const result = await h.send("TEST sensitive request", {
      id: "TEST-traced-error",
    });
    assert.equal(result.status, "accepted");
    assert.match(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /agent run failed/,
    );
    assert.equal(
      result.snapshot.conversations[0]!.messages.at(-1)!.replyToCommandId,
      "TEST-traced-error",
    );
    assert(!JSON.stringify(result).includes("TEST-secret"));
    const { trace } = saved(h, "TEST-traced-error");
    assert.equal(trace.status, "failed");
    assert.equal(trace.steps.at(-1)?.status, "failed");
    assert(trace.finishedAt);
    assert(!JSON.stringify(trace).includes("TEST-secret"));
    assert(!JSON.stringify(trace).includes("TEST sensitive request"));
  } finally {
    await h.close();
  }
});

test("an unknown model-generated tool name cannot smuggle private content into operational metadata", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) =>
      toolResults(body).some((result) => result.error === "unknown_tool")
        ? { content: "The unavailable tool was skipped." }
        : h.call("TEST-private-model-secret", {
            private: "TEST-private-arguments",
          }),
    );
    const result = await h.send("TEST request body", {
      id: "TEST-traced-unknown-tool",
    });
    assert.equal(result.status, "accepted");
    assert.match(
      result.snapshot.conversations[0]!.messages.at(-1)!.text,
      /step limit/,
    );
    const { trace } = saved(h, "TEST-traced-unknown-tool");
    const encoded = JSON.stringify(trace);
    assert(!encoded.includes("TEST-private-model-secret"));
    assert(!encoded.includes("TEST-private-arguments"));
    assert(
      trace.steps.some(
        (step) => step.kind === "tool" && step.status === "failed",
      ),
    );
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("cancellation before an action receipt closes the active tool without claiming a result", async () => {
  const abort = new AbortController();
  const h = createTrustHarness({ signal: abort.signal });
  try {
    h.onChat(h.lookupScript);
    h.controller.invoke = async () => {
      const error = new Error("TEST stopped before receipt");
      abort.abort(error);
      throw error;
    };
    await assert.rejects(
      h.send("Find Jane Test in CRM", { id: "TEST-traced-cancel" }),
      /TEST stopped before receipt/,
    );
    const { trace } = saved(h, "TEST-traced-cancel");
    assert.equal(trace.status, "cancelled");
    assert.equal(trace.steps.at(-1)?.status, "cancelled");
    assert.equal(h.network.length, 0);
    assert(trace.steps.every((step) => step.status !== "running"));
  } finally {
    await h.close();
  }
});

test("an uncertain write receipt keeps the completed loop outcome unknown", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    h.writeResponse = "lost";
    h.onChat((body) =>
      toolResults(body).some((result) => result.status === "unknown")
        ? { content: "The action outcome could not be verified." }
        : h.writeScript(body),
    );
    await h.send("Create a meeting for Jane Test", {
      id: "TEST-traced-unknown",
    });
    const { trace } = saved(h, "TEST-traced-unknown");
    assert.equal(trace.status, "unknown");
    assert(
      trace.steps.some(
        (step) => step.kind === "tool" && step.status === "unknown",
      ),
    );
    assert.equal(
      h.network.filter((call) => call.path.endsWith("meetings")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("a read failure followed by successful verification remains a completed loop with visible retry", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(h.lookupScript);
    const invoke = h.controller.invoke.bind(h.controller);
    let fail = true;
    h.controller.invoke = async (...args) => {
      if (fail) {
        fail = false;
        throw new Error("TEST failed read before dispatch");
      }
      return invoke(...args);
    };
    await h.send("Find Jane Test in CRM", { id: "TEST-traced-retry" });
    const { trace } = saved(h, "TEST-traced-retry");
    assert.equal(trace.status, "succeeded");
    const reads = trace.steps.filter(
      (step) => step.kind === "tool" && step.label === "TEST Find contact",
    );
    assert.deepEqual(
      reads.map((step) => step.status),
      ["failed", "succeeded"],
    );
    assert.equal(h.network.length, 1);
  } finally {
    await h.close();
  }
});

test("bounded lookup fallback without a matching read reports failed verification instead of completed work", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "I looked again and Jane does not exist." }));
    await h.send("Find Jane Test in CRM", { id: "TEST-traced-no-evidence" });
    const { turn, trace } = saved(h, "TEST-traced-no-evidence");
    assert.match(turn.answer!.reply, /not verified this person/);
    assert.equal(trace.status, "failed");
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("a committed memory correction keeps its paired receipt and successful trace through a post-commit interruption", async () => {
  const abort = new AbortController();
  const h = createTrustHarness({ signal: abort.signal });
  try {
    const original = await h.memoryStore.remember(h.memoryActor, {
      requestId: "TEST-trace-memory-seed",
      content: "TEST private old preference",
      kind: "preference",
      scope: "private",
      source: { type: "user_note" },
      explicitIntent: true,
      settings: h.memorySettings,
    });
    h.onChat((body) => {
      const search = toolResults(body).find((result) =>
        Array.isArray(result.items),
      );
      if (!search) return h.call("memory_search", { query: original.content });
      const found = search.items.find(
        (item: { id: string; revision: number }) => item.id === original.id,
      );
      assert(found);
      return h.call("memory_revise", {
        id: found.id,
        revision: found.revision,
        content: "TEST private new preference",
      });
    });
    const revise = h.memoryStore.revise.bind(h.memoryStore);
    h.memoryStore.revise = async (actor, input, checkpoint) => {
      await revise(actor, input, checkpoint);
      const error = new Error("TEST interrupted after memory checkpoint");
      abort.abort(error);
      throw error;
    };
    await assert.rejects(
      h.send(
        'Oprav paměť: "TEST private old preference" → "TEST private new preference"',
        { id: "TEST-traced-memory-atomic", language: "cs" },
      ),
      /TEST interrupted after memory checkpoint/,
    );
    const { turn, trace } = saved(h, "TEST-traced-memory-atomic");
    const mutation = turn.memoryReceipts.find(
      (receipt) => receipt.name === "memory_revise",
    );
    assert(
      mutation,
      "The mutation receipt must commit with the business journal",
    );
    assert.equal(
      turn.memoryReceipts.filter(
        (receipt) => receipt.toolCallId === mutation.toolCallId,
      ).length,
      1,
    );
    assert.equal(turn.memoryChanged, true);
    assert(!JSON.stringify(turn).includes('"transcript"'));

    assert(
      trace.steps.some(
        (step) =>
          step.kind === "tool" &&
          step.label === "memory_revise" &&
          step.status === "succeeded",
      ),
    );
    assert.equal(trace.status, "cancelled");
    assert(!JSON.stringify(trace).includes("TEST private old preference"));
    assert(!JSON.stringify(trace).includes("TEST private new preference"));
  } finally {
    await h.close();
  }
});

test("trace growth is bounded and older turns without a trace remain unchanged", () => {
  const turn = { trace: newLoopTrace() };
  for (let i = 0; i < 122; i++) {
    const step = startLoopStep(turn, "tool", "x".repeat(200), [
      { label: "y".repeat(100), value: "z".repeat(2200) },
    ]);
    finishLoopStep(step, "succeeded");
  }
  finishLoopTrace(turn, "succeeded");
  assert.equal(turn.trace.steps.length, 120);
  assert.equal(turn.trace.truncated, true);
  LoopTraceSchema.parse(turn.trace);
  const old = {};
  assert.equal(startLoopStep(old, "model", "Old model"), undefined);
  finishLoopTrace(old, "succeeded");
  assert.deepEqual(old, {});
  assert.equal(toolOutcome({ status: "needs_input" }), "waiting");
  assert.equal(toolOutcome({ skipped: true }), "cancelled");
  assert.equal(toolOutcome({ status: "unknown" }), "unknown");
});

test("human rejection is cancellation rather than a failed attempted action", () => {
  assert.equal(toolOutcome({ status: "rejected" }), "cancelled");
  assert.equal(toolOutcome({ status: "awaiting_approval" }), "waiting");
  assert.equal(toolOutcome({ status: "failed" }), "failed");
  assert.equal(toolOutcome({ status: "unknown" }), "unknown");
});

for (const approved of [true, false])
  test(`typed action projection keeps waiting proposal separate from later ${approved ? "executed" : "declined"} outcome`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(h.writeScript);
      await h.send("Create a meeting for Jane Test", {
        id: "TEST-trace-presentation",
      });
      const turn = saved(h, "TEST-trace-presentation").turn;
      assert(turn.pending);
      const loops = presentationStore(h);
      const runId = h.catalog.latestTurn(
        h.scope.workspaceId,
        h.scope.userId,
      )!.id;
      const first = loops.detail(h.target.organizationId, runId)!;
      const proposal = first.nodes.find(
        (node) => node.action?.phase === "proposal",
      );
      assert(
        proposal?.action,
        "The actual prepared action needs a typed proposal detail",
      );
      assert.equal(proposal.status, "waiting");
      assert.equal(proposal.action.status, "awaiting_approval");
      assert.equal(proposal.action.effect, "write");
      assert.equal(proposal.action.operationId, turn.pending.operationId);
      assert(proposal.action.input.length > 0);
      assert.deepEqual(proposal.action.output, []);
      assert.equal(h.network.length, 0);
      await h
        .runtime()
        .resolve(
          turn.pending!.operationId!,
          approved,
          "en",
          new AbortController().signal,
        );
      const next = loops.detail(h.target.organizationId, runId)!;
      const preserved = next.nodes.find((node) => node.id === proposal.id)!;
      assert.deepEqual(
        preserved.action,
        proposal.action,
        "A current receipt must not backfill execution into the earlier proposal",
      );
      const execution = next.nodes.find(
        (node) =>
          node.action?.operationId === turn.pending!.operationId &&
          node.status === (approved ? "succeeded" : "cancelled") &&
          node.action?.status === (approved ? "succeeded" : "rejected"),
      );
      assert(
        execution?.action,
        "The person's decision needs a distinct execution outcome",
      );
      assert.equal(
        execution.action.status,
        approved ? "succeeded" : "rejected",
      );
      assert.equal(execution.action.phase, approved ? "execution" : "proposal");
      assert.equal(execution.status, approved ? "succeeded" : "cancelled");
      if (approved)
        assert(
          JSON.stringify(execution.action.output).includes(
            "TEST-created-meeting",
          ),
        );
      else assert.deepEqual(execution.action.output, []);
      assert.equal(h.network.length, approved ? 1 : 0);
    } finally {
      await h.close();
    }
  });

test("historical tool without a usable result stays unknown and does not invent action values", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST prior reply" }));
    await h.send("TEST prior request", { id: "TEST-trace-historical" });
    const { turn } = saved(h, "TEST-trace-historical");
    const runId = h.catalog.latestTurn(h.scope.workspaceId, h.scope.userId)!.id;
    const loops = presentationStore(h);
    for (const content of [
      undefined,
      "null",
      "{}",
      '"TEST unavailable legacy result"',
      "{malformed",
    ]) {
      const historical = {
        ...turn,
        kind: "agent-1",
        trace: undefined,
        operations: [],
        receipts: [],
        transcript: [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "TEST-unavailable-call",
                type: "function",
                function: {
                  name: "memory_search",
                  arguments: '{"query":"TEST private historical query"}',
                },
              },
            ],
          },
          ...(content === undefined
            ? []
            : [
                {
                  role: "tool",
                  tool_call_id: "TEST-unavailable-call",
                  content,
                },
              ]),
        ],
      };
      h.catalog.saveTurn(
        runId,
        h.scope.workspaceId,
        h.scope.userId,
        historical,
      );
      const detail = loops.detail(h.target.organizationId, runId)!;
      assert.equal(detail.run.traceMode, "reconstructed");
      const tool = detail.nodes.find((node) => node.kind === "tool")!;
      assert.equal(
        tool.status,
        "unknown",
        `No outcome can be inferred from ${String(content)}`,
      );
      assert.equal(tool.action, undefined);
      assert.equal(tool.startedAt, null);
      assert.equal(tool.finishedAt, null);
      assert(!JSON.stringify(detail).includes("TEST private historical query"));
      assert(
        !JSON.stringify(detail).includes("TEST unavailable legacy result"),
      );
    }
  } finally {
    await h.close();
  }
});

test("business names cannot impersonate decline metadata or lose bracket-prefixed text and zero results", () => {
  const receipt: StoredInvocation = {
    id: "TEST-business-operation",
    organizationId: "TEST-org",
    workspaceId: "TEST-workspace",
    userId: "TEST-user",
    serviceId: "TEST-service",
    actionId: "TEST-action",
    serviceRevision: 1,
    actionRevision: 1,
    policyRevision: 1,
    input: { title: "[Confirmed] Call Jane", location: "{North entrance}" },
    result: { count: 0, found: false, contacts: [] },
    status: "succeeded",
    title: "Declined action",
    serviceName: "TEST Directory",
    effect: "read",
  };
  const detail = loopActionDetails(receipt, {
    status: "succeeded",
    label: "Declined action",
  });
  assert.equal(detail.phase, "execution");
  assert.equal(detail.status, "succeeded");
  assert(detail.input.some((field) => field.value === "[Confirmed] Call Jane"));
  assert(detail.input.some((field) => field.value === "{North entrance}"));
  assert(detail.output.some((field) => field.value === "0"));
  assert(detail.output.some((field) => field.value === "false"));
  assert.equal(detail.outputTruncated, false);
});
