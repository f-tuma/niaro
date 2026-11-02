import type {
  ProcessDefinition,
  ProcessStep,
  ProcessValidation,
} from "../../../../packages/protocol/service-processes";

/**
 * Validation issues as one sentence each, placed on the step they concern.
 * The server's `{code, path}` stays the only source of truth; this only
 * phrases it. Sentences name the step (as the canvas names it) and the fix.
 */
export type ProcessIssue = {
  code: ProcessValidation["issues"][number]["code"];
  path: string;
  /** The step it concerns, or null for the process as a whole. */
  stepId: string | null;
  sentence: string;
};
type Copy = typeof issueEn;
export type ProcessIssueCopy = Copy;
// NIAR-270: validation issue sentences.
const issueEn = {
  process: "Process",
  bind: "{step}: give “{field}” a value from the process input or an earlier step.",
  bindCondition:
    "{step}: the condition reads a value that isn't there on every path; pick one from the input or an earlier step.",
  bindResult: "{step}: give the result field “{field}” a value.",
  type: "{step}: “{field}” may not have the type it needs; bind a value of the right type.",
  typeAll:
    "{step}: its values may not fit what it needs; check each field it receives.",
  typeCondition:
    "{step}: the compared value may not fit; compare with a value of the same type.",
  action:
    "{step}: its action is off or missing; turn it on in Services or choose another one.",
  denied:
    "{step}: you can't use its action; choose another one or ask an administrator.",
  allowed:
    "{step}: one of its allowed actions is off or not yours to use; remove it or choose another.",
  model: "{step}: its model is unavailable; choose another model.",
  memory: "{step}: saved memory is off in this workspace; choose other memory.",
  graphStep: "{step}: connect its outputs to existing steps, without a loop.",
  graph:
    "Connect every step from the start, with unique names and without loops.",
  stepLimit: "Limits: allow more steps or model calls, or remove steps.",
  limit: "Limits: “{field}” is above what this workspace allows; lower it.",
  invalidStep: "{step}: “{field}” isn't valid; fix it in the step's settings.",
  invalid: "{step}: fix “{field}” in the process settings.",
  unknown: "{step}: fix this problem ({code}).",
  more: "Only the first 20 problems are shown; fix these to see the rest.",
};
const issueCs: Copy = {
  process: "Proces",
  bind: "{step}: doplň „{field}“ hodnotou ze vstupu procesu nebo z dřívějšího kroku.",
  bindCondition:
    "{step}: podmínka čte hodnotu, která není na každé cestě; vyber ji ze vstupu nebo z dřívějšího kroku.",
  bindResult: "{step}: doplň hodnotu pole výsledku „{field}“.",
  type: "{step}: „{field}“ nemusí mít potřebný typ; napoj hodnotu správného typu.",
  typeAll:
    "{step}: jeho hodnoty nemusí odpovídat tomu, co potřebuje; zkontroluj každé pole, které dostává.",
  typeCondition:
    "{step}: porovnávaná hodnota nemusí sedět; porovnej s hodnotou stejného typu.",
  action:
    "{step}: jeho akce je vypnutá nebo chybí; zapni ji ve Službách, nebo vyber jinou.",
  denied:
    "{step}: jeho akci nemůžeš použít; vyber jinou, nebo požádej administrátora.",
  allowed:
    "{step}: jedna z povolených akcí je vypnutá nebo ti nepatří; odeber ji, nebo vyber jinou.",
  model: "{step}: jeho model není dostupný; vyber jiný model.",
  memory:
    "{step}: uložená paměť je v tomto prostoru vypnutá; vyber jinou paměť.",
  graphStep: "{step}: napoj jeho výstupy na existující kroky, bez smyčky.",
  graph: "Napoj každý krok od začátku, s jedinečnými názvy a bez smyček.",
  stepLimit: "Limity: povol víc kroků nebo volání modelu, nebo kroky odeber.",
  limit: "Limity: „{field}“ je nad tím, co tento prostor dovolí; sniž ho.",
  invalidStep: "{step}: „{field}“ není platné; oprav ho v nastavení kroku.",
  invalid: "{step}: oprav „{field}“ v nastavení procesu.",
  unknown: "{step}: oprav tento problém ({code}).",
  more: "Zobrazuje se jen prvních 20 problémů; po jejich opravě uvidíš další.",
};
export const processIssueCopy = (language: "en" | "cs") =>
  language === "cs" ? issueCs : issueEn;

const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{(\w+)\}/g, (_, key: string) => values[key] ?? "");

/** One sentence per issue, in the server's order. */
export function processIssues(
  validation: Pick<ProcessValidation, "issues">,
  definition: ProcessDefinition | null,
  copy: ProcessIssueCopy,
  stepTitle: (step: ProcessStep) => string,
): ProcessIssue[] {
  return validation.issues.map((issue) => {
    const parts = issue.path.split("/").filter(Boolean);
    let step: ProcessStep | undefined;
    let rest = parts;
    if (parts[0] === "steps" && definition?.kind === "workflow" && parts[1]) {
      const key = parts[1];
      step =
        (/^\d+$/.test(key) ? definition.steps[Number(key)] : undefined) ??
        definition.steps.find((s) => s.id === key);
      rest = parts.slice(2);
    }
    const name = step
      ? stepTitle(step)
      : definition?.kind === "agent"
        ? definition.name || copy.process
        : copy.process;
    return {
      code: issue.code,
      path: issue.path,
      stepId: step?.id ?? null,
      sentence: sentence(issue.code, parts, rest, !!step, name, copy),
    };
  });
}

function sentence(
  code: ProcessIssue["code"],
  parts: string[],
  rest: string[],
  onStep: boolean,
  step: string,
  copy: Copy,
) {
  const [area, ...more] = rest;
  // The field a person recognises: the last named key, never an index.
  const field =
    [...rest].reverse().find((part) => !/^\d+$/.test(part)) ?? area ?? "";
  const say = (template: string, value = field) =>
    fill(template, { step, field: value, code });
  if (parts[0] === "limits")
    return ["maxSteps", "maxModelCalls"].includes(parts[1] ?? "") &&
      code === "limit_exceeded"
      ? copy.stepLimit
      : say(copy.limit, parts[1] ?? "");
  if (parts[0] === "memory" || area === "memory") return say(copy.memory);
  if (parts[0] === "steps" && !onStep)
    return code === "graph_invalid" ? copy.graph : say(copy.unknown);
  switch (code) {
    case "binding_invalid":
      if (area === "condition") return say(copy.bindCondition);
      if (area === "output" && more[0]) return say(copy.bindResult, more[0]);
      return say(copy.bind, more[0] ?? field);
    case "binding_type_unproven":
      if (area === "condition") return say(copy.typeCondition);
      return more[0] ? say(copy.type, more[0]) : say(copy.typeAll);
    case "resource_unavailable":
      if (area === "modelId") return say(copy.model);
      if (area === "capabilities") return say(copy.allowed);
      return say(copy.action);
    case "capability_denied":
      return area === "capabilities" ? say(copy.allowed) : say(copy.denied);
    case "graph_invalid":
      return onStep ? say(copy.graphStep) : copy.graph;
    case "definition_invalid":
      return say(onStep ? copy.invalidStep : copy.invalid);
    default:
      return say(copy.unknown);
  }
}

/** The server stops at 20 issues; say so instead of hiding the rest. */
export const processIssuesTruncated = (
  validation: Pick<ProcessValidation, "issues">,
) => validation.issues.length >= 20;
