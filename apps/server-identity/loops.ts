import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { z } from "zod";
import {
  LOOPS_PROFILE,
  LoopDetailSchema,
  LoopPageSchema,
  LoopQuery,
  type LoopSummary,
  type LoopNode,
  type LoopEdge,
  type LoopStatus,
} from "../../packages/protocol/loops";
import { LoopTraceSchema, finishLoopTrace, toolOutcome } from "./loop-trace";
import type { ServiceCatalogStore, StoredInvocation } from "./service-catalog";
import {
  ProcessProvenanceSchema,
  type ProcessProvenance,
} from "../../packages/protocol/process-work";

import { loopText } from "./loop-redaction";
import { loopActionDetails } from "./loop-action-details";
import {
  startLoopToolDetails,
  finishLoopToolDetails,
  sanitizeLoopToolDetails,
} from "./loop-tool-details";
export { loopText } from "./loop-redaction";

type Row = Record<string, SQLOutputValue>;
const supportedKindsSQL =
  "(json_extract(t.data,'$.kind') IN ('agent-1','mastra-1','service-process-1') AND (json_extract(t.data,'$.kind')!='mastra-1' OR json_type(t.data,'$.runId') IS NULL OR json_extract(t.data,'$.runId')=t.id))";
const statusSQL = `CASE WHEN json_type(t.data,'$.trace.status')='text' THEN json_extract(t.data,'$.trace.status') WHEN json_type(t.data,'$.pending')='text' OR json_extract(t.data,'$.paused')=1 THEN 'waiting' WHEN json_type(t.data,'$.answer')='object' THEN 'succeeded' WHEN json_extract(t.data,'$.kind')='mastra-1' THEN 'unknown' ELSE 'interrupted' END`;
const count = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
const date = (value: unknown) =>
  z.iso.datetime().safeParse(value).success
    ? (value as string)
    : "1970-01-01T00:00:00.000Z";
function summary(row: Row): LoopSummary {
  return {
    id: String(row.id),
    workspaceId: String(row.workspace_id),
    workspaceName:
      row.workspace_name === null ? null : loopText(row.workspace_name, 100),
    actorId: String(row.user_id),
    actorName: row.actor_name === null ? null : loopText(row.actor_name, 100),
    request: loopText(row.request, 8000),
    reply: typeof row.reply === "string" ? loopText(row.reply) : null,
    startedAt: date(row.started_at),
    finishedAt:
      typeof row.finished_at === "string" ? date(row.finished_at) : null,
    status: row.status as LoopStatus,
    modelCalls: count(row.model_calls),
    toolCalls: count(row.tool_calls),
    inferenceCalls: count(row.inference_calls),
    traceMode: row.trace_mode === "recorded" ? "recorded" : "reconstructed",
  };
}
const projection = `t.rowid AS cursor,t.id,t.workspace_id,t.user_id,w.name AS workspace_name,u.name AS actor_name,
 json_extract(t.data,'$.kind') AS kind,json_extract(t.data,'$.runId') AS process_run_id,
 json_extract(t.data,'$.processId') AS process_id,json_extract(t.data,'$.version') AS process_version,
 json_extract(t.data,'$.artifactDigest') AS artifact_digest,
 CASE WHEN json_type(t.data,'$.goal')='text' AND json_extract(t.data,'$.goal')!='' THEN substr(json_extract(t.data,'$.goal'),1,8000) ELSE substr(json_extract(t.data,'$.text'),1,8000) END AS request,
 substr(json_extract(t.data,'$.answer.reply'),1,8000) AS reply,
 COALESCE(json_extract(t.data,'$.trace.startedAt'),json_extract(t.data,'$.clock.referenceNow')) AS started_at,
 json_extract(t.data,'$.trace.finishedAt') AS finished_at,${statusSQL} AS status,
 CASE WHEN json_extract(t.data,'$.kind')='service-process-1' THEN json_extract(t.data,'$.inference') ELSE json_extract(t.data,'$.modelCalls') END AS model_calls,
 CASE WHEN json_type(t.data,'$.trace')='object' THEN (SELECT COUNT(*) FROM json_each(t.data,'$.trace.steps') s WHERE json_extract(s.value,'$.kind')='tool') WHEN json_extract(t.data,'$.kind')='agent-1' THEN (SELECT COUNT(*) FROM json_each(t.data,'$.transcript') m JOIN json_each(m.value,'$.tool_calls') c WHERE json_extract(m.value,'$.role')='assistant') ELSE 0 END AS tool_calls,
 json_extract(t.data,'$.inference') AS inference_calls,
 CASE WHEN json_type(t.data,'$.trace')='object' THEN 'recorded' ELSE 'reconstructed' END AS trace_mode,
 CASE WHEN json_extract(t.data,'$.kind')='mastra-1' AND json_type(t.data,'$.answer') IS NULL AND json_extract(t.data,'$.terminalCandidate') IN ('budget','protocol','provider','execution','catalog_budget_exhausted','catalog_budget_overrun','catalog_budget_usage_unknown','catalog_budget_policy_changed','catalog_budget_price_required','catalog_budget_request_too_large','catalog_provider_limit') THEN 1 ELSE 0 END AS failure_candidate`;

/** Read only org-scoped persisted turns; startup recovery changes diagnostic metadata only. */
export class LoopsStore {
  private readonly nativeRunsUnverifiedAtStartup = new Set<string>();

  constructor(
    private db: DatabaseSync,
    private catalog: ServiceCatalogStore,
  ) {
    // Legacy loop workers cannot survive a server restart as active owners.
    // Native Mastra retirement needs framework-owned proof, so a diagnostic
    // read must leave its persisted running trace untouched.
    for (const row of db
      .prepare(
        `SELECT t.id FROM agent_service_turn t WHERE json_valid(t.data) AND ${supportedKindsSQL} AND json_extract(t.data,'$.kind')='mastra-1' AND (${statusSQL}) IN ('running','unknown')`,
      )
      .all()) {
      this.nativeRunsUnverifiedAtStartup.add(String(row.id));
    }
    for (const row of db
      .prepare(
        `SELECT id,data FROM agent_service_turn t WHERE json_valid(t.data) AND ${supportedKindsSQL} AND json_extract(t.data,'$.kind')!='mastra-1' AND json_extract(t.data,'$.trace.status')='running'`,
      )
      .all()) {
      const turn = JSON.parse(String(row.data));
      const trace = LoopTraceSchema.safeParse(turn.trace);
      if (!trace.success) continue;
      turn.trace = trace.data;
      finishLoopTrace(turn, "interrupted");
      db.prepare("UPDATE agent_service_turn SET data=? WHERE id=?").run(
        JSON.stringify(turn),
        String(row.id),
      );
    }
  }
  private summary(row: Row): LoopSummary {
    let value = summary(row);
    if (
      row.kind === "mastra-1" &&
      (value.status === "running" || value.status === "unknown") &&
      this.nativeRunsUnverifiedAtStartup.has(value.id)
    )
      value = { ...value, statusEvidence: "last_saved_unverified" };
    if (row.failure_candidate === 1)
      value = { ...value, unconfirmedFailure: true };
    if (row.kind !== "service-process-1") return value;
    let provenance: Partial<ProcessProvenance> = {
      runId: String(row.process_run_id),
      processId: String(row.process_id),
      version: Number(row.process_version),
      artifactDigest: String(row.artifact_digest),
      actorId: String(row.user_id),
    };
    // Historical diagnostics stay readable even when they predate today's journal schema.
    // Provenance is shown only when the immutable private pin corroborates it.
    if (
      !this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_service_process_run'",
        )
        .get()
    )
      return value;
    const pin = this.db
      .prepare(
        "SELECT r.process_id,r.version,v.digest FROM agent_service_process_run r JOIN agent_service_process_version v ON v.process_id=r.process_id AND v.version=r.version WHERE r.run_id=? AND r.workspace_id=? AND r.user_id=?",
      )
      .get(String(row.id), String(row.workspace_id), String(row.user_id));
    if (
      !pin ||
      pin.process_id !== row.process_id ||
      pin.version !== row.process_version ||
      pin.digest !== row.artifact_digest
    )
      return value;
    if (
      this.db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_process_start_command'",
        )
        .get()
    ) {
      const admitted = this.db
        .prepare("SELECT data FROM agent_process_start_command WHERE run_id=?")
        .get(String(row.id));
      if (admitted) {
        const data = JSON.parse(String(admitted.data));
        const receipt = data.receipt;
        if (
          receipt?.status === "admitted" &&
          receipt.parentRunId === row.id &&
          receipt.runId === row.process_run_id &&
          receipt.processId === row.process_id &&
          receipt.version === row.process_version &&
          receipt.artifactDigest === row.artifact_digest &&
          data.scope?.userId === row.user_id &&
          data.scope?.workspaceId === row.workspace_id
        ) {
          provenance = {
            ...provenance,
            commandId: receipt.commandId,
            admissionId: receipt.receiptId,
            conversationId: receipt.origin?.conversationId,
          };
        }
      }
    }
    const parsed = ProcessProvenanceSchema.safeParse(provenance);
    return parsed.success ? { ...value, process: parsed.data } : value;
  }
  page(raw: z.infer<typeof LoopQuery>) {
    const query = LoopQuery.parse(raw);
    const where = [
      "w.organization_id=?",
      "json_valid(t.data)",
      supportedKindsSQL,
    ];
    const args: (string | number)[] = [query.organizationId];
    if (query.workspaceId) {
      where.push("t.workspace_id=?");
      args.push(query.workspaceId);
    }
    if (query.status) {
      where.push(`${statusSQL}=?`);
      args.push(query.status);
    }
    if (query.before) {
      where.push("t.rowid<?");
      args.push(Number(query.before));
    }
    const rows = this.db
      .prepare(
        `SELECT ${projection} FROM agent_service_turn t JOIN agent_workspace w ON w.id=t.workspace_id LEFT JOIN user u ON u.id=t.user_id WHERE ${where.join(" AND ")} ORDER BY t.rowid DESC LIMIT 51`,
      )
      .all(...args);
    return LoopPageSchema.parse({
      profile: LOOPS_PROFILE,
      organizationId: query.organizationId,
      entries: rows.slice(0, 50).map((row) => this.summary(row)),
      nextBefore: rows.length > 50 ? String(rows[49]!.cursor) : null,
    });
  }
  detail(organizationId: string, id: string) {
    const row = this.db
      .prepare(
        `SELECT ${projection},t.data FROM agent_service_turn t JOIN agent_workspace w ON w.id=t.workspace_id LEFT JOIN user u ON u.id=t.user_id WHERE w.organization_id=? AND t.id=? AND json_valid(t.data) AND ${supportedKindsSQL}`,
      )
      .get(organizationId, id);
    if (!row) return null;
    const run = this.summary(row);
    const turn = JSON.parse(String(row.data));
    const trace = LoopTraceSchema.safeParse(turn.trace);
    if (!trace.success) run.traceMode = "reconstructed";
    const nodes: LoopNode[] = [];
    const edges: LoopEdge[] = [];
    let truncated = trace.success && trace.data.truncated;
    const add = (
      node: LoopNode,
      source?: string,
      edgeKind: LoopEdge["kind"] = "flow",
    ) => {
      if (nodes.length >= 160) {
        truncated = true;
        return;
      }
      const previous = source ?? nodes.at(-1)?.id;
      const prior = nodes.at(-1);
      if (
        !source &&
        node.kind === "model" &&
        prior &&
        (prior.status === "failed" ||
          (prior.kind === "decision" &&
            prior.details.some(
              (item) => item.label === "Choice" && item.value === "incomplete",
            )))
      )
        edgeKind = "retry";
      nodes.push({
        ...node,
        ...(node.tool ? { tool: sanitizeLoopToolDetails(node.tool) } : {}),
        label: loopText(node.label, 160),
        details: node.details.slice(0, 12).map((item) => ({
          label: loopText(item.label, 80),
          value: loopText(item.value),
        })),
      });
      if (previous)
        edges.push({
          id: `edge-${edges.length + 1}`,
          source: previous,
          target: node.id,
          kind: edgeKind,
        });
    };
    const receipts = new Map<string, string>();
    for (const receipt of Array.isArray(turn.receipts) ? turn.receipts : [])
      if (
        typeof receipt?.callId === "string" &&
        typeof receipt?.operationId === "string" &&
        turn.operations?.includes(receipt.operationId)
      )
        receipts.set(receipt.callId, receipt.operationId);
    const scopedReceipt = (operationId: string | undefined) => {
      if (
        !operationId ||
        !Array.isArray(turn.operations) ||
        !turn.operations.includes(operationId)
      )
        return undefined;
      const receipt = this.catalog.invocation(
        operationId,
        run.workspaceId,
        run.actorId,
      );
      return receipt &&
        receipt.organizationId === organizationId &&
        receipt.workspaceId === run.workspaceId &&
        receipt.userId === run.actorId &&
        receipt.id === operationId
        ? receipt
        : undefined;
    };
    const resultDetails = (
      receipt: StoredInvocation | undefined,
      node: LoopNode,
    ) => {
      return receipt
        ? [
            { label: "Operation", value: receipt.id },
            { label: "Service", value: receipt.serviceName },
            { label: "Action", value: receipt.title },
            { label: "Effect", value: receipt.effect },
            {
              label: "Receipt status",
              value: loopActionDetails(receipt, node).status,
            },
          ]
        : [];
    };
    add({
      id: "request",
      kind: "request",
      label: "Request",
      status: "succeeded",
      startedAt: run.startedAt,
      finishedAt: run.startedAt,
      details: [{ label: "Message", value: loopText(run.request, 2000) }],
    });
    if (trace.success) {
      const tools = new Map<string, string>();
      for (const step of trace.data.steps) {
        const { callId, action: _storedAction, ...node } = step;
        const operationId = callId
          ? receipts.get(callId)
          : node.details.find((item) => item.label === "Operation")?.value;
        const receipt =
          node.kind === "tool" || node.kind === "result"
            ? scopedReceipt(operationId)
            : undefined;
        if (node.kind === "tool" && callId) tools.set(callId, node.id);
        const source =
          node.kind === "result" && callId ? tools.get(callId) : undefined;
        add(
          {
            ...node,
            ...(receipt ? { action: loopActionDetails(receipt, node) } : {}),
            details: [
              ...node.details.filter((item) => item.label !== "Receipt status"),
              ...resultDetails(receipt, node),
            ].slice(0, 12),
          },
          undefined,
          node.kind === "result" ? "result" : "flow",
        );
        if (
          source &&
          source !== nodes.at(-2)?.id &&
          nodes.some((n) => n.id === node.id)
        )
          edges.push({
            id: `edge-${edges.length + 1}`,
            source,
            target: node.id,
            kind: "result",
          });
      }
    } else if (turn.kind === "agent-1") {
      // Historical tool call/result envelopes are observed evidence. Assistant
      // prose, raw arguments/results and carried history are not reasoning nodes.
      const calls = new Map<string, string>();
      let sequence = 0;
      for (const message of Array.isArray(turn.transcript)
        ? turn.transcript.slice(0, 120)
        : []) {
        if (message.role === "assistant" && Array.isArray(message.tool_calls)) {
          const modelId = `historical-model-${++sequence}`;
          add({
            id: modelId,
            kind: "model",
            label: "Model tool request",
            status: "succeeded",
            startedAt: null,
            finishedAt: null,
            details: [],
          });
          for (const call of message.tool_calls.slice(0, 4)) {
            if (
              typeof call.id !== "string" ||
              typeof call.function?.name !== "string"
            )
              continue;
            const nodeId = `historical-tool-${++sequence}`;
            calls.set(call.id, nodeId);
            const operationId = receipts.get(call.id);
            const receipt = scopedReceipt(operationId);
            const known = [
              "compose_card",
              "ask_user",
              "find_service",
              "find_actions",
              "internal_datetime_resolve",
              "memory_search",
              "memory_remember",
              "memory_revise",
              "memory_forget",
            ].includes(call.function.name);
            add(
              {
                id: nodeId,
                kind: "tool",
                label: receipt
                  ? receipt.title
                  : known
                    ? call.function.name
                    : "Unknown tool",
                status: "unknown",
                startedAt: null,
                finishedAt: null,
                details: [],
                ...(known || receipt
                  ? {
                      tool: finishLoopToolDetails(
                        startLoopToolDetails(call.function.name),
                        { status: "unknown" },
                      ),
                    }
                  : {}),
              },
              modelId,
            );
          }
        } else if (
          message.role === "tool" &&
          typeof message.tool_call_id === "string"
        ) {
          const source = calls.get(message.tool_call_id);
          if (!source) continue;
          let status: LoopStatus = "unknown";
          let observedEnvelope = false;
          try {
            const result: unknown = JSON.parse(message.content);
            if (
              result &&
              typeof result === "object" &&
              !Array.isArray(result)
            ) {
              const envelope = result as Record<string, unknown>;
              if (
                envelope.status === "cancelled" ||
                envelope.status === "interrupted" ||
                envelope.status === "running"
              ) {
                status = envelope.status;
                observedEnvelope = true;
              } else if (
                (typeof envelope.status === "string" &&
                  [
                    "awaiting_approval",
                    "needs_input",
                    "unknown",
                    "failed",
                    "rejected",
                    "succeeded",
                    "composed",
                  ].includes(envelope.status)) ||
                envelope.error ||
                envelope.skipped ||
                envelope.asked ||
                Array.isArray(envelope.services) ||
                Array.isArray(envelope.actions)
              ) {
                status = toolOutcome(envelope);
                observedEnvelope = true;
              }
            }
          } catch {
            /* unavailable envelope */
          }
          const tool = nodes.find((node) => node.id === source);
          const receipt = scopedReceipt(receipts.get(message.tool_call_id));
          if (tool) {
            tool.status = status;
            if (tool.tool)
              tool.tool = finishLoopToolDetails(tool.tool, { status });
            if (receipt && observedEnvelope) {
              tool.action = loopActionDetails(receipt, tool);
              tool.details = resultDetails(receipt, tool);
            }
          }
          const resultNode: LoopNode = {
            id: `historical-result-${++sequence}`,
            kind: "result",
            label: "Tool result",
            status,
            startedAt: null,
            finishedAt: null,
            details: [],
          };
          if (receipt && observedEnvelope) {
            resultNode.action = loopActionDetails(receipt, resultNode);
            resultNode.details = resultDetails(receipt, resultNode);
          }
          add(resultNode, source, "result");
        }
      }
    }
    if (run.reply)
      add({
        id: "reply",
        kind: run.status === "waiting" ? "question" : "reply",
        label: run.status === "waiting" ? "Waiting for the person" : "Reply",
        status: run.status,
        startedAt: run.finishedAt,
        finishedAt: run.finishedAt,
        details: [{ label: "Message", value: run.reply }],
      });
    else if (run.unconfirmedFailure)
      add({
        id: "unconfirmed-outcome",
        kind: "error",
        label: "Unconfirmed outcome",
        status: "unknown",
        startedAt: null,
        finishedAt: null,
        details: [
          {
            label: "Outcome",
            value: "unconfirmed_failure",
          },
        ],
      });
    else if (run.status !== "running")
      add({
        id: "outcome",
        kind: "error",
        label: "Run outcome",
        status: run.status,
        startedAt: run.finishedAt,
        finishedAt: run.finishedAt,
        details: [{ label: "Outcome", value: run.status }],
      });
    return LoopDetailSchema.parse({
      profile: LOOPS_PROFILE,
      organizationId,
      run,
      nodes,
      edges,
      truncated,
    });
  }
}
