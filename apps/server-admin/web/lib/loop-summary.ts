import type { LoopEdge, LoopNode } from "../../../../packages/protocol/loops";

export type LoopViewMode = "summary" | "all";
export type LoopSummaryEdge = LoopEdge & { hiddenStepCount?: number };
const technicalLabels = new Set([
  "Tool",
  "Model",
  "Tool requests",
  "Operation",
  "Service",
  "Action",
  "Effect",
  "Receipt status",
]);

export function loopPresentationStatus(node: LoopNode): LoopNode["status"] {
  const status = node.action?.status;
  const toolStatuses = {
    pending: "running",
    completed: "succeeded",
    waiting: "waiting",
    failed: "failed",
    invalid_arguments: "failed",
    unavailable: "failed",
    skipped: "cancelled",
    cancelled: "cancelled",
    unknown: "unknown",
  } as const;
  return status === "awaiting_approval"
    ? "waiting"
    : status === "rejected"
      ? "cancelled"
      : (status ??
        (node.status === "interrupted" && node.tool?.outcome === "cancelled"
          ? "interrupted"
          : node.tool
            ? toolStatuses[node.tool.outcome]
            : node.status));
}

export function loopDetailSections(node: LoopNode) {
  return {
    content: node.details.filter(
      (detail) =>
        !technicalLabels.has(detail.label) &&
        !(
          node.kind === "decision" &&
          ["Question", "Confidence"].includes(detail.label)
        ),
    ),
    technical: node.details.filter(
      (detail) =>
        technicalLabels.has(detail.label) ||
        (node.kind === "decision" &&
          ["Question", "Confidence"].includes(detail.label)),
    ),
  };
}

/** Combines only exact recorded call/results. Every other recorded step remains visible. */
export function projectLoop(
  nodes: LoopNode[],
  edges: LoopEdge[],
  mode: LoopViewMode,
) {
  if (mode === "all")
    return { nodes, edges: edges as LoopSummaryEdge[], hiddenCount: 0 };
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const owner = new Map<string, string>();
  // The server's result edge binds a result to its exact call, including failures.
  for (const edge of edges) {
    if (edge.kind !== "result") continue;
    const source = byId.get(edge.source),
      target = byId.get(edge.target);
    if (
      source?.kind === "tool" &&
      target?.kind === "result" &&
      (!source.action ||
        !target.action ||
        (source.action.operationId === target.action.operationId &&
          source.action.phase === target.action.phase))
    )
      owner.set(target.id, source.id);
  }
  const merged = new Map<string, LoopNode>();
  for (const node of nodes) {
    const targetId = owner.get(node.id);
    if (!targetId) {
      merged.set(node.id, { ...node, details: [...node.details] });
      continue;
    }
    const target = merged.get(targetId) ?? byId.get(targetId);
    if (!target) continue;
    const details = new Map(
      target.details.map((detail) => [detail.label, detail]),
    );
    for (const detail of node.details) details.set(detail.label, detail);
    merged.set(targetId, {
      ...target,
      status: node.status,
      finishedAt: node.finishedAt ?? target.finishedAt,
      details: [...details.values()],
      ...(node.action ? { action: node.action } : {}),
      ...(node.tool ? { tool: node.tool } : {}),
    });
  }
  const visible = nodes
    .filter((node) => !owner.has(node.id))
    .map((node) => {
      const result = merged.get(node.id)!;
      return { ...result, status: loopPresentationStatus(result) };
    });
  const visibleIds = new Set(visible.map((node) => node.id));
  const order = new Map(visible.map((node, index) => [node.id, index]));
  const canonical = (id: string) => owner.get(id) ?? id;
  const outgoing = new Map<string, LoopEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
    const source = canonical(edge.source),
      target = canonical(edge.target);
    if (source === target) continue;
    const value = { ...edge, source, target };
    outgoing.set(source, [...(outgoing.get(source) ?? []), value]);
  }
  const contracted = new Map<string, LoopSummaryEdge>();
  let edgeNumber = 0;
  for (const node of visible) {
    const pending = (outgoing.get(node.id) ?? []).map((edge) => ({
      edge,
      hidden: 0,
    }));
    const seen = new Set<string>();
    while (pending.length) {
      const { edge, hidden } = pending.shift()!;
      if (edge.target === node.id) continue;
      if (visibleIds.has(edge.target)) {
        // Folding an interleaved result back into its call must not invent a loop.
        if (
          edge.kind !== "retry" &&
          order.get(edge.target)! <= order.get(node.id)!
        )
          continue;
        const key = `${node.id}:${edge.target}:${edge.kind === "retry" ? "retry" : "flow"}`;
        const prior = contracted.get(key);
        if (!prior || (prior.hiddenStepCount ?? 0) > hidden)
          contracted.set(key, {
            id: `summary-${++edgeNumber}`,
            source: node.id,
            target: edge.target,
            kind: edge.kind === "retry" ? "retry" : hidden ? "flow" : edge.kind,
            ...(hidden ? { hiddenStepCount: hidden } : {}),
          });
        continue;
      }
      const visit = `${edge.target}:${edge.kind === "retry"}`;
      if (seen.has(visit)) continue;
      seen.add(visit);
      for (const next of outgoing.get(edge.target) ?? [])
        pending.push({
          edge: {
            ...next,
            kind:
              edge.kind === "retry" || next.kind === "retry"
                ? "retry"
                : next.kind,
          },
          hidden: hidden + 1,
        });
    }
  }
  return {
    nodes: visible,
    edges: [...contracted.values()],
    hiddenCount: nodes.length - visible.length,
  };
}
