import { z } from "zod";
import { LoopNodeSchema, LoopStatus } from "../../packages/protocol/loops";
import { finishLoopToolDetails } from "./loop-tool-details";

/** Operational metadata and allowlisted previews; never reasoning, prompts or raw tool bodies. */
export const LoopTraceSchema = z.strictObject({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: LoopStatus,
  steps: z
    .array(LoopNodeSchema.extend({ callId: z.string().optional() }))
    .max(120),
  truncated: z.boolean(),
});
export type LoopTrace = z.infer<typeof LoopTraceSchema>;
type Traced = { trace?: LoopTrace };
export function newLoopTrace(): LoopTrace {
  return {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: "running",
    steps: [],
    truncated: false,
  };
}
export function startLoopStep(
  turn: Traced,
  kind: "model" | "decision" | "tool" | "result",
  label: string,
  details: { label: string; value: string }[] = [],
  callId?: string,
) {
  const trace = turn.trace;
  if (!trace) return undefined;
  if (trace.steps.length >= 120) {
    trace.truncated = true;
    return undefined;
  }
  const step: LoopTrace["steps"][number] = {
    id: `step-${trace.steps.length + 1}`,
    kind,
    label: label.slice(0, 160),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: null,
    details: details.slice(0, 10).map((item) => ({
      label: item.label.slice(0, 80),
      value: item.value.slice(0, 2000),
    })),
    ...(callId ? { callId } : {}),
  };
  trace.steps.push(step);
  return step;
}
export function finishLoopStep(
  step: LoopTrace["steps"][number] | undefined,
  status: z.infer<typeof LoopStatus>,
  details: { label: string; value: string }[] = [],
) {
  if (!step) return;
  step.status = status;
  step.finishedAt = new Date().toISOString();
  if (step.tool?.outcome === "pending")
    step.tool = finishLoopToolDetails(step.tool, { status });
  step.details.push(
    ...details.slice(0, 12 - step.details.length).map((item) => ({
      label: item.label.slice(0, 80),
      value: item.value.slice(0, 2000),
    })),
  );
}
export function finishLoopTrace(
  turn: Traced,
  status: z.infer<typeof LoopStatus>,
) {
  if (!turn.trace) return;
  turn.trace.status = status;
  turn.trace.finishedAt = new Date().toISOString();
  for (const step of turn.trace.steps)
    if (step.status === "running")
      finishLoopStep(
        step,
        status === "succeeded" || status === "waiting" ? "interrupted" : status,
      );
}
/** Interpret only known envelope fields; never copy arbitrary provider error text. */
export function toolOutcome(value: unknown): z.infer<typeof LoopStatus> {
  if (!value || typeof value !== "object") return "succeeded";
  const result = value as Record<string, unknown>;
  if (result.skipped || result.status === "rejected") return "cancelled";
  if (
    result.status === "awaiting_approval" ||
    result.status === "needs_input" ||
    result.asked
  )
    return "waiting";
  if (result.status === "unknown") return "unknown";
  if (result.error || result.status === "failed") return "failed";
  return "succeeded";
}
