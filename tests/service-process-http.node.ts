import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../packages/protocol/identity";
import { AuditPage } from "../packages/protocol/audit";
import {
  ProcessListSchema,
  ProcessRecordSchema,
  ProcessVersionSchema,
  ProcessValidationSchema,
} from "../packages/protocol/service-processes";
import { processWorkflow } from "./helpers/service-process";
import { seedIdentityFixture } from "./helpers/identity-seed";

test("process HTTP uses authenticated scope, stays passive and survives an identity restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "niaro-process-http-"));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST process HTTP",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    administration: {
      keyFile: join(root, "key"),
      identity: { directory: join(root, "identity"), baseURL: origin },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  let externalCalls = 0;
  const options = {
    integrationTransport: async () => {
      externalCalls++;
      throw Error("TEST process metadata must not dispatch");
    },
  };
  const key = issueAdminKey(config.administration!.keyFile),
    password = "TEST-process-password-only-2026";
  let identity = await openIdentity(config, options);
  app = createReferenceServer(config, {}, identity);
  function client() {
    const cookies = new Map<string, string>();
    return async (path: string, input?: unknown) => {
      const res = await fetch(origin + "/admin/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(10000),
        headers: {
          Origin: origin,
          "X-Agent-Admin": "1",
          "Content-Type": "application/json",
          Cookie: [...cookies].map(([k, v]) => `${k}=${v}`).join("; "),
        },
        body: input === undefined ? undefined : JSON.stringify(input),
      });
      for (const c of res.headers.getSetCookie()) {
        const pair = c.split(";")[0]!,
          i = pair.indexOf("=");
        cookies.set(pair.slice(0, i), pair.slice(i + 1));
      }
      return { status: res.status, data: (await res.json()) as unknown };
    };
  }
  const owner = client(),
    admin = client(),
    member = client(),
    operator = client(),
    anonymous = client();
  function record(value: unknown): Record<string, unknown> {
    assert(value && typeof value === "object");
    return value as Record<string, unknown>;
  }
  try {
    assert.equal((await operator("api/login", { key })).status, 200);
    assert.equal(
      (
        await operator("api/identity/bootstrap", {
          name: "TEST owner",
          email: "owner@example.test",
          password,
          organizationName: "TEST process org",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await owner("auth/sign-in/email", {
          email: "owner@example.test",
          password,
        })
      ).status,
      200,
    );
    const organizationId = IdentityStateSchema.parse(
      (await owner("api/identity")).data,
    ).organizations[0]!.id;
    assert.equal(
      (
        await owner("api/identity/command", {
          organizationId,
          type: "createWorkspace",
          name: "TEST workspace",
        })
      ).status,
      200,
    );
    for (const role of ["admin", "member"] as const)
      await seedIdentityFixture(identity, {
        type: "createAccount",
        organizationId,
        role,
        name: `TEST ${role}`,
        email: `${role}@example.test`,
        password,
      });
    const detail = OrganizationDetailSchema.parse(
      (await owner(`api/identity/organization?id=${organizationId}`)).data,
    );
    const workspaceId = detail.workspaces[0]!.id,
      target = { organizationId, workspaceId };
    await seedIdentityFixture(identity, {
      organizationId,
      type: "setWorkspaceMember",
      workspaceId,
      memberId: detail.members.find((m) => m.role === "member")!.id,
      allowed: true,
    });
    for (const [request, email] of [
      [admin, "admin@example.test"],
      [member, "member@example.test"],
    ] as const)
      assert.equal(
        (await request("auth/sign-in/email", { email, password })).status,
        200,
      );
    const catalog = async (body: object) => {
      const result = await owner("api/identity/catalog/command", {
        ...target,
        ...body,
      });
      assert.equal(result.status, 200, JSON.stringify(result.data));
      return String(record(result.data).id);
    };
    const serviceId = await catalog({
      type: "saveService",
      revision: 0,
      settings: {
        name: "TEST process service",
        url: "https://services.example.test/v1",
        protocol: "openapi",
        icon: "database",
        auth: { type: "none" },
        enabled: true,
      },
    });
    const actionId = await catalog({
      type: "saveAction",
      serviceId,
      serviceRevision: 1,
      revision: 0,
      settings: {
        name: "TEST lookup",
        description: "",
        inputSchema: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: "GET",
          path: "/items",
          parameters: [],
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["owner", "admin", "member"], users: [] },
      },
    });
    const base = "api/identity/catalog/processes",
      query = new URLSearchParams(target).toString(),
      list = `${base}?${query}`;
    assert.equal(
      ProcessListSchema.parse((await owner(list)).data).processes.length,
      0,
    );
    assert.equal((await admin(list)).status, 200);
    assert.equal((await member(list)).status, 403);
    assert.equal((await operator(list)).status, 403);
    assert.equal((await anonymous(list)).status, 401);
    assert.equal(
      (
        await owner(
          `${base}?${new URLSearchParams({ ...target, organizationId: "TEST-foreign" })}`,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await owner(
          `${base}?${new URLSearchParams({ ...target, workspaceId: "33333333-3333-4333-8333-333333333333" })}`,
        )
      ).status,
      404,
    );
    const definition = processWorkflow(serviceId, actionId),
      save = {
        ...target,
        type: "saveDraft",
        serviceId,
        revision: 0,
        definition,
      };
    const csrf = await fetch(origin + "/admin/" + base + "/command", {
      method: "POST",
      headers: {
        Origin: "https://foreign.example.test",
        "Content-Type": "application/json",
        "X-Agent-Admin": "1",
      },
      body: JSON.stringify(save),
    });
    assert.equal(csrf.status, 403);
    const invalid = ProcessValidationSchema.parse(
      (
        await owner(`${base}/validate`, {
          ...target,
          serviceId,
          definition: { ...definition, entry: "missing" },
        })
      ).data,
    );
    assert.equal(invalid.valid, false);
    assert(invalid.issues.some((i) => i.code === "graph_invalid"));
    assert.equal(
      ProcessValidationSchema.parse(
        (await owner(`${base}/validate`, { ...target, serviceId, definition }))
          .data,
      ).valid,
      true,
    );
    assert.equal((await member(`${base}/command`, save)).status, 403);
    assert.equal(
      (await owner(`${base}/command`, { ...save, role: "owner" })).status,
      400,
    );
    assert.equal(
      (
        await owner(`${base}/command`, {
          ...save,
          type: "activate",
          version: 1,
        })
      ).status,
      400,
    );
    assert.equal((await owner(`${base}/activate`, save)).status, 404);
    assert.equal((await owner(`${base}/test`, save)).status, 404);
    assert.equal((await owner(`${base}/run`, save)).status, 404);
    const saved = await owner(`${base}/command`, save);
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    const process = ProcessRecordSchema.parse(record(saved.data).process);
    assert.equal(process.activeVersion, null);
    assert.equal(
      (await owner(`${base}/command`, { ...save, id: process.id, revision: 0 }))
        .status,
      409,
    );
    const freeze = await admin(`${base}/command`, {
      ...target,
      type: "freezeDraft",
      id: process.id,
      revision: process.revision,
    });
    assert.equal(freeze.status, 200, JSON.stringify(freeze.data));
    const version = ProcessVersionSchema.parse(record(freeze.data).version);
    assert.equal(version.testStatus, "untested");
    const read = `${list}&id=${process.id}&version=1`;
    assert.equal(
      ProcessVersionSchema.parse(record((await owner(read)).data).version)
        .digest,
      version.digest,
    );
    const audit = AuditPage.parse(
      (await owner(`api/identity/audit?${query}`)).data,
    );
    const events = audit.entries.filter(
      (entry) => entry.action === "catalog.process_changed",
    );
    assert.equal(events.length, 2);
    assert.deepEqual(
      events.map((entry) => entry.details.processEvent),
      ["version_frozen", "draft_saved"],
    );
    const auditCount = events.length;
    for (let i = 0; i < 3; i++) assert.equal((await owner(read)).status, 200);
    assert.equal(
      AuditPage.parse(
        (await owner(`api/identity/audit?${query}`)).data,
      ).entries.filter((entry) => entry.action === "catalog.process_changed")
        .length,
      auditCount,
    );
    app.emit("close");
    await identity.close();
    identity = await openIdentity(config, options);
    app = createReferenceServer(config, {}, identity);
    assert.equal(
      ProcessVersionSchema.parse(record((await owner(read)).data).version)
        .digest,
      version.digest,
    );
    assert.equal(
      ProcessListSchema.parse((await owner(list)).data).processes[0]!
        .activeVersion,
      null,
    );
    assert.equal(externalCalls, 0);
  } finally {
    app.emit("close");
    await identity.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    rmSync(root, { recursive: true, force: true });
  }
});
