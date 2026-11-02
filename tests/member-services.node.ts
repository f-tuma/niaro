import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CatalogCommand } from "../packages/protocol/service-catalog";
import {
  MemberServiceList,
  type MemberService,
} from "../packages/protocol/member-services";
import { PersonalServicePermissions } from "../packages/protocol/service-oauth";
import { ServiceOAuthStore } from "../apps/server-identity/service-oauth";
import {
  ServiceCatalogStore,
  type CatalogActor,
  type StoredInvocation,
} from "../apps/server-identity/service-catalog";
import {
  CatalogController,
  type CatalogContext,
} from "../apps/server-identity/catalog-controller";
import { IdentityError } from "../apps/server-identity/error";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

const target = {
  organizationId: "TEST-org",
  workspaceId: "11111111-1111-4111-8111-111111111111",
};
const otherWorkspace = "22222222-2222-4222-8222-222222222222";
const sharedKey = "TEST-shared-key-never-shown";
const code = (name: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === name;

function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT,name TEXT);
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT);
    INSERT INTO organization VALUES ('TEST-org');
    INSERT INTO user VALUES ('TEST-owner','TEST owner'),('TEST-alice','TEST alice'),('TEST-bob','TEST bob');
    INSERT INTO agent_workspace VALUES ('${target.workspaceId}','TEST-org','TEST workspace'),('${otherWorkspace}','TEST-org','TEST other');
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
  const command = (body: object) =>
    catalog.command(CatalogCommand.parse({ ...target, ...body }));
  const service = (
    name: string,
    options: {
      enabled?: boolean;
      access?: { roles: CatalogActor["role"][]; workspaceRoles: string[] };
    } = {},
  ) =>
    command({
      type: "saveService",
      revision: 0,
      settings: {
        name,
        url: `https://${name.replace(/\W/g, "").toLowerCase()}.example.test/v1`,
        protocol: "openapi",
        icon: "database",
        auth: { type: "bearer" },
        enabled: options.enabled ?? true,
        ...(options.access ? { access: options.access } : {}),
      },
      apiKey: sharedKey,
    });
  const action = (
    serviceId: string,
    effect: "read" | "write",
    name: string,
    roles: CatalogActor["role"][] = ["owner", "admin", "member"],
  ) =>
    command({
      type: "saveAction",
      serviceId,
      serviceRevision: catalog.service(target.workspaceId, serviceId).revision,
      revision: 0,
      settings: {
        name,
        description: `${name} description`,
        inputSchema: { type: "object", properties: {} },
        binding: {
          type: "http",
          method: effect === "read" ? "GET" : "POST",
          path: "/items",
          parameters: [],
          body: effect === "write",
        },
        effect,
        approval: "always",
        enabled: true,
        policy: { roles, users: [] },
      },
    });
  const signIn = (serviceId: string, requiredFor: "writes" | "all") => {
    const oauthTarget = catalog.oauthTarget(target.workspaceId, serviceId);
    oauth.save(
      oauthTarget,
      oauth.config(oauthTarget).revision,
      { requiredFor, signInHint: "service" },
      { clientId: "TEST-client-id", clientSecret: "TEST-client-secret" },
    );
  };
  const ready = (serviceId: string) => {
    const oauthTarget = catalog.oauthTarget(target.workspaceId, serviceId);
    const issuer = new URL(oauthTarget.serviceUrl).origin;
    oauth.setDiscovery(oauthTarget, oauth.config(oauthTarget).revision, {
      issuer,
      authorizationEndpoint: `${issuer}/authorize`,
      tokenEndpoint: `${issuer}/token`,
      registrationEndpoint: null,
      scopes: ["api"],
      tokenEndpointAuthMethods: ["client_secret_post"],
      authorizationResponseIssParameterSupported: true,
    });
  };
  const own = (userId: string, name: string, status: "pending" | "active") => {
    const id = catalog.addPersonalService(
      target.workspaceId,
      userId,
      {
        name,
        url: `https://${name.replace(/\W/g, "").toLowerCase()}.example.test/v1`,
        protocol: "openapi",
        auth: { type: "none" },
      },
      undefined,
      status,
    );
    catalog.importPersonalActions(
      target.workspaceId,
      id,
      catalog.service(target.workspaceId, id).revision,
      [
        {
          sourceKey: `openapi:GET /${name}`,
          name: `${name} list`,
          description: "",
          inputSchema: { type: "object", properties: {} },
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
          policy: { roles: [], users: [] },
        },
      ],
      [],
    );
    return id;
  };
  const receipt = (
    userId: string,
    serviceId: string,
    effect: "read" | "write",
    status: StoredInvocation["status"],
    completedAt: number,
    patch: Partial<StoredInvocation> = {},
  ) =>
    catalog.saveInvocation({
      id: `TEST-${userId}-${serviceId}-${completedAt}`,
      organizationId: target.organizationId,
      workspaceId: target.workspaceId,
      userId,
      serviceId,
      actionId: "TEST-action",
      serviceRevision: 1,
      actionRevision: 1,
      policyRevision: 0,
      input: { query: "TEST secret input" },
      status,
      title: "TEST title",
      serviceName: "TEST name",
      effect,
      result: { value: "TEST private result" },
      completedAt,
      ...(status === "failed"
        ? {
            failure: {
              code: "TEST_failure",
              kind: "connection" as const,
              stage: "dispatch" as const,
              retry: "later" as const,
              message: "TEST provider message",
              fields: [],
            },
          }
        : {}),
      ...patch,
    });

  let userId = "TEST-alice",
    role: CatalogActor["role"] = "member",
    sessionUser: string | undefined;
  let queue: Promise<unknown> = Promise.resolve();
  const context = (session = true): CatalogContext => ({
    serial: (run) => {
      const pending = queue.then(run);
      queue = pending.catch(() => {});
      return pending;
    },
    actor: async () => ({ userId, role }),
    ...(session
      ? {
          session: async () => ({
            userId: sessionUser ?? userId,
            sessionId: `session-${userId}`,
          }),
        }
      : {}),
    epoch: () => 0,
    change: () => {},
    audit: () => 0,
    finish: () => {},
    transaction: async (run) => run(),
  });
  const controller = new CatalogController(catalog, async () => {
    throw Error("TEST no network");
  });
  const call = (path: string, body: object = {}, session = true) =>
    controller.handle(
      "POST",
      new URL(`https://agent.example.test/admin/api/identity/catalog/${path}`),
      { ...target, ...body },
      context(session),
      new AbortController().signal,
    );
  const list = async () =>
    MemberServiceList.parse(await call("member/services"));
  return {
    db,
    oauth,
    catalog,
    command,
    service,
    action,
    signIn,
    ready,
    own,
    receipt,
    call,
    list,
    as: (next: string, nextRole: CatalogActor["role"] = "member") => {
      userId = next;
      role = nextRole;
      sessionUser = undefined;
    },
    impersonate: (next: string) => {
      sessionUser = next;
    },
  };
}

const byName = (services: MemberService[]) =>
  Object.fromEntries(services.map((service) => [service.name, service]));

test("member projection: every usable service with the account it reads with, own outcomes only and nothing secret", async () => {
  const h = fixture();
  try {
    const crm = h.service("TEST CRM");
    const crmRead = h.action(crm, "read", "TEST find contacts");
    h.action(crm, "write", "TEST update contact", ["owner", "admin"]);
    const mail = h.service("TEST mail");
    const mailRead = h.action(mail, "read", "TEST read mail", ["owner"]);
    const mailWrite = h.action(mail, "write", "TEST send mail", ["owner"]);
    h.signIn(mail, "all");
    h.ready(mail);
    const tracker = h.service("TEST tracker");
    h.action(tracker, "read", "TEST list issues");
    h.action(tracker, "write", "TEST file issue", []);
    h.signIn(tracker, "writes");
    const hidden = h.service("TEST hidden");
    h.action(hidden, "read", "TEST owner only", ["owner"]);
    const off = h.service("TEST off", { enabled: false });
    h.action(off, "read", "TEST off read");
    const gated = h.service("TEST gated", {
      access: { roles: ["owner"], workspaceRoles: [] },
    });
    h.action(gated, "read", "TEST gated read");
    const aliceOwn = h.own("TEST-alice", "TEST alice notes", "active");
    h.own("TEST-alice", "TEST alice pending", "pending");
    const bobOwn = h.own("TEST-bob", "TEST bob notes", "active");

    // Alice's own receipts, Bob's later ones, and Alice's in another workspace.
    h.receipt("TEST-alice", crm, "read", "succeeded", 1_000);
    h.receipt("TEST-alice", crm, "read", "succeeded", 2_000);
    h.receipt("TEST-alice", crm, "read", "failed", 3_000);
    h.receipt("TEST-alice", crm, "write", "succeeded", 4_000);
    h.receipt("TEST-alice", crm, "write", "unknown", 5_000);
    h.receipt("TEST-alice", mail, "read", "awaiting_approval", 6_000);
    h.receipt("TEST-alice", aliceOwn, "read", "succeeded", 7_000);
    h.receipt("TEST-bob", crm, "read", "succeeded", 9_000);
    h.receipt("TEST-bob", crm, "read", "failed", 9_500);
    h.receipt("TEST-bob", bobOwn, "read", "succeeded", 9_700);
    h.receipt("TEST-alice", crm, "read", "succeeded", 9_900, {
      id: "TEST-elsewhere",
      workspaceId: otherWorkspace,
    });

    const alice = await h.list();
    assert.deepEqual(alice.services.map((s) => s.name).sort(), [
      "TEST CRM",
      "TEST alice notes",
      "TEST mail",
      "TEST tracker",
    ]);
    const seen = byName(alice.services);
    // Company account: reads with the shared credential, no sign-in, and
    // only what the member may run.
    assert.deepEqual(seen["TEST CRM"], {
      serviceId: crm,
      name: "TEST CRM",
      icon: "database",
      iconSource: "favicon",
      own: false,
      reads: {
        account: "company",
        actions: [
          {
            id: crmRead,
            name: "TEST find contacts",
            description: "TEST find contacts description",
          },
        ],
      },
      changes: { account: "company", actions: [] },
      signIn: null,
      lastRead: { at: 2_000 },
      lastFailure: { at: 3_000, kind: "connection" },
    });
    // Own account for everything: the person's defaults let both run.
    const mailView = seen["TEST mail"]!;
    assert.equal(mailView.reads.account, "own");
    assert.equal(mailView.changes.account, "own");
    assert.deepEqual(
      [mailView.reads.actions, mailView.changes.actions].map((a) =>
        a.map((x) => x.id),
      ),
      [[mailRead], [mailWrite]],
    );
    assert.equal(mailView.signIn, "disconnected");
    assert.equal(mailView.lastRead, null);
    assert.equal(mailView.lastFailure, null);
    // Reads with the company account, changes with the person's own.
    const trackerView = seen["TEST tracker"]!;
    assert.equal(trackerView.reads.account, "company");
    assert.equal(trackerView.changes.account, "own");
    assert.equal(trackerView.signIn, "not_ready");
    assert.equal(trackerView.reads.actions.length, 1);
    // The person's own service.
    const ownView = seen["TEST alice notes"]!;
    assert.equal(ownView.own, true);
    assert.equal(ownView.reads.account, "own");
    assert.equal(ownView.signIn, null);
    assert.deepEqual(ownView.lastRead, { at: 7_000 });

    // Nothing of the configuration, the credential or the receipts' content.
    const wire = JSON.stringify(alice);
    for (const secret of [
      sharedKey,
      "TEST-client-id",
      "TEST-client-secret",
      "example.test",
      "TEST secret input",
      "TEST private result",
      "TEST provider message",
      "TEST_failure",
      "/authorize",
      "9000",
      "9500",
      "9900",
      "TEST-bob",
      "policy",
    ])
      assert(!wire.includes(secret), `leaked ${secret}`);

    // Bob sees his own outcomes and his own service, not Alice's.
    h.as("TEST-bob");
    const bob = byName((await h.list()).services);
    assert.deepEqual(bob["TEST CRM"]!.lastRead, { at: 9_000 });
    assert.deepEqual(bob["TEST CRM"]!.lastFailure, {
      at: 9_500,
      kind: "connection",
    });
    assert.equal(bob["TEST alice notes"], undefined);
    assert.deepEqual(bob["TEST bob notes"]!.lastRead, { at: 9_700 });

    // An owner sees what owners may run, still only their own outcomes.
    h.as("TEST-owner", "owner");
    const owner = byName((await h.list()).services);
    assert.deepEqual(Object.keys(owner).sort(), [
      "TEST CRM",
      "TEST gated",
      "TEST hidden",
      "TEST mail",
      "TEST tracker",
    ]);
    assert.equal(owner["TEST CRM"]!.changes.actions.length, 1);
    assert.equal(owner["TEST CRM"]!.lastRead, null);
  } finally {
    h.db.close();
  }
});

test("member projection: switched-off actions keep the service listed; account sessions only", async () => {
  const h = fixture();
  try {
    const mail = h.service("TEST mail");
    const read = h.action(mail, "read", "TEST read mail");
    h.signIn(mail, "all");
    h.ready(mail);
    const permissions = PersonalServicePermissions.parse(
      await h.call("oauth/permissions", { serviceId: mail }),
    );
    await h.call("oauth/permissions/save", {
      serviceId: mail,
      revision: permissions.revision,
      actions: [{ actionId: read, enabled: false, approval: "never" }],
    });
    const [view] = (await h.list()).services;
    assert.equal(view?.name, "TEST mail");
    assert.deepEqual(view?.reads, { account: "own", actions: [] });
    // A disabled service is gone for everyone.
    const settings = h.catalog.service(target.workspaceId, mail);
    h.command({
      type: "saveService",
      id: mail,
      revision: settings.revision,
      settings: {
        name: settings.name,
        url: settings.url,
        protocol: settings.protocol,
        icon: settings.icon,
        iconSource: settings.iconSource,
        auth: settings.auth,
        enabled: false,
      },
    });
    assert.deepEqual((await h.list()).services, []);

    await assert.rejects(
      h.call("member/services", {}, false),
      code("identity_account_required"),
    );
    h.impersonate("TEST-bob");
    await assert.rejects(h.list(), code("identity_forbidden"));
  } finally {
    h.db.close();
  }
});

test(
  "member projection over the web and app APIs",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const ok = (response: { status: number; data: unknown }) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return response.data;
      };
      const web = MemberServiceList.parse(
        ok(
          await h.request(
            "member",
            "api/identity/catalog/member/services",
            h.target,
          ),
        ),
      );
      assert.deepEqual(
        web.services.map((service) => [
          service.serviceId,
          service.reads.account,
          service.signIn,
        ]),
        [[h.serviceId, "company", null]],
      );
      assert.equal(
        (
          await h.request(
            "anonymous",
            "api/identity/catalog/member/services",
            h.target,
          )
        ).status,
        401,
      );

      const member = await h.pair("member");
      assert.equal((await h.mobile(undefined, "services")).status, 401);
      assert.equal((await h.mobile(member, "services?x=1")).status, 400);
      assert.equal((await h.mobile(member, "services", {})).status, 405);
      const app = MemberServiceList.parse(
        ok(await h.mobile(member, "services")),
      );
      assert.deepEqual(app, web);
      assert(!JSON.stringify(app).includes("services.example.test"));
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);
