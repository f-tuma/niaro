import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  fixture,
  target,
  scope,
  signal,
  code,
} from "./helpers/service-process-runtime";
import { processAgent, callProcessTool } from "./helpers/service-process-agent";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { LoopsStore } from "../apps/server-identity/loops";

async function isolated(
  run: (h: ReturnType<typeof fixture>, path: string) => Promise<void>,
) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-process-agent-"));
  const path = join(dir, "identity.sqlite");
  const h = fixture(path);
  try {
    await run(h, path);
  } finally {
    await h.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

function conversationCounts(h: ReturnType<typeof fixture>) {
  const db = new DatabaseSync(fileURLToPath(h.catalog.nativeStorageUrl));
  try {
    return db
      .prepare(
        "SELECT COUNT(*) AS count, COUNT(DISTINCT thread_id) AS threads FROM mastra_messages",
      )
      .get()!;
  } finally {
    db.close();
  }
}

function journal(h: ReturnType<typeof fixture>) {
  const row = h.db
    .prepare("SELECT data FROM agent_service_turn LIMIT 1")
    .get()!;
  return JSON.parse(String(row.data));
}

test("custom agent executes the native Agent with typed output and passive replay", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    const first = await h.runtime.start(
      id,
      "TEST-agent",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(first.status, "succeeded", JSON.stringify(first));
    assert.deepEqual(first.output, { result: "TEST-model-result" });
    assert.deepEqual(
      await h.runtime.start(id, "TEST-agent", { name: "TEST-input" }, signal()),
      first,
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
    assert.equal(journal(h).compilerVersion, "niaro-native-workflow/2");
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS count FROM agent_inference_run").get()!
        .count,
      1,
    );
    assert.equal(
      h.db.prepare("SELECT status FROM agent_inference_attempt").get()!.status,
      "settled",
    );
    assert.equal(
      conversationCounts(h).count,
      0,
      "none disables conversation recall; execution checkpoints still exist",
    );
  }));

function twoAgents(h: ReturnType<typeof fixture>) {
  const base = processAgent(h, "conversation");
  assert(base.kind === "agent");
  const {
    kind: _kind,
    modelId,
    instructions,
    capabilities,
    memory,
    ...common
  } = base;
  const agent = {
    type: "agent",
    modelId,
    instructions,
    capabilities,
    memory,
    inputSchema: common.inputSchema,
    outputSchema: common.outputSchema,
  };
  return ProcessDefinitionSchema.parse({
    ...common,
    kind: "workflow",
    entry: "first",
    steps: [
      {
        ...agent,
        id: "first",
        input: { name: { source: "input", path: ["name"] } },
        next: "second",
      },
      {
        ...agent,
        id: "second",
        input: { name: { source: "step", stepId: "first", path: ["result"] } },
        next: "done",
      },
      {
        id: "done",
        type: "return",
        output: {
          result: { source: "step", stepId: "second", path: ["result"] },
        },
      },
    ],
  });
}

test("native agent steps share one root ledger and isolate conversation threads", () =>
  isolated(async (h) => {
    const definition = twoAgents(h);
    const id = h.activate(definition);
    let calls = 0;
    h.onModel(() => ({
      content: JSON.stringify({
        result: ++calls === 1 ? "TEST-first" : "TEST-second",
      }),
    }));
    const done = await h.runtime.start(
      id,
      "TEST-two",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    assert.deepEqual(done.output, { result: "TEST-second" });
    assert(JSON.stringify(h.models()[1]).includes("TEST-first"));
    const state = journal(h);
    assert.notEqual(state.agents.first.threadId, state.agents.second.threadId);
    assert.equal(state.inference, 2);
    const rows = h.db
      .prepare(
        "SELECT run_id,COUNT(*) AS count FROM agent_inference_attempt GROUP BY run_id",
      )
      .all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.count, 2);
    const settings = JSON.parse(
      String(
        h.db.prepare("SELECT settings FROM agent_inference_run").get()!
          .settings,
      ),
    );
    assert.equal(settings.maxTokens, definition.limits.maxTokens);
    assert.equal(settings.maxCostMicros, definition.limits.maxCostMicros);
    assert.equal(conversationCounts(h).threads, 2);
  }));

/** A floor call: 2,048 input tokens plus the fixture price's 1,000 output
 * tokens (one micro per token, so tokens and cost are equal). */
const FLOOR_CALL = 2048 + 1000;

/** What the first agent's call reserves: its own request estimate plus the
 * output ceiling. Request bodies are deterministic, so one run measures it. */
async function firstHold(build: (h: ReturnType<typeof fixture>) => string) {
  let held = 0;
  await isolated(async (h) => {
    h.setModelUsage(undefined);
    await h.runtime.start(
      build(h),
      "TEST-hold",
      { name: "TEST-input" },
      signal(),
    );
    held = Number(
      h.db
        .prepare(
          "SELECT reserved_tokens FROM agent_inference_attempt ORDER BY rowid LIMIT 1",
        )
        .get()!.reserved_tokens,
    );
  });
  assert(held > FLOOR_CALL && held < 51_000, String(held));
  return held;
}

test("process model-call and monetary limits cannot reset at a subsequent agent", async () => {
  // The first agent's unmeasured call is charged its whole hold; one token
  // or micro short of a further floor call, the second agent cannot start.
  const held = await firstHold((h) => h.activate(twoAgents(h)));
  for (const limits of [
    { maxModelCalls: 2 },
    { maxTokens: held + FLOOR_CALL - 1 },
    { maxCostMicros: held + FLOOR_CALL - 1 },
  ]) {
    await isolated(async (h) => {
      const definition = twoAgents(h);
      definition.limits = { ...definition.limits, ...limits };
      const id = h.activate(definition);
      let calls = 0;
      if (limits.maxModelCalls)
        h.onModel(() =>
          ++calls === 1
            ? callProcessTool(1)
            : { content: '{"result":"TEST-first"}' },
        );
      else h.setModelUsage(undefined);
      const stopped = await h.runtime.start(
        id,
        "TEST-cap",
        { name: "TEST-input" },
        signal(),
      );
      assert.equal(stopped.status, "failed", JSON.stringify(stopped));
      assert.equal(stopped.failure?.code, "catalog_budget_exhausted");
      assert.equal(h.models().length, limits.maxModelCalls ? 2 : 1);
      assert.deepEqual(h.counts(), limits.maxModelCalls ? [["GET", 1]] : []);
      assert.equal(
        h.db
          .prepare("SELECT COUNT(*) AS count FROM agent_inference_attempt")
          .get()!.count,
        limits.maxModelCalls ? 2 : 1,
      );
    });
  }
});

test("nested native approval resumes after restart once, then permits another tool", () =>
  isolated(async (h, path) => {
    const id = h.activate(processAgent(h, "conversation"));
    h.onModel(() => callProcessTool());
    const waiting = await h.runtime.start(
      id,
      "TEST-approval",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
    assert(waiting.approval);
    assert.deepEqual(h.counts(), []);
    await assert.rejects(
      h.runtime.resume(
        "TEST-approval",
        { ...waiting.approval, operationId: "TEST-wrong", approved: true },
        signal(),
      ),
      code("process_approval_conflict"),
    );
    await h.close();
    const restarted = fixture(path, h.ids);
    try {
      let calls = 0;
      restarted.onModel(() =>
        ++calls === 1
          ? callProcessTool(1)
          : { content: '{"result":"TEST-done"}' },
      );
      const done = await restarted.runtime.resume(
        "TEST-approval",
        { ...waiting.approval, approved: true },
        signal(),
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.deepEqual(done.output, { result: "TEST-done" });
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
      assert.equal(restarted.models().length, 3);
      assert.equal(done.operations.length, 2);
      assert.notEqual(done.operations[0], done.operations[1]);
      assert(
        JSON.stringify(restarted.models()[1]).includes("TEST-result"),
        "Fresh receipts feed the resumed model",
      );
      assert.deepEqual(
        await restarted.runtime.start(
          id,
          "TEST-approval",
          { name: "TEST-input" },
          signal(),
        ),
        done,
      );
      await assert.rejects(
        restarted.runtime.resume(
          "TEST-approval",
          { ...waiting.approval, approved: true },
          signal(),
        ),
        code("process_approval_conflict"),
      );
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
    } finally {
      await restarted.close();
    }
  }));

test("process Agent step preserves reserved business fields through approval restart", () =>
  isolated(async (h, path) => {
    const businessInput = {
      resumeData: "TEST-process-business-resumeData",
      _background: false,
      suspendedToolRunId: "TEST-process-business-run-id",
      suspendedToolCallId: "TEST-process-business-call-id",
      niaroBusinessInput: "TEST-process-nested-business-field",
    };
    const service = h.catalog.service(target.workspaceId, h.ids.serviceId);
    const action = service.actions.find((item) => item.id === h.ids.writeId)!;
    const inputSchema = {
      type: "object",
      properties: {
        resumeData: { type: "string" },
        _background: { type: "boolean" },
        suspendedToolRunId: { type: "string" },
        suspendedToolCallId: { type: "string" },
        niaroBusinessInput: { type: "string" },
      },
      required: Object.keys(businessInput),
      additionalProperties: false,
    };
    h.catalog.command(
      CatalogCommand.parse({
        ...target,
        type: "saveAction",
        serviceId: service.id,
        serviceRevision: service.revision,
        id: action.id,
        revision: action.revision,
        settings: {
          name: action.name,
          description: action.description,
          inputSchema,
          binding: action.binding,
          effect: action.effect,
          approval: "always",
          policy: action.policy,
          enabled: action.enabled,
        },
      }),
    );

    const id = h.activate(processAgent(h, "conversation"));
    let initialCalls = 0;
    h.onModel((body) => {
      const request = body as {
        tools?: { function?: { parameters?: unknown } }[];
      };
      if (initialCalls++ === 0) {
        assert(request.tools);
        const writeTool = request.tools.find((tool) =>
          JSON.stringify(tool).includes("action_process_0"),
        );
        assert(writeTool);
        const parameterSchema = writeTool.function?.parameters as {
          properties?: Record<string, unknown>;
        };
        assert.deepEqual(Object.keys(parameterSchema.properties ?? {}), [
          "niaroBusinessInput",
        ]);
        return {
          content: null,
          tool_calls: [
            {
              id: "TEST-process-business-call",
              type: "function",
              function: {
                name: "action_process_0",
                arguments: JSON.stringify({
                  niaroBusinessInput: businessInput,
                }),
              },
            },
          ],
        };
      }
      return { content: '{"result":"TEST-process-business-resumed"}' };
    });
    const waiting = await h.runtime.start(
      id,
      "TEST-business-approval",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(
      waiting.status,
      "waiting",
      JSON.stringify({ waiting, model: h.models() }),
    );
    assert(waiting.approval);
    assert.deepEqual(h.counts(), []);
    await h.close();

    const restarted = fixture(path, h.ids);
    try {
      let calls = 0;
      restarted.onModel(() =>
        ++calls === 1
          ? callProcessTool(1)
          : { content: '{"result":"TEST-process-business-resumed"}' },
      );
      const done = await restarted.runtime.resume(
        "TEST-business-approval",
        { ...waiting.approval, approved: true },
        signal(),
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.deepEqual(restarted.counts(), [
        ["GET", 1],
        ["POST", 1],
      ]);
      const invocation = restarted.catalog.invocation(
        waiting.approval.operationId,
        target.workspaceId,
        scope.userId,
      );
      assert.equal(invocation?.status, "succeeded");
      assert.deepEqual(invocation?.input, businessInput);
      assert.equal(restarted.models().length, 3);
    } finally {
      await restarted.close();
    }
  }));

test("memory none also supports durable approval without conversation recall", () =>
  isolated(async (h, path) => {
    const id = h.activate(processAgent(h));
    h.onModel(() => callProcessTool());
    const waiting = await h.runtime.start(
      id,
      "TEST-none",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(waiting.status, "waiting", JSON.stringify(waiting));
    assert(waiting.approval);
    await h.close();
    const restarted = fixture(path, h.ids);
    try {
      const done = await restarted.runtime.resume(
        "TEST-none",
        { ...waiting.approval, approved: true },
        signal(),
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      assert.deepEqual(restarted.counts(), [["POST", 1]]);
      assert.equal(conversationCounts(restarted).count, 0);
    } finally {
      await restarted.close();
    }
  }));

test("native agent rejection and uncertain writes retain canonical outcomes", async () => {
  for (const rejected of [true, false]) {
    await isolated(async (h, path) => {
      const id = h.activate(processAgent(h));
      h.onModel(() => callProcessTool());
      const waiting = await h.runtime.start(
        id,
        "TEST-outcome",
        { name: "TEST-input" },
        signal(),
      );
      assert(waiting.approval, JSON.stringify(waiting));
      if (!rejected) h.setMode("unknown");
      const done = await h.runtime.resume(
        "TEST-outcome",
        { ...waiting.approval, approved: !rejected },
        signal(),
      );
      assert.equal(
        done.status,
        rejected ? "cancelled" : "unknown",
        JSON.stringify(done),
      );
      assert.equal(
        h.catalog.invocation(
          waiting.approval.operationId,
          target.workspaceId,
          scope.userId,
        )?.status,
        rejected ? "rejected" : "unknown",
      );
      assert.deepEqual(h.counts(), rejected ? [] : [["POST", 1]]);
      const loops = new LoopsStore(h.db, h.catalog);
      const detail = loops.detail(
        target.organizationId,
        loops.page(target).entries[0]!.id,
      )!;
      const nativeTools = detail.nodes.filter(
        (node) => node.tool?.name === "action_process_0",
      );
      assert(nativeTools.length > 0);
      const outcome = nativeTools.at(-1)!;
      assert.equal(outcome.tool?.outcome, rejected ? "cancelled" : "unknown");
      assert.equal(outcome.status, rejected ? "cancelled" : "unknown");
      assert.equal(outcome.action?.status, rejected ? "rejected" : "unknown");
      assert.equal(outcome.action?.phase, rejected ? "proposal" : "execution");
      assert(
        !nativeTools.some(
          (node) =>
            node.tool?.outcome === "completed" ||
            node.action?.status === "succeeded",
        ),
      );
      assert.equal(
        h.models().length,
        1,
        "No model can invent success after a failed action",
      );
      await h.close();
      const restarted = fixture(path, h.ids);
      try {
        assert.deepEqual(
          await restarted.runtime.start(
            id,
            "TEST-outcome",
            { name: "TEST-input" },
            signal(),
          ),
          done,
        );
        assert.deepEqual(restarted.counts(), rejected ? [] : [["POST", 1]]);
      } finally {
        await restarted.close();
      }
    });
  }
});

test("invalid derived output cannot overwrite a successful action receipt", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    let calls = 0;
    h.onModel(() =>
      ++calls === 1 ? callProcessTool(1) : { content: '{"result":42}' },
    );
    const done = await h.runtime.start(
      id,
      "TEST-output",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.failure?.code, "process_output_invalid");
    assert.equal(
      h.catalog.invocation(
        done.operations[0]!,
        target.workspaceId,
        scope.userId,
      )?.status,
      "succeeded",
    );
    assert.deepEqual(h.counts(), [["GET", 1]]);
  }));

test("revocation before the model dispatch prevents native execution", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    h.onModelDispatch(() => h.revoke());
    await assert.rejects(
      h.runtime.start(id, "TEST-revoke", { name: "TEST-input" }, signal()),
      code("identity_forbidden"),
    );
    assert.equal(h.models().length, 0);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.db.prepare("SELECT status FROM agent_inference_attempt").get()!.status,
      "cancelled",
    );
  }));

test("cancellation after a model response retains usage and gives the process a precise terminal reason", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    const cancellation = new AbortController();
    h.onModelResponse(() => cancellation.abort());
    // Native cancellation may reject its pending stream; the server journal remains authoritative.
    await h.runtime
      .start(id, "TEST-cancel", { name: "TEST-input" }, cancellation.signal)
      .catch(() => {});
    const done = await h.runtime.start(
      id,
      "TEST-cancel",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(done.status, "cancelled", JSON.stringify(done));
    assert.equal(done.failure?.code, "process_cancelled");
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
    assert.equal(
      h.db
        .prepare("SELECT status,cost_micros FROM agent_inference_attempt")
        .get()!.status,
      "settled",
    );
    assert.equal(
      h.db.prepare("SELECT cost_micros FROM agent_inference_attempt").get()!
        .cost_micros,
      20,
    );
  }));

test("saved memory is read-only authorized context; forget or opt-out blocks resume before hydration", async () => {
  for (const optOut of [false, true]) {
    await isolated(async (h, path) => {
      const note = await h.memoryStore.remember(h.memoryActor, {
        requestId: "TEST-memory",
        content: "TEST preference Czech",
        kind: "preference",
        source: { type: "user_note" },
        explicitIntent: true,
        settings: h.memorySettings,
      });
      const id = h.activate(processAgent(h, "saved"));
      h.onModel(() => callProcessTool());
      const waiting = await h.runtime.start(
        id,
        "TEST-saved",
        { name: "TEST-input" },
        signal(),
      );
      assert(waiting.approval, JSON.stringify(waiting));
      const request = JSON.stringify(h.models()[0]);
      assert(request.includes("TEST preference Czech"));
      assert(!request.includes('"name":"memory.remember"'));
      await h.close();
      const restarted = fixture(path, h.ids);
      try {
        if (optOut)
          restarted.memoryStore.setOptOut(restarted.memoryActor, {
            requestId: "TEST-off",
            optOut: true,
          });
        else
          await restarted.memoryStore.forget(restarted.memoryActor, {
            requestId: "TEST-forget",
            id: note.id,
            revision: note.revision,
          });
        await assert.rejects(
          restarted.runtime.resume(
            "TEST-saved",
            { ...waiting.approval, approved: true },
            signal(),
          ),
          code("memory_context_changed"),
        );
        assert.equal(restarted.models().length, 1);
        assert.deepEqual(restarted.counts(), []);
      } finally {
        await restarted.close();
      }
    });
  }
});

test("agent model and tool dispatches spend the frozen logical step budget", () =>
  isolated(async (h) => {
    const definition = processAgent(h);
    definition.limits.maxSteps = 2; // Agent step plus the first inference; no tool allowance remains.
    const id = h.activate(definition);
    h.onModel(() => callProcessTool(1));
    const done = await h.runtime.start(
      id,
      "TEST-steps",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.failure?.code, "process_step_limit");
    assert.deepEqual(h.counts(), []);
    assert.equal(h.models().length, 1);
  }));

test("a repeated identical read is not dispatched again; the agent answers from the first result", () =>
  isolated(async (h) => {
    const definition = processAgent(h);
    const id = h.activate(definition);
    let calls = 0;
    const seen: string[] = [];
    h.onModel((body) => {
      calls++;
      seen.push(JSON.stringify(body));
      return calls <= 2
        ? {
            ...callProcessTool(1),
            tool_calls: callProcessTool(1).tool_calls.map((call) => ({
              ...call,
              id: `TEST-read-${calls}`,
            })),
          }
        : { content: '{"result":"TEST-model-result"}' };
    });
    const done = await h.runtime.start(
      id,
      "TEST-repeat",
      { name: "TEST-input" },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    // One service read for two identical calls; the second got a pointer.
    assert.deepEqual(h.counts(), [["GET", 1]]);
    assert.equal(h.models().length, 3);
    assert.match(seen[2]!, /already_read/);
  }));

/** Approve a write, then let the resumed call (with unknown usage) read. */
async function unmeasuredAfterApproval(
  h: ReturnType<typeof fixture>,
  limits: object = {},
) {
  const definition = processAgent(h);
  definition.limits = { ...definition.limits, ...limits };
  const id = h.activate(definition);
  h.onModel(() => callProcessTool());
  const waiting = await h.runtime.start(
    id,
    "TEST-usage",
    { name: "TEST-input" },
    signal(),
  );
  assert(waiting.approval);
  h.setModelUsage(undefined);
  h.onModel(() => callProcessTool(1));
  const done = await h.runtime.resume(
    "TEST-usage",
    { ...waiting.approval, approved: true },
    signal(),
  );
  return { waiting: { ...waiting, approval: waiting.approval }, done };
}

test("unknown usage keeps its full hold, so the run cap stops later inference without overwriting the confirmed write", async () => {
  // The resumed call's hold (its request estimate plus output); measured
  // once, since request bodies are deterministic.
  let resumed = 0;
  await isolated(async (h) => {
    await unmeasuredAfterApproval(h);
    resumed = Number(
      h.db
        .prepare(
          "SELECT reserved_tokens FROM agent_inference_attempt ORDER BY rowid LIMIT 1 OFFSET 1",
        )
        .get()!.reserved_tokens,
    );
  });
  assert(resumed > FLOOR_CALL, String(resumed));
  await isolated(async (h) => {
    // 15 measured tokens and the unknown hold leave one token short of a
    // floor call.
    const { waiting, done } = await unmeasuredAfterApproval(h, {
      maxTokens: 15 + resumed + FLOOR_CALL - 1,
    });
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.failure?.code, "catalog_budget_exhausted");
    // The unmeasured call's read still ran within the caps; the next model
    // call no longer fits beside its full hold.
    assert.deepEqual(h.counts(), [
      ["GET", 1],
      ["POST", 1],
    ]);
    assert.equal(
      h.catalog.invocation(
        waiting.approval.operationId,
        target.workspaceId,
        scope.userId,
      )?.status,
      "succeeded",
    );
    assert.equal(h.models().length, 2);
    const root = String(
      h.db.prepare("SELECT id FROM agent_inference_run").get()!.id,
    );
    const summary = h.catalog.inferenceBudget.summary(root);
    assert.equal(summary.unknownCalls, 1);
    assert.equal(summary.accountedTokens, 15 + resumed);
  });
});

test("an operator budget change cannot prevent declining approval or reading a completed result", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    h.onModel(() => callProcessTool());
    const waiting = await h.runtime.start(
      id,
      "TEST-decline",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    const policy = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { ...policy.settings, mode: "observe", prices: [] },
    );
    const rejected = await h.runtime.resume(
      "TEST-decline",
      { ...waiting.approval, approved: false },
      signal(),
    );
    assert.equal(rejected.status, "cancelled", JSON.stringify(rejected));
    assert.deepEqual(
      await h.runtime.start(
        id,
        "TEST-decline",
        { name: "TEST-input" },
        signal(),
      ),
      rejected,
    );
    assert.equal(h.models().length, 1);
    assert.deepEqual(h.counts(), []);
  }));

test("a budget change during tool preparation is checked at the final dispatch guard", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    h.onModel(() => callProcessTool());
    const waiting = await h.runtime.start(
      id,
      "TEST-budget-guard",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    h.onDispatch(() => {
      const policy = h.catalog.inferenceBudget.policy(
        target.organizationId,
        target.workspaceId,
      );
      h.catalog.inferenceBudget.savePolicy(
        target.organizationId,
        target.workspaceId,
        policy.revision,
        { ...policy.settings, maxTokens: policy.settings.maxTokens - 1 },
      );
    });
    const done = await h.runtime.resume(
      "TEST-budget-guard",
      { ...waiting.approval, approved: true },
      signal(),
    );
    assert.equal(done.status, "failed", JSON.stringify(done));
    assert.equal(done.failure?.code, "catalog_budget_policy_changed");
    assert.deepEqual(h.counts(), []);
    assert.equal(h.models().length, 1);
  }));

test("price coverage is checked before an earlier workflow business step", () =>
  isolated(async (h) => {
    const base = h.basic();
    const agents = twoAgents(h);
    assert(base.kind === "workflow" && agents.kind === "workflow");
    const definition = ProcessDefinitionSchema.parse({
      ...agents,
      entry: "lookup",
      steps: [{ ...base.steps[0], next: "first" }, ...agents.steps],
    });
    const id = h.activate(definition);
    const policy = h.catalog.inferenceBudget.policy(
      target.organizationId,
      target.workspaceId,
    );
    h.catalog.inferenceBudget.savePolicy(
      target.organizationId,
      target.workspaceId,
      policy.revision,
      { ...policy.settings, prices: [] },
    );
    await assert.rejects(
      h.runtime.start(id, "TEST-pricing", { name: "TEST-input" }, signal()),
      code("catalog_budget_price_required"),
    );
    assert.deepEqual(h.counts(), []);
    assert.equal(h.models().length, 0);
  }));

test("revoked capability blocks suspended agent hydration and preserves the proposal", () =>
  isolated(async (h, path) => {
    const id = h.activate(processAgent(h, "conversation"));
    h.onModel(() => callProcessTool());
    const waiting = await h.runtime.start(
      id,
      "TEST-policy",
      { name: "TEST-input" },
      signal(),
    );
    assert(waiting.approval);
    await h.close();
    const restarted = fixture(path, h.ids);
    try {
      const service = restarted.catalog.service(
        target.workspaceId,
        h.ids.serviceId,
      );
      const action = service.actions.find((a) => a.id === h.ids.writeId)!;
      restarted.catalog.command(
        CatalogCommand.parse({
          ...target,
          type: "saveAction",
          serviceId: service.id,
          serviceRevision: service.revision,
          id: action.id,
          revision: action.revision,
          settings: {
            name: action.name,
            description: action.description,
            inputSchema: action.inputSchema,
            binding: action.binding,
            effect: action.effect,
            approval: action.approval,
            policy: action.policy,
            enabled: false,
          },
        }),
      );
      await assert.rejects(
        restarted.runtime.resume(
          "TEST-policy",
          { ...waiting.approval, approved: true },
          signal(),
        ),
        code("process_definition_invalid"),
      );
      assert.equal(restarted.models().length, 1);
      assert.deepEqual(restarted.counts(), []);
      assert.equal(
        restarted.catalog.invocation(
          waiting.approval.operationId,
          target.workspaceId,
          scope.userId,
        )?.status,
        "awaiting_approval",
      );
    } finally {
      await restarted.close();
    }
  }));

test("custom agent Loops joins only its native tool receipts without copying prompts", () =>
  isolated(async (h) => {
    const id = h.activate(processAgent(h));
    let calls = 0;
    h.onModel(() =>
      ++calls === 1
        ? callProcessTool(1)
        : { content: '{"result":"TEST-derived"}' },
    );
    const done = await h.runtime.start(
      id,
      "TEST-loops",
      { name: "TEST-private-input" },
      signal(),
    );
    assert.equal(done.status, "succeeded", JSON.stringify(done));
    const loops = new LoopsStore(h.db, h.catalog);
    const page = loops.page(target);
    assert.equal(page.entries.length, 1);
    assert.equal(page.entries[0]!.modelCalls, 2);
    assert.equal(page.entries[0]!.inferenceCalls, 2);
    const detail = loops.detail(target.organizationId, page.entries[0]!.id)!;
    assert.equal(
      detail.nodes.find((n) => n.kind === "tool")?.action?.operationId,
      done.operations[0],
    );
    assert(detail.nodes.some((n) => n.kind === "model"));
    const models = detail.nodes.filter((n) => n.kind === "model");
    assert.equal(
      models.length,
      2,
      "workflow entry is not an additional provider call",
    );
    assert(
      models.every((n) =>
        n.details.some((d) => d.label === "Model" && d.value),
      ),
    );
    const tool = detail.nodes.find((n) => n.kind === "tool")!;
    assert.equal(tool.tool?.name, "action_process_1");
    assert.equal(tool.tool?.outcome, "completed");
    assert.equal(
      tool.tool?.inputRecorded,
      false,
      "service fields belong to scoped receipt projection",
    );
    assert(tool.action?.input.length);
    const counts = { model: h.models().length, effects: h.counts() };
    assert.deepEqual(
      loops.detail(target.organizationId, page.entries[0]!.id),
      detail,
    );
    assert.deepEqual({ model: h.models().length, effects: h.counts() }, counts);
    assert(
      !JSON.stringify(detail.nodes.map((n) => n.details)).includes(
        "TEST-private-input",
      ),
    );
  }));

test("custom agent Loops records invalid/unavailable native calls without private payloads or effects", async () => {
  for (const unavailable of [false, true]) {
    await isolated(async (h) => {
      const id = h.activate(processAgent(h));
      let calls = 0;
      h.onModel(() => {
        if (++calls > 1) return { content: '{"result":"TEST-repaired"}' };
        const call = callProcessTool(1);
        call.tool_calls[0]!.function.name = unavailable
          ? "TEST_PRIVATE_UNKNOWN_TOOL"
          : "action_process_1";
        call.tool_calls[0]!.function.arguments =
          '{"name":123,"privateToken":"TEST_PRIVATE_INVALID_PAYLOAD"}';
        return call;
      });
      const done = await h.runtime.start(
        id,
        "TEST-invalid-loops",
        { name: "TEST-private-context" },
        signal(),
      );
      assert.equal(done.status, "succeeded", JSON.stringify(done));
      const loops = new LoopsStore(h.db, h.catalog);
      const page = loops.page(target);
      const detail = loops.detail(target.organizationId, page.entries[0]!.id)!;
      const tool = detail.nodes.find((n) => n.kind === "tool")!;
      assert.equal(tool.status, "failed");
      assert.equal(
        tool.tool?.outcome,
        unavailable ? "unavailable" : "invalid_arguments",
      );
      assert.equal(
        tool.tool?.name,
        unavailable ? "unknown" : "action_process_1",
      );
      assert.equal(tool.action, undefined);
      assert.equal(tool.tool?.inputRecorded, false);
      assert.equal(tool.tool?.outputRecorded, false);
      for (const secret of [
        "TEST_PRIVATE_UNKNOWN_TOOL",
        "TEST_PRIVATE_INVALID_PAYLOAD",
        "TEST-private-context",
      ])
        assert(!JSON.stringify(detail.nodes).includes(secret));
      assert.deepEqual(h.counts(), []);
      assert.equal(h.models().length, 2);
      assert.deepEqual(
        loops.detail(target.organizationId, page.entries[0]!.id),
        detail,
      );
      assert.equal(h.models().length, 2);
    });
  }
});

test("actual SIGKILL preserves custom agent usage uncertainty and never repeats a dispatched write", async (t) => {
  for (const stage of ["model", "write"]) {
    const directory = mkdtempSync(join(tmpdir(), "niaro-process-crash-"));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const outcome = await new Promise<{
      signal: NodeJS.Signals | null;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL(
              "./helpers/service-process-agent-crash-worker.ts",
              import.meta.url,
            ),
          ),
          directory,
          stage,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(Error("TEST worker timeout " + stderr));
      }, 20000);
      child.on("error", reject);
      child.on("close", (_code, signal) => {
        clearTimeout(timer);
        resolve({ signal, stderr });
      });
    });
    assert.equal(outcome.signal, "SIGKILL", outcome.stderr);
    const metadata = JSON.parse(
      readFileSync(join(directory, "run.json"), "utf8"),
    );
    for (let restart = 0; restart < 2; restart++) {
      const h = fixture(join(directory, "identity.sqlite"), metadata.ids);
      try {
        const done = await h.runtime.start(
          metadata.processId,
          "TEST-crash",
          { name: "TEST-input" },
          signal(),
        );
        assert.equal(
          done.status,
          stage === "model" ? "failed" : "unknown",
          JSON.stringify(done),
        );
        if (stage === "model") {
          const row = h.db
            .prepare(
              "SELECT run_id,status,reserved_tokens FROM agent_inference_attempt",
            )
            .get()!;
          assert.equal(row.status, "unknown");
          // The hold is the request's own estimate plus the output ceiling,
          // below the priced maximum (50,000 + 1,000), and stays charged.
          const reserved = Number(row.reserved_tokens);
          assert(reserved > FLOOR_CALL && reserved < 51000, String(reserved));
          const held = h.catalog.inferenceBudget.summary(String(row.run_id));
          assert.equal(held.unknownCalls, 1);
          assert.equal(held.accountedTokens, reserved);
          assert.equal(done.failure?.code, "process_checkpoint_interrupted");
        } else
          assert.equal(
            h.catalog.invocation(
              done.operations[0]!,
              target.workspaceId,
              scope.userId,
            )?.status,
            "unknown",
          );
        assert.equal(h.models().length, 1);
        assert.deepEqual(h.counts(), stage === "write" ? [["POST", 1]] : []);
      } finally {
        await h.close();
      }
    }
  }
});
