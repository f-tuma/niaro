import { DatabaseSync } from "node:sqlite";
import { AuditStore } from "../apps/server-identity/audit";
import { AuditQuery, type AuditRecord } from "../packages/protocol/audit";
const record: AuditRecord = {
  organizationId: "org-a",
  workspaceId: "ws-a",
  actorId: "user-a",
  source: "console",
  action: "connection.configured",
  targetId: "connection-a",
  outcome: "succeeded",
  details: { enabled: true, revision: 2 },
};
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE user (id TEXT,name TEXT); CREATE TABLE agent_workspace (id TEXT,organization_id TEXT,name TEXT); INSERT INTO user VALUES ('user-a','TEST Owner'); INSERT INTO agent_workspace VALUES ('ws-a','org-a','TEST Sales');",
  );
  return { db, audit: new AuditStore(db) };
}
test("audit keyset pagination is bounded, ordered and scoped under new arrivals", () => {
  const { db, audit } = setup();
  try {
    for (let i = 0; i < 65; i++) audit.append(record);
    audit.append({ ...record, organizationId: "org-b", workspaceId: "ws-b" });
    const first = audit.page({ organizationId: "org-a" });
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]?.actorName).toBe("TEST Owner");
    expect(first.entries[0]?.workspaceName).toBe("TEST Sales");
    audit.append(record);
    const second = audit.page({
      organizationId: "org-a",
      before: first.nextBefore!,
    });
    expect(second.entries).toHaveLength(15);
    expect(second.nextBefore).toBeNull();
    expect(
      new Set([...first.entries, ...second.entries].map((e) => e.id)).size,
    ).toBe(65);
    expect(
      audit.page({ organizationId: "org-a", workspaceId: "ws-b" }).entries,
    ).toEqual([]);
    expect(audit.page({ organizationId: "org-b" }).entries).toHaveLength(1);
    expect(
      audit.page({ organizationId: "org-a", category: "tools" }).entries,
    ).toEqual([]);
  } finally {
    db.close();
  }
});
test("tool outcomes are completed once and unfinished attempts survive restart as interrupted", () => {
  const { db, audit } = setup();
  try {
    const tool = {
      ...record,
      action: "tool.invoked" as const,
      outcome: "running" as const,
      details: { toolId: "crm.contacts.list" as const },
    };
    const completed = audit.append(tool),
      orphan = audit.append(tool);
    audit.finish(completed, "succeeded", { ...tool.details, durationMs: 12 });
    audit.finish(completed, "failed", { reason: "provider_failed" });
    const reopened = new AuditStore(db);
    const entries = reopened.page({
      organizationId: "org-a",
      category: "tools",
    }).entries;
    expect(entries.find((e) => e.id === completed)).toMatchObject({
      outcome: "succeeded",
      details: { durationMs: 12 },
    });
    expect(entries.find((e) => e.id === orphan)).toMatchObject({
      outcome: "interrupted",
      details: { toolId: "crm.contacts.list", reason: "server_stopped" },
    });
    expect(entries.every((e) => !!e.finishedAt)).toBe(true);
    expect(
      reopened.page({ organizationId: "org-a", outcome: "succeeded" }).entries,
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});
test("audit rejects arbitrary details and validates cursors before SQL", () => {
  const { db, audit } = setup();
  try {
    for (const field of [
      "apiKey",
      "password",
      "input",
      "result",
      "error",
      "email",
      "text",
    ])
      expect(() =>
        audit.append({
          ...record,
          details: { [field]: "private" },
        } as AuditRecord),
      ).toThrow();
    for (const before of ["0", "-1", "1 OR 1=1", "9007199254740992", "1.5"])
      expect(
        AuditQuery.safeParse({ organizationId: "org-a", before }).success,
      ).toBe(false);
    expect(audit.page({ organizationId: "org-a" }).entries).toEqual([]);
  } finally {
    db.close();
  }
});
