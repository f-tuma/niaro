import {
  NativeTestSuiteSchema,
  type NativeTestCase,
  type NativeTestSuite,
} from "../../packages/protocol/process-native-testing";
import type {
  ProcessData,
  ProcessStep,
  ProcessVersion,
} from "../../packages/protocol/service-processes";
import { ProcessTestScenarioSchema } from "../../packages/protocol/process-testing";
import {
  processBindingValue,
  processBoundInput,
  processValueSchema,
  processWorkflowDefinition,
} from "../server-agent/process-workflow";
import { schemaValidator } from "../server-integrations/schema";
import { processAgentToolName } from "../server-agent/process-agent-tools";
import type { ProcessTestCatalog } from "./process-test-catalog";
import { mastraActionToolName, rankNativeActions } from "./mastra-domain";
import { processNativeExecutionSettings } from "./process-native-environment";
import { nativeQualificationApplicableScenarios } from "./process-native-qualification";
import { nativePassedBudget } from "./process-native-verdict";

/**
 * Why a default qualification suite cannot be prepared without a person.
 * The process is then saved and frozen, and its test is left to the console.
 */
export type DefaultSuiteGap =
  | "input_unsupported"
  | "output_unsupported"
  | "action_input_unsupported"
  | "action_unavailable"
  | "branch_loop"
  | "scenario_unsupported"
  | "limits_exceeded";
export type DefaultSuite =
  | { suite: NativeTestSuite }
  | { gap: DefaultSuiteGap };

type Catalog = ProcessTestCatalog;
type Action = Catalog["services"][number]["actions"][number];
type Service = Catalog["services"][number];
/** A model reply, a service call (a workflow action, or an agent's own tool
 * call when `tool` is set: the agent asks for it, then the call runs). */
type Step =
  | { model: string; text: string }
  | { action: number; tool?: { model: string; name: string } };
type Fixture = NativeTestCase["actions"][number];
type Receipt = NativeTestCase["expected"]["receipts"][number];
const usage = { inputTokens: 1, outputTokens: 1 };
const SAMPLE = "Ukázka";

const unusedKey = (value: Record<string, unknown>) => {
  let key = "unexpected";
  while (Object.hasOwn(value, key)) key += "_";
  return key;
};
/** A small value for a catalog action's JSON Schema: required fields only;
 * undefined when the schema needs more than this simple subset. */
function sampleJsonValue(schema: unknown, depth = 0): unknown {
  if (!schema || typeof schema !== "object" || depth > 6) return undefined;
  const value = schema as Record<string, unknown>;
  if (Array.isArray(value.enum) && value.enum.length) return value.enum[0];
  if ("const" in value) return value.const;
  const type = Array.isArray(value.type)
    ? value.type.find((t) => t !== "null")
    : value.type;
  switch (type) {
    case "object": {
      const properties = (value.properties ?? {}) as Record<string, unknown>;
      const required = Array.isArray(value.required) ? value.required : [];
      const entries = required.map((key) => [
        key,
        sampleJsonValue(properties[String(key)], depth + 1),
      ]);
      return entries.some(([, item]) => item === undefined)
        ? undefined
        : Object.fromEntries(entries);
    }
    case "array": {
      const min = typeof value.minItems === "number" ? value.minItems : 0;
      if (!min) return [];
      const item = sampleJsonValue(value.items, depth + 1);
      return item === undefined
        ? undefined
        : Array.from({ length: min }, () => item);
    }
    case "string": {
      if (value.format === "date") return "2026-01-01";
      if (value.format === "date-time") return "2026-01-01T08:00:00Z";
      if (value.format === "email") return "ukazka@example.com";
      if (value.format === "uri") return "https://example.com";
      const min = typeof value.minLength === "number" ? value.minLength : 0;
      let text = SAMPLE;
      while (text.length < min) text += SAMPLE;
      return text;
    }
    case "integer":
    case "number": {
      const min =
        typeof value.minimum === "number"
          ? value.minimum
          : typeof value.exclusiveMinimum === "number"
            ? value.exclusiveMinimum + 1
            : 1;
      return type === "integer" ? Math.ceil(min) : min;
    }
    case "boolean":
      return true;
    default:
      return undefined;
  }
}
class Gap extends Error {
  constructor(readonly gap: DefaultSuiteGap) {
    super(gap);
  }
}

/** A small value that satisfies the schema; every declared field is present. */
export function sampleProcessValue(schema: ProcessData): unknown {
  switch (schema.type) {
    case "string": {
      if (schema.enum?.length) return schema.enum[0];
      const max = schema.maxLength ?? 4000,
        min = schema.minLength ?? 0;
      let value = SAMPLE;
      while (value.length < min) value += SAMPLE;
      return value.slice(0, Math.max(min, Math.min(max, value.length)));
    }
    case "number":
    case "integer": {
      let value = schema.minimum ?? Math.min(1, schema.maximum ?? 1);
      if (schema.type === "integer") value = Math.ceil(value);
      if (schema.maximum !== undefined && value > schema.maximum)
        throw new Gap("output_unsupported");
      return value;
    }
    case "boolean":
      return schema.enum?.length ? schema.enum[0] : true;
    case "null":
      return null;
    case "array": {
      const count = Math.min(
        Math.max(1, schema.minItems ?? 0),
        schema.maxItems ?? 100,
      );
      return Array.from({ length: count }, () =>
        sampleProcessValue(schema.items),
      );
    }
    case "object":
      return Object.fromEntries(
        Object.entries(schema.properties).map(([key, field]) => [
          key,
          sampleProcessValue(field),
        ]),
      );
  }
}
function parsed(schema: ProcessData, value: unknown, gap: DefaultSuiteGap) {
  const result = processValueSchema(schema).safeParse(value);
  if (!result.success) throw new Gap(gap);
  return result.data as Record<string, unknown>;
}

/**
 * The ordinary path through the frozen graph with sample data: what each
 * action receives and returns, what each agent replies and what the process
 * returns. Agents reply directly; they call none of their tools.
 */
function walk(artifact: ProcessVersion, catalog: Catalog) {
  const definition = processWorkflowDefinition(artifact.definition);
  const input = parsed(
    definition.inputSchema,
    sampleProcessValue(definition.inputSchema),
    "input_unsupported",
  );
  const carry = {
    input,
    outputs: {} as Record<string, unknown>,
    next: definition.entry as string | null,
  };
  const steps: Step[] = [];
  const fixtures: {
    fixture: Fixture;
    receipt: Receipt;
    service: Service;
    action: Action;
  }[] = [];
  const nodes = new Map(definition.steps.map((step) => [step.id, step]));
  let output: Record<string, unknown> | undefined;
  for (let guard = 0; carry.next !== null; guard++) {
    if (guard > definition.steps.length) throw new Gap("branch_loop");
    const node: ProcessStep | undefined = nodes.get(carry.next);
    if (!node) throw new Gap("branch_loop");
    if (node.type === "action") {
      const service = catalog.services.find((s) => s.id === node.serviceId);
      const action = service?.actions.find((a) => a.id === node.actionId);
      if (!service || !action) throw new Gap("action_unavailable");
      const bound = processBoundInput(node.input, carry);
      let valid = false;
      try {
        valid = schemaValidator(action.inputSchema)(bound);
      } catch {
        valid = false;
      }
      if (!valid) throw new Gap("action_input_unsupported");
      const result = parsed(
        node.outputSchema,
        sampleProcessValue(node.outputSchema),
        "output_unsupported",
      );
      fixtures.push({
        service,
        action,
        fixture: {
          serviceId: service.id,
          actionId: action.id,
          input: bound as Fixture["input"],
          decision: action.approval === "always" ? "approve" : "none",
          outcome: "complete",
          output: result as Fixture["input"],
        },
        receipt: {
          serviceId: service.id,
          actionId: action.id,
          serviceRevision: service.revision,
          actionRevision: action.revision,
          input: bound as Receipt["input"],
          effect: action.effect,
          status: "succeeded",
          output: result as Receipt["input"],
          dispatches: 1,
        },
      });
      steps.push({ action: fixtures.length - 1 });
      carry.outputs[node.id] = result;
      carry.next = node.next;
    } else if (node.type === "agent") {
      parsed(
        node.inputSchema,
        processBoundInput(node.input, carry),
        "input_unsupported",
      );
      const result = parsed(
        node.outputSchema,
        sampleProcessValue(node.outputSchema),
        "output_unsupported",
      );
      // An agent that can read uses its tool first, as a real run does, so
      // the test also spends its steps, model calls and service calls.
      for (const [index, capability] of node.capabilities.entries()) {
        const service = catalog.services.find(
          (s) => s.id === capability.serviceId,
        );
        const action = service?.actions.find(
          (a) => a.id === capability.actionId,
        );
        if (
          !service ||
          action?.effect !== "read" ||
          action.approval !== "never"
        )
          continue;
        const sample = sampleJsonValue(action.inputSchema);
        let valid = false;
        try {
          valid =
            !!sample &&
            typeof sample === "object" &&
            !Array.isArray(sample) &&
            schemaValidator(action.inputSchema)(sample);
        } catch {
          valid = false;
        }
        if (!valid) continue;
        // An MCP action's receipt keeps its whole tools/call result.
        const output: Fixture["input"] =
          service.protocol === "mcp"
            ? {
                content: [
                  { type: "text", text: JSON.stringify({ value: SAMPLE }) },
                ],
              }
            : { value: SAMPLE };
        fixtures.push({
          service,
          action,
          fixture: {
            serviceId: service.id,
            actionId: action.id,
            input: sample as Fixture["input"],
            decision: "none",
            outcome: "complete",
            output,
          },
          receipt: {
            serviceId: service.id,
            actionId: action.id,
            serviceRevision: service.revision,
            actionRevision: action.revision,
            input: sample as Receipt["input"],
            effect: "read",
            status: "succeeded",
            output,
            dispatches: 1,
          },
        });
        steps.push({
          action: fixtures.length - 1,
          tool: { model: node.modelId, name: processAgentToolName(index) },
        });
        break;
      }
      steps.push({ model: node.modelId, text: JSON.stringify(result) });
      carry.outputs[node.id] = result;
      carry.next = node.next;
    } else if (node.type === "branch") {
      const left = processBindingValue(node.condition.left, carry);
      const matches =
        node.condition.operator === "exists"
          ? left !== undefined
          : left === node.condition.right;
      carry.next = matches ? node.whenTrue : node.whenFalse;
    } else {
      output = parsed(
        definition.outputSchema,
        processBoundInput(node.output, carry),
        "output_unsupported",
      );
      carry.next = null;
    }
  }
  if (!output) throw new Gap("output_unsupported");
  return { input, steps, fixtures, output };
}

/**
 * A minimal qualifying suite derived only from the frozen definition and the
 * pinned catalog, for processes made from chat. Values are samples ("Ukázka",
 * 1, true); agents answer with sample JSON and services return sample data.
 * Nothing is dispatched: the native test runs these scripts in isolation.
 * Every applicable family is covered or the suite is refused with a gap.
 */
export function defaultProcessSuite(
  artifact: ProcessVersion,
  catalog: Catalog,
  genericModelId?: string,
): DefaultSuite {
  try {
    return { suite: build(artifact, catalog, genericModelId) };
  } catch (error) {
    if (error instanceof Gap) return { gap: error.gap };
    throw error;
  }
}

function build(
  artifact: ProcessVersion,
  catalog: Catalog,
  genericModelId?: string,
): NativeTestSuite {
  const definition = processWorkflowDefinition(artifact.definition);
  const configuredOnly = !definition.steps.some((s) => s.type === "agent");
  if (!configuredOnly && !genericModelId) throw new Gap("scenario_unsupported");
  const settings = processNativeExecutionSettings(artifact, catalog);
  const path = walk(artifact, catalog);
  const applicable = nativeQualificationApplicableScenarios(artifact, catalog);
  const allowed = (service: Service, action: Action) => {
    if (!service.enabled || !action.enabled) return false;
    const user = action.policy.users.find((u) => u.userId === catalog.userId);
    return user
      ? user.access === "allow"
      : action.policy.roles.includes(catalog.role) ||
          !!action.policy.workspaceRoles?.some((role) =>
            catalog.workspaceRoles.includes(role),
          );
  };
  let calls = 0;
  const callId = (caseId: string) => `${caseId}-call-${++calls}`;
  const text = (model: string, value: string) => ({
    modelId: model,
    requiredTools: [],
    reply: { type: "text" as const, text: value },
    usage,
  });
  /** The same discovery a generic agent makes: find the action, then call it. */
  const genericCall = (caseId: string, index: number) => {
    const { service, action, fixture } = path.fixtures[index]!;
    const named = service.name.toLocaleLowerCase();
    const accessible = catalog.services.filter(
      (s) => s.enabled && s.actions.some((a) => allowed(s, a)),
    );
    const found =
      accessible.find((s) => s.name.toLocaleLowerCase() === named) ??
      accessible.find((s) => s.name.toLocaleLowerCase().includes(named));
    if (found?.id !== service.id) throw new Gap("scenario_unsupported");
    const need = `${action.name} ${action.description}`.slice(0, 500);
    let picked = service.actions.filter((a) => allowed(service, a));
    if (picked.length > 5) picked = rankNativeActions(picked, need).slice(0, 6);
    if (!picked.some((a) => a.id === action.id))
      throw new Gap("scenario_unsupported");
    const name = mastraActionToolName(action.id);
    return [
      {
        modelId: genericModelId!,
        requiredTools: ["find_actions"],
        reply: {
          type: "tool" as const,
          name: "find_actions",
          callId: callId(caseId),
          input: { service: service.name, need },
        },
        usage,
      },
      {
        modelId: genericModelId!,
        requiredTools: [name],
        reply: {
          type: "tool" as const,
          name,
          callId: callId(caseId),
          input: fixture.input,
        },
        usage,
      },
    ];
  };
  /**
   * The ordinary path up to (and including) step `stop`; that step ends
   * the run as `end` says. The generic agent repeats the same calls.
   */
  const scripted = (
    id: string,
    scenario: NativeTestCase["scenario"],
    end?: {
      at: number;
      as: "failure" | "reject" | "unknown" | "invalid" | "malformed";
    },
  ): NativeTestCase => {
    const steps = end ? path.steps.slice(0, end.at + 1) : path.steps;
    const actions: Fixture[] = [];
    const receipts: Receipt[] = [];
    const configured: NativeTestCase["models"]["configured"] = [];
    const generic: NativeTestCase["models"]["generic"] = [];
    steps.forEach((step, index) => {
      const last = end?.at === index;
      if ("model" in step) {
        configured.push(text(step.model, last ? "nejde" : step.text));
        return;
      }
      const { fixture, receipt } = path.fixtures[step.action]!;
      const { output: _output, ...bare } = receipt;
      if (step.tool)
        configured.push({
          modelId: step.tool.model,
          requiredTools: [step.tool.name],
          reply: {
            type: "tool" as const,
            name: step.tool.name,
            callId: callId(id),
            input: fixture.input,
          },
          usage,
        });
      if (!last) {
        actions.push(fixture);
        receipts.push(receipt);
      } else if (end!.as === "malformed") {
        // A write never fails plainly (its effect is then uncertain): its
        // result does not match the step's declared output instead.
        const output = {
          ...(fixture.output as Record<string, unknown>),
          [unusedKey(fixture.output as Record<string, unknown>)]: SAMPLE,
        } as Fixture["input"];
        actions.push({ ...fixture, output });
        receipts.push({ ...receipt, output });
      } else if (end!.as === "reject") {
        actions.push({ ...fixture, decision: "reject", outcome: "complete" });
        receipts.push({ ...bare, status: "rejected", dispatches: 0 });
      } else {
        const outcome = end!.as === "unknown" ? "unknown" : "failure";
        const { output: _o, ...rest } = fixture;
        actions.push({ ...rest, outcome });
        receipts.push({
          ...bare,
          status: outcome === "unknown" ? "unknown" : "failed",
          code:
            outcome === "unknown"
              ? "integration_unavailable"
              : "integration_provider_failed",
        });
      }
      if (!configuredOnly) generic.push(...genericCall(id, step.action));
    });
    if (!configuredOnly) {
      // The generic agent ends as the person would see it: the answer, or a
      // short explanation after a failed or uncertain call.
      if (!end)
        generic.push(text(genericModelId!, JSON.stringify(path.output)));
      else if (end.as === "invalid" || end.as === "malformed")
        generic.push(text(genericModelId!, "nejde"));
      else if (end.as === "failure" || end.as === "reject")
        generic.push(text(genericModelId!, JSON.stringify(path.output)));
      else if (end.as === "unknown") {
        const note = "The outcome is unknown; verify before retrying.";
        generic.push(text(genericModelId!, note), text(genericModelId!, note));
      }
    }
    const codes = {
      failure: "integration_provider_failed",
      reject: "process_action_rejected",
      unknown: "integration_unavailable",
      invalid: "process_output_invalid",
      malformed: "process_output_invalid",
    } as const;
    const outcome = {
      failure: "failed",
      reject: "rejected",
      unknown: "unknown",
      invalid: "failed",
      malformed: "failed",
    } as const;
    return {
      id,
      scenario,
      input: path.input as NativeTestCase["input"],
      actions,
      models: { configured, generic },
      expected: end
        ? {
            outcome: outcome[end.as],
            codes: {
              configured: codes[end.as],
              ...(configuredOnly ? {} : { generic: codes[end.as] }),
            },
            receipts,
          }
        : {
            outcome: "succeeded",
            output: path.output as NativeTestCase["input"],
            receipts,
          },
      ...(scenario === "restart" ? { reopenAt: "completed" as const } : {}),
    };
  };
  const firstIndex = (match: (step: Step) => boolean) =>
    path.steps.findIndex(match);
  const actionAt = (step: Step) =>
    "action" in step ? path.fixtures[step.action]!.action : undefined;
  const cases: NativeTestCase[] = [];
  for (const scenario of ProcessTestScenarioSchema.options) {
    if (!applicable[scenario]) continue;
    if (scenario === "success" || scenario === "restart")
      cases.push(scripted(scenario, scenario));
    else if (scenario === "missing_input") {
      const schema = definition.inputSchema;
      if (schema.type !== "object" || !schema.required.length)
        throw new Gap("scenario_unsupported");
      const input = { ...path.input };
      delete input[schema.required[0]!];
      cases.push({
        id: scenario,
        scenario,
        input: input as NativeTestCase["input"],
        actions: [],
        models: { configured: [], generic: [] },
        expected: {
          outcome: "input_invalid",
          codes: {
            configured: "process_input_invalid",
            ...(configuredOnly ? {} : { generic: "process_input_invalid" }),
          },
          receipts: [],
        },
      });
    } else if (scenario === "failure") {
      const at = firstIndex(() => true);
      if (at < 0) throw new Gap("scenario_unsupported");
      const step = path.steps[at]!;
      cases.push(
        scripted(scenario, scenario, {
          at,
          as:
            "model" in step
              ? "invalid"
              : actionAt(step)?.effect === "write"
                ? "malformed"
                : "failure",
        }),
      );
    } else {
      const at = firstIndex((step) => {
        const action = actionAt(step);
        return scenario === "rejection"
          ? action?.approval === "always"
          : action?.effect === "write";
      });
      // A hazard only an agent's own tool call could reach needs a person.
      if (at < 0) throw new Gap("scenario_unsupported");
      cases.push(
        scripted(scenario, scenario, {
          at,
          as: scenario === "rejection" ? "reject" : "unknown",
        }),
      );
    }
  }
  const suite = NativeTestSuiteSchema.parse(
    configuredOnly
      ? { comparisonMode: "configured_only", cases }
      : { genericModelId, cases },
  );
  const limits = settings.genericSafetyLimits;
  if (
    suite.cases.some(
      (c) =>
        c.models.configured.length >
          settings.effectiveBudgetLimits.maxModelCalls ||
        c.models.generic.length >
          Math.min(limits.maxModelCalls, limits.maxInference) ||
        c.actions.length >
          Math.min(limits.maxActionCalls, definition.limits.maxSteps) ||
        // Each model call must be able to reserve at least the floor input
        // plus its full output within the frozen caps.
        (["configured", "generic"] as const).some(
          (strategy) =>
            !nativePassedBudget(
              c,
              strategy,
              catalog,
              settings.effectiveBudgetLimits,
            ),
        ),
    )
  )
    throw new Gap("limits_exceeded");
  return suite;
}
