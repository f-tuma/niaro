import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  AUDIT_PROFILE,
  AuditDetails,
  AuditPage,
  AuditQuery,
  AuditRecordSchema,
  type AuditRecord,
  type AuditOutcome,
} from "../../packages/protocol/audit";

/** Called in the identity queue. No request bodies, credentials, tool arguments/results or exception text. */
export class AuditStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, finished_at TEXT,
        organization_id TEXT NOT NULL, workspace_id TEXT, actor_id TEXT,
        source TEXT NOT NULL, action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL, details TEXT NOT NULL
      ) STRICT;
      CREATE INDEX IF NOT EXISTS agent_audit_org_id ON agent_audit(organization_id, id DESC);
      CREATE INDEX IF NOT EXISTS agent_audit_workspace_id ON agent_audit(organization_id, workspace_id, id DESC);
    `);
    // The identity process lock is held. A previous process cannot finish these attempts.
    this.interrupt();
  }
  append(raw: AuditRecord) {
    const value = AuditRecordSchema.parse(raw);
    const now = new Date().toISOString();
    return Number(
      this.db
        .prepare(
          "INSERT INTO agent_audit (created_at,finished_at,organization_id,workspace_id,actor_id,source,action,target_id,outcome,details) VALUES (?,?,?,?,?,?,?,?,?,?)",
        )
        .run(
          now,
          value.outcome === "running" ? null : now,
          value.organizationId,
          value.workspaceId,
          value.actorId,
          value.source,
          value.action,
          value.targetId,
          value.outcome,
          JSON.stringify(value.details),
        ).lastInsertRowid,
    );
  }
  finish(
    id: number,
    outcome: Exclude<z.infer<typeof AuditOutcome>, "running">,
    details: z.infer<typeof AuditDetails>,
  ) {
    const value = AuditDetails.parse(details);
    this.db
      .prepare(
        "UPDATE agent_audit SET outcome=?,finished_at=?,details=? WHERE id=? AND outcome='running'",
      )
      .run(outcome, new Date().toISOString(), JSON.stringify(value), id);
  }
  interrupt() {
    this.db
      .prepare(
        "UPDATE agent_audit SET outcome='interrupted',finished_at=?,details=json_set(details,'$.reason','server_stopped') WHERE outcome='running'",
      )
      .run(new Date().toISOString());
  }
  page(query: z.infer<typeof AuditQuery>) {
    const where = ["a.organization_id=?"];
    const args: (string | number)[] = [query.organizationId];
    if (query.workspaceId) {
      where.push("a.workspace_id=?");
      args.push(query.workspaceId);
    }
    if (query.before) {
      where.push("a.id<?");
      args.push(query.before);
    }
    if (query.category)
      where.push(
        query.category === "tools"
          ? "a.action IN ('tool.invoked','calendar.executed','catalog.action_invoked')"
          : "a.action NOT IN ('tool.invoked','calendar.executed','catalog.action_invoked')",
      );
    if (query.outcome) {
      where.push("a.outcome=?");
      args.push(query.outcome);
    }
    const rows = this.db
      .prepare(
        `SELECT a.*, u.name AS actor_name, w.name AS workspace_name FROM agent_audit a LEFT JOIN user u ON u.id=a.actor_id LEFT JOIN agent_workspace w ON w.id=a.workspace_id AND w.organization_id=a.organization_id WHERE ${where.join(" AND ")} ORDER BY a.id DESC LIMIT 51`,
      )
      .all(...args);
    const entries = rows.slice(0, 50).map((row) => ({
      id: Number(row.id),
      createdAt: row.created_at,
      finishedAt: row.finished_at,
      organizationId: row.organization_id,
      workspaceId: row.workspace_id,
      actorId: row.actor_id,
      actorName: row.actor_name ?? null,
      workspaceName: row.workspace_name ?? null,
      source: row.source,
      action: row.action,
      targetId: row.target_id,
      outcome: row.outcome,
      details: JSON.parse(String(row.details)),
    }));
    return AuditPage.parse({
      profile: AUDIT_PROFILE,
      organizationId: query.organizationId,
      entries,
      nextBefore: rows.length > 50 ? entries.at(-1)!.id : null,
    });
  }
}
