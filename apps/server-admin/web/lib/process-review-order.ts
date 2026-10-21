import type { ProcessStep } from "../../../../packages/protocol/service-processes";
import type { Workflow } from "./process-editor";

/** Present prerequisites before consumers, including both paths of a branch. */
export function processReviewOrder(workflow: Workflow): ProcessStep[] {
  const nodes = new Map(workflow.steps.map((step) => [step.id, step]));
  if (nodes.size !== workflow.steps.length) return workflow.steps;
  const incoming = new Map(workflow.steps.map((step) => [step.id, 0]));
  const targets = (step: ProcessStep) =>
    step.type === "branch"
      ? [step.whenTrue, step.whenFalse]
      : step.type === "return"
        ? []
        : [step.next];
  for (const step of workflow.steps)
    for (const target of targets(step))
      if (incoming.has(target)) incoming.set(target, incoming.get(target)! + 1);
  const pending = workflow.steps
    .filter((step) => incoming.get(step.id) === 0)
    .sort(
      (a, b) =>
        Number(b.id === workflow.entry) - Number(a.id === workflow.entry),
    )
    .map((step) => step.id);
  const ordered: ProcessStep[] = [];
  while (pending.length) {
    const step = nodes.get(pending.shift()!)!;
    ordered.push(step);
    for (const target of targets(step)) {
      if (!incoming.has(target)) continue;
      incoming.set(target, incoming.get(target)! - 1);
      if (incoming.get(target) === 0) pending.push(target);
    }
  }
  // An invalid graph still shows every step so the review cannot hide a problem.
  const shown = new Set(ordered.map((step) => step.id));
  return [...ordered, ...workflow.steps.filter((step) => !shown.has(step.id))];
}
