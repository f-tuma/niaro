import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ProcessDefinitionSchema,
  type ProcessDefinition,
} from "../packages/protocol/service-processes";
import { deriveNativeQualification } from "../apps/server-identity/process-native-qualification";
import {
  defaultProcessSuite,
  sampleProcessValue,
} from "../apps/server-identity/process-proposal-suite";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import { fixture, admin, target } from "./helpers/service-process-runtime";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import { processObject, processWorkflow } from "./helpers/service-process";

type H = ReturnType<typeof fixture>;
async function setup(run: (h: H) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "niaro-proposal-suite-"));
  const h = fixture(join(root, "identity.sqlite"));
  try {
    await run(h);
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
/** Freeze, generate, run the actual isolated native comparison and derive the verdict. */
async function qualify(
  h: H,
  definition: ProcessDefinition,
  generic?: string,
  serviceId = h.ids.serviceId,
) {
  const draft = h.registry.saveDraft(admin, {
    serviceId,
    revision: 0,
    definition,
  });
  const artifact = h.registry.freezeDraft(admin, draft.id, draft.revision);
  const catalog = h.catalog.processTestCatalog(
    admin.organizationId,
    admin.workspaceId,
    admin,
    artifact.sources,
    generic,
  );
  const generated = defaultProcessSuite(artifact, catalog, generic);
  if (!("suite" in generated)) return { gap: generated.gap };
  const { runProcessNativeComparison } = await import(
    "../apps/server-identity/process-native-testing"
  );
  const report = await runProcessNativeComparison(
    artifact,
    catalog,
    generated.suite,
    new AbortController().signal,
    async () => {},
  );
  const verdict = deriveNativeQualification(
    artifact,
    generated.suite,
    report,
    catalog,
  );
  return { suite: generated.suite, report, verdict };
}
const noBusinessEffects = (h: H) => {
  for (const table of [
    "test_dispatch",
    "test_model",
    "agent_service_invocation",
  ])
    assert.equal(
      h.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get()!.n,
      0,
      table,
    );
};

test("samples satisfy every declared constraint", () => {
  assert.deepEqual(
    sampleProcessValue(
      processObject({
        a: { type: "string", minLength: 10, maxLength: 12 },
        b: { type: "string", enum: ["x", "y"] },
        c: { type: "integer", minimum: 2.5, maximum: 9 },
        d: { type: "array", items: { type: "boolean" }, minItems: 2 },
        e: { type: "null" },
      }),
    ),
    { a: "UkázkaUkázka", b: "x", c: 3, d: [true, true], e: null },
  );
});

test("a model-free read workflow qualifies with a generated suite", () =>
  setup(async (h) => {
    h.model(); // enforce-mode budget; the workflow itself uses no model
    const result = await qualify(
      h,
      processWorkflow(h.ids.serviceId, h.ids.readId),
    );
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.report.status,
      "passed",
      JSON.stringify(result.report.observations.filter((o) => !o.passed)),
    );
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    assert.equal(result.suite.comparisonMode, "configured_only");
    noBusinessEffects(h);
  }));

test("an overview-style workflow (read, agent summary, return) qualifies in both strategies", () =>
  setup(async (h) => {
    const modelId = h.model();
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "workflow",
      name: "TEST Shrnutí dne",
      description: "Synthetic overview process",
      trigger: "manual",
      inputSchema: processObject({}),
      outputSchema: processObject({
        summary: { type: "string" },
        items: { type: "array", items: { type: "string" } },
      }),
      limits: DEFAULT_PROCESS_LIMITS,
      entry: "read",
      steps: [
        {
          id: "read",
          type: "action",
          serviceId: h.ids.serviceId,
          actionId: h.ids.readId,
          input: { name: { source: "literal", value: "dnes" } },
          outputSchema: processObject({ value: { type: "string" } }),
          next: "summarize",
        },
        {
          id: "summarize",
          type: "agent",
          modelId,
          instructions: "Shrň den.",
          capabilities: [],
          memory: "none",
          inputSchema: processObject({ value: { type: "string" } }),
          outputSchema: processObject({
            summary: { type: "string" },
            items: { type: "array", items: { type: "string" } },
          }),
          input: { value: { source: "step", stepId: "read", path: ["value"] } },
          next: "done",
        },
        {
          id: "done",
          type: "return",
          output: {
            summary: { source: "step", stepId: "summarize", path: ["summary"] },
            items: { source: "step", stepId: "summarize", path: ["items"] },
          },
        },
      ],
    });
    const result = await qualify(h, definition, modelId);
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.report.status,
      "passed",
      JSON.stringify(result.report.observations.filter((o) => !o.passed)),
    );
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    assert.deepEqual(
      result.suite.cases.map((c) => c.scenario),
      ["success", "failure", "restart"],
    );
    noBusinessEffects(h);
  }));

test("an agent that reads with its own tool qualifies; one that can only write through its own tool needs a person", () =>
  setup(async (h) => {
    const modelId = h.model();
    const agent = (actionId?: string) =>
      ProcessDefinitionSchema.parse({
        schemaVersion: 1,
        kind: "agent",
        name: "TEST agent",
        description: "Synthetic",
        trigger: "manual",
        inputSchema: processObject({}),
        outputSchema: processObject({ summary: { type: "string" } }),
        limits: DEFAULT_PROCESS_LIMITS,
        modelId,
        instructions: "Shrň.",
        memory: "none",
        capabilities: actionId
          ? [{ serviceId: h.ids.serviceId, actionId }]
          : [],
      });
    const plain = await qualify(h, agent(h.ids.readId), modelId);
    assert(plain.verdict, JSON.stringify(plain));
    assert.equal(plain.report.status, "passed", JSON.stringify(plain.report));
    assert.equal(
      plain.verdict.status,
      "qualified",
      JSON.stringify(plain.verdict),
    );
    const writer = await qualify(h, agent(h.ids.writeId), modelId);
    assert.deepEqual(writer, { gap: "scenario_unsupported" });
    noBusinessEffects(h);
  }));

test("a workflow with a confirmed write covers rejection and an uncertain write", () =>
  setup(async (h) => {
    h.model();
    const result = await qualify(
      h,
      processWorkflow(h.ids.serviceId, h.ids.writeId),
    );
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.report.status,
      "passed",
      JSON.stringify(result.report.observations.filter((o) => !o.passed)),
    );
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    assert.deepEqual(
      result.suite.cases.map((c) => c.scenario),
      [
        "success",
        "rejection",
        "missing_input",
        "failure",
        "unknown",
        "restart",
      ],
    );
    noBusinessEffects(h);
  }));

test("an agent workflow with a confirmed write qualifies all six families in both strategies", () =>
  setup(async (h) => {
    const modelId = h.model();
    const definition = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "workflow",
      name: "TEST zapiš shrnutí",
      description: "Synthetic",
      trigger: "manual",
      inputSchema: processObject({ name: { type: "string" } }),
      outputSchema: processObject({ result: { type: "string" } }),
      limits: DEFAULT_PROCESS_LIMITS,
      entry: "draft",
      steps: [
        {
          id: "draft",
          type: "agent",
          modelId,
          instructions: "Navrhni název.",
          capabilities: [],
          memory: "none",
          inputSchema: processObject({ name: { type: "string" } }),
          outputSchema: processObject({ title: { type: "string" } }),
          input: { name: { source: "input", path: ["name"] } },
          next: "save",
        },
        {
          id: "save",
          type: "action",
          serviceId: h.ids.serviceId,
          actionId: h.ids.writeId,
          input: { name: { source: "step", stepId: "draft", path: ["title"] } },
          outputSchema: processObject({ value: { type: "string" } }),
          next: "done",
        },
        {
          id: "done",
          type: "return",
          output: {
            result: { source: "step", stepId: "save", path: ["value"] },
          },
        },
      ],
    });
    const result = await qualify(h, definition, modelId);
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.report.status,
      "passed",
      JSON.stringify(result.report.observations.filter((o) => !o.passed)),
    );
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    noBusinessEffects(h);
  }));

/** The shape the designer writes for "how many companies are in the CRM": one agent with a
 * CRM read, small caps; prices as configured on a real workspace. */
test("a large-context model fits a process once the designer's small caps are sized, and only a budget below the floor calls is reported", () =>
  setup(async (h) => {
    const modelId = h.model();
    const { fitProcessLimits } = await import(
      "../apps/server-identity/process-proposal-limits"
    );
    const budget = h.catalog.inferenceBudget;
    const realistic = (maxInputTokens: number, maxTokens = 1_000_000) => {
      const policy = budget.policy(admin.organizationId, admin.workspaceId);
      budget.savePolicy(
        admin.organizationId,
        admin.workspaceId,
        policy.revision,
        {
          mode: "enforce",
          maxTokens,
          maxCostMicros: 10_000_000,
          prices: policy.settings.prices.map((price) => ({
            ...price,
            maxInputTokens,
            maxOutputTokens: 8000,
            inputMicrosPerMillion: 250000,
            outputMicrosPerMillion: 1500000,
          })),
        },
      );
    };
    const count = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "Počet firem v CRM",
      description: "Celkový počet firem v CRM pro přehled.",
      trigger: "manual",
      inputSchema: processObject({}),
      outputSchema: processObject({
        count: { type: "integer", minimum: 0 },
      }),
      limits: {
        maxSteps: 2,
        maxModelCalls: 2,
        maxTokens: 1200,
        maxCostMicros: 100000,
        maxDurationMs: 30000,
      },
      modelId,
      instructions: "Zavolej search_companies a vrať celkový počet v count.",
      memory: "none",
      capabilities: [{ serviceId: h.ids.serviceId, actionId: h.ids.readId }],
    });
    const fit = () =>
      fitProcessLimits(count, {
        budget: budget.policy(admin.organizationId, admin.workspaceId).settings,
        ceiling: h.registry.effectiveLimits(),
        model: (id) => {
          const usable = h.catalog.model(admin.organizationId, id, "tools");
          return {
            id: usable.model.id,
            revision: usable.model.revision,
            providerRevision: usable.provider.revision,
          };
        },
      });
    // The live shape: the whole context window is the priced input ceiling
    // (200 000 + 8 000), a process holds 100 000 at most. Each call reserves
    // only its own request size, so the designer's 1 200 tokens are the only
    // problem: the generated test refuses them as they are…
    realistic(200_000);
    const asDesigned = await qualify(h, count, modelId);
    assert.deepEqual(asDesigned, { gap: "limits_exceeded" });
    // Tokens and calls alone are not enough. The generated test now lets the
    // agent call its read tool first, as the live hub run did: the agent
    // node, its first model call and the tool call are three steps, over
    // the designer's maxSteps 2.
    const tokensOnly = await qualify(
      h,
      {
        ...count,
        limits: { ...count.limits, maxTokens: 100_000, maxModelCalls: 4 },
      },
      modelId,
    );
    assert(tokensOnly.verdict, JSON.stringify(tokensOnly));
    assert.equal(tokensOnly.verdict.status, "failed");
    assert(
      tokensOnly.report.observations.some(
        (o) => o.code === "process_step_limit",
      ),
      JSON.stringify(tokensOnly.report.observations),
    );
    // Sized for an ordinary run: the agent node + 3 tool calls + 4 model
    // calls (tool calls + 1) = 8 steps; 15 s + 4 × 10 s + 3 × 5 s; tokens for
    // four calls at a typical 32 768-token input + 8 000 output, capped by
    // the 100 000 ceiling; cost stays at the designer's $0.10.
    const sized = fit();
    assert(!("gap" in sized));
    assert.deepEqual(sized.limits, {
      maxSteps: 8,
      maxModelCalls: 4,
      maxTokens: 100_000,
      maxCostMicros: 100_000,
      maxDurationMs: 70_000,
    });
    const result = await qualify(
      h,
      { ...count, limits: sized.limits },
      modelId,
    );
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    // Only a run budget below the smallest useful run (two calls at the
    // 2 048-token floor input plus 8 000 output) cannot be sized.
    realistic(200_000, 15_000);
    assert.deepEqual(fit(), {
      gap: "model_reservation_too_large",
      reservation: { tokens: 20_096, costMicros: 25_024, calls: 2 },
      allowed: { tokens: 15_000, costMicros: 10_000_000 },
    });
    assert.deepEqual(
      result.suite.cases.map((c) => c.scenario),
      ["success", "failure", "restart"],
    );
    // The success case calls the read tool with sample input before answering.
    const success = result.suite.cases.find((c) => c.scenario === "success")!;
    assert.deepEqual(
      success.models.configured.map((m) =>
        m.reply.type === "tool" ? m.reply.name : "text",
      ),
      ["action_process_0", "text"],
    );
    assert.deepEqual(success.actions[0]?.input, { name: "Ukázka" });
    noBusinessEffects(h);
  }));

/** The live failure of v3: the CRM is an MCP service, whose receipts keep the
 * whole tools/call result. The agent's read and the generic loop's read must
 * expect exactly that, in both strategies. */
test("an agent reading through an MCP service qualifies in both strategies, the generic loop included", () =>
  setup(async (h) => {
    const modelId = h.model();
    const command = (body: object) =>
      h.catalog.command(CatalogCommand.parse({ ...target, ...body }));
    const serviceId = command({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST Acme CRM",
        url: "https://mcp.example.test/mcp",
        protocol: "mcp",
        icon: "database",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const actionId = command({
      type: "saveAction",
      serviceId,
      serviceRevision: h.catalog.service(target.workspaceId, serviceId)
        .revision,
      revision: 0,
      settings: {
        name: "search_companies",
        description:
          "Find companies using flexible filters, pagination, and sorting.",
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "integer", exclusiveMinimum: 0 },
            select: { type: "array", minItems: 1, items: { type: "string" } },
          },
          required: ["select"],
        },
        binding: {
          type: "mcp",
          name: "execute_tool",
          catalogTool: "find_many_companies",
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["owner", "admin", "member"], users: [] },
      },
    });
    const count = ProcessDefinitionSchema.parse({
      schemaVersion: 1,
      kind: "agent",
      name: "Počet firem v CRM",
      description: "Celkový počet firem v CRM pro přehled.",
      trigger: "manual",
      inputSchema: processObject({}),
      outputSchema: processObject({ count: { type: "integer", minimum: 0 } }),
      // The sized limits of the live v3.
      limits: {
        maxSteps: 8,
        maxModelCalls: 4,
        maxTokens: 100_000,
        maxCostMicros: 100_000,
        maxDurationMs: 70_000,
      },
      modelId,
      instructions: "Zavolej search_companies a vrať celkový počet v count.",
      memory: "none",
      capabilities: [{ serviceId, actionId }],
    });
    const result = await qualify(h, count, modelId, serviceId);
    assert(result.verdict, JSON.stringify(result));
    assert.equal(
      result.report.status,
      "passed",
      JSON.stringify(result.report.observations.filter((o) => !o.passed)),
    );
    assert.equal(
      result.verdict.status,
      "qualified",
      JSON.stringify(result.verdict),
    );
    const success = result.report.observations.filter(
      (o) => o.caseId === "success",
    );
    assert.deepEqual(
      success.map((o) => [o.strategy, o.passed]),
      [
        ["configured", true],
        ["generic", true],
      ],
    );
    assert.deepEqual(success[1]!.receipts[0]!.output, {
      content: [{ type: "text", text: '{"value":"Ukázka"}' }],
    });
    assert.deepEqual(success[1]!.receipts[0]!.input, { select: ["Ukázka"] });
    noBusinessEffects(h);
  }));
