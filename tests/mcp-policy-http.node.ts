import assert from "node:assert/strict";
import { after, test } from "node:test";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpAdminState } from "../packages/protocol/mcp-admin";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

type Fixture = Awaited<ReturnType<typeof coordinatorHttpFixture>>;
type Role = "owner" | "admin" | "member";
const fixture = coordinatorHttpFixture();
after(async () => {
  await (await fixture).close();
});

async function issue(h: Fixture, role: Role, label: string) {
  return h.request(role, "api/identity/mcp/access/issue", {
    workspaceId: h.target.workspaceId,
    label,
    scopes: ["data.read"],
    expiresAt: Date.now() + 3_600_000,
  });
}
async function issued(h: Fixture, role: Role, label: string) {
  const result = await issue(h, role, label);
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const data = h.record(result.data);
  const grant = h.record(data.grant);
  return {
    token: String(data.accessToken),
    id: String(grant.id),
    status: String(grant.status),
  };
}
/** The MCP request an app makes first; its HTTP status says whether it may. */
async function mcp(h: Fixture, token: string) {
  const response = await fetch(h.origin + "/mcp", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + token,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "TEST policy", version: "1" },
      },
    }),
  });
  return { status: response.status, text: await response.text() };
}
async function list(h: Fixture, role: Role = "admin") {
  const result = await h.request(role, "api/identity/mcp/admin/list", h.target);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return McpAdminState.parse(result.data);
}
async function policy(h: Fixture, value: string, role: Role = "owner") {
  const { revision } = await list(h);
  return h.request(role, "api/identity/mcp/admin/policy", {
    ...h.target,
    policy: value,
    revision,
  });
}
const review = (h: Fixture, body: object, role: Role = "admin") =>
  h.request(role, "api/identity/mcp/admin/review", { ...h.target, ...body });

test("members cannot read or change the policy and the review queue", async () => {
  const h = await fixture;
  const initial = await list(h);
  assert.equal(initial.policy, "review");
  for (const [path, body] of [
    ["list", {}],
    ["policy", { policy: "free", revision: initial.revision }],
    [
      "review",
      { kind: "grant", id: "grant-1", revision: 0, decision: "approve" },
    ],
    ["revoke", { grantId: "grant-1" }],
  ] as const) {
    const refused = await h.request(
      "member",
      `api/identity/mcp/admin/${path}`,
      {
        ...h.target,
        ...body,
      },
    );
    assert.equal(refused.status, 403, path);
    assert.deepEqual(refused.data, { error: "identity_forbidden" });
  }
  assert.equal((await list(h)).policy, "review");
  // A save from an outdated revision keeps the newer policy.
  assert.equal((await policy(h, "free")).status, 200);
  const stale = await h.request("admin", "api/identity/mcp/admin/policy", {
    ...h.target,
    policy: "off",
    revision: initial.revision,
  });
  assert.equal(stale.status, 409);
  assert.deepEqual(stale.data, { error: "mcp_policy_conflict" });
  assert.equal((await list(h)).policy, "free");
  assert.equal((await policy(h, "review")).status, 200);
});

test("a member's grant waits for approval; a rejection with a reason shows on the account page", async () => {
  const h = await fixture;
  const owner = await issued(h, "owner", "TEST owner app");
  assert.equal(owner.status, "active");
  assert.equal((await mcp(h, owner.token)).status, 200);
  const waiting = await issued(h, "member", "TEST waiting app");
  assert.equal(waiting.status, "pending");
  const refused = await mcp(h, waiting.token);
  assert.equal(refused.status, 403);
  assert.match(refused.text, /mcp_access_pending/);
  const queue = await list(h);
  const request = queue.requests.grants.find(
    (grant) => grant.id === waiting.id,
  );
  assert.equal(request?.person.email, "member@example.test");
  assert(!JSON.stringify(queue).includes(waiting.token));
  const decide = (decision: string, revision: number, reason?: string) =>
    review(h, { kind: "grant", id: waiting.id, revision, decision, reason });
  assert.equal((await decide("approve", 1)).status, 409);
  assert.equal((await decide("approve", 0)).status, 200);
  // Decided twice from the same revision: the first decision stands.
  const twice = await decide("reject", 0);
  assert.equal(twice.status, 409);
  assert.deepEqual(twice.data, { error: "mcp_review_conflict" });
  const client = new Client({ name: "TEST approved", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + waiting.token } },
    }),
  );
  assert((await client.listTools()).tools.length > 0);
  await client.close();
  const rejected = await issued(h, "member", "TEST rejected app");
  assert.equal(
    (
      await review(h, {
        kind: "grant",
        id: rejected.id,
        revision: 0,
        decision: "reject",
        reason: "Use the shared assistant",
      })
    ).status,
    200,
  );
  assert.match((await mcp(h, rejected.token)).text, /mcp_access_rejected/);
  const access = h.record(
    (
      await h.request("member", "api/identity/account/access", {
        action: "list",
      })
    ).data,
  ).mcp as Record<string, unknown>[];
  const row = access.find((grant) => grant.label === "TEST rejected app");
  assert.equal(row?.status, "rejected");
  assert.equal(row?.reason, "Use the shared assistant");
  assert.equal(typeof row?.workspaceName, "string");
  // Removable by its owner.
  assert.equal(
    (
      await h.request("member", "api/identity/account/access", {
        action: "revoke",
        id: row!.id,
      })
    ).status,
    200,
  );
  const revoked = await h.request("admin", "api/identity/mcp/admin/revoke", {
    ...h.target,
    grantId: waiting.id,
  });
  assert.deepEqual(revoked.data, { revoked: true });
  assert.equal((await mcp(h, waiting.token)).status, 401);
  assert.deepEqual(
    (
      await h.request("admin", "api/identity/mcp/admin/revoke", {
        ...h.target,
        grantId: waiting.id,
      })
    ).data,
    { revoked: false },
  );
  // The owner's own grant is not a member's to revoke here.
  assert.equal(
    (
      await h.request("admin", "api/identity/mcp/admin/revoke", {
        ...h.target,
        grantId: owner.id,
      })
    ).status,
    404,
  );
});

test("switching to off revokes every member grant and stops admitted work; owners keep theirs", async () => {
  const h = await fixture;
  assert.equal((await policy(h, "free")).status, 200);
  const grants = [
    await issued(h, "member", "TEST one"),
    await issued(h, "member", "TEST two"),
  ];
  assert.equal((await policy(h, "review")).status, 200);
  // free → review keeps what is active; new grants wait.
  assert.equal((await mcp(h, grants[0]!.token)).status, 200);
  grants.push(await issued(h, "member", "TEST three"));
  assert.equal(grants[2]!.status, "pending");
  const owner = await issued(h, "owner", "TEST owner kept");
  const serverId = h.identity["workflowServerId"]!;
  // Work admitted before the switch, as a commit would recheck it.
  const admitted = await h.identity.mcpAuthenticate(
    "Bearer " + grants[0]!.token,
    serverId,
  );
  assert.equal((await policy(h, "off")).status, 200);
  assert.throws(
    () => h.identity["mcpPrincipal"](admitted.grantId, serverId, ["data.read"]),
    (error: { status?: number }) => error.status === 401,
  );
  for (const grant of grants)
    assert.equal((await mcp(h, grant.token)).status, 401);
  assert.equal((await mcp(h, owner.token)).status, 200);
  const off = await issue(h, "member", "TEST refused");
  assert.equal(off.status, 403);
  assert.deepEqual(off.data, { error: "mcp_external_apps_off" });
  assert.equal((await issued(h, "admin", "TEST admin app")).status, "active");
  const audit = await h.request(
    "owner",
    `api/identity/audit?${new URLSearchParams(h.target)}`,
  );
  const entries = h.record(audit.data).entries as Record<string, unknown>[];
  const change = entries.find(
    (entry) =>
      entry.action === "mcp.policy_changed" &&
      h.record(entry.details).externalAppsPolicy === "off",
  );
  assert.equal(h.record(change!.details).revokedCount, 3);
  for (const action of ["mcp.access_reviewed", "mcp.access_revoked"])
    assert(
      entries.some((entry) => entry.action === action),
      action,
    );
  const json = JSON.stringify(entries);
  for (const grant of [...grants, owner]) assert(!json.includes(grant.token));
  assert.equal((await policy(h, "review")).status, 200);
});
