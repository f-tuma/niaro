import { ZodError } from "zod";
import {
  ProcessApprovalSchema,
  type ProcessWork,
} from "../../packages/protocol/process-work";
import type { ProcessVersion } from "../../packages/protocol/service-processes";
import type { Scope, Language } from "../../packages/protocol";
import { processAgentNodes } from "../server-agent/process-agent-tools";
import type { CatalogController } from "./catalog-controller";
import type { Journal } from "./service-process-journal";
import type { StoredInvocation } from "./service-catalog";
import { processDigest } from "./process-validation";
import { presentServiceAnswer } from "./service-answer";

/** Held, passive review of the original receipt. Callers prove current read authority first. */
export function projectProcessApproval(
  controller: CatalogController,
  scope: Scope,
  organizationId: string,
  parentRunId: string,
  journal: Journal,
  artifact: ProcessVersion,
  receipts: StoredInvocation[],
  language: Language,
  policyRevision: number,
): Pick<ProcessWork, "approval" | "approvalUnavailable"> {
  const pending = journal.pending;
  if (journal.status !== "waiting" || !pending || "kind" in pending) return {};
  const awaiting = receipts.filter(
    (receipt) => receipt.status === "awaiting_approval",
  );
  const receipt = awaiting[0];
  const call = journal.receipts.find(
    (value) => value.operationId === pending.operationId,
  );
  const action =
    artifact.definition.kind === "workflow"
      ? artifact.definition.steps.find(
          (node) => node.id === pending.nodeId && node.type === "action",
        )
      : undefined;
  const agent = processAgentNodes(artifact.definition).find(
    (node) => node.id === pending.nodeId,
  );
  const child = journal.agents[pending.nodeId];
  const belongsToNode =
    action?.type === "action"
      ? call?.callId === action.id &&
        action.serviceId === receipt?.serviceId &&
        action.actionId === receipt?.actionId
      : agent &&
        child?.pending?.kind === "approval" &&
        child.pending.operationId === pending.operationId &&
        child.pending.toolCallId === call?.callId &&
        agent.capabilities.some(
          (capability) =>
            capability.serviceId === receipt?.serviceId &&
            capability.actionId === receipt?.actionId,
        );
  if (
    !receipt ||
    awaiting.length !== 1 ||
    receipt.id !== pending.operationId ||
    receipt.organizationId !== organizationId ||
    receipt.workspaceId !== scope.workspaceId ||
    receipt.userId !== scope.userId ||
    receipt.policyRevision !== policyRevision ||
    receipts.some((value) => value.status === "unknown") ||
    !journal.operations.includes(receipt.id) ||
    !call ||
    !belongsToNode ||
    receipt.id !== processDigest([parentRunId, "action", call.callId]) ||
    controller.store.turnForOperation(
      receipt.id,
      scope.workspaceId,
      scope.userId,
    )?.id !== parentRunId
  )
    return { approvalUnavailable: "identity" };
  // Persisted legacy/corrupt receipts cannot turn an incomplete review into a snapshot error.
  if (
    !receipt.input ||
    typeof receipt.input !== "object" ||
    Array.isArray(receipt.input)
  )
    return { approvalUnavailable: "parameters" };
  const inputJson = JSON.stringify(receipt.input);
  if (inputJson.length > 131072) return { approvalUnavailable: "parameters" };
  try {
    const presented = presentServiceAnswer(receipt, language).result!;
    const { card: _card, ...result } = presented;
    const approval = ProcessApprovalSchema.safeParse({
      nodeId: pending.nodeId,
      serviceId: receipt.serviceId,
      serviceRevision: receipt.serviceRevision,
      actionId: receipt.actionId,
      actionRevision: receipt.actionRevision,
      result,
    });
    if (!approval.success || approval.data.result.inputJson !== inputJson)
      return { approvalUnavailable: "parameters" };
    return { approval: approval.data };
  } catch (error) {
    if (!(error instanceof ZodError)) throw error;
    return { approvalUnavailable: "parameters" };
  }
}
