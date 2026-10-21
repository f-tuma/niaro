import type { LoopNode } from "../../../../packages/protocol/loops";
import { loopPresentationStatus } from "./loop-summary";

export type LoopRole =
  | "conversation"
  | "model"
  | "decision"
  | "processStep"
  | "internalTool"
  | "serviceAction";
export function loopNodeRole(node: LoopNode): LoopRole {
  if (node.action) return "serviceAction";
  if (
    node.details.some((detail) => detail.label === "Process version") &&
    node.details.some((detail) => detail.label === "Step")
  )
    return "processStep";
  if (node.kind === "model" || node.kind === "decision") return node.kind;
  return node.kind === "tool" || node.kind === "result"
    ? "internalTool"
    : "conversation";
}
export function loopNodeToolName(node: LoopNode) {
  const name =
    node.tool?.name ??
    node.details.find((detail) => detail.label === "Tool")?.value;
  return name === "unknown" ? undefined : name;
}
export function loopNodeDuration(node: LoopNode) {
  if (!node.startedAt || !node.finishedAt) return undefined;
  const ms = Date.parse(node.finishedAt) - Date.parse(node.startedAt);
  return Number.isFinite(ms) && ms >= 0
    ? ms < 1000
      ? `${ms} ms`
      : `${(ms / 1000).toFixed(1)} s`
    : undefined;
}
type Field = { label: string; value: string };
const inputPriority = [
  "Need",
  "Query",
  "Name",
  "Contact",
  "Title",
  "Date",
  "Time",
  "Date kind",
];
const outputPriority = [
  "Returned services",
  "Candidates",
  "Returned actions",
  "Contacts returned",
  "UTC",
  "ISO",
  "Reason",
  "Result",
  "Outcome",
  "Receipt status",
  "Status",
];
function importantField(fields: readonly Field[], priority: readonly string[]) {
  for (const label of priority) {
    const field = fields.find((value) => value.label === label);
    if (field) return field;
  }
  // Envelope flags such as "success: true" restate the status, not the result.
  const leaf = (label: string) => label.split(" · ").at(-1)!.toLowerCase();
  return fields.find(
    (field) =>
      !["Service", "Action", "Tool", "Effect", "Revision"].includes(
        field.label,
      ) &&
      !["success", "iserror", "is error", "ok"].includes(leaf(field.label)),
  );
}
/** Uses only the API's bounded evidence; labels and missing fields are never guessed. */
export function loopNodeEvidence(node: LoopNode) {
  const status = loopPresentationStatus(node);
  const action = node.action;
  const tool = node.tool;
  return {
    identifier:
      loopNodeToolName(node) ??
      (node.kind === "model"
        ? node.details.find((field) => field.label === "Model")?.value
        : undefined),
    input: importantField(
      action?.input ?? (tool?.inputRecorded ? tool.input : []),
      inputPriority,
    ),
    inputTruncated: action?.inputTruncated ?? tool?.inputTruncated ?? false,
    output:
      status === "succeeded" && action?.phase !== "proposal"
        ? importantField(
            action?.output ?? (tool?.outputRecorded ? tool.output : []),
            outputPriority,
          )
        : undefined,
    outputTruncated: action?.outputTruncated ?? tool?.outputTruncated ?? false,
    failure: ["failed", "unknown"].includes(status)
      ? (action?.failure ?? tool?.failure)
      : undefined,
    decision:
      node.kind === "decision"
        ? node.details.find((field) =>
            ["Outcome", "Choice"].includes(field.label),
          )
        : undefined,
  };
}
/** Lanes indicate operational roles. Vertical order remains recorded chronology. */
export function loopRoleLanes(
  nodes: readonly LoopNode[],
  separateServices = false,
) {
  const group = (node: LoopNode) => {
    const role = loopNodeRole(node);
    return role === "conversation"
      ? 0
      : role === "model" || role === "decision" || role === "processStep"
        ? 1
        : role === "serviceAction" && separateServices
          ? 3
          : 2;
  };
  const groups = [...new Set(nodes.map(group))].sort();
  return new Map(nodes.map((node) => [node.id, groups.indexOf(group(node))]));
}
