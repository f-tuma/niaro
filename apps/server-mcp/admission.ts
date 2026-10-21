import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  CommandSchema,
  sameScope,
  type Command,
  type Scope,
} from "../../packages/protocol";
import { IdentityError } from "../server-identity/error";
import { processDigest } from "../server-identity/process-validation";

export type McpPrincipal = {
  grantId: string;
  credentialKind?: "mcp" | "browser";
  userId: string;
  memberId?: string;
  workspaceId: string;
  serverId: string;
};
export const mcpScope = (actor: McpPrincipal): Scope => ({
  connectionId: `account-${actor.workspaceId}`,
  serverId: actor.serverId,
  workspaceId: actor.workspaceId,
  userId: actor.userId,
});
export type McpAdmission = {
  id: string;
  scope: Scope;
  grantId: string;
  credentialKind?: "mcp" | "browser";
  credentialMemberId?: string;
  conversationId: string;
  rootCommandId: string;
  workItemId: string;
  command: Extract<Command, { type: "message.send" | "service.resolve" }>;
  phase: "queued" | "running" | "settled";
  revision: number;
  cancelRequested: boolean;
  cancellationSettled?: boolean;
  /** Revoked delivery authority stops retries without claiming native closure. */
  cancellationBlocked?: boolean;
  errorCode?: string;
};
const scopeKey = (scope: Scope) => JSON.stringify(scope);
export const nativeMcpWorkId = (scope: Scope, commandId: string) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        scope.serverId,
        scope.workspaceId,
        scope.userId,
        commandId,
      ]),
    )
    .digest("hex");

/** Delivery receipts only. Native journals own the task, questions and effects. */
export class McpAdmissionStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_mcp_task (
        id TEXT PRIMARY KEY, scope_key TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(json_valid(payload)), updated_at INTEGER NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_mcp_task_scope ON agent_mcp_task(scope_key);
      CREATE TABLE IF NOT EXISTS agent_mcp_request (
        scope_key TEXT NOT NULL, request_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
        task_id TEXT NOT NULL REFERENCES agent_mcp_task(id),
        PRIMARY KEY(scope_key, request_id)
      ) STRICT;
    `);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private parse(payload: unknown): McpAdmission {
    const task = JSON.parse(String(payload)) as McpAdmission;
    const command = CommandSchema.parse(task.command);
    if (
      !["message.send", "service.resolve"].includes(command.type) ||
      command.conversationId !== task.conversationId
    )
      throw new IdentityError(503, "mcp_task_unavailable");
    return { ...task, command: command as McpAdmission["command"] };
  }
  read(actor: McpPrincipal, id: string): McpAdmission {
    const row = this.db
      .prepare("SELECT payload FROM agent_mcp_task WHERE id=? AND scope_key=?")
      .get(id, scopeKey(mcpScope(actor)));
    if (!row) throw new IdentityError(404, "mcp_task_not_found");
    const task = this.parse(row.payload);
    if (!sameScope(task.scope, mcpScope(actor)))
      throw new IdentityError(404, "mcp_task_not_found");
    return task;
  }
  private previous(
    actor: McpPrincipal,
    requestId: string,
    fingerprint: string,
  ) {
    const row = this.db
      .prepare(
        "SELECT fingerprint,task_id FROM agent_mcp_request WHERE scope_key=? AND request_id=?",
      )
      .get(scopeKey(mcpScope(actor)), requestId);
    if (!row) return undefined;
    if (row.fingerprint !== fingerprint)
      throw new IdentityError(409, "mcp_idempotency_conflict");
    return this.read(actor, String(row.task_id));
  }
  replay(
    actor: McpPrincipal,
    requestId: string,
    input: unknown,
  ): McpAdmission | undefined {
    return this.previous(actor, requestId, processDigest(input));
  }
  private reserve(
    actor: McpPrincipal,
    requestId: string,
    input: unknown,
    taskId: string,
  ) {
    this.db
      .prepare("INSERT INTO agent_mcp_request VALUES(?,?,?,?)")
      .run(scopeKey(mcpScope(actor)), requestId, processDigest(input), taskId);
  }
  submit(
    actor: McpPrincipal,
    input: {
      requestId: string;
      text: string;
      language: "cs" | "en";
      timeZone?: string;
    },
  ): McpAdmission {
    return this.transaction(() => {
      const request = { tool: "task_submit", ...input };
      const prior = this.replay(actor, input.requestId, request);
      if (prior) return prior;
      const outstanding = Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM agent_mcp_task WHERE json_extract(payload,'$.phase') IN ('queued','running')",
          )
          .get()!.n,
      );
      if (outstanding >= 128) throw new IdentityError(429, "mcp_task_capacity");
      const id = randomUUID(),
        commandId = `mcp-${randomUUID()}`;
      const scope = mcpScope(actor);
      const command = CommandSchema.parse({
        type: "message.send",
        commandId,
        idempotencyKey: commandId,
        conversationId: `mcp-${id}`,
        text: input.text,
        language: input.language,
        ...(input.timeZone ? { timeZone: input.timeZone } : {}),
      }) as McpAdmission["command"];
      const task: McpAdmission = {
        id,
        scope,
        grantId: actor.grantId,
        conversationId: command.conversationId,
        rootCommandId: commandId,
        workItemId: nativeMcpWorkId(scope, commandId),
        command,
        phase: "queued",
        revision: 1,
        cancelRequested: false,
      };
      this.db
        .prepare("INSERT INTO agent_mcp_task VALUES(?,?,?,?)")
        .run(id, scopeKey(scope), JSON.stringify(task), Date.now());
      this.reserve(actor, input.requestId, request, id);
      return task;
    });
  }
  respond(
    actor: McpPrincipal,
    input: {
      taskId: string;
      requestId: string;
      inputId: string;
      expectedRevision: number;
      text: string;
    },
    command: McpAdmission["command"],
  ): McpAdmission {
    return this.transaction(() => {
      const request = { tool: "task_respond", ...input };
      const prior = this.replay(actor, input.requestId, request);
      if (prior) return prior;
      const current = this.read(actor, input.taskId);
      if (current.cancelRequested || current.phase !== "settled")
        throw new IdentityError(409, "mcp_task_changed");
      const task: McpAdmission = {
        ...current,
        grantId: actor.grantId,
        credentialKind: "mcp",
        command,
        phase: "queued",
        revision: current.revision + 1,
        errorCode: undefined,
        cancellationSettled: false,
        cancellationBlocked: false,
      };
      this.save(task);
      this.reserve(actor, input.requestId, request, current.id);
      return task;
    });
  }
  cancel(
    actor: McpPrincipal,
    input: { taskId: string; requestId: string },
  ): McpAdmission {
    return this.transaction(() => {
      const request = { tool: "task_cancel", ...input };
      const prior = this.replay(actor, input.requestId, request);
      if (prior) return prior;
      const current = this.read(actor, input.taskId);
      const task = {
        ...current,
        grantId: actor.grantId,
        credentialKind: "mcp" as const,
        credentialMemberId: undefined,
        cancelRequested: true,
        cancellationSettled: false,
        cancellationBlocked: false,
        errorCode: undefined,
        revision: current.revision + 1,
      };
      this.save(task);
      this.reserve(actor, input.requestId, request, current.id);
      return task;
    });
  }
  humanDecision(
    actor: McpPrincipal,
    input: {
      taskId: string;
      requestId: string;
      input: { operationId: string; expectedRevision: number };
      approved: boolean;
    },
    command: McpAdmission["command"],
  ) {
    return this.transaction(() => {
      const request = { tool: "human_decision", ...input };
      const prior = this.replay(actor, input.requestId, request);
      if (prior) return prior;
      const current = this.read(actor, input.taskId);
      if (current.cancelRequested || current.phase !== "settled")
        throw new IdentityError(409, "mcp_task_changed");
      if (!actor.memberId) throw new IdentityError(403, "identity_forbidden");
      const task: McpAdmission = {
        ...current,
        grantId: actor.grantId,
        credentialMemberId: actor.memberId,
        credentialKind: "browser",
        command,
        phase: "queued",
        revision: current.revision + 1,
        errorCode: undefined,
        cancellationSettled: false,
        cancellationBlocked: false,
      };
      this.save(task);
      this.reserve(actor, input.requestId, request, current.id);
      return task;
    });
  }
  save(task: McpAdmission) {
    this.db
      .prepare(
        "UPDATE agent_mcp_task SET payload=?,updated_at=? WHERE id=? AND scope_key=?",
      )
      .run(JSON.stringify(task), Date.now(), task.id, scopeKey(task.scope));
  }
  pending(): McpAdmission[] {
    return this.db
      .prepare(
        "SELECT payload FROM agent_mcp_task WHERE json_extract(payload,'$.phase') IN ('queued','running') OR (json_extract(payload,'$.cancelRequested')=1 AND COALESCE(json_extract(payload,'$.cancellationSettled'),0)=0 AND COALESCE(json_extract(payload,'$.cancellationBlocked'),0)=0) ORDER BY updated_at LIMIT 128",
      )
      .all()
      .map((row) => this.parse(row.payload));
  }
}
