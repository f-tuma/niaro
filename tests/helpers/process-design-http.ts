import assert from "node:assert/strict";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdtempSync,
  lstatSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createServer,
  request as rawRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  ServerConfigSchema,
  type ServerConfig,
} from "../../apps/reference-server/config";
import { createReferenceServer } from "../../apps/reference-server/runtime";
import { openIdentity } from "../../apps/server-identity/service";
import { issueAdminKey } from "../../apps/server-admin/auth";
import {
  IdentityStateSchema,
  OrganizationDetailSchema,
} from "../../packages/protocol/identity";
import { seedIdentityFixture } from "./identity-seed";
import { processWorkflow } from "./service-process";
import type { ModelRequest } from "../agent-trust/harness";
import type { IntegrationTransport } from "../../apps/server-integrations/transport";

export const designHttpPath = "api/identity/catalog/processes/design";
type Role = "owner" | "admin" | "member" | "operator" | "anonymous";
export type DesignHttpTestOptions = {
  /** Explicit browser origins for isolated local tests. The default stays empty. */
  testAllowedOrigins?: string[];
  testSavedMemory?: boolean;
  observeRequest?: (request: IncomingMessage, response: ServerResponse) => void;
};
/** Baseline proof of a complete stopped copy, before an optional fault injection. */
export type StoppedCopyProof = {
  readonly source: string;
  readonly destination: string;
  readonly sourceHashes: Readonly<Record<string, string>>;
  readonly copyHashes: Readonly<Record<string, string>>;
  readonly integrity: readonly {
    readonly path: string;
    readonly checks: readonly unknown[];
    readonly foreignKeys: readonly unknown[];
  }[];
};
function stoppedTupleManifest(directory: string) {
  const hashes: Record<string, string> = {};
  const modes: Record<string, number> = {};
  const walk = (relative = "") => {
    const path = join(directory, relative);
    const stat = lstatSync(path);
    modes[relative || "."] = stat.mode & 0o777;
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) walk(join(relative, name));
    } else {
      assert(stat.isFile(), "TEST restore tuple contains regular files");
      hashes[relative] = createHash("sha256")
        .update(readFileSync(path))
        .digest("hex");
    }
  };
  walk();
  return { hashes, modes };
}
export async function designHttpFixture(
  trackedPath = designHttpPath + "/turns",
  testOptions: DesignHttpTestOptions = {},
) {
  for (const value of testOptions.testAllowedOrigins ?? []) {
    const url = new URL(value);
    assert.equal(url.origin, value, "TEST CORS requires an exact origin");
    assert.equal(url.protocol, "http:");
    assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname));
  }
  const root = mkdtempSync(join(tmpdir(), "niaro-design-http-"));
  const ownedRoots = [root];
  const registeredSources = new WeakMap<
    StoppedCopyProof,
    ReturnType<typeof stoppedTupleManifest>
  >();
  let currentRoot = root;
  let app: ReturnType<typeof createReferenceServer>;
  let turnRequest: IncomingMessage | undefined;
  let disconnectTurnAtBodyEnd = false;
  const server = createServer((req, res) => {
    testOptions.observeRequest?.(req, res);
    if (
      req.method === "POST" &&
      req.url?.split("?")[0] ===
        (trackedPath.startsWith("/") ? trackedPath : "/admin/" + trackedPath)
    ) {
      turnRequest = req;
      if (disconnectTurnAtBodyEnd) {
        disconnectTurnAtBodyEnd = false;
        req.once("end", () => res.destroy());
      }
    }
    app.emit("request", req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const config = ServerConfigSchema.parse({
    version: 1,
    name: "TEST design HTTP",
    listen: { port: address.port },
    dataDirectory: join(root, "workflow"),
    allowedOrigins: testOptions.testAllowedOrigins ?? [],
    ...(testOptions.testSavedMemory
      ? {
          plugins: {
            enabled: ["datetime", "memory"],
            timeZone: "Europe/Prague",
            memory: {},
          },
        }
      : {}),
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
  let modelCount = 0,
    businessCount = 0;
  const requests: ModelRequest[] = [];
  let model: (request: ModelRequest) => object | Promise<object> = () => ({
    content: "TEST design HTTP reply",
  });
  let before: (() => void | Promise<void>) | undefined;
  const options = {
    integrationTransport: async (
      request: Parameters<IntegrationTransport>[0],
    ) => {
      if (new URL(request.url).origin !== "https://models.example.test") {
        businessCount++;
        throw Error("TEST no business transport");
      }
      await before?.();
      assert(request.beforeDispatch);
      await request.beforeDispatch(() => {
        modelCount++;
        requests.push(request.body as ModelRequest);
      });
      const response = await model(request.body as ModelRequest);
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          choices: [{ message: response }],
          usage: { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 },
        }),
      };
    },
  };
  const key = issueAdminKey(config.administration!.keyFile);
  let identity = await openIdentity(config, options);
  app = createReferenceServer(config, {}, identity);
  let ownerOpen = true;
  const stopOwner = async () => {
    if (!ownerOpen) return;
    ownerOpen = false;
    app.emit("close");
    await identity.close();
  };
  const openOwner = async () => {
    identity = await openIdentity(config, options);
    try {
      app = createReferenceServer(config, {}, identity);
      ownerOpen = true;
    } catch (error) {
      await identity.close();
      throw error;
    }
  };
  const cookies = new Map<Role, Map<string, string>>();
  async function request(
    role: Role,
    path: string,
    input?: unknown,
    settings: {
      headers?: Record<string, string>;
      raw?: string;
      signal?: AbortSignal;
      method?: string;
    } = {},
  ) {
    const jar = cookies.get(role) ?? new Map<string, string>();
    cookies.set(role, jar);
    if (settings.headers?.Host) {
      // Fetch normalizes Host. Use the native HTTP client to send the actual
      // hostile header, rather than merely setting a discarded fetch option.
      return new Promise<{ status: number; data: unknown }>(
        (resolve, reject) => {
          const call = rawRequest(
            origin + "/admin/" + path,
            {
              method: "GET",
              headers: {
                Origin: origin,
                "X-Agent-Admin": "1",
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
                ...settings.headers,
              },
            },
            (res) => {
              const chunks: Buffer[] = [];
              res.on("data", (chunk: Buffer) => chunks.push(chunk));
              res.on("end", () => {
                try {
                  resolve({
                    status: res.statusCode!,
                    data: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                  });
                } catch (error) {
                  reject(error);
                }
              });
            },
          );
          call.on("error", reject);
          call.end();
        },
      );
    }
    const response = await fetch(origin + "/admin/" + path, {
      method:
        settings.method ??
        (input === undefined && settings.raw === undefined ? "GET" : "POST"),
      signal: settings.signal ?? AbortSignal.timeout(15000),
      headers: {
        Origin: origin,
        "X-Agent-Admin": "1",
        "Content-Type": "application/json",
        Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
        ...settings.headers,
      },
      body:
        settings.raw ??
        (input === undefined ? undefined : JSON.stringify(input)),
    });
    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";")[0]!,
        i = pair.indexOf("=");
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    return {
      status: response.status,
      data: (await response.json()) as unknown,
    };
  }
  const record = (raw: unknown): Record<string, unknown> => {
    assert(raw && typeof raw === "object");
    return raw as Record<string, unknown>;
  };
  const password = "TEST-design-HTTP-password-only-2026";
  assert.equal((await request("operator", "api/login", { key })).status, 200);
  assert.equal(
    (
      await request("operator", "api/identity/bootstrap", {
        name: "TEST owner",
        email: "owner@example.test",
        password,
        organizationName: "TEST design org",
      })
    ).status,
    200,
  );
  // Setup signed this browser in as the owner: back to the recovery key.
  await request("operator", "api/login", { key });
  assert.equal(
    (
      await request("owner", "auth/sign-in/email", {
        email: "owner@example.test",
        password,
      })
    ).status,
    200,
  );
  const organizationId = IdentityStateSchema.parse(
    (await request("owner", "api/identity")).data,
  ).organizations[0]!.id;
  assert.equal(
    (
      await request("owner", "api/identity/command", {
        organizationId,
        type: "createWorkspace",
        name: "TEST design workspace",
      })
    ).status,
    200,
  );
  for (const role of ["admin", "member"] as const) {
    await seedIdentityFixture(identity, {
      type: "createAccount",
      organizationId,
      role,
      name: `TEST ${role}`,
      email: `${role}@example.test`,
      password,
    });
    assert.equal(
      (
        await request(role, "auth/sign-in/email", {
          email: `${role}@example.test`,
          password,
        })
      ).status,
      200,
    );
  }
  const detail = OrganizationDetailSchema.parse(
    (await request("owner", `api/identity/organization?id=${organizationId}`))
      .data,
  );
  const workspaceId = detail.workspaces[0]!.id,
    target = { organizationId, workspaceId };
  await seedIdentityFixture(identity, {
    type: "setWorkspaceMember",
    ...target,
    memberId: detail.members.find((m) => m.role === "member")!.id,
    allowed: true,
  });
  const catalog = async (body: object) => {
    const saved = await request("owner", "api/identity/catalog/command", {
      ...target,
      ...body,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.data));
    return String(record(saved.data).id);
  };
  const serviceId = await catalog({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST design service",
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
      policy: { roles: ["owner", "admin"], users: [] },
    },
  });
  const providerId = await catalog({
    type: "saveProvider",
    revision: 0,
    apiKey: "TEST-HTTP-provider-key",
    settings: {
      name: "TEST provider",
      url: "https://models.example.test/v1",
      enabled: true,
      dailyRequestLimit: 100,
    },
  });
  const modelId = await catalog({
    type: "saveModel",
    revision: 0,
    settings: {
      providerId,
      name: "TEST tools model",
      model: "TEST-tools",
      tools: true,
      enabled: true,
    },
  });
  const query = new URLSearchParams(target).toString();
  const budgetSettings = {
    mode: "enforce",
    maxTokens: 10_000_000,
    maxCostMicros: 100_000_000,
    prices: [
      {
        modelId,
        modelRevision: 1,
        providerRevision: 1,
        maxInputTokens: 100000,
        maxOutputTokens: 10000,
        inputMicrosPerMillion: 1000000,
        outputMicrosPerMillion: 1000000,
      },
    ],
  };
  const budget = await request("owner", "api/identity/catalog/budget", {
    ...target,
    revision: 0,
    settings: budgetSettings,
  });
  assert.equal(budget.status, 200, JSON.stringify(budget.data));
  return {
    root,
    origin,
    config,
    target,
    query,
    serviceId,
    actionId,
    providerId,
    modelId,
    request,
    loginOperator: () => request("operator", "api/login", { key }),
    record,
    catalog,
    budgetSettings,
    workflow: () => processWorkflow(serviceId, actionId),
    scriptedModelTransport: options.integrationTransport,
    modelCount: () => modelCount,
    businessCount: () => businessCount,
    models: () => requests,
    onModel: (next: typeof model) => {
      model = next;
    },
    beforeModel: (next: typeof before) => {
      before = next;
    },
    mutateTurnHeader: (name: string, value: string) => {
      assert(turnRequest);
      turnRequest.headers[name] = value;
    },
    disconnectNextTurnAtBodyEnd: () => {
      disconnectTurnAtBodyEnd = true;
    },
    trackRequestPath: (path: string) => {
      trackedPath = path;
    },
    get identity() {
      return identity;
    },
    restart: async (
      beforeOpen?: (stopped: {
        root: string;
        config: ServerConfig;
      }) => void | Promise<void>,
    ) => {
      await stopOwner();
      await beforeOpen?.({ root: currentRoot, config });
      await openOwner();
    },
    /** Synthetic acceptance only: copy the entire stopped owner tuple to a
     * different private directory, then reopen the actual public server there.
     * This is neither a production backup command nor a process rollback. */
    restoreCopy: async (
      afterVerifiedCopy?: (copy: StoppedCopyProof) => void | Promise<void>,
      original?: StoppedCopyProof,
    ) => {
      await stopOwner();
      const source = original?.source ?? currentRoot;
      const registered = original ? registeredSources.get(original) : undefined;
      if (original) {
        assert(registered, "TEST original copy proof belongs to this fixture");
        assert.notEqual(
          source,
          currentRoot,
          "TEST original source stays stopped",
        );
        assert.deepEqual(stoppedTupleManifest(source), registered);
        assert.deepEqual(registered.hashes, original.sourceHashes);
      }
      // libsql can defer native statement finalization beyond awaited close(),
      // leaving a WAL that a later GC checkpoints. Establish the stopped TEST
      // snapshot before capturing any baseline: a separate WAL-aware SQLite
      // connection must checkpoint completely and close all physical sidecars.
      // Production backups instead require the owner process to have exited.
      const nativeFile = fileURLToPath(
        identity["catalog"].store.nativeStorageUrl,
      );
      assert(
        existsSync(nativeFile) ||
          (!existsSync(nativeFile + "-wal") &&
            !existsSync(nativeFile + "-shm")),
        "TEST native snapshot has orphaned sidecars",
      );
      if (!original && existsSync(nativeFile)) {
        const db = new DatabaseSync(nativeFile);
        try {
          const checkpoint = db
            .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
            .get();
          assert(
            checkpoint,
            "TEST native snapshot checkpoint must return proof",
          );
          assert.equal(
            checkpoint.busy,
            0,
            "TEST native snapshot is still busy",
          );
          assert.equal(checkpoint.log, 0);
          assert.equal(checkpoint.checkpointed, 0);
        } finally {
          db.close();
        }
        assert(
          !existsSync(nativeFile + "-wal"),
          "TEST native WAL is not closed",
        );
        assert(
          !existsSync(nativeFile + "-shm"),
          "TEST native SHM is not closed",
        );
      }
      // Real fixture configuration is part of the copied stopped tuple too.
      // The destination paths are relocated only after its bytes are checked.
      if (!original)
        writeFileSync(
          join(source, "TEST-server-config.json"),
          JSON.stringify(config),
          { mode: 0o600 },
        );
      const destination = mkdtempSync(join(tmpdir(), "niaro-restored-http-"));
      ownedRoots.push(destination);
      chmodSync(destination, 0o700);
      cpSync(source, destination, { recursive: true });
      const preserveModes = (relative = "") => {
        const from = join(source, relative),
          to = join(destination, relative);
        const stat = lstatSync(from);
        assert(
          stat.isDirectory() || stat.isFile(),
          "TEST restore copies only regular private tuple files",
        );
        chmodSync(to, stat.mode & 0o777);
        if (stat.isDirectory())
          for (const entry of readdirSync(from))
            preserveModes(join(relative, entry));
      };
      preserveModes();
      const fingerprints = (directory: string) =>
        stoppedTupleManifest(directory).hashes;
      const sourceHashes = Object.freeze(fingerprints(source));
      const copyHashes = Object.freeze(fingerprints(destination));
      assert.deepEqual(copyHashes, sourceHashes);
      const sourceManifest = stoppedTupleManifest(source);
      assert.deepEqual(stoppedTupleManifest(destination), sourceManifest);
      if (registered) assert.deepEqual(sourceManifest, registered);
      // A normal WAL-aware SQLite reader can create or update sidecars even
      // with readOnly:true. Inspect an exact disposable clone instead, including
      // nonempty native WAL; immutable main-only reads would silently ignore it.
      const inspection = mkdtempSync(
        join(tmpdir(), "niaro-restore-inspection-"),
      );
      let integrity: StoppedCopyProof["integrity"];
      try {
        cpSync(destination, inspection, { recursive: true });
        assert.deepEqual(fingerprints(inspection), copyHashes);
        // Check before reacquiring either owner lock. An active lock SQLite
        // intentionally holds BEGIN EXCLUSIVE, while both copied owners stop.
        integrity = Object.keys(copyHashes)
          .filter((path) => path.endsWith(".sqlite"))
          .map((path) => {
            const db = new DatabaseSync(join(inspection, path), {
              readOnly: true,
            });
            try {
              const checks = db
                .prepare("PRAGMA integrity_check")
                .all()
                .map((row) => row.integrity_check);
              const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
              assert.deepEqual(checks, ["ok"], path);
              assert.deepEqual(foreignKeys, [], path);
              return Object.freeze({
                path,
                checks: Object.freeze(checks),
                foreignKeys: Object.freeze(foreignKeys.map(Object.freeze)),
              });
            } finally {
              db.close();
            }
          });
      } finally {
        rmSync(inspection, { recursive: true, force: true });
      }
      assert.deepEqual(fingerprints(destination), copyHashes);
      config.dataDirectory = join(destination, "workflow");
      config.administration!.keyFile = join(destination, "key");
      config.administration!.identity!.directory = join(
        destination,
        "identity",
      );
      // Relocation also survives a refused reopen. Correction must target this
      // copied owner, never the protected original or a previous successful root.
      currentRoot = destination;
      const proof: StoppedCopyProof = Object.freeze({
        source,
        destination,
        sourceHashes,
        copyHashes,
        integrity: Object.freeze(integrity),
      });
      registeredSources.set(proof, sourceManifest);
      try {
        // Trusted test-only callback: both owners are closed, no DB handle is
        // exposed, and the baseline proof cannot be rewritten by the callback.
        await afterVerifiedCopy?.(proof);
      } finally {
        assert.deepEqual(
          stoppedTupleManifest(source),
          sourceManifest,
          "TEST fault injection must preserve the protected original tuple",
        );
      }
      await openOwner();
      return proof;
    },
    close: async () => {
      try {
        await stopOwner();
      } finally {
        try {
          await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          );
        } finally {
          for (const directory of ownedRoots)
            rmSync(directory, { recursive: true, force: true });
        }
      }
    },
  };
}
