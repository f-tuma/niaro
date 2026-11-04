import assert from "node:assert/strict";
import { after, test } from "node:test";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
// eslint-disable-next-line import/no-unresolved -- Official SDK export-map subpath.
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

type Fixture = Awaited<ReturnType<typeof coordinatorHttpFixture>>;
const fixture = coordinatorHttpFixture({ allowOrdinaryRuntime: true });
after(async () => {
  await (await fixture).close();
});

async function issue(h: Fixture, scopes: string[]) {
  const result = await h.request("owner", "api/identity/mcp/access/issue", {
    workspaceId: h.target.workspaceId,
    label: "TEST connector client",
    scopes,
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  const data = h.record(result.data);
  return {
    accessToken: String(data.accessToken),
    grantId: String(h.record(data.grant).id),
  };
}
async function connect(h: Fixture, token: string) {
  const client = new Client({ name: "TEST connector", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(h.origin + "/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + token } },
    }),
  );
  return client;
}
type Call = {
  requestId: string;
  status: string;
  result?: unknown;
  approvalUrl?: string;
  error?: { code: string };
};
async function call(client: Client, name: string, input: object) {
  const result = await client.callTool({ name, arguments: { ...input } });
  return {
    isError: result.isError ?? false,
    value: result.structuredContent as Call,
  };
}

test("connector exposes permitted service actions and keeps approval with a person", async () => {
  const h = await fixture;
  const grant = await issue(h, ["services.call"]);
  const client = await connect(h, grant.accessToken);
  try {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert(names.includes("niaro_call_status"), names.join());
    assert(!names.some((name) => name.startsWith("task_")), names.join());
    const lookup = tools.find((tool) =>
      tool.annotations?.title?.startsWith("TEST lookup"),
    )!;
    const write = tools.find((tool) =>
      tool.annotations?.title?.startsWith("TEST confirmed write"),
    )!;
    assert.equal(lookup.name, "test_design_service__test_lookup");
    assert.equal(lookup.annotations?.readOnlyHint, true);
    assert.equal(write.annotations?.destructiveHint, true);
    assert.deepEqual(lookup.inputSchema.required, ["name"]);

    // A read runs immediately through the catalog and returns unwrapped data.
    const before = h.dispatches.length;
    const read = await call(client, lookup.name, { name: "TEST" });
    assert.equal(read.isError, false, JSON.stringify(read));
    assert.equal(read.value.status, "succeeded");
    assert.deepEqual(read.value.result, { value: "TEST-mobile-result" });
    assert.equal(h.dispatches.length, before + 1);

    // Invalid input names the field and dispatches nothing.
    const invalid = await call(client, lookup.name, {});
    assert.equal(invalid.isError, true);
    assert.equal(invalid.value.error?.code, "integration_input_invalid");
    assert.match(
      (invalid.value.error as { message?: string }).message ?? "",
      /\/name: Required field is missing/,
    );
    assert.equal(h.dispatches.length, before + 1);

    // A write that needs approval waits; the client cannot approve it.
    const pending = await call(client, write.name, { name: "TEST write" });
    assert.equal(pending.value.status, "awaiting_approval");
    assert.match(pending.value.approvalUrl ?? "", /\/admin\/mcp\?approval=/);
    assert.equal(h.dispatches.length, before + 1);
    const lookupPending = {
      workspaceId: h.target.workspaceId,
      requestId: pending.value.requestId,
    };
    assert.equal(
      (
        await h.request(
          "member",
          "api/identity/mcp/access/connector-call",
          lookupPending,
        )
      ).status,
      404,
    );
    const shown = await h.request(
      "owner",
      "api/identity/mcp/access/connector-call",
      lookupPending,
    );
    assert.equal(shown.status, 200, JSON.stringify(shown.data));
    const receipt = h.record(h.record(shown.data).call);
    assert.equal(receipt.status, "awaiting_approval");

    // The person approves through the console's catalog invoke.
    const approved = await h.request("owner", "api/identity/catalog/invoke", {
      organizationId: receipt.organizationId,
      workspaceId: receipt.workspaceId,
      serviceId: receipt.serviceId,
      actionId: receipt.actionId,
      revision: receipt.actionRevision,
      serviceRevision: receipt.serviceRevision,
      input: receipt.input,
      requestId: receipt.requestId,
      approve: true,
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(h.dispatches.length, before + 2);
    const status = await call(client, "niaro_call_status", {
      requestId: pending.value.requestId,
    });
    assert.equal(status.value.status, "succeeded");

    // A declined call never runs.
    const declined = await call(client, write.name, { name: "TEST decline" });
    assert.equal(
      (
        await h.request("owner", "api/identity/mcp/access/connector-reject", {
          workspaceId: h.target.workspaceId,
          requestId: declined.value.requestId,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await call(client, "niaro_call_status", {
          requestId: declined.value.requestId,
        })
      ).value.status,
      "rejected",
    );
    assert.equal(h.dispatches.length, before + 2);

    // Niaro's own agent takes no tasks over MCP.
    const task = await call(client, "task_submit", {
      requestId: "TEST-connector-task",
      text: "TEST",
    });
    assert.equal(task.isError, true);
  } finally {
    await client.close();
  }
});

test("data grants do not expose service actions, and revoked connectors stop", async () => {
  const h = await fixture;
  const data = await issue(h, ["data.read"]);
  const dataClient = await connect(h, data.accessToken);
  try {
    const names = (await dataClient.listTools()).tools.map((t) => t.name);
    assert(!names.includes("niaro_call_status"), names.join());
    const before = h.dispatches.length;
    const direct = await call(dataClient, "test_design_service__test_lookup", {
      name: "TEST",
    });
    assert.equal(direct.isError, true);
    assert.equal(h.dispatches.length, before);
  } finally {
    await dataClient.close();
  }
  // Retired processor scopes cannot be issued any more.
  const retired = await h.request("owner", "api/identity/mcp/access/issue", {
    workspaceId: h.target.workspaceId,
    label: "TEST processor client",
    scopes: ["native.view", "native.run"],
    expiresAt: Date.now() + 3_600_000,
  });
  assert.equal(retired.status, 400);

  const connector = await issue(h, ["services.call"]);
  const revoked = await h.request("owner", "api/identity/mcp/access/revoke", {
    workspaceId: h.target.workspaceId,
    grantId: connector.grantId,
  });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.data));
  await assert.rejects(connect(h, connector.accessToken));
});
