import { seedIdentityFixture } from "./helpers/identity-seed";
import { processObject } from "./helpers/service-process";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerConfigSchema } from "../apps/reference-server/config";
import { createReferenceServer } from "../apps/reference-server/runtime";
import { openIdentity } from "../apps/server-identity/service";
import { issueAdminKey } from "../apps/server-admin/auth";
import { DEFAULT_PROCESS_LIMITS } from "../apps/server-identity/process-validation";
import {
  ConfigBundlePreview,
  ConfigBundleSchema,
  type ConfigBundle,
  type ConfigBundlePreview as Preview,
} from "../packages/protocol/config-bundle";
import { SKILLS_PROFILE } from "../packages/protocol/skills";
import { WORKSPACE_PROCESS_PROFILE } from "../packages/protocol/service-processes";

const password = "TEST-config-bundle-password-2026";
const PROVIDER_KEY = "TEST-provider-SECRET-7f3a";
const SERVICE_KEY = "TEST-service-SECRET-91bc";

type Client = (
  path: string,
  input?: unknown,
) => Promise<{ status: number; headers: Headers; data: any }>;

/** One reference server with its own data, owner and workspace. */
async function startServer(label: string, workspaceName: string) {
  const root = mkdtempSync(join(tmpdir(), `config-bundle-${label}-`));
  let app: ReturnType<typeof createReferenceServer>;
  const server = createServer((req, res) => app.emit("request", req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  // A failed setup must not keep the test process alive.
  server.unref();
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: `TEST ${label}`,
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: [],
    plugins: { enabled: ["datetime"], timeZone: "Europe/Prague" },
    administration: {
      keyFile: join(root, "key"),
      identity: {
        directory: join(root, "identity"),
        baseURL: origin,
        hub: { scheduler: { intervalSeconds: 0 } },
      },
    },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });
  const key = issueAdminKey(config.administration!.keyFile);
  const identity = await openIdentity(config, {
    hosting: { autostart: false },
  });
  app = createReferenceServer(config, {}, identity);
  const client = (): Client => {
    const cookies = new Map<string, string>();
    return async (path, input) => {
      const res = await fetch(origin + "/" + path, {
        method: input === undefined ? "GET" : "POST",
        signal: AbortSignal.timeout(20000),
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
      return {
        status: res.status,
        headers: res.headers,
        data: await res.json().catch(() => null),
      };
    };
  };
  const owner = client(),
    member = client(),
    operator = client();
  await operator("admin/api/login", { key });
  assert.equal(
    (
      await operator("admin/api/identity/bootstrap", {
        name: "TEST Owner",
        email: `owner-${label}@example.test`,
        password,
        organizationName: `TEST ${label}`,
      })
    ).status,
    200,
  );
  await owner("admin/auth/sign-in/email", {
    email: `owner-${label}@example.test`,
    password,
  });
  const organizationId: string = (await owner("admin/api/identity")).data
    .organizations[0].id;
  await owner("admin/api/identity/command", {
    organizationId,
    type: "createWorkspace",
    name: workspaceName,
  });
  const detail = (
    await owner(`admin/api/identity/organization?id=${organizationId}`)
  ).data;
  const workspaceId: string = detail.workspaces.find(
    (w: { name: string }) => w.name === workspaceName,
  ).id;
  await seedIdentityFixture(identity, {
    organizationId,
    type: "createAccount",
    name: "TEST member",
    email: `member-${label}@example.test`,
    password,
    role: "member",
  });
  await member("admin/auth/sign-in/email", {
    email: `member-${label}@example.test`,
    password,
  });
  const target = { organizationId, workspaceId };
  const ok = async (path: string, input?: unknown, who = owner) => {
    const response = await who(path, input);
    assert.equal(
      response.status,
      200,
      `${path}: ${JSON.stringify(response.data)}`,
    );
    return response.data;
  };
  return {
    origin,
    owner,
    member,
    target,
    ok,
    catalog: () =>
      ok(
        `admin/api/identity/catalog?organizationId=${organizationId}&workspaceId=${workspaceId}`,
      ),
    close: async () => {
      app.emit("close");
      await identity.close();
      await new Promise((r) => server.close(r));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const FORBIDDEN_KEY =
  /^(apiKey|key|token|accessToken|refreshToken|idToken|secret|clientSecret|password|credential|hasCredential|secretValues|cookie)$/i;
/** Every object key in a value, at any depth. */
function keys(value: unknown, path = ""): string[] {
  if (Array.isArray(value))
    return value.flatMap((item, i) => keys(item, `${path}[${i}]`));
  if (value && typeof value === "object")
    return Object.entries(value).flatMap(([k, v]) => [
      `${path}.${k}`,
      ...keys(v, `${path}.${k}`),
    ]);
  return [];
}
/** A bundle without the fields that name where and when it was exported. */
function comparable(bundle: ConfigBundle) {
  return {
    organization: bundle.organization,
    workspaces: bundle.workspaces.map((w) => w.sections),
  };
}
const section = (preview: Preview, key: string) => {
  const found = preview.sections.find((s) => s.key === key);
  assert(found, `section ${key}`);
  return found;
};

test(
  "configuration bundle: export without secrets, preview, confirmed import into a fresh server, conflicts, idempotent re-import and audit",
  { timeout: 180000 },
  async () => {
    const a = await startServer("source", "TEST Workspace");
    const b = await startServer("target", "TEST Other workspace");
    try {
      // --- A complete setup on the source server, through the console APIs.
      const command = (body: object) =>
        a.ok("admin/api/identity/catalog/command", { ...a.target, ...body });
      const providerId = (
        await command({
          type: "saveProvider",
          revision: 0,
          settings: {
            name: "TEST Models",
            url: "https://models.example.test/v1",
            enabled: true,
            dailyRequestLimit: 100,
          },
          apiKey: PROVIDER_KEY,
        })
      ).id;
      const modelId = (
        await command({
          type: "saveModel",
          revision: 0,
          settings: {
            providerId,
            name: "TEST Chat",
            model: "test/chat",
            enabled: true,
            tools: true,
            kind: "chat",
          },
        })
      ).id;
      await a.ok("admin/api/identity/command", {
        ...a.target,
        type: "saveWorkspaceRole",
        revision: 0,
        name: "TEST Sales",
        memberIds: [],
      });
      const roleId: string = (
        await a.ok(
          `admin/api/identity/organization?id=${a.target.organizationId}`,
        )
      ).workspaces.find((w: { id: string }) => w.id === a.target.workspaceId)
        .roles[0].id;
      const serviceId = (
        await command({
          type: "saveService",
          revision: 0,
          settings: {
            name: "TEST CRM",
            description: "Customers and deals",
            url: "https://crm.example.test/v1",
            protocol: "openapi",
            icon: "database",
            auth: { type: "bearer" },
            enabled: true,
          },
          apiKey: SERVICE_KEY,
        })
      ).id;
      let catalog = await a.catalog();
      const memberUser = (await a.member("admin/api/identity")).data.user.id;
      const actionId = (
        await command({
          type: "saveAction",
          serviceId,
          serviceRevision: catalog.services[0].revision,
          revision: 0,
          settings: {
            name: "TEST Find person",
            description: "Finds a person by name",
            inputSchema: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
              additionalProperties: false,
            },
            binding: {
              type: "http",
              method: "GET",
              path: "/people",
              parameters: [{ name: "name", in: "query", required: true }],
              body: false,
            },
            effect: "read",
            approval: "never",
            enabled: true,
            policy: {
              roles: ["owner", "admin", "member"],
              workspaceRoles: [roleId],
              // A grant to one person is never exported.
              users: [{ userId: memberUser, access: "deny" }],
            },
          },
        })
      ).id;
      catalog = await a.catalog();
      await command({
        type: "saveOrganizationModelPolicy",
        revision: 0,
        policy: {
          roles: { chat: { models: [modelId], tier: null, fallback: true } },
          tiers: [{ id: "fast", name: "Fast", models: [modelId] }],
        },
      });
      await command({
        type: "saveWorkspaceModelPolicy",
        revision: 0,
        policy: {
          roles: { background: { models: [], tier: "fast", fallback: false } },
          services: [
            {
              serviceId,
              route: { models: [modelId], tier: null, fallback: false },
            },
          ],
          options: { selector: { minConfidence: 0.9 } },
        },
      });
      catalog = await a.catalog();
      const model = catalog.models.find(
        (m: { id: string }) => m.id === modelId,
      );
      const provider = catalog.providers[0];
      await a.ok("admin/api/identity/catalog/budget", {
        ...a.target,
        revision: 0,
        settings: {
          mode: "enforce",
          maxTokens: 200000,
          maxCostMicros: 2000000,
          prices: [
            {
              modelId,
              modelRevision: model.revision,
              providerRevision: provider.revision,
              maxInputTokens: 128000,
              maxOutputTokens: 8000,
              inputMicrosPerMillion: 1500000,
              outputMicrosPerMillion: 6000000,
            },
          ],
        },
      });
      for (const [scope, text] of [
        [{ type: "organization" }, "TEST Default tone."],
        [
          { type: "workspace", workspaceId: a.target.workspaceId },
          "TEST Sales tone for {workspace.name}.",
        ],
      ] as const)
        await a.ok("admin/api/identity/instructions/command", {
          organizationId: a.target.organizationId,
          type: "save",
          scope,
          revision: 0,
          content: { text, starters: ["TEST Summarize my week"] },
        });
      await a.ok("admin/api/identity/plugins", {
        ...a.target,
        revision: 0,
        settings: { enabled: ["datetime"], timeZone: "Europe/London" },
      });
      await a.ok("admin/api/identity/skills/command", {
        ...a.target,
        profile: SKILLS_PROFILE,
        type: "save",
        revision: 0,
        owner: "workspace",
        content: {
          name: "TEST Offer letter",
          description: "Writes an offer in the company style",
          instructions: "Use the template and keep it short.",
          files: [{ name: "template.md", content: "Dear {name}," }],
        },
        enabled: true,
      });
      await a.ok(
        `admin/api/identity/catalog/processes/command?profile=${WORKSPACE_PROCESS_PROFILE}`,
        {
          ...a.target,
          profile: WORKSPACE_PROCESS_PROFILE,
          type: "saveDraft",
          owner: { type: "workspace" },
          revision: 0,
          definition: {
            schemaVersion: 1,
            kind: "workflow",
            name: "TEST Lookup",
            description: "Finds a person",
            trigger: "manual",
            inputSchema: processObject({ name: { type: "string" } }),
            outputSchema: processObject({ result: { type: "string" } }),
            limits: { ...DEFAULT_PROCESS_LIMITS, maxModelCalls: 0 },
            entry: "find",
            steps: [
              {
                id: "find",
                type: "action",
                serviceId,
                actionId,
                input: { name: { source: "input", path: ["name"] } },
                outputSchema: processObject({ value: { type: "string" } }),
                next: "done",
              },
              {
                id: "done",
                type: "return",
                output: {
                  result: { source: "step", stepId: "find", path: ["value"] },
                },
              },
            ],
          },
        },
      );

      // --- Export: owners and administrators only, a download, no secrets.
      // Setup made a workspace named after the organization; this bundle
      // holds the one configured above.
      const exportPath = `admin/api/identity/config-bundle/export?organizationId=${a.target.organizationId}&workspaceId=${a.target.workspaceId}`;
      assert.equal((await a.member(exportPath)).status, 403);
      const exported = await a.owner(exportPath);
      assert.equal(exported.status, 200, JSON.stringify(exported.data));
      assert.match(
        exported.headers.get("content-disposition") ?? "",
        /^attachment; filename="niaro-configuration-\d{4}-\d{2}-\d{2}\.json"$/,
      );
      const bundle = ConfigBundleSchema.parse(exported.data);
      // Without a workspace, every workspace of the organization.
      const whole = ConfigBundleSchema.parse(
        (
          await a.owner(
            `admin/api/identity/config-bundle/export?organizationId=${a.target.organizationId}`,
          )
        ).data,
      );
      assert.deepEqual(whole.workspaces.map((w) => w.name).sort(), [
        "TEST Workspace",
        "TEST source",
      ]);
      const text = JSON.stringify(bundle);
      assert(!text.includes(PROVIDER_KEY), "provider key in the bundle");
      assert(!text.includes(SERVICE_KEY), "service key in the bundle");
      assert(!text.includes(memberUser), "a person's id in the bundle");
      assert(!text.includes(providerId) && !text.includes(serviceId));
      const forbidden = keys(bundle).filter((path) =>
        FORBIDDEN_KEY.test(path.split(".").at(-1)!),
      );
      assert.deepEqual(forbidden, []);
      assert.deepEqual(Object.keys(bundle.organization).sort(), [
        "hosted",
        "instructions",
        "modelPolicy",
        "models",
        "providers",
        "searchBackends",
        "serverSettings",
      ]);
      const providers = bundle.organization.providers as {
        items: { name: string; keyRequired: boolean }[];
      };
      assert.deepEqual(
        providers.items.map((p) => [p.name, p.keyRequired]),
        [["TEST Models", true]],
      );
      const workspace = bundle.workspaces[0]!;
      assert.equal(workspace.name, "TEST Workspace");
      assert.deepEqual(Object.keys(workspace.sections).sort(), [
        "instructions",
        "plugins",
        "processes",
        "roles",
        "routing",
        "services",
        "skills",
        "usage",
      ]);
      const services = workspace.sections.services as {
        items: {
          keyRequired: boolean;
          actions: { policy: object; name: string }[];
        }[];
      };
      assert.equal(services.items[0]!.keyRequired, true);
      assert.deepEqual(services.items[0]!.actions[0]!.policy, {
        roles: ["owner", "admin", "member"],
        workspaceRoles: ["TEST Sales"],
      });

      // --- Import into a fresh server: preview first, then the confirmed import.
      const preview = async (value: unknown = bundle, who = b.owner) =>
        who("admin/api/identity/config-bundle/preview", {
          ...b.target,
          bundle: value,
        });
      assert.equal((await preview(bundle, b.member)).status, 403);
      assert.equal(
        (await preview({ ...bundle, profile: "niaro-server-settings" })).status,
        400,
      );
      const first = ConfigBundlePreview.parse((await preview()).data);
      assert.equal(first.changes, true);
      assert.deepEqual(section(first, "providers").added, ["TEST Models"]);
      assert.deepEqual(section(first, "providers").needsKey, ["TEST Models"]);
      assert.deepEqual(section(first, "models").added, [
        "TEST Models / test/chat",
      ]);
      assert.deepEqual(section(first, "services").needsKey, ["TEST CRM"]);
      assert.deepEqual(section(first, "processes").added, ["TEST Lookup"]);
      assert.deepEqual(section(first, "modelPolicy").changed, [
        "Organization model policy",
      ]);
      assert.deepEqual(section(first, "routing").changed, [
        "Workspace model policy",
      ]);
      for (const s of first.sections)
        assert.deepEqual(s.conflicts, [], `${s.key}: ${JSON.stringify(s)}`);
      // A preview changes nothing.
      assert.deepEqual((await b.catalog()).providers, []);

      const importPath = "admin/api/identity/config-bundle/import";
      const stale = await b.owner(importPath, {
        ...b.target,
        bundle,
        revision: "0".repeat(64),
      });
      assert.equal(stale.status, 409);
      assert.equal(stale.data.error, "config_bundle_conflict");
      const imported = await b.owner(importPath, {
        ...b.target,
        bundle,
        revision: first.revision,
      });
      assert.equal(imported.status, 200, JSON.stringify(imported.data));
      assert.equal(imported.data.imported, true);

      // The fresh server now has the same configuration, keys still missing.
      const reexport = ConfigBundleSchema.parse(
        (
          await b.owner(
            `admin/api/identity/config-bundle/export?organizationId=${b.target.organizationId}&workspaceId=${b.target.workspaceId}`,
          )
        ).data,
      );
      const { serverSettings: _a, ...sourceOrganization } = bundle.organization;
      const { serverSettings: _b, ...targetOrganization } =
        reexport.organization;
      assert.deepEqual(targetOrganization, sourceOrganization);
      assert.deepEqual(
        (reexport.organization.serverSettings as { settings: object }).settings,
        (bundle.organization.serverSettings as { settings: object }).settings,
      );
      assert.deepEqual(
        comparable(reexport).workspaces,
        comparable(bundle).workspaces,
      );
      const imported_catalog = await b.catalog();
      assert.equal(imported_catalog.providers[0].hasCredential, false);
      assert.equal(imported_catalog.services[0].hasCredential, false);
      // A grant to one person on the source server does not travel.
      assert.deepEqual(
        imported_catalog.services[0].actions[0].policy.users,
        [],
      );

      // Applying the same bundle again changes nothing.
      const again = ConfigBundlePreview.parse((await preview()).data);
      assert.equal(again.changes, false);
      assert.equal(again.revision, imported.data.revision);
      const second = await b.owner(importPath, {
        ...b.target,
        bundle,
        revision: again.revision,
      });
      assert.equal(second.status, 200);
      assert.equal(second.data.changes, false);
      assert.equal(second.data.revision, again.revision);

      // Audited with counts only.
      const audit = (
        await b.owner(
          `admin/api/identity/audit?organizationId=${b.target.organizationId}&category=changes`,
        )
      ).data.entries as { action: string; details: Record<string, number> }[];
      const entries = audit.filter(
        (e) => e.action === "config.bundle_imported",
      );
      assert.equal(entries.length, 2);
      assert(entries.some((e) => e.details.added! > 0));

      // --- Conflicts: a key here never goes to another address; unknown
      // sections and workspaces are reported, never guessed.
      catalog = await b.catalog();
      await b.ok("admin/api/identity/catalog/command", {
        ...b.target,
        type: "saveProvider",
        id: catalog.providers[0].id,
        revision: catalog.providers[0].revision,
        settings: {
          name: "TEST Models",
          url: "https://models.example.test/v1",
          enabled: true,
          dailyRequestLimit: 100,
        },
        apiKey: "TEST-target-key",
      });
      const edited = structuredClone(bundle) as ConfigBundle & {
        organization: Record<string, any>;
        workspaces: { name: string; sections: Record<string, any> }[];
      };
      edited.organization.providers.items[0].url =
        "https://elsewhere.example.test/v1";
      edited.organization.futureThing = { version: 1 };
      edited.workspaces[0]!.sections.skills.items[0].instructions =
        "Use the new template.";
      const diff = ConfigBundlePreview.parse((await preview(edited)).data);
      assert.deepEqual(section(diff, "providers").conflicts, [
        { name: "TEST Models", reason: "address_changed" },
      ]);
      assert.deepEqual(section(diff, "providers").needsKey, []);
      assert.deepEqual(section(diff, "futureThing").conflicts, [
        { name: "futureThing", reason: "section_unknown" },
      ]);
      assert.deepEqual(section(diff, "skills").changed, ["TEST Offer letter"]);
      assert.deepEqual(section(diff, "models").unchanged, [
        "TEST Models / test/chat",
      ]);
      const applied = await b.owner(importPath, {
        ...b.target,
        bundle: edited,
        revision: diff.revision,
      });
      assert.equal(applied.status, 200);
      catalog = await b.catalog();
      // The stored key and its address stayed.
      assert.equal(catalog.providers[0].hasCredential, true);
      assert.equal(catalog.providers[0].url, "https://models.example.test/v1");

      // Without a chosen workspace, workspaces are matched by name.
      const unmatched = ConfigBundlePreview.parse(
        (
          await b.owner("admin/api/identity/config-bundle/preview", {
            organizationId: b.target.organizationId,
            bundle,
          })
        ).data,
      );
      assert.deepEqual(section(unmatched, "workspace").conflicts, [
        { name: "TEST Workspace", reason: "workspace_missing" },
      ]);
    } finally {
      await a.close();
      await b.close();
    }
  },
);
