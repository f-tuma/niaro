import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { AdminAuth, issueAdminKey } from "../apps/server-admin/auth";
import { createAdminHandler } from "../apps/server-admin/http";
import { createFixtureServer } from "../apps/fixture-server/http";
import {
  ServerConfigSchema,
  loadServerConfig,
} from "../apps/reference-server/config";
import { inspectServerServices } from "../apps/reference-server/runtime";
import { createContactTools } from "../apps/server-tools/contacts";
import { AdminOverviewSchema } from "../packages/protocol/admin";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { AUTH_PROFILE, PROFILE } from "../packages/protocol";

const http = (
  url: string,
  method = "GET",
  headers: Record<string, string> = {},
  body?: string,
) =>
  new Promise<{ status: number; headers: IncomingHttpHeaders; body: string }>(
    (resolve, reject) => {
      const req = request(url, { method, headers, agent: false }, (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () =>
          resolve({
            status: res.statusCode!,
            headers: res.headers,
            body: text,
          }),
        );
      });
      req.on("error", reject);
      req.end(body);
    },
  );

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "server-admin-test-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

test("administrator keys store only a digest, reject unsafe files and cannot overwrite an existing key", () => {
  const file = join(root, "key.json");
  const key = issueAdminKey(file);
  expect(readFileSync(file, "utf8")).not.toContain(key);
  expect(() => issueAdminKey(file)).toThrow();
  expect(new AdminAuth(file, 60).login(key, "operator")).toMatch(/^[\w-]{43}$/);
  chmodSync(file, 0o644);
  expect(() => new AdminAuth(file, 60)).toThrow("private administrator key");
});

test("administrator sessions expire, revoke, rotate and do not survive a process restart", () => {
  const file = join(root, "key.json");
  const key = issueAdminKey(file);
  let now = 1000;
  const auth = new AdminAuth(file, 60, () => now);
  const token = auth.login(key, "operator");
  expect(auth.authenticate(token).expiresAt).toBe(
    new Date(61000).toISOString(),
  );
  now = 61000;
  expect(() => auth.authenticate(token)).toThrow("admin_unauthorized");
  const next = auth.login(key, "operator");
  const rotatedKey = issueAdminKey(file, true);
  expect(() => auth.authenticate(next)).toThrow("admin_unauthorized");
  expect(() => auth.login(key, "operator")).toThrow("admin_unauthorized");
  const rotated = auth.login(rotatedKey, "operator");
  expect(() =>
    new AdminAuth(file, 60, () => now).authenticate(rotated),
  ).toThrow("admin_unauthorized");
  auth.revoke(rotated);
  expect(() => auth.authenticate(rotated)).toThrow("admin_unauthorized");
});

test("incorrect keys are throttled before another attempt; the limit resets", () => {
  const file = join(root, "key.json");
  const key = issueAdminKey(file);
  let now = 0;
  const auth = new AdminAuth(file, 60, () => now);
  for (let i = 0; i < 10; i++)
    expect(() => auth.login("wrong", "ip")).toThrow("admin_unauthorized");
  expect(() => auth.login(key, "ip")).toThrow("admin_rate_limited");
  now = 60000;
  expect(auth.authenticate(auth.login(key, "ip"))).toBeDefined();
});

const profile = (directory: string) =>
  ServerConfigSchema.parse({
    version: 1,
    name: "TEST administration",
    listen: { port: 8799 },
    dataDirectory: directory,
    allowedOrigins: ["http://localhost:8085"],
    administration: { keyFile: join(root, "admin.json") },
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  });

test("optional administration resolves private paths relative to the profile and bounds session length", () => {
  const file = join(root, "profile.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...profile("./data"),
      administration: { keyFile: "./operator.json" },
    }),
  );
  expect(loadServerConfig(file).administration).toEqual({
    keyFile: join(root, "operator.json"),
    sessionSeconds: 1800,
  });
  expect(
    ServerConfigSchema.safeParse({
      ...profile("./data"),
      administration: { keyFile: "x", sessionSeconds: 3601 },
    }).success,
  ).toBe(false);
  expect(
    ServerConfigSchema.parse({
      ...profile("./data"),
      administration: undefined,
    }).administration,
  ).toBeUndefined();
});

test("metadata never invokes providers or publishes extra adapter fields; tool descriptions are defensive copies", () => {
  const list = jest.fn(async () => []);
  const crm = {
    list,
    adminInfo: {
      expiresAt: "2026-09-24T00:00:00Z",
      apiKey: "secret-provider",
      configFile: "/private/path",
    },
  };
  const result = inspectServerServices({ crm });
  expect(result.find((s) => s.id === "crm")).toEqual({
    id: "crm",
    provider: "custom",
    state: "configured",
    expiresAt: crm.adminInfo.expiresAt,
  });
  expect(result.find((s) => s.id === "calendar")).toEqual({
    id: "calendar",
    provider: "simulated",
    state: "demo",
  });
  const registry = createContactTools(crm);
  const tools = registry.describe();
  expect(tools.map((t) => t.id)).toEqual([
    "crm.contacts.list",
    "crm.contacts.search",
  ]);
  tools[0]!.description.en = "modified";
  expect(registry.describe()[0]!.description.en).not.toBe("modified");
  expect(list).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toMatch(/secret-provider|private\/path/);
});

test("same-server admin protects inventory, rejects cross-origin writes, revokes sessions and keeps app auth isolated", async () => {
  const config = profile(join(root, "workflow"));
  const key = issueAdminKey(config.administration!.keyFile);
  for (const [file, body] of [
    ["index.html", "<html><head></head><body>Admin shell</body></html>"],
    ["app.js", "// public UI"],
    ["app.css", "body {}"],
  ])
    writeFileSync(join(root, file!), body!);
  const model = { timeZone: "Europe/Prague", decide: jest.fn() };
  const crm = {
    list: jest.fn(async () => []),
    adminInfo: { expiresAt: "2020-01-01T00:00:00Z" },
  };
  const services = jest.fn(() => inspectServerServices({ crm }));
  const management = createAdminHandler(config, services, {
    assetsDirectory: root,
  });
  const server = createFixtureServer(
    config.dataDirectory,
    config.allowedOrigins,
    { model, crm, management },
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const headers = {
    Origin: origin,
    "Content-Type": "application/json",
    "X-Agent-Admin": "1",
  };
  const login = (value: string, extra = {}) =>
    http(
      `${origin}/admin/api/login`,
      "POST",
      { ...headers, ...extra },
      JSON.stringify({ key: value }),
    );
  try {
    expect((await http(`${origin}/admin`)).status).toBe(302);
    const shell = await http(`${origin}/admin/`);
    expect(shell.body).toContain("Admin shell");
    const nonce = shell.body.match(
      /name="agent-style-nonce" content="([A-Za-z0-9+/]{32})"/,
    )?.[1];
    expect(nonce).toBeDefined();
    expect(shell.headers["content-security-policy"]).toContain(
      `style-src 'self' 'nonce-${nonce}'`,
    );
    expect(shell.headers["content-security-policy"]).toContain(
      "script-src 'self';",
    );
    expect(shell.headers["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
    // Direct loads and refreshes use the actual same-server shell allowlist.
    for (const route of ["/pet", "/pet/", "/me/memory", "/me/memory/"]) {
      const page = await http(`${origin}${route}`);
      expect({ route, status: page.status }).toEqual({ route, status: 200 });
      expect(page.body).toContain("Admin shell");
      expect(page.headers["content-security-policy"]).toContain(
        "frame-ancestors 'none'",
      );
    }
    for (const route of [
      "/pet/unknown",
      "/pet-extra",
      "/me/memory/unknown",
      "/me/memory-extra",
    ]) {
      const page = await http(`${origin}${route}`);
      expect({ route, status: page.status }).toEqual({ route, status: 404 });
      expect(page.body).not.toContain("Admin shell");
    }
    const nextShell = await http(`${origin}/admin/`);
    expect(nextShell.body).not.toBe(shell.body);
    for (const route of [
      "tools",
      "access",
      "settings",
      "audit",
      "ai",
      "plugins",
      "plugins/",
      "plugins/datetime",
      "plugins/memory",
      "providers/test-provider",
      "auth-providers/ap_0123456789abcdef0123456789abcdef",
      "connections/model",
      "connections/voice",
      "connections/crm",
      "connections/calendar",
    ]) {
      const page = await http(`${origin}/admin/${route}`);
      expect(page.status).toBe(200);
      expect(
        page.body.replace(/content="[A-Za-z0-9+/]{32}"/, 'content="nonce"'),
      ).toBe(
        shell.body.replace(/content="[A-Za-z0-9+/]{32}"/, 'content="nonce"'),
      );
    }
    expect(shell.headers["content-security-policy"]).toContain(
      "frame-ancestors 'none'",
    );
    expect((await http(`${origin}/admin/api/overview`)).status).toBe(401);
    expect(services).not.toHaveBeenCalled();
    expect(
      (await http(`${origin}/admin/`, "GET", { Host: "rebinding.test" }))
        .status,
    ).toBe(403);
    expect((await login(key, { Origin: "http://localhost:8085" })).status).toBe(
      403,
    );
    expect((await login(key, { "X-Agent-Admin": "" })).status).toBe(403);
    expect((await login(key, { "Sec-Fetch-Site": "cross-site" })).status).toBe(
      403,
    );
    expect((await login("mobile-pairing-code")).status).toBe(401);
    expect(
      (await http(`${origin}/admin/api/login`, "POST", headers, "{bad-json"))
        .status,
    ).toBe(400);
    const paired = await http(
      `${origin}/v1/a/auth/pair`,
      "POST",
      { "Content-Type": "application/json", Origin: "http://localhost:8085" },
      JSON.stringify({
        authProfile: AUTH_PROFILE,
        profile: PROFILE,
        code: issuePairingCode(config.dataDirectory, "test-user", "a"),
      }),
    );
    expect(paired.status).toBe(200);
    const appToken = JSON.parse(paired.body).accessToken;
    expect(
      (
        await http(`${origin}/admin/api/overview`, "GET", {
          Authorization: `Bearer ${appToken}`,
        })
      ).status,
    ).toBe(401);
    const signed = await login(key);
    expect(signed.status).toBe(200);
    expect(signed.body).toBe('{"ok":true}');
    const setCookie = signed.headers["set-cookie"]![0]!;
    expect(setCookie).toMatch(/Path=\/admin; HttpOnly; SameSite=Strict/);
    const Cookie = setCookie.split(";")[0]!;
    const overview = await http(`${origin}/admin/api/overview`, "GET", {
      Cookie,
    });
    const data = AdminOverviewSchema.parse(JSON.parse(overview.body));
    expect(data.services.find((s) => s.id === "crm")!.state).toBe("expired");
    expect(data.tools).toHaveLength(2);
    expect(data.authentication.oauth).toBe("not_configured");
    expect(overview.body).not.toContain(key);
    expect(overview.body).not.toContain(root);
    expect(overview.body).not.toContain(appToken);
    expect(overview.headers["cache-control"]).toBe("no-store");
    expect(
      (await http(`${origin}/v1/a/snapshot`, "GET", { Cookie })).status,
    ).toBe(401);
    expect(
      (
        await http(
          `${origin}/admin/api/tools/invoke`,
          "POST",
          { ...headers, Cookie },
          "{}",
        )
      ).status,
    ).toBe(404);
    expect(
      (await http(`${origin}/admin/private.json`, "GET", { Cookie })).status,
    ).toBe(404);
    expect(
      (
        await http(`${origin}/admin/connections/private.json`, "GET", {
          Cookie,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await http(`${origin}/admin/api/overview`, "GET", {
          Cookie,
          Origin: "https://evil.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await http(
          `${origin}/admin/api/logout`,
          "POST",
          { ...headers, Cookie },
          "{}",
        )
      ).status,
    ).toBe(200);
    expect(
      (await http(`${origin}/admin/api/overview`, "GET", { Cookie })).status,
    ).toBe(401);
    expect(
      (
        await http(`${origin}/v1/a/snapshot`, "GET", {
          Authorization: `Bearer ${appToken}`,
        })
      ).status,
    ).toBe(200);
    expect(crm.list).not.toHaveBeenCalled();
    expect(model.decide).not.toHaveBeenCalled();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
