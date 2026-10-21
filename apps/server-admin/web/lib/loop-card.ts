import type { LoopNode } from "../../../../packages/protocol/loops";
import {
  modelName,
  readableName,
} from "../../../../packages/protocol/display-name";
import {
  loopDecisionChoiceLabel,
  loopDetailLabel,
  loopFailureLabel,
  loopFieldValue,
  loopNodeLabel,
  loopNodeStatusLabel,
  type LoopsCopy,
} from "../loops-copy";
import {
  loopNodeEvidence,
  loopNodeRole,
  loopNodeToolName,
} from "./loop-presentation";

export type LoopStepFact = { label: string; value: string };
export type LoopStepContent = {
  /** Role of the step, such as "Service read" or "Model". */
  kind: string;
  title: string;
  /** Conversation text reads as a quote and may span several lines. */
  message: boolean;
  meta?: string;
  facts: LoopStepFact[];
  /** Why a step did not complete, or what a proposal is waiting for. */
  note?: string;
  status: string;
};

function fieldLabel(label: string, copy: LoopsCopy) {
  // Nested result labels read "value · Returned items"; the leaf names the fact.
  const leaf = label.split(" · ").at(-1) ?? label;
  const translated = loopDetailLabel(leaf, copy);
  return translated === leaf
    ? readableName(leaf.trim().replace(/\s+/g, "_"))
    : translated;
}

function toolTitle(node: LoopNode, copy: LoopsCopy) {
  const label = loopNodeLabel(node, copy);
  return label === node.label
    ? readableName(loopNodeToolName(node) ?? node.label)
    : label;
}

function headline(node: LoopNode, copy: LoopsCopy) {
  const label = loopNodeLabel(node, copy);
  return label !== copy[node.kind]
    ? label
    : (node.details.find((detail) => detail.label === "Message")?.value ??
        label);
}

/**
 * One timeline step: what happened, the one or two facts that explain it, and
 * how it ended. Missing evidence is left out rather than announced; the
 * expanded details still distinguish recorded from absent fields.
 */
export function loopStepContent(
  node: LoopNode,
  copy: LoopsCopy,
): LoopStepContent {
  const role = loopNodeRole(node);
  const evidence = loopNodeEvidence(node);
  const detail = (label: string) =>
    node.details.find((field) => field.label === label)?.value;
  const fact = (
    field: { label: string; value: string } | undefined,
    truncated = false,
  ) =>
    field?.value.trim()
      ? {
          label: fieldLabel(field.label, copy),
          value: `${loopFieldValue(field.label, field.value, copy)}${truncated ? "…" : ""}`,
        }
      : undefined;

  let kind: string = role === "conversation" ? copy[node.kind] : copy[role];
  let title: string;
  let meta: string | undefined;
  let message = false;
  const facts: (LoopStepFact | undefined)[] = [];
  if (node.action) {
    kind =
      node.action.effect === "write" ? copy.serviceWrite : copy.serviceRead;
    title = readableName(node.action.actionName);
    meta = node.action.serviceName;
    facts.push(fact(evidence.input, evidence.inputTruncated));
    facts.push(fact(evidence.output, evidence.outputTruncated));
  } else if (node.kind === "decision") {
    const choice = detail("Choice") ?? detail("Outcome");
    title = choice
      ? (loopDecisionChoiceLabel(choice, copy, detail("Selected criterion")) ??
        readableName(choice))
      : copy.decision;
    const confidence = Number(detail("Confidence"));
    if (Number.isFinite(confidence) && detail("Confidence")?.trim())
      facts.push({
        label: copy.confidence,
        value: `${Math.round(confidence <= 1 ? confidence * 100 : confidence)} %`,
      });
  } else if (role === "model") {
    title = copy.agentTurn;
    const model = detail("Model");
    if (model) meta = modelName(model);
    const requests = detail("Tool requests");
    if (requests) facts.push(fact({ label: "Tool requests", value: requests }));
  } else if (node.kind === "tool" || node.kind === "result") {
    title = toolTitle(node, copy);
    facts.push(fact(evidence.input, evidence.inputTruncated));
    facts.push(fact(evidence.output, evidence.outputTruncated));
  } else {
    title = headline(node, copy);
    message = title === detail("Message");
  }

  return {
    kind,
    title,
    message,
    ...(meta?.trim() ? { meta } : {}),
    facts: facts.filter((value): value is LoopStepFact => !!value).slice(0, 2),
    // "Input rejected before execution" already says the input was rejected.
    ...(evidence.failure &&
    !(
      evidence.failure.kind === "validation" &&
      node.tool?.outcome === "invalid_arguments"
    )
      ? { note: loopFailureLabel(evidence.failure.kind, copy) }
      : node.action?.phase === "proposal"
        ? { note: copy.proposalOutcome }
        : {}),
    status: loopNodeStatusLabel(node, copy),
  };
}
