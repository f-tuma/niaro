import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  PersonalServicePermissions,
  PersonalSignInList,
} from "../packages/protocol/service-oauth";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import {
  ServiceCatalogStore,
  type CatalogActor,
} from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import {
  PROCESS_TEST_SCENARIOS,
  ServiceProcessStore,
  type ProcessActor,
} from "../apps/server-identity/service-processes";
import { WorkspacePluginStore } from "../apps/server-identity/workspace-plugins";
import { AuditStore } from "../apps/server-identity/audit";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import { designCapabilities } from "../apps/server-identity/process-design-capabilities";
import { connectorTools } from "../apps/server-identity/mcp-connector";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { processObject, processWorkflow } from "./helpers/service-process";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const scopeFor = (userId: string) => ({
  serverId: "TEST-server",
  connectionId: "TEST-connection",
  workspaceId: target.workspaceId,
  userId,
});
const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;

/**
 * A service whose actions an administrator granted only to owners/admins and
 * set to run writes without approval: under personal sign-in neither applies,
 * the service gate and each person's own choices do.
 */
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    INSERT INTO organization VALUES ('TEST-org');
    INSERT INTO user VALUES ('TEST-owner','TEST owner'),('TEST-alice','TEST alice'),('TEST-bob','TEST bob');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST workspace');
    INSERT INTO member VALUES ('m1','TEST-org','TEST-owner'),('m2','TEST-org','TEST-alice'),('m3','TEST-org','TEST-bob');`);
  const oauth = new ServiceOAuthStore(
    db,
    "TEST-only-encryption-secret",
    "https://agent.example.test",
  );
  const catalog = new ServiceCatalogStore(
    db,
    "TEST-only-encryption-secret",
    [],
    oauth,
  );
  const audit = new AuditStore(db);
  const plugins = new WorkspacePluginStore(db, {
    enabled: ["memory"],
    timeZone: "UTC",
  });
  const registry = new ServiceProcessStore(db, catalog, plugins, (record) => {
    audit.append(record);
  });
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  const serviceId = command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST mail",
      url: "https://mail.example.test/v1",
      protocol: "openapi",
      icon: "mail",
      auth: { type: "none" },
      enabled: true,
    },
  });
  const action = (effect: "read" | "write", name = `TEST ${effect}`) =>
    command({
      type: "saveAction",
      serviceId,
      serviceRevision: catalog.service(target.workspaceId, serviceId).revision,
      revision: 0,
      settings: {
        name,
        description: `TEST ${effect} description`,
        inputSchema: processObject({ name: { type: "string" } }),
        binding: {
          type: "http",
          method: effect === "read" ? "GET" : "POST",
          path: "/items",
          parameters: [],
          body: effect === "write",
        },
        effect,
        approval: "never",
        enabled: true,
        policy: { roles: ["owner", "admin"], users: [] },
      },
    });
  const readId = action("read"),
    writeId = action("write");
  const service = () => catalog.service(target.workspaceId, serviceId);
  const actionOf = (id: string) => service().actions.find((a) => a.id === id)!;
  const signIn = (requiredFor: "none" | "writes" | "all") => {
    const oauthTarget = catalog.oauthTarget(target.workspaceId, serviceId);
    oauth.save(oauthTarget, oauth.config(oauthTarget).revision, {
      requiredFor,
      signInHint: "service",
    });
  };
  let userId = "TEST-alice",
    role: CatalogActor["role"] = "member",
    epoch = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const context: CatalogContext = {
    serial: (run) => {
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },
    actor: async (value) => {
      assert.equal(value.organizationId, target.organizationId);
      assert.equal(value.workspaceId, target.workspaceId);
      return { userId, role };
    },
    session: async () => ({ userId, sessionId: `session-${userId}` }),
    epoch: () => epoch,
    change: () => {
      epoch++;
    },
    audit: (record) => audit.append(record),
    finish: (id, outcome, details) => audit.finish(id, outcome, details),
    transaction: async (run) => {
      db.exec("BEGIN");
      try {
        const value = await run();
        db.exec("COMMIT");
        return value;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const controller = new CatalogController(catalog, async () => {
    throw Error("TEST no network");
  });
  const call = (path: string, body: object) =>
    controller.handle(
      "POST",
      new URL(`https://agent.example.test/admin/api/identity/catalog/${path}`),
      { ...target, ...body },
      context,
      new AbortController().signal,
    );
  const permissions = async () =>
    PersonalServicePermissions.parse(
      await call("oauth/permissions", { serviceId }),
    );
  const save = async (
    actions: { actionId: string; enabled: boolean; approval: string }[],
    revision?: number,
  ) =>
    PersonalServicePermissions.parse(
      await call("oauth/permissions/save", {
        serviceId,
        revision: revision ?? (await permissions()).revision,
        actions,
      }),
    );
  const actor = (): CatalogActor => ({ userId, role });
  const processActor = (): ProcessActor => ({ ...target, userId, role });
  return {
    db,
    oauth,
    catalog,
    registry,
    audit,
    plugins,
    command,
    serviceId,
    readId,
    writeId,
    service,
    actionOf,
    signIn,
    call,
    permissions,
    save,
    actor,
    processActor,
    epoch: () => epoch,
    as: (next: string, nextRole: CatalogActor["role"] = "member") => {
      userId = next;
      role = nextRole;
    },
  };
}

test("effective policy: shared roles and approval, personal choices, mixed per effect", () => {
  const h = fixture();
  try {
    const { catalog, readId, writeId, serviceId } = h;
    const ws = target.workspaceId;
    // Shared: the administrator's role grants and approval apply.
    assert.equal(catalog.allowed(h.actionOf(readId), h.actor()), false);
    h.as("TEST-owner", "owner");
    assert.equal(catalog.allowed(h.actionOf(writeId), h.actor()), true);
    assert.equal(
      catalog.effectiveAction(ws, serviceId, h.actionOf(writeId), "TEST-owner")
        .approval,
      "never",
    );
    assert.equal(catalog.personalAction(ws, serviceId, "write"), false);

    // Personal for everything: the service gate admits the member, their own
    // defaults apply (reads on, writes on but confirmed), role grants do not.
    h.signIn("all");
    h.as("TEST-alice");
    assert.equal(catalog.allowed(h.actionOf(readId), h.actor()), true);
    assert.equal(catalog.allowed(h.actionOf(writeId), h.actor()), true);
    const effective = catalog.serviceFor(ws, serviceId, "TEST-alice");
    assert.deepEqual(
      effective.actions.map((a) => [a.effect, a.approval]).sort(),
      [
        ["read", "never"],
        ["write", "always"],
      ],
    );

    // Mixed: reads stay shared (roles deny the member), writes are personal.
    h.signIn("writes");
    assert.equal(catalog.allowed(h.actionOf(readId), h.actor()), false);
    assert.equal(catalog.allowed(h.actionOf(writeId), h.actor()), true);
    assert.equal(
      catalog.effectiveAction(ws, serviceId, h.actionOf(readId), "TEST-alice")
        .approval,
      "never",
    );
    assert.equal(
      catalog.effectiveAction(ws, serviceId, h.actionOf(writeId), "TEST-alice")
        .approval,
      "always",
    );
    // A member's catalog view carries the same effective approval.
    const view = catalog
      .inventory(target.organizationId, ws, h.actor())
      .services.find((s) => s.id === serviceId)!;
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.approval]),
      [[writeId, "always"]],
    );
  } finally {
    h.db.close();
  }
});

test("defaults, own changes, idempotent revisions, isolation and audit without an epoch move", async () => {
  const h = fixture();
  try {
    h.signIn("all");
    const initial = await h.permissions();
    assert.equal(initial.revision, 0);
    assert.equal(initial.requiredFor, "all");
    assert.deepEqual(
      initial.actions.map((a) => [a.effect, a.enabled, a.approval]).sort(),
      [
        ["read", true, "never"],
        ["write", true, "always"],
      ],
    );
    const change = [
      { actionId: h.writeId, enabled: true, approval: "never" },
      { actionId: h.readId, enabled: false, approval: "never" },
    ];
    const saved = await h.save(change, 0);
    assert.equal(saved.revision, 1);
    // A retry of the same request after a lost response is harmless.
    assert.equal((await h.save(change, 0)).revision, 1);
    // A different change from a stale view is refused.
    await assert.rejects(
      h.save([{ actionId: h.writeId, enabled: false, approval: "never" }], 0),
      code("personal_policy_conflict"),
    );
    // Reads never ask, whatever is sent.
    await h.save([{ actionId: h.readId, enabled: true, approval: "always" }]);
    assert.equal(
      (await h.permissions()).actions.find((a) => a.id === h.readId)?.approval,
      "never",
    );
    assert.equal(
      h.catalog.allowed(h.actionOf(h.writeId), h.actor()) &&
        h.catalog.effectiveAction(
          target.workspaceId,
          h.serviceId,
          h.actionOf(h.writeId),
          "TEST-alice",
        ).approval,
      "never",
    );
    assert.equal(h.epoch(), 0);
    const entries = h.db
      .prepare(
        "SELECT actor_id FROM agent_audit WHERE action='catalog.personal_policy_changed'",
      )
      .all();
    assert.equal(entries.length, 2);
    assert.ok(entries.every((e) => e.actor_id === "TEST-alice"));

    // Bob keeps his own defaults; the session decides whose choices change.
    h.as("TEST-bob");
    const bob = await h.permissions();
    assert.equal(bob.revision, 0);
    assert.equal(
      bob.actions.find((a) => a.id === h.writeId)?.approval,
      "always",
    );
    await h.save([{ actionId: h.writeId, enabled: false, approval: "always" }]);
    assert.equal(h.catalog.allowed(h.actionOf(h.writeId), h.actor()), false);
    h.as("TEST-alice");
    assert.equal(h.catalog.allowed(h.actionOf(h.writeId), h.actor()), true);

    // Disconnecting keeps the choices; reconnecting restores them.
    h.oauth.disconnect(
      h.catalog.oauthTarget(target.workspaceId, h.serviceId),
      "TEST-alice",
      0,
    );
    assert.equal(
      (await h.permissions()).actions.find((a) => a.id === h.writeId)?.approval,
      "never",
    );
  } finally {
    h.db.close();
  }
});

test("administrators set the ceiling and who may connect; shared services have no personal settings", async () => {
  const h = fixture();
  try {
    await assert.rejects(h.permissions(), code("catalog_not_found"));
    h.signIn("all");
    // Blocked by the administrator: gone for everyone, and not settable.
    const write = h.actionOf(h.writeId);
    h.command({
      type: "updateActions",
      serviceId: h.serviceId,
      serviceRevision: h.service().revision,
      actions: [{ id: write.id, revision: write.revision }],
      patch: { enabled: false },
    });
    assert.deepEqual(
      (await h.permissions()).actions.map((a) => a.id),
      [h.readId],
    );
    await assert.rejects(
      h.save([{ actionId: h.writeId, enabled: true, approval: "never" }]),
      code("catalog_not_found"),
    );
    // The service gate decides who may connect at all.
    const settings = h.service();
    h.command({
      type: "saveService",
      id: h.serviceId,
      revision: settings.revision,
      settings: {
        name: settings.name,
        url: settings.url,
        protocol: settings.protocol,
        icon: settings.icon,
        iconSource: settings.iconSource,
        auth: settings.auth,
        enabled: true,
        access: { roles: ["owner"], workspaceRoles: [] },
      },
    });
    await assert.rejects(h.permissions(), code("catalog_not_found"));
    assert.equal(h.catalog.allowed(h.actionOf(h.readId), h.actor()), false);
    assert.deepEqual(
      PersonalSignInList.parse(await h.call("oauth/list", {})).services,
      [],
    );
    h.as("TEST-owner", "owner");
    assert.equal((await h.permissions()).actions.length, 1);
    // Switching everything off keeps the service in the person's list.
    await h.save([{ actionId: h.readId, enabled: false, approval: "never" }]);
    assert.deepEqual(
      PersonalSignInList.parse(await h.call("oauth/list", {})).services.map(
        (s) => s.serviceId,
      ),
      [h.serviceId],
    );
    // Removing the service forgets everyone's choices.
    h.command({
      type: "removeService",
      id: h.serviceId,
      revision: h.service().revision,
    });
    assert.equal(
      h.db
        .prepare("SELECT COUNT(*) AS n FROM agent_personal_action_policy")
        .get()?.n,
      0,
    );
  } finally {
    h.db.close();
  }
});

test("chat and MCP exposure follow the person's own switches and approval", async () => {
  const h = fixture();
  try {
    h.signIn("all");
    const exposed = () => {
      // The same composition chat (mastra-domain) and @mentions use.
      const raw = h.catalog.inventory(
        target.organizationId,
        target.workspaceId,
        {
          ...h.actor(),
          role: "owner",
        },
      );
      return raw.services.flatMap((s) =>
        s.actions
          .filter((a) => a.enabled && h.catalog.allowed(a, h.actor()))
          .map((a) => a.id),
      );
    };
    const mcpNotes = () =>
      connectorTools(
        h.catalog.servicesFor(
          target.workspaceId,
          h.catalog.inventory(
            target.organizationId,
            target.workspaceId,
            h.actor(),
          ).services,
          "TEST-alice",
        ),
        (action) => h.catalog.allowed(action, h.actor()),
      ).map((tool) => [
        tool.action.id,
        /approve each call/.test(tool.description),
      ]);
    assert.deepEqual(exposed().sort(), [h.readId, h.writeId].sort());
    assert.deepEqual(
      mcpNotes().sort(),
      [
        [h.readId, false],
        [h.writeId, true],
      ].sort(),
    );
    await h.save([{ actionId: h.writeId, enabled: true, approval: "never" }]);
    assert.deepEqual(
      mcpNotes().find(([id]) => id === h.writeId),
      [h.writeId, false],
    );
    await h.save([{ actionId: h.readId, enabled: false, approval: "never" }]);
    assert.deepEqual(exposed(), [h.writeId]);
    assert.deepEqual(
      mcpNotes().map(([id]) => id),
      [h.writeId],
    );
  } finally {
    h.db.close();
  }
});

test("designer offers only the person's enabled actions with their approval", async () => {
  const h = fixture();
  try {
    h.signIn("all");
    const offered = () =>
      designCapabilities(
        h.catalog,
        h.plugins,
        h.processActor(),
      ).services.flatMap((s) =>
        s.actions.map((a) => [a.id, a.approval] as const),
      );
    assert.deepEqual(
      offered().sort(),
      [
        [h.readId, "never"],
        [h.writeId, "always"],
      ].sort(),
    );
    await h.save([{ actionId: h.writeId, enabled: true, approval: "never" }]);
    assert.deepEqual(
      offered().find(([id]) => id === h.writeId),
      [h.writeId, "never"],
    );
    await h.save([{ actionId: h.writeId, enabled: false, approval: "never" }]);
    assert.deepEqual(
      offered().map(([id]) => id),
      [h.readId],
    );
    // Someone else's choices never change what Alice is offered.
    h.as("TEST-bob");
    assert.equal(offered().length, 2);
  } finally {
    h.db.close();
  }
});

test("processes run under the starting person's choices: inventory, hub and run checks", async () => {
  const h = fixture();
  try {
    const owner: ProcessActor = {
      ...target,
      userId: "TEST-owner",
      role: "owner",
    };
    const base = processWorkflow(h.serviceId, h.readId);
    assert(base.kind === "workflow");
    const readWrite = ProcessDefinitionSchema.parse({
      ...base,
      steps: [
        { ...base.steps[0], next: "write" },
        {
          ...base.steps[0],
          id: "write",
          actionId: h.writeId,
          input: {
            name: { source: "step", stepId: "lookup", path: ["value"] },
          },
          next: "done",
        },
        base.steps[1],
      ],
    });
    h.signIn("all");
    // A workspace process: an administrator activates it once; each person
    // who starts it does so under their own choices.
    const draft = h.registry.saveDraft(owner, {
      serviceId: h.serviceId,
      revision: 0,
      definition: readWrite,
    });
    const version = h.registry.freezeDraft(owner, draft.id, draft.revision);
    h.registry.recordTest(owner, draft.id, version.version, {
      testId: `TEST-${draft.id}`,
      digest: version.digest,
      runnerVersion: "TEST-offline/1",
      passed: true,
      scenarios: [...PROCESS_TEST_SCENARIOS],
      reportDigest: processDigest({ fixture: true }),
    });
    h.registry.activate(
      owner,
      draft.id,
      h.registry.get(owner, draft.id).revision,
      version.version,
    );
    const expected = {
      version: version.version,
      artifactDigest: version.digest,
    };
    const entry = () =>
      h.registry
        .executionInventory(h.processActor(), scopeFor("TEST-alice"))
        .processes.find((p) => p.processId === draft.id);
    const unattended = () =>
      h.registry.unattendedEffect(h.processActor(), draft.id, expected);

    // Defaults: the write waits for Alice, so the hub may run it.
    assert.ok(entry());
    assert.equal(unattended(), "approval");
    // "Don't ask" makes it an unattended write: the hub no longer runs it.
    await h.save([{ actionId: h.writeId, enabled: true, approval: "never" }]);
    assert.equal(unattended(), "write");
    // Bob's defaults are unaffected.
    h.as("TEST-bob");
    assert.equal(unattended(), "approval");
    h.as("TEST-alice");

    // Switched off: still listed for Alice, but blocked; dispatch is denied.
    await h.save([{ actionId: h.writeId, enabled: false, approval: "never" }]);
    const blocked = entry();
    assert.equal(blocked?.availability, "blocked");
    assert.equal(
      blocked?.availability === "blocked" && blocked.reason,
      "service_unavailable",
    );
    const write = h.actionOf(h.writeId);
    assert.throws(
      () =>
        h.catalog.authorize(
          target.workspaceId,
          h.serviceId,
          h.service().revision,
          write.id,
          write.revision,
          h.actor(),
        ),
      code("catalog_action_denied"),
    );
    // Turning it back on lets the process start again (still needs sign-in).
    await h.save([{ actionId: h.writeId, enabled: true, approval: "always" }]);
    const ready = entry();
    assert.equal(
      ready?.availability === "blocked" && ready.reason,
      "connection_required",
    );
  } finally {
    h.db.close();
  }
});

test("a personal process can only be saved and frozen with actions its owner allows", async () => {
  const h = fixture();
  try {
    h.signIn("all");
    const alice = h.processActor();
    const save = (revision: number, id?: string) =>
      h.registry.saveWorkspaceDraft(alice, {
        ...(id ? { id } : {}),
        owner: { type: "user" },
        revision,
        definition: processWorkflow(h.serviceId, h.readId),
      });
    await h.save([{ actionId: h.readId, enabled: false, approval: "never" }]);
    assert.throws(() => save(0), code("process_definition_invalid"));
    await h.save([{ actionId: h.readId, enabled: true, approval: "never" }]);
    const draft = save(0);
    await h.save([{ actionId: h.readId, enabled: false, approval: "never" }]);
    assert.throws(
      () => h.registry.freezeDraft(alice, draft.id, draft.revision),
      code("process_definition_invalid"),
    );
    await h.save([{ actionId: h.readId, enabled: true, approval: "never" }]);
    assert.equal(
      h.registry.freezeDraft(alice, draft.id, draft.revision).version,
      1,
    );
  } finally {
    h.db.close();
  }
});
