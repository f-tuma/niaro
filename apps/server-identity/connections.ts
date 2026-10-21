import {
  createCipheriv,
  createDecipheriv,
  hkdfSync,
  randomBytes,
  randomUUID,
} from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import {
  ConnectionCommandSchema,
  WorkspaceConnectionsSchema,
  type WorkspaceConnection,
} from "../../packages/protocol/connections";
import { OrganizationRole } from "../../packages/protocol/identity";
import { TwentyTestDirectory } from "../fixture-server/twenty";
import { createContactTools } from "../server-tools/contacts";
import { IdentityError } from "./error";

type Row = {
  id: string;
  workspace_id: string;
  name: string;
  origin: string;
  secret: string;
  expires_at: string;
  enabled: number;
  revision: number;
  grants: string;
};
const Grants = z.record(
  z.enum(["crm.contacts.list", "crm.contacts.search"]),
  z.array(OrganizationRole).max(3),
);
const inventory = createContactTools({ list: async () => [] }).describe();

/** Called only inside IdentityService's queue, after organization/workspace authorization. */
export class WorkspaceConnectionStore {
  private key: Buffer;
  constructor(
    private db: DatabaseSync,
    secret: string,
    readonly allowedOrigins: readonly string[],
    private transport: typeof fetch = fetch,
  ) {
    this.key = Buffer.from(
      hkdfSync(
        "sha256",
        secret,
        "agent-server",
        "workspace-credentials/v1",
        32,
      ),
    );
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_org_policy (
        organization_id TEXT PRIMARY KEY REFERENCES organization(id) ON DELETE CASCADE,
        revision INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_connection (
        id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE,
        name TEXT NOT NULL, origin TEXT NOT NULL, secret TEXT NOT NULL, expires_at TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)), revision INTEGER NOT NULL DEFAULT 1,
        grants TEXT NOT NULL, UNIQUE(workspace_id, name)
      ) STRICT;
      CREATE TABLE IF NOT EXISTS agent_workspace_runtime (
        workspace_id TEXT PRIMARY KEY REFERENCES agent_workspace(id) ON DELETE CASCADE,
        connection_id TEXT REFERENCES agent_connection(id) ON DELETE SET NULL,
        revision INTEGER NOT NULL
      ) STRICT;
    `);
  }
  private seal(value: string, id: string, workspaceId: string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(JSON.stringify(["v1", workspaceId, id])));
    const encrypted = Buffer.concat([
      cipher.update(value, "utf8"),
      cipher.final(),
    ]);
    return [
      "v1",
      iv.toString("base64url"),
      cipher.getAuthTag().toString("base64url"),
      encrypted.toString("base64url"),
    ].join(".");
  }
  private unseal(row: Row) {
    const [version, iv, tag, data] = row.secret.split(".");
    if (version !== "v1" || !iv || !tag || !data)
      throw Error("Invalid credential");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      Buffer.from(iv, "base64url"),
      { authTagLength: 16 },
    );
    decipher.setAAD(
      Buffer.from(JSON.stringify(["v1", row.workspace_id, row.id])),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(data, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  }
  policyVersion(orgId: string) {
    return Number(
      this.db
        .prepare(
          "SELECT revision FROM agent_org_policy WHERE organization_id=?",
        )
        .get(orgId)?.revision ?? 0,
    );
  }
  binding(workspaceId: string) {
    const row = this.db
      .prepare(
        "SELECT connection_id,revision FROM agent_workspace_runtime WHERE workspace_id=?",
      )
      .get(workspaceId);
    return {
      connectionId:
        row?.connection_id == null ? null : String(row.connection_id),
      revision: Number(row?.revision ?? 0),
    };
  }
  changePolicy(orgId: string) {
    this.db
      .prepare(
        "INSERT INTO agent_org_policy VALUES (?, 1) ON CONFLICT(organization_id) DO UPDATE SET revision=revision+1",
      )
      .run(orgId);
  }
  private rows(workspaceId: string): Row[] {
    return this.db
      .prepare(
        "SELECT * FROM agent_connection WHERE workspace_id=? ORDER BY name",
      )
      .all(workspaceId) as unknown as Row[];
  }
  private state(row: Row): WorkspaceConnection["state"] {
    if (!this.allowedOrigins.includes(row.origin)) return "unavailable";
    if (Date.now() >= Date.parse(row.expires_at)) return "expired";
    return row.enabled ? "configured" : "disabled";
  }
  list(
    orgId: string,
    workspaceId: string,
    role: z.infer<typeof OrganizationRole>,
  ) {
    const canManage = role !== "member";
    return WorkspaceConnectionsSchema.parse({
      organizationId: orgId,
      workspaceId,
      canManage,
      agentConnectionId: this.binding(workspaceId).connectionId,
      bindingRevision: this.binding(workspaceId).revision,
      allowedOrigins: canManage ? this.allowedOrigins : [],
      connections: this.rows(workspaceId)
        .map((row) => {
          const grants = Grants.parse(JSON.parse(row.grants));
          const state = this.state(row);
          return {
            id: row.id,
            name: row.name,
            origin: row.origin,
            provider: "twenty-test",
            expiresAt: row.expires_at,
            revision: row.revision,
            enabled: !!row.enabled,
            state,
            tools: inventory
              .map((tool) => ({
                ...tool,
                roles: canManage ? grants[tool.id as keyof typeof grants] : [],
                canInvoke:
                  state === "configured" &&
                  grants[tool.id as keyof typeof grants].includes(role),
              }))
              .filter((tool) => canManage || tool.canInvoke),
          };
        })
        .filter((connection) => canManage || connection.tools.length > 0),
    });
  }
  row(workspaceId: string, id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM agent_connection WHERE workspace_id=? AND id=?")
      .get(workspaceId, id) as Row | undefined;
    if (!row) throw new IdentityError(404, "connection_not_found");
    return row;
  }
  private expiry(expiresAt: string) {
    if (Date.parse(expiresAt) <= Date.now())
      throw new IdentityError(400, "connection_expired");
  }
  command(input: z.infer<typeof ConnectionCommandSchema>) {
    if (input.type === "selectAgentConnection") {
      if (input.connectionId) this.row(input.workspaceId, input.connectionId);
      if (this.binding(input.workspaceId).revision !== input.bindingRevision)
        throw new IdentityError(409, "connection_conflict");
      this.db
        .prepare(
          "INSERT INTO agent_workspace_runtime VALUES (?,?,1) ON CONFLICT(workspace_id) DO UPDATE SET connection_id=excluded.connection_id, revision=revision+1",
        )
        .run(input.workspaceId, input.connectionId);
      return input.connectionId;
    }
    if (input.type === "create") {
      if (!this.allowedOrigins.includes(input.origin))
        throw new IdentityError(403, "connection_origin_denied");
      this.expiry(input.expiresAt);
      if (this.rows(input.workspaceId).length >= 50)
        throw new IdentityError(409, "identity_limit");
      if (
        this.db
          .prepare(
            "SELECT id FROM agent_connection WHERE workspace_id=? AND name=?",
          )
          .get(input.workspaceId, input.name)
      )
        throw new IdentityError(409, "connection_conflict");
      const id = randomUUID();
      this.db
        .prepare(
          "INSERT INTO agent_connection (id,workspace_id,name,origin,secret,expires_at,grants) VALUES (?,?,?,?,?,?,?)",
        )
        .run(
          id,
          input.workspaceId,
          input.name,
          input.origin,
          this.seal(input.apiKey, id, input.workspaceId),
          input.expiresAt,
          JSON.stringify({
            "crm.contacts.list": [],
            "crm.contacts.search": [],
          }),
        );
      return id;
    }
    const row = this.row(input.workspaceId, input.connectionId);
    if (row.revision !== input.revision)
      throw new IdentityError(409, "connection_conflict");
    if (input.type === "remove") {
      this.db.prepare("DELETE FROM agent_connection WHERE id=?").run(row.id);
    } else if (input.type === "rotate") {
      this.expiry(input.expiresAt);
      this.db
        .prepare(
          "UPDATE agent_connection SET secret=?,expires_at=?,revision=revision+1 WHERE id=?",
        )
        .run(
          this.seal(input.apiKey, row.id, row.workspace_id),
          input.expiresAt,
          row.id,
        );
    } else {
      if (
        input.enabled &&
        (!this.allowedOrigins.includes(row.origin) ||
          Date.parse(row.expires_at) <= Date.now())
      )
        throw new IdentityError(409, "connection_unavailable");
      const grants = Object.fromEntries(
        input.grants.map((g) => [g.toolId, [...new Set(g.roles)]]),
      );
      this.db
        .prepare(
          "UPDATE agent_connection SET enabled=?,grants=?,revision=revision+1 WHERE id=?",
        )
        .run(Number(input.enabled), JSON.stringify(grants), row.id);
    }
    return row.id;
  }
  authorize(
    workspaceId: string,
    id: string,
    revision: number,
    toolId: string,
    role: z.infer<typeof OrganizationRole>,
  ) {
    const row = this.row(workspaceId, id);
    if (row.revision !== revision)
      throw new IdentityError(409, "connection_conflict");
    if (this.state(row) !== "configured")
      throw new IdentityError(403, "connection_unavailable");
    const grants = Grants.parse(JSON.parse(row.grants));
    if (
      !inventory.some((tool) => tool.id === toolId) ||
      !grants[toolId as keyof typeof grants]?.includes(role)
    )
      throw new IdentityError(403, "tool_forbidden");
    return row;
  }
  registry(row: Row) {
    return createContactTools(
      new TwentyTestDirectory(
        {
          baseUrl: row.origin,
          apiKey: this.unseal(row),
          expiresAt: row.expires_at,
        },
        this.transport,
      ),
    );
  }
}
