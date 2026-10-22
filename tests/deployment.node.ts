import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { loggedPath } from "../apps/fixture-server/operator-log";
import {
  loadServerConfig,
  ServerConfigError,
} from "../apps/reference-server/config";

function withEnv<T>(values: Record<string, string | undefined>, run: () => T) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  for (const [key, value] of Object.entries(values))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  try {
    return run();
  } finally {
    for (const [key, value] of Object.entries(previous))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
}

test("logged paths keep the route shape and drop identifiers and tokens", () => {
  assert.equal(loggedPath("/v1/a/snapshot?token=secret"), "/v1/a/snapshot");
  assert.equal(loggedPath("/admin/api/overview"), "/admin/api/overview");
  assert.equal(
    loggedPath("/admin/auth/reset-password/AbCdEfGhIjKlMnOpQrStUvWx"),
    "/admin/auth/reset-password/:id",
  );
  assert.equal(
    loggedPath("/chat/2f7c1d9e-8a3b-4c5d-9e0f-123456789abc"),
    "/chat/:id",
  );
  assert.equal(
    loggedPath("/admin/auth/callback/ap_0123456789abcdef0123456789abcdef"),
    "/admin/auth/callback/:id",
  );
  assert.equal(
    loggedPath("/.well-known/oauth-protected-resource/mcp"),
    "/.well-known/oauth-protected-resource/mcp",
  );
  assert.equal(loggedPath("/account/invite#fragment"), "/account/invite");
});

test("container environment sets the public origin and the listener", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-deploy-config-"));
  try {
    const file = join(dir, "server.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        name: "Deploy",
        listen: { host: "127.0.0.1", port: 8793 },
        dataDirectory: "/data/workflow",
        allowedOrigins: [],
        administration: {
          keyFile: "/data/admin-key.json",
          identity: {
            directory: "/data/identity",
            baseURL: "https://assistant.example.com",
          },
        },
        adapters: {
          model: { provider: "fixture" },
          voice: { provider: "disabled" },
          crm: { provider: "disabled" },
          calendar: { provider: "simulated" },
        },
      }),
    );
    const base = {
      NIARO_PUBLIC_URL: undefined,
      NIARO_LISTEN_HOST: undefined,
      NIARO_HOSTED_RUNTIME: undefined,
    };
    const plain = withEnv(base, () => loadServerConfig(file));
    assert.equal(plain.listen.host, "127.0.0.1");
    assert.equal(plain.administration?.identity?.hosting.runtime, "auto");
    assert.equal(
      plain.administration?.identity?.baseURL,
      "https://assistant.example.com",
    );
    const container = withEnv(
      {
        NIARO_PUBLIC_URL: "https://niaro.example.org",
        NIARO_LISTEN_HOST: "0.0.0.0",
        NIARO_HOSTED_RUNTIME: "process",
      },
      () => loadServerConfig(file),
    );
    assert.equal(container.listen.host, "0.0.0.0");
    assert.equal(
      container.administration?.identity?.hosting.runtime,
      "process",
    );
    assert.equal(
      container.administration?.identity?.baseURL,
      "https://niaro.example.org",
    );
    assert.equal(
      withEnv({ ...base, NIARO_PUBLIC_URL: "http://localhost:8793" }, () =>
        loadServerConfig(file),
      ).administration?.identity?.baseURL,
      "http://localhost:8793",
    );
    for (const env of [
      { ...base, NIARO_PUBLIC_URL: "http://assistant.example.com" },
      { ...base, NIARO_PUBLIC_URL: "https://assistant.example.com/path" },
      { ...base, NIARO_LISTEN_HOST: "10.0.0.5" },
      { ...base, NIARO_HOSTED_RUNTIME: "podman" },
    ])
      assert.throws(
        () => withEnv(env, () => loadServerConfig(file)),
        ServerConfigError,
      );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("health probes answer without credentials and the access log has no query", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-deploy-health-"));
  const lines: string[] = [];
  const write = process.stdout.write.bind(process.stdout);
  const previous = process.env.NIARO_LOG;
  process.env.NIARO_LOG = "1";
  // Record operator lines; everything else (the test reporter) passes through.
  process.stdout.write = ((chunk: string | Uint8Array, ...rest: never[]) => {
    const text = String(chunk);
    if (text.startsWith('{"time"')) {
      lines.push(text);
      return true;
    }
    return write(chunk, ...rest);
  }) as typeof process.stdout.write;
  const server = createFixtureServer(dir, ["http://localhost:8081"]);
  try {
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    for (const path of ["/healthz", "/readyz"]) {
      const response = await fetch(`${base}${path}`, {
        headers: { Origin: "https://elsewhere.example" },
      });
      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), { status: "ok" });
    }
    const post = await fetch(`${base}/healthz`, { method: "POST" });
    assert.equal(post.status, 405);
    await post.body?.cancel();
    const denied = await fetch(`${base}/v1/a/snapshot?secret=do-not-log`);
    assert.equal(denied.status, 401);
    await denied.body?.cancel();
    await new Promise((ok) => setTimeout(ok, 20));
  } finally {
    process.stdout.write = write;
    if (previous === undefined) delete process.env.NIARO_LOG;
    else process.env.NIARO_LOG = previous;
    await new Promise((ok) => server.close(ok));
    rmSync(dir, { recursive: true, force: true });
  }
  const entries = lines
    .flatMap((chunk) => chunk.split("\n"))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line));
  const request = entries.find(
    (entry) => entry.event === "http_request" && entry.status === 401,
  );
  assert.ok(request);
  assert.equal(request.path, "/v1/a/snapshot");
  assert.equal(typeof request.ms, "number");
  assert.ok(!lines.join("").includes("do-not-log"));
  // Probes stay out of the access log.
  assert.ok(!entries.some((entry) => entry.path === "/healthz"));
});

test("backup copies live SQLite databases and restore rebuilds them in an empty directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-deploy-backup-"));
  try {
    const data = join(dir, "data");
    mkdirSync(join(data, "identity"), { recursive: true });
    writeFileSync(join(data, "admin-key.json"), "{}", { mode: 0o600 });
    writeFileSync(join(data, "admin-key.initial"), "acadmin_TEST\n", {
      mode: 0o600,
    });
    // A writer holds the database open in WAL mode, with uncheckpointed rows.
    const live = new DatabaseSync(join(data, "identity", "identity.sqlite"));
    live.exec(
      "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE note(text TEXT); INSERT INTO note VALUES ('kept');",
    );
    writeFileSync(join(data, "identity", "server-lock.sqlite"), "");
    const archive = join(dir, "backup.tar.gz");
    const node = [process.execPath, "--disable-warning=ExperimentalWarning"];
    execFileSync(node[0]!, [node[1]!, "scripts/backup.mjs", data, archive], {
      stdio: "pipe",
    });
    // The copy was staged inside the volume and nothing of it is left there.
    assert.deepEqual(
      readdirSync(data).filter((name) => name.startsWith(".niaro-backup-")),
      [],
    );
    live.exec("INSERT INTO note VALUES ('after backup')");
    live.close();
    const restored = join(dir, "restored");
    execFileSync(
      node[0]!,
      [node[1]!, "scripts/restore.mjs", archive, restored],
      { stdio: "pipe" },
    );
    const db = new DatabaseSync(join(restored, "identity", "identity.sqlite"));
    assert.deepEqual(
      db
        .prepare("SELECT text FROM note")
        .all()
        .map((row) => row.text),
      ["kept"],
    );
    db.close();
    assert.equal(readFileSync(join(restored, "admin-key.json"), "utf8"), "{}");
    // A first-start key nobody fetched yet never leaves in a backup.
    assert.ok(!existsSync(join(restored, "admin-key.initial")));
    assert.ok(!existsSync(join(restored, "identity", "server-lock.sqlite")));
    // Restore never writes into a directory that already has data.
    assert.throws(() =>
      execFileSync(
        node[0]!,
        [node[1]!, "scripts/restore.mjs", archive, restored],
        { stdio: "pipe" },
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("rate limits count the real client behind the trusted proxy only", async () => {
  const { clientAddress, trustProxyFromEnv, trustedProxiesFromEnv } =
    await import("../apps/server-identity/client-address");
  // compose sets "auto": only the HTTPS profile (Caddy in front) trusts it.
  assert.equal(trustProxyFromEnv({}), false);
  assert.equal(trustProxyFromEnv({ NIARO_TRUST_PROXY: "0" }), false);
  assert.equal(trustProxyFromEnv({ NIARO_TRUST_PROXY: "1" }), true);
  assert.equal(
    trustProxyFromEnv({
      NIARO_TRUST_PROXY: "auto",
      NIARO_PUBLIC_URL: "http://localhost:8793",
    }),
    false,
  );
  assert.equal(
    trustProxyFromEnv({
      NIARO_TRUST_PROXY: "auto",
      NIARO_PUBLIC_URL: "https://assistant.example.com",
    }),
    true,
  );
  const req = (peer: string, forwarded?: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: forwarded ? { "x-forwarded-for": forwarded } : {},
    }) as unknown as import("node:http").IncomingMessage;
  // Off by default: the socket address counts, headers are ignored.
  assert.equal(
    clientAddress(req("127.0.0.1", "203.0.113.9"), false),
    "127.0.0.1",
  );
  // The proxy appends the peer it saw; a client-supplied prefix is ignored.
  assert.equal(
    clientAddress(req("172.18.0.3", "198.51.100.1, 203.0.113.9"), true),
    "203.0.113.9",
  );
  assert.equal(clientAddress(req("::1", "2001:db8::1"), true), "2001:db8::1");
  // A public peer is never trusted, and a malformed header falls back.
  assert.equal(
    clientAddress(req("203.0.113.7", "198.51.100.1"), true),
    "203.0.113.7",
  );
  assert.equal(clientAddress(req("10.0.0.2", "not-an-ip"), true), "10.0.0.2");
  // Named proxies (a network shared with other containers): only they may
  // name the client; another private peer counts as itself.
  assert.equal(trustedProxiesFromEnv({}), null);
  const proxies = trustedProxiesFromEnv({
    NIARO_TRUSTED_PROXIES: "10.0.1.5, 172.20.0.0/16 fd00::1 bogus 10.9.9.9/99",
  })!;
  assert.equal(
    clientAddress(req("10.0.1.5", "203.0.113.9"), true, proxies),
    "203.0.113.9",
  );
  assert.equal(
    clientAddress(req("::ffff:172.20.3.4", "203.0.113.9"), true, proxies),
    "203.0.113.9",
  );
  assert.equal(
    clientAddress(req("fd00::1", "2001:db8::1"), true, proxies),
    "2001:db8::1",
  );
  assert.equal(
    clientAddress(req("10.0.1.6", "203.0.113.9"), true, proxies),
    "10.0.1.6",
  );
  assert.equal(
    clientAddress(req("10.9.9.9", "203.0.113.9"), true, proxies),
    "10.9.9.9",
  );
  // Still only when trust is on.
  assert.equal(
    clientAddress(req("10.0.1.5", "203.0.113.9"), false, proxies),
    "10.0.1.5",
  );
});

test("a fresh start logs the setup hint and no key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-deploy-first-start-"));
  try {
    const port = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const profile = join(dir, "server.json");
    writeFileSync(
      profile,
      JSON.stringify({
        version: 1,
        name: "TEST first start",
        listen: { host: "127.0.0.1", port },
        dataDirectory: join(dir, "workflow"),
        allowedOrigins: [],
        administration: {
          keyFile: join(dir, "admin-key.json"),
          identity: {
            directory: join(dir, "identity"),
            baseURL: `http://127.0.0.1:${port}`,
          },
        },
        adapters: {
          model: { provider: "fixture" },
          voice: { provider: "disabled" },
          crm: { provider: "disabled" },
          calendar: { provider: "simulated" },
        },
      }),
    );
    const cli = [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "apps/reference-server/cli.ts",
    ];
    const env = { ...process.env, TSX_DISABLE_CACHE: "1" };
    // stdout is a pipe here, as under Docker or a service manager.
    const start = async () => {
      const server = spawn(process.execPath, [...cli, "start", profile], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let log = "";
      server.stdout.on("data", (chunk) => (log += String(chunk)));
      server.stderr.on("data", (chunk) => (log += String(chunk)));
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(log)), 60_000);
        server.stdout.on("data", () => {
          if (/Administration:/.test(log)) {
            clearTimeout(timer);
            resolve();
          }
        });
        server.once("exit", () => reject(Error(log)));
      });
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
      return log;
    };
    const first = await start();
    // No key in the log or on disk: the first account becomes the owner.
    assert.match(
      first,
      new RegExp(
        `No owner yet: open http://127\\.0\\.0\\.1:${port}/admin/ and create the owner account`,
      ),
    );
    assert.doesNotMatch(first, /acadmin_/);
    assert.ok(!existsSync(join(dir, "admin-key.initial")));
    // The recovery key exists only as a digest, for admin-rotate-key.
    const digest = readFileSync(join(dir, "admin-key.json"), "utf8");
    assert.equal(statSync(join(dir, "admin-key.json")).mode & 0o777, 0o600);
    assert.doesNotMatch(digest, /acadmin_/);
    assert.match(JSON.parse(digest).hash, /^[a-f0-9]{64}$/);
    // A restart keeps the key; once the owner exists the hint is gone.
    const db = new DatabaseSync(join(dir, "identity", "identity.sqlite"));
    try {
      const now = new Date().toISOString();
      db.prepare(
        'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt") VALUES (?, ?, ?, 1, ?, ?)',
      ).run("TEST-owner", "TEST Owner", "owner@example.test", now, now);
    } finally {
      db.close();
    }
    const after = await start();
    assert.doesNotMatch(after, /No owner yet|acadmin_/);
    assert.equal(readFileSync(join(dir, "admin-key.json"), "utf8"), digest);
    // A key file left by an older version is shown once, then deleted.
    const waiting = join(dir, "admin-key.initial");
    writeFileSync(waiting, "acadmin_TEST-leftover\n", { mode: 0o600 });
    const shown = execFileSync(
      process.execPath,
      [...cli, "admin-key", profile, "--initial"],
      { env, encoding: "utf8" },
    );
    assert.equal(shown.trim(), "acadmin_TEST-leftover");
    assert.ok(!existsSync(waiting));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("without a profile the server builds its own from the environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-deploy-automatic-"));
  try {
    const port = await new Promise<number>((resolve) => {
      const probe = createNetServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    const env = {
      ...process.env,
      TSX_DISABLE_CACHE: "1",
      // The repository's .env may name a development profile.
      SERVER_PROFILE: "",
      NIARO_CONFIG: "",
      NIARO_PUBLIC_URL: `http://localhost:${port}`,
      NIARO_PORT: String(port),
      NIARO_DATA: dir,
      NIARO_NAME: "TEST automatic",
      NIARO_LISTEN_HOST: "",
    };
    const node = [
      "--disable-warning=ExperimentalWarning",
      "--import",
      "tsx",
      "apps/reference-server/cli.ts",
    ];
    // `check` validates the same profile without starting anything.
    const checked = JSON.parse(
      execFileSync(process.execPath, [...node, "check"], {
        env,
        encoding: "utf8",
      }),
    );
    assert.equal(checked.name, "TEST automatic");
    const server = spawn(process.execPath, [...node, "start"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let log = "";
    server.stdout.on("data", (chunk) => (log += String(chunk)));
    server.stderr.on("data", (chunk) => (log += String(chunk)));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(Error(log)), 60_000);
        server.stdout.on("data", () => {
          if (/Administration:/.test(log)) {
            clearTimeout(timer);
            resolve();
          }
        });
        server.once("exit", () => reject(Error(log)));
      });
      assert.match(log, /using the automatic profile/);
      assert.match(log, /No owner yet: open /);
      assert.ok(log.includes(`http://localhost:${port}/admin/`));
      // Everything lives under NIARO_DATA; no plain key is left on disk.
      for (const name of ["admin-key.json", "identity"])
        assert.ok(existsSync(join(dir, name)), name);
      assert.ok(!existsSync(join(dir, "admin-key.initial")));
      // The container healthcheck finds the port without a profile file.
      execFileSync(process.execPath, ["scripts/docker/healthcheck.mjs", ""], {
        env,
      });
      // A recovery key is handed out without naming a profile.
      const key = execFileSync(
        process.execPath,
        [...node, "admin-rotate-key"],
        { env, encoding: "utf8" },
      ).trim();
      assert.match(key, /^acadmin_[A-Za-z0-9_-]{43}$/);
    } finally {
      server.kill("SIGTERM");
      await new Promise((resolve) => server.once("exit", resolve));
    }
    // Without NIARO_PUBLIC_URL there is no automatic profile.
    assert.throws(
      () =>
        execFileSync(process.execPath, [...node, "check"], {
          env: { ...env, NIARO_PUBLIC_URL: "" },
          stdio: "pipe",
        }),
      (error: { stderr?: Buffer }) =>
        /NIARO_PUBLIC_URL/.test(String(error.stderr)),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
