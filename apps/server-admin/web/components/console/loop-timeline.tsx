import { useMemo, useState, type ReactNode } from "react";
import {
  BrainCircuit,
  ChevronDown,
  CircleHelp,
  MessageSquare,
  Plug,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  Wrench,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@admin/components/ui/collapsible";
import { Badge } from "@admin/components/ui/badge";
import { StatusBadge, type Tone } from "@admin/components/console/status";
import type {
  LoopEdge,
  LoopNode,
} from "../../../../../packages/protocol/loops";
import type { LoopsCopy } from "../../loops-copy";
import { loopStepContent } from "@admin/lib/loop-card";
import { loopNodeDuration, loopNodeRole } from "@admin/lib/loop-presentation";
import { loopPresentationStatus } from "@admin/lib/loop-summary";

const roleIcons = {
  conversation: MessageSquare,
  model: BrainCircuit,
  decision: ShieldCheck,
  processStep: ShieldCheck,
  internalTool: Wrench,
  serviceAction: Plug,
};

function tone(status: LoopNode["status"]): Tone {
  return status === "failed"
    ? "danger"
    : status === "running"
      ? "info"
      : status === "succeeded"
        ? "success"
        : status === "waiting" || status === "unknown"
          ? "warning"
          : "neutral";
}

/**
 * Recorded steps read top to bottom in their recorded order. Each step shows
 * what happened and why it matters; its full evidence opens in place.
 */
export function LoopTimeline({
  nodes,
  edges,
  copy,
  renderDetails,
}: {
  nodes: LoopNode[];
  edges: LoopEdge[];
  copy: LoopsCopy;
  renderDetails: (node: LoopNode) => ReactNode;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const retried = useMemo(
    () =>
      new Set(
        edges.filter((edge) => edge.kind === "retry").map((e) => e.target),
      ),
    [edges],
  );
  return (
    <ol aria-label={copy.graph} className="flex flex-col">
      {nodes.map((node, index) => {
        const role = loopNodeRole(node);
        const status = loopPresentationStatus(node);
        const step = loopStepContent(node, copy);
        const duration = loopNodeDuration(node);
        const Icon =
          node.kind === "question"
            ? CircleHelp
            : node.kind === "error" || status === "failed"
              ? TriangleAlert
              : roleIcons[role];
        const expanded = open === node.id;
        // A "Waiting for input" step should not repeat its title as a badge.
        const showStatus = status !== "succeeded" && step.status !== step.title;
        return (
          <li
            key={node.id}
            className="relative flex gap-2 pb-1 last:pb-0"
            data-loop-step
            data-role={role}
            data-status={status}
          >
            {index < nodes.length - 1 && (
              <span aria-hidden="true" data-loop-step-line />
            )}
            <span aria-hidden="true" data-loop-step-icon>
              <Icon />
            </span>
            <Collapsible
              open={expanded}
              onOpenChange={(value) => setOpen(value ? node.id : null)}
              className="min-w-0 flex-1"
            >
              <CollapsibleTrigger asChild>
                <button type="button" data-loop-step-summary>
                  <span className="sr-only">
                    {copy.step} {index + 1}:{" "}
                  </span>
                  <span className="flex items-start justify-between gap-3">
                    <span
                      className={
                        step.message
                          ? "line-clamp-3 min-w-0 whitespace-pre-wrap"
                          : "min-w-0 truncate font-medium"
                      }
                    >
                      {step.title}
                    </span>
                    <span className="flex h-5 shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
                      {duration}
                      <ChevronDown aria-hidden="true" data-loop-step-chevron />
                    </span>
                  </span>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5 text-xs">
                    <span className="text-muted-foreground">{step.kind}</span>
                    {step.meta && <span className="truncate">{step.meta}</span>}
                    {step.facts.map((fact) => (
                      <span key={fact.label} className="flex min-w-0 gap-1.5">
                        <span className="shrink-0 text-muted-foreground">
                          {fact.label}
                        </span>
                        <span className="truncate">{fact.value}</span>
                      </span>
                    ))}
                  </span>
                  {(showStatus || retried.has(node.id)) && (
                    <span className="flex flex-wrap items-center gap-2 pt-1">
                      {showStatus && (
                        <StatusBadge tone={tone(status)}>
                          {step.status}
                        </StatusBadge>
                      )}
                      {retried.has(node.id) && (
                        <Badge variant="outline">
                          <RotateCcw data-icon="inline-start" />
                          {copy.retry}
                        </Badge>
                      )}
                      {step.note && (
                        <span className="text-xs text-muted-foreground">
                          {step.note}
                        </span>
                      )}
                    </span>
                  )}
                </button>
              </CollapsibleTrigger>
              <CollapsibleContent data-loop-step-content>
                <div data-loop-step-details className="flex flex-col gap-6">
                  {renderDetails(node)}
                </div>
              </CollapsibleContent>
            </Collapsible>
          </li>
        );
      })}
    </ol>
  );
}
