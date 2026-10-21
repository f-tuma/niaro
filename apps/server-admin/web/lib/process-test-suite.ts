import { z } from "zod";
import {
  NativeTestSuiteSchema,
  type NativeTestSuite,
} from "../../../../packages/protocol/process-native-testing";
import {
  ProcessTestScenarioSchema,
  TestJsonSchema,
  TestObjectSchema,
} from "../../../../packages/protocol/process-testing";
import {
  processValueSchema,
  type ProcessVersion,
} from "../../../../packages/protocol/service-processes";

const text = z.string().max(65536);
const actionDraft = z.strictObject({
  serviceId: text,
  actionId: text,
  input: text,
  output: text,
  decision: z.enum(["none", "approve", "reject"]),
  outcome: z.enum(["complete", "failure", "unknown"]),
});
const receiptDraft = z.strictObject({
  serviceId: text,
  actionId: text,
  serviceRevision: text,
  actionRevision: text,
  input: text,
  output: text,
  effect: z.enum(["read", "write"]),
  status: z.enum(["succeeded", "failed", "unknown", "rejected"]),
  code: text,
  dispatches: text,
});
const modelDraft = z.strictObject({
  modelId: text,
  requiredTools: text,
  replyType: z.enum(["text", "tool"]),
  replyText: text,
  tool: text,
  callId: text,
  input: text,
  inputTokens: text,
  outputTokens: text,
});
const questionDraft = z.strictObject({
  question: z.string().max(2000),
  answer: z.string().max(4000),
});
const questionsDraft = z.strictObject({
  configured: z.array(questionDraft).max(16),
  generic: z.array(questionDraft).max(16),
});
const caseDraft = z.strictObject({
  id: text,
  scenario: ProcessTestScenarioSchema,
  input: text,
  output: text,
  configuredCode: text,
  genericCode: text,
  reopenAt: z.enum(["", "completed", "suspended"]),
  actions: z.array(actionDraft).max(32),
  receipts: z.array(receiptDraft).max(32),
  configured: z.array(modelDraft).max(32),
  generic: z.array(modelDraft).max(32),
  questions: questionsDraft.optional(),
});
export const SuiteDraftSchema = z.strictObject({
  comparisonMode: z.literal("configured_only").optional(),
  genericModelId: text,
  cases: z.array(caseDraft).max(16),
});
export type SuiteDraft = z.infer<typeof SuiteDraftSchema>;
export type CaseDraft = SuiteDraft["cases"][number];
export type ActionDraft = CaseDraft["actions"][number];
export type ReceiptDraft = CaseDraft["receipts"][number];
export type ModelDraft = CaseDraft["configured"][number];
export type QuestionDraft = NonNullable<
  CaseDraft["questions"]
>["configured"][number];
export function readSuiteDraft(value: string): SuiteDraft {
  if (!value) return { genericModelId: "", cases: [] };
  if (value.length > 250000)
    throw new SyntaxError("Suite draft exceeds 250000 characters");
  const data = JSON.parse(value);
  return SuiteDraftSchema.parse(data);
}
export function newCaseDraft(
  scenario: CaseDraft["scenario"],
  index: number,
): CaseDraft {
  return {
    id: `${scenario}_${index}`,
    scenario,
    input: "{}",
    output: ["success", "restart"].includes(scenario) ? "{}" : "",
    configuredCode: "",
    genericCode: "",
    reopenAt: scenario === "restart" ? "suspended" : "",
    actions: [],
    receipts: [],
    configured: [],
    generic: [],
  };
}

/** The exact literal return supplies an explicit oracle; no result is guessed. */
export function literalWorkflowStarterSuite(
  artifact: ProcessVersion | null,
): string | null {
  const definition = artifact?.definition;
  if (
    !definition ||
    definition.kind !== "workflow" ||
    definition.steps.length !== 1 ||
    !processValueSchema(definition.inputSchema).safeParse({}).success
  )
    return null;
  const step = definition.steps[0]!;
  if (
    step.type !== "return" ||
    step.id !== definition.entry ||
    Object.values(step.output).some((binding) => binding.source !== "literal")
  )
    return null;
  const output = Object.fromEntries(
    Object.entries(step.output).map(([key, binding]) => [
      key,
      binding.source === "literal" ? binding.value : undefined,
    ]),
  );
  if (!processValueSchema(definition.outputSchema).safeParse(output).success)
    return null;
  return suiteToDraft(
    NativeTestSuiteSchema.parse({
      comparisonMode: "configured_only",
      cases: ["success", "restart"].map((scenario) => ({
        id: scenario,
        scenario,
        input: {},
        actions: [],
        models: { configured: [], generic: [] },
        expected: { outcome: "succeeded", output, receipts: [] },
        ...(scenario === "restart" ? { reopenAt: "completed" } : {}),
      })),
    }),
  );
}
export const newActionDraft = (): ActionDraft => ({
  serviceId: "",
  actionId: "",
  input: "{}",
  output: "{}",
  decision: "none",
  outcome: "complete",
});
export const newReceiptDraft = (): ReceiptDraft => ({
  serviceId: "",
  actionId: "",
  serviceRevision: "",
  actionRevision: "",
  input: "{}",
  output: "{}",
  effect: "read",
  status: "succeeded",
  code: "",
  dispatches: "1",
});
export const newModelDraft = (modelId = ""): ModelDraft => ({
  modelId,
  requiredTools: "[]",
  replyType: "text",
  replyText: "",
  tool: "",
  callId: crypto.randomUUID(),
  input: "{}",
  inputTokens: "1",
  outputTokens: "1",
});
export const newQuestionDraft = (): QuestionDraft => ({
  question: "",
  answer: "",
});
function object(value: string, field = "JSON") {
  try {
    return TestObjectSchema.parse(JSON.parse(value));
  } catch {
    throw new SyntaxError(field + ": Invalid JSON object");
  }
}
function integer(value: string, field = "Number") {
  if (!/^\d+$/.test(value))
    throw new SyntaxError(field + ": An unsigned integer is required");
  return Number(value);
}
export function parseSuiteDraft(value: string): NativeTestSuite {
  const d = readSuiteDraft(value);
  const models = (steps: ModelDraft[], field: string) =>
    steps.map((s, index) => ({
      modelId: s.modelId,
      requiredTools: z
        .array(z.string())
        .max(64)
        .parse(JSON.parse(s.requiredTools || "[]")),
      reply:
        s.replyType === "text"
          ? { type: "text" as const, text: s.replyText }
          : {
              type: "tool" as const,
              name: s.tool,
              callId: s.callId,
              input: object(s.input, `${field} ${index + 1} input`),
            },
      usage: {
        inputTokens: integer(
          s.inputTokens,
          `${field} ${index + 1} inputTokens`,
        ),
        outputTokens: integer(
          s.outputTokens,
          `${field} ${index + 1} outputTokens`,
        ),
      },
    }));
  const wanted = {
    success: "succeeded",
    restart: "succeeded",
    rejection: "rejected",
    missing_input: "input_invalid",
    failure: "failed",
    unknown: "unknown",
  } as const;
  const suite = {
    ...(d.comparisonMode === "configured_only"
      ? { comparisonMode: d.comparisonMode }
      : { genericModelId: d.genericModelId }),
    cases: d.cases.map((c, index) => ({
      id: c.id,
      scenario: c.scenario,
      input: object(c.input, `Case ${index + 1} input`),
      actions: c.actions.map((a, actionIndex) => ({
        serviceId: a.serviceId,
        actionId: a.actionId,
        input: object(
          a.input,
          `Case ${index + 1} action ${actionIndex + 1} input`,
        ),
        ...(a.output
          ? {
              output: object(
                a.output,
                `Case ${index + 1} action ${actionIndex + 1} output`,
              ),
            }
          : {}),
        decision: a.decision,
        outcome: a.outcome,
      })),
      models: {
        configured: models(c.configured, `Case ${index + 1} configured model`),
        generic: models(c.generic, `Case ${index + 1} generic model`),
      },
      ...(c.questions !== undefined ? { questions: c.questions } : {}),
      expected: {
        outcome: wanted[c.scenario],
        ...(c.output
          ? { output: object(c.output, `Case ${index + 1} expected output`) }
          : {}),
        ...(!["success", "restart"].includes(c.scenario)
          ? {
              codes: {
                configured: c.configuredCode,
                ...(d.comparisonMode !== "configured_only"
                  ? { generic: c.genericCode }
                  : {}),
              },
            }
          : {}),
        receipts: c.receipts.map((r, receiptIndex) => ({
          serviceId: r.serviceId,
          actionId: r.actionId,
          serviceRevision: integer(
            r.serviceRevision,
            `Case ${index + 1} receipt ${receiptIndex + 1} serviceRevision`,
          ),
          actionRevision: integer(
            r.actionRevision,
            `Case ${index + 1} receipt ${receiptIndex + 1} actionRevision`,
          ),
          input: object(
            r.input,
            `Case ${index + 1} receipt ${receiptIndex + 1} input`,
          ),
          ...(r.output
            ? {
                output: object(
                  r.output,
                  `Case ${index + 1} receipt ${receiptIndex + 1} output`,
                ),
              }
            : {}),
          effect: r.effect,
          status: r.status,
          ...(r.code ? { code: r.code } : {}),
          dispatches: integer(
            r.dispatches,
            `Case ${index + 1} receipt ${receiptIndex + 1} dispatches`,
          ),
        })),
      },
      ...(c.reopenAt ? { reopenAt: c.reopenAt } : {}),
    })),
  };
  TestJsonSchema.parse(suite);
  return NativeTestSuiteSchema.parse(suite);
}
/** Original private scripts/oracles are copied only following an explicit human action. */
export function suiteToDraft(raw: NativeTestSuite): string {
  const suite = NativeTestSuiteSchema.parse(raw),
    json = (v: unknown) => (v === undefined ? "" : JSON.stringify(v, null, 2));
  const model = (
    s: NativeTestSuite["cases"][number]["models"]["generic"][number],
  ): ModelDraft => ({
    modelId: s.modelId,
    requiredTools: JSON.stringify(s.requiredTools, null, 2),
    replyType: s.reply.type,
    replyText: s.reply.type === "text" ? s.reply.text : "",
    tool: s.reply.type === "tool" ? s.reply.name : "",
    callId: s.reply.type === "tool" ? s.reply.callId : "",
    input: s.reply.type === "tool" ? json(s.reply.input) : "{}",
    inputTokens: String(s.usage.inputTokens),
    outputTokens: String(s.usage.outputTokens),
  });
  return JSON.stringify(
    SuiteDraftSchema.parse({
      genericModelId: suite.genericModelId ?? "",
      ...(suite.comparisonMode ? { comparisonMode: suite.comparisonMode } : {}),
      cases: suite.cases.map((c) => ({
        id: c.id,
        scenario: c.scenario,
        input: json(c.input),
        output: json(c.expected.output),
        configuredCode: c.expected.codes?.configured ?? "",
        genericCode: c.expected.codes?.generic ?? "",
        reopenAt: c.reopenAt ?? "",
        actions: c.actions.map((a) => ({
          ...a,
          input: json(a.input),
          output: json(a.output),
        })),
        receipts: c.expected.receipts.map((r) => ({
          ...r,
          input: json(r.input),
          output: json(r.output),
          serviceRevision: String(r.serviceRevision),
          actionRevision: String(r.actionRevision),
          code: r.code ?? "",
          dispatches: String(r.dispatches),
        })),
        configured: c.models.configured.map(model),
        generic: c.models.generic.map(model),
        ...(c.questions !== undefined ? { questions: c.questions } : {}),
      })),
    }),
  );
}
