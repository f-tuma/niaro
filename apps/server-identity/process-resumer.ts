/**
 * Recovery policy A for processes (owner decision 2026-11-07): after the
 * server restarts, a run that stopped mid-run continues by itself. Each one
 * is driven again exactly as its original command would drive it, under the
 * person's current membership: the agent core admits the restart only after
 * the domain proved every stored boundary, receipts decide whether an action
 * already ran (a write is never repeated), and a run restarted too often or
 * that cannot be proved fails closed. Runs waiting for a person stay waiting.
 */
import type { DatabaseSync } from "node:sqlite";
import type { Scope } from "../../packages/protocol";
import type { ProcessQuestionAccess } from "../../packages/protocol/process-questions";
import { operatorLog } from "../fixture-server/operator-log";
import type { AgentMemory } from "./agent-memory";
import type { CatalogContext, CatalogController } from "./catalog-controller";
import {
  JournalSchema,
  serviceProcessRunIdentity,
} from "./service-process-journal";
import { createServiceProcessRuntime } from "./service-process-runtime";
import type { ServiceProcessStore } from "./service-processes";

export type InterruptedRun = {
  parentRunId: string;
  organizationId: string;
  scope: Scope;
  journal: ReturnType<typeof JournalSchema.parse>;
};

/** Process runs this server left `running`: stopped mid-run by a crash. */
export function interruptedProcessRuns(db: DatabaseSync, serverId: string) {
  const rows = db
    .prepare(
      `SELECT t.id, t.workspace_id, t.user_id, t.data, w.organization_id
         FROM agent_service_turn t JOIN agent_workspace w ON w.id=t.workspace_id
        WHERE json_extract(t.data,'$.kind')='service-process-1'
          AND json_extract(t.data,'$.status')='running'
        ORDER BY t.rowid`,
    )
    .all() as {
    id: string;
    workspace_id: string;
    user_id: string;
    data: string;
    organization_id: string;
  }[];
  return rows.flatMap((row): InterruptedRun[] => {
    const parsed = JournalSchema.safeParse(JSON.parse(row.data));
    if (!parsed.success) return [];
    const scope: Scope = {
      connectionId: `account-${row.workspace_id}`,
      serverId,
      workspaceId: row.workspace_id,
      userId: row.user_id,
    };
    // Only runs of this server's identity: the run id binds scope and run.
    if (
      serviceProcessRunIdentity(scope, row.organization_id, parsed.data.runId)
        .parentRunId !== row.id
    )
      return [];
    return [
      {
        parentRunId: row.id,
        organizationId: row.organization_id,
        scope,
        journal: parsed.data,
      },
    ];
  });
}

export async function resumeInterruptedProcesses(deps: {
  db: DatabaseSync;
  serverId: string;
  controller: CatalogController;
  registry: Pick<ServiceProcessStore, "pinRun" | "resolveRun">;
  /** The member's current authority, or a throw when they lost it. */
  access(
    scope: Scope,
    organizationId: string,
  ): {
    context: CatalogContext;
    memory?: AgentMemory;
  };
  questions?: ProcessQuestionAccess;
  signal: AbortSignal;
}) {
  const outcomes: { parentRunId: string; status: string }[] = [];
  for (const run of interruptedProcessRuns(deps.db, deps.serverId)) {
    if (deps.signal.aborted) break;
    let status: string;
    try {
      const { context, memory } = deps.access(run.scope, run.organizationId);
      const runtime = createServiceProcessRuntime(
        deps.controller,
        deps.registry,
        context,
        run.scope,
        run.organizationId,
        {
          ...(memory ? { memory } : {}),
          ...(deps.questions ? { questions: deps.questions } : {}),
          automatic: true,
        },
      );
      status = (
        await runtime.start(
          run.journal.processId,
          run.journal.runId,
          run.journal.input,
          deps.signal,
        )
      ).status;
    } catch (error) {
      // Lost authority or a refused start leaves the run as it is; its
      // original command then fails closed as before.
      status =
        error instanceof Error && "code" in error
          ? String((error as { code: unknown }).code)
          : "process_resume_failed";
    }
    operatorLog("process_resume", { status });
    outcomes.push({ parentRunId: run.parentRunId, status });
  }
  return outcomes;
}
