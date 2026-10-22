import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  HostedServers,
  maskLog,
  type HostedRuntime,
} from "../apps/server-hosting/manager";
import {
  DockerSandbox,
  HOSTED_NETWORK,
  NODE_IMAGE,
  ProcessSandbox,
  type Sandbox,
} from "../apps/server-hosting/sandbox";
import {
  HOSTED_TEMPLATES_DIRECTORY,
  hostedBuiltins,
} from "../apps/server-hosting/templates";
import {
  HostedDefinition,
  type HostedDefinitionInput,
} from "../packages/protocol/hosted";

const template = hostedBuiltins().get("microsoft-365")!.definition;
const microsoft = template.source as { npm: string; version: string };
const custom = (
  fields: Partial<HostedDefinitionInput> = {},
): HostedDefinitionInput => ({
  version: 1,
  name: "TEST custom",
  source: { npm: "@example/mcp", version: "1.2.3" },
  args: ["--port", "{port}"],
  ...fields,
});
const node = (code: string) => ({
  command: process.execPath,
  args: ["-e", code],
});
// A stand-in MCP server: prints its environment and a token, then serves HTTP on the
// port found in its arguments (host:port or a bare port).
const server = `
const arg = process.argv.slice(2).find((a) => /(^|:)\\d+$/.test(a));
const port = Number(arg.split(":").at(-1));
console.log("env " + Object.keys(process.env).filter((k) => !k.startsWith("npm_")).sort().join(","));
console.log("SECRET_TOKEN=" + (process.env.SECRET_TOKEN ?? ""));
console.log("Authorization: Bearer eyJabcdefghij.klmnopqrstuv.wxyz0123456 access_token=very-secret");
if (process.env.CRASH_MARKER) process.exit(1);
require("node:http").createServer((q, s) => s.end("ok")).listen(port, "127.0.0.1");
`;
/** Runs the same lifecycle as Docker with plain processes, so supervision is testable anywhere. */
function processSandbox(options: { crash?: boolean; missing?: boolean } = {}) {
  const calls: string[] = [];
  const sandbox: Sandbox = {
    kind: "docker",
    probe: () => node(`process.exit(${options.missing ? 1 : 0})`),
    network: () => ({ inspect: node(""), create: node("") }),
    install: (dir) => {
      calls.push("install");
      return node(`
        const fs = require("node:fs"), p = require("node:path");
        const lock = JSON.parse(fs.readFileSync(p.join(${JSON.stringify(dir)}, "package.json"), "utf8"));
        for (const name of Object.keys(lock.dependencies)) {
          const root = p.join(${JSON.stringify(dir)}, "node_modules", name);
          fs.mkdirSync(p.join(root, "dist"), { recursive: true });
          fs.writeFileSync(p.join(root, "dist", "index.js"), ${JSON.stringify(server)});
          fs.writeFileSync(p.join(root, "package.json"), JSON.stringify({ name, bin: { [name.split("/").at(-1)]: "dist/index.js" } }));
        }`);
    },
    lock: (dir) => {
      calls.push("lock");
      return node(
        `require("node:fs").writeFileSync(${JSON.stringify(join(dir, "package-lock.json"))}, "{}")`,
      );
    },
    run: (spec) => {
      calls.push("run");
      const load = spec.envFile
        ? `for (const l of require("node:fs").readFileSync(${JSON.stringify(spec.envFile)}, "utf8").split("\\n")) if (l) { const i = l.indexOf("="); process.env[l.slice(0, i)] = l.slice(i + 1); }`
        : "";
      const crash = options.crash ? `process.env.CRASH_MARKER = "1";` : "";
      const program =
        spec.program.kind === "node"
          ? {
              file: join(spec.dir, spec.program.entry),
              args: spec.program.args,
            }
          : { file: "", args: [String(spec.port)] };
      return {
        command: process.execPath,
        args: [
          "-e",
          `${load}${crash}process.argv = [process.argv[0], "x", ...${JSON.stringify(program.args)}];${program.file ? `require(${JSON.stringify(program.file)})` : server}`,
        ],
      };
    },
    remove: () => node(""),
  };
  return { sandbox, calls };
}
function harness(
  options: { crash?: boolean; missing?: boolean; allowCustom?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "agent-hosted-"));
  const db = new DatabaseSync(":memory:");
  const trusted = ["https://allowed.example.test"];
  const { sandbox, calls } = processSandbox(options);
  const hosted = new HostedServers(
    db,
    join(root, "hosted"),
    trusted,
    "test-secret",
    {
      sandbox,
      // Docker on purpose: auto would fall back to Node processes.
      ...(options.missing ? { runtime: "docker" as const } : {}),
      npm: "fake-npm",
      allowCustom: options.allowCustom,
      ports: { first: 39150 + Math.floor(Math.random() * 40), last: 39199 },
      readyTimeoutMs: 5000,
      launch: (command, args, spawnOptions) =>
        command === "fake-npm"
          ? spawn(
              process.execPath,
              [
                "-e",
                `console.log(JSON.stringify({ name: "@example/mcp", version: "1.2.3", description: "TEST server", license: "MIT", _npmUser: { name: "publisher" }, time: { "1.2.3": "2026-01-01T00:00:00Z" }, "dist.integrity": "sha512-TEST", bin: { one: "a.js", two: "b.js" }, scripts: { postinstall: "x" } }))`,
              ],
              spawnOptions,
            )
          : spawn(command, args, spawnOptions),
    },
  );
  return { root, db, trusted, calls, hosted };
}
async function until(check: () => boolean, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw Error("timed out");
    await new Promise((r) => setTimeout(r, 50));
  }
}

test("definitions are versioned, exact and pinned; built-ins use the same format", () => {
  const ok = HostedDefinition.parse(custom());
  assert.deepEqual(
    { env: ok.env, secrets: ok.secrets, memoryMb: ok.memoryMb, path: ok.path },
    { env: {}, secrets: [], memoryMb: 512, path: "/mcp" },
  );
  const image = {
    version: 1,
    name: "TEST image",
    source: {
      image: `ghcr.io/example/mcp:1@sha256:${"a".repeat(64)}`,
      port: 8080,
    },
  };
  assert(HostedDefinition.safeParse(image).success, "an image needs no {port}");
  const bad: unknown[] = [
    { ...custom(), version: 2 },
    custom({ source: { npm: "@example/mcp", version: "^1.2.3" } }),
    custom({ source: { npm: "@example/mcp", version: "latest" } }),
    custom({ source: { npm: "../evil", version: "1.0.0" } }),
    custom({ source: { npm: "git+https://x/y.git", version: "1.0.0" } }),
    custom({ args: ["--port", "8080"] }),
    custom({ args: ["--a\nb", "{port}"] }),
    custom({ env: { lower: "x" } }),
    custom({ env: { NODE_OPTIONS: "--allow-child-process" } }),
    custom({ env: { LD_PRELOAD: "/tmp/x.so" } }),
    custom({ secrets: ["PATH"] }),
    custom({ env: { TOKEN: "x" }, secrets: ["TOKEN"] }),
    custom({ secrets: ["TOKEN", "TOKEN"] }),
    custom({ path: "mcp" }),
    custom({ memoryMb: 64 }),
    { ...custom(), command: "sh -c id" },
    { ...image, source: { image: "ghcr.io/example/mcp:latest", port: 8080 } },
    {
      ...image,
      source: { image: `example/mcp@sha256:${"a".repeat(63)}`, port: 8080 },
    },
    { ...image, source: { image: `example/mcp@sha256:${"a".repeat(64)}` } },
    {
      ...image,
      source: {
        image: `example/mcp@sha256:${"a".repeat(64)}`,
        port: 8080,
        npm: "x",
      },
    },
  ];
  for (const value of bad)
    assert(!HostedDefinition.safeParse(value).success, JSON.stringify(value));
  // The built-in installs from a lockfile pinning exactly what its definition names.
  const builtins = hostedBuiltins();
  assert.deepEqual([...builtins.keys()], ["microsoft-365"]);
  const dir = join(HOSTED_TEMPLATES_DIRECTORY, "microsoft-365");
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8"));
  const pinned = lock.packages[`node_modules/${microsoft.npm}`];
  assert.equal(pinned.version, microsoft.version);
  assert.match(pinned.integrity, /^sha512-/);
  assert.equal(
    JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).dependencies[
      microsoft.npm
    ],
    microsoft.version,
  );
});

test("a built-in definition installs once from its lockfile and runs sandboxed on a trusted loopback port", async () => {
  process.env.AGENT_TEST_SECRET = "must-not-leak";
  const h = harness();
  try {
    const created = await h.hosted.create("org-a", "microsoft-365");
    assert.match(created.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(created.builtin, "microsoft-365");
    assert.deepEqual(created.definition, template);
    const origin = new URL(created.url).origin;
    assert(h.trusted.includes(origin));
    await until(() => h.hosted.list("org-a")[0]!.status === "running");
    const log = h.hosted.logs("org-a", created.id).join("\n");
    assert(!log.includes("AGENT_TEST_SECRET"), "no server environment leaks");
    assert(!log.includes("eyJabcdefghij") && !log.includes("very-secret"));
    assert.deepEqual(h.hosted.list("org-b"), []);
    assert.throws(() => h.hosted.logs("org-b", created.id), /hosted_not_found/);
    await assert.rejects(
      h.hosted.create("org-a", "microsoft-365"),
      /hosted_exists/,
    );
    await assert.rejects(
      h.hosted.create("org-a", "nothing-like-this"),
      /hosted_template_unknown/,
    );
    const stopped = h.hosted.command("org-a", created.id, 1, "stop")!;
    assert.equal(stopped.status, "stopped");
    assert.throws(
      () => h.hosted.command("org-a", created.id, 1, "start"),
      /hosted_conflict/,
    );
    h.hosted.command("org-a", created.id, stopped.revision, "start");
    await until(() => h.hosted.list("org-a")[0]!.status === "running");
    assert.equal(h.calls.filter((c) => c === "install").length, 1);
    assert(!h.calls.includes("lock"), "a built-in ships its lockfile");
    const dir = join(h.root, "hosted", created.id);
    h.hosted.command(
      "org-a",
      created.id,
      h.hosted.list("org-a")[0]!.revision,
      "remove",
    );
    assert(!h.trusted.includes(origin));
    assert(!existsSync(dir));
    assert.deepEqual(h.trusted, ["https://allowed.example.test"]);
  } finally {
    delete process.env.AGENT_TEST_SECRET;
    await h.hosted.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("the operator can limit hosted servers to the built-in definitions", async () => {
  const open = harness();
  const h = harness({ allowCustom: false });
  try {
    assert.equal(
      open.hosted.allowCustom,
      true,
      "on unless the operator says so",
    );
    assert.equal(h.hosted.allowCustom, false);
    await assert.rejects(
      h.hosted.createCustom("org-a", custom()),
      /hosted_custom_disabled/,
    );
    await assert.rejects(
      h.hosted.resolve("@example/mcp"),
      /hosted_custom_disabled/,
    );
    // Built-ins stay available.
    await h.hosted.create("org-a", "microsoft-365");
  } finally {
    await open.hosted.close();
    await h.hosted.close();
    rmSync(open.root, { recursive: true, force: true });
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a custom definition keeps secrets sealed, in a private env file and out of the log and export", async () => {
  const h = harness();
  try {
    const info = await h.hosted.resolve("@example/mcp", "1.2.3");
    assert.deepEqual(info.bins, ["one", "two"]);
    assert.equal(info.hasInstallScripts, true);
    assert.equal(info.publisher, "publisher");
    await assert.rejects(
      h.hosted.createCustom("org-a", custom({ secrets: ["SECRET_TOKEN"] }), {
        OTHER: "x",
      }),
      /hosted_invalid/,
    );
    await assert.rejects(
      h.hosted.createCustom("org-a", custom({ path: "no-slash" })),
      /hosted_invalid/,
    );
    const created = await h.hosted.createCustom(
      "org-a",
      custom({ env: { PLAIN: "visible" }, secrets: ["SECRET_TOKEN"] }),
      { SECRET_TOKEN: "TEST-very-private-value" },
    );
    assert.equal(created.builtin, undefined);
    assert.deepEqual(created.secretsSet, ["SECRET_TOKEN"]);
    // The view is the export: the definition with secret names only.
    assert.deepEqual(created.definition, {
      version: 1,
      name: "TEST custom",
      source: { npm: "@example/mcp", version: "1.2.3" },
      args: ["--port", "{port}"],
      env: { PLAIN: "visible" },
      secrets: ["SECRET_TOKEN"],
      memoryMb: 512,
      path: "/mcp",
    });
    assert(!JSON.stringify(created).includes("TEST-very-private-value"));
    assert(
      !JSON.stringify(
        h.db.prepare("SELECT * FROM agent_hosted_server").all(),
      ).includes("TEST-very-private-value"),
    );
    await until(() => h.hosted.list("org-a")[0]!.status === "running");
    assert.deepEqual(h.calls.slice(0, 3), ["lock", "install", "run"]);
    const envFile = join(h.root, "hosted", `${created.id}.env`);
    assert.equal(statSync(envFile).mode & 0o777, 0o600);
    assert.match(
      readFileSync(envFile, "utf8"),
      /SECRET_TOKEN=TEST-very-private-value/,
    );
    assert.match(readFileSync(envFile, "utf8"), /PLAIN=visible/);
    const log = h.hosted.logs("org-a", created.id).join("\n");
    assert.match(log, /SECRET_TOKEN=\[redacted\]/);
    assert(!log.includes("TEST-very-private-value"));
    // A new value restarts the server with it; the pinned lockfile is kept.
    assert.throws(
      () => h.hosted.setSecrets("org-a", created.id, 1, { NOPE: "x" }),
      /hosted_invalid/,
    );
    const rotated = h.hosted.setSecrets("org-a", created.id, 1, {
      SECRET_TOKEN: "TEST-rotated-value",
    });
    assert.equal(rotated.revision, 2);
    await until(
      () =>
        h.hosted.list("org-a")[0]!.status === "running" &&
        h.calls.filter((c) => c === "run").length === 2,
    );
    assert.match(
      readFileSync(envFile, "utf8"),
      /SECRET_TOKEN=TEST-rotated-value/,
    );
    assert.equal(h.calls.filter((c) => c === "lock").length, 1);
    const cleared = h.hosted.setSecrets("org-a", created.id, 2, {
      SECRET_TOKEN: "",
    });
    assert.deepEqual(cleared.secretsSet, []);
    // Importing the export elsewhere gives the same server, without the secret.
    const exported = JSON.parse(JSON.stringify(cleared.definition));
    const imported = await h.hosted.createCustom("org-b", exported);
    assert.deepEqual(imported.definition, created.definition);
    assert.deepEqual(imported.secretsSet, []);
    assert.notEqual(imported.url, created.url);
  } finally {
    await h.hosted.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("servers saved before definitions read as definitions", async () => {
  const h = harness();
  try {
    const insert = h.db.prepare(
      "INSERT INTO agent_hosted_server VALUES (?,?,?,?,?,?)",
    );
    insert.run(
      `hs_${"1".repeat(24)}`,
      "org-a",
      "microsoft-365",
      39100,
      JSON.stringify({ revision: 3, enabled: false }),
      null,
    );
    insert.run(
      `hs_${"2".repeat(24)}`,
      "org-a",
      "custom:1",
      39101,
      JSON.stringify({
        revision: 1,
        enabled: false,
        name: "TEST old",
        definition: {
          source: "npm",
          package: "@example/mcp",
          version: "1.2.3",
          bin: "one",
          args: ["--port", "{port}"],
          env: [
            { name: "PLAIN", value: "visible", secret: false },
            { name: "TOKEN", secret: true },
            { name: "NODE_OPTIONS", value: "--x", secret: false },
          ],
        },
      }),
      null,
    );
    const [builtin, old] = h.hosted.list("org-a");
    assert.equal(builtin!.builtin, "microsoft-365");
    assert.deepEqual(builtin!.definition, template);
    assert.equal(builtin!.revision, 3);
    assert.deepEqual(old!.definition, {
      version: 1,
      name: "TEST old",
      source: { npm: "@example/mcp", version: "1.2.3", bin: "one" },
      args: ["--port", "{port}"],
      env: { PLAIN: "visible" },
      secrets: ["TOKEN"],
      memoryMb: 512,
      path: "/mcp",
    });
    // Rewriting keeps the new format.
    h.hosted.command("org-a", old!.id, 1, "stop");
    assert.deepEqual(h.hosted.list("org-a")[1]!.definition, old!.definition);
  } finally {
    await h.hosted.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a crashing server is restarted with backoff; a missing sandbox fails closed", async () => {
  const crash = harness({ crash: true });
  const missing = harness({ missing: true });
  try {
    await crash.hosted.create("org-a", "microsoft-365");
    await until(
      () => crash.calls.filter((c) => c === "run").length >= 3,
      10000,
    );
    const view = crash.hosted.list("org-a")[0]!;
    assert(view.restarts >= 2);
    assert.notEqual(view.status, "running");
    await missing.hosted.create("org-a", "microsoft-365");
    await until(() => missing.hosted.list("org-a")[0]!.status === "failed");
    assert.equal(missing.hosted.list("org-a")[0]!.error, "sandbox_unavailable");
    assert.equal(missing.calls.length, 0, "nothing runs without the sandbox");
  } finally {
    await crash.hosted.close();
    await missing.hosted.close();
    rmSync(crash.root, { recursive: true, force: true });
    rmSync(missing.root, { recursive: true, force: true });
  }
});
test("Docker runs every server hardened, on loopback, with a pinned image and no inline secrets", () => {
  const docker = new DockerSandbox("docker", "1000:1000");
  const run = docker.run({
    name: "agent-hs_x",
    dir: "/srv/hosted/hs_x",
    port: 39100,
    memoryMb: 512,
    envFile: "/srv/hosted/hs_x.env",
    env: { SHOULD_STAY_IN_FILE: "x" },
    program: {
      kind: "node",
      entry: "node_modules/p/dist/index.js",
      args: ["--http", "0.0.0.0:39100"],
    },
  }).args;
  const pair = (flag: string) => run[run.indexOf(flag) + 1];
  for (const flag of ["--rm", "--read-only"]) assert(run.includes(flag), flag);
  assert.equal(pair("--cap-drop"), "ALL");
  assert.equal(pair("--security-opt"), "no-new-privileges");
  assert.equal(pair("--network"), HOSTED_NETWORK);
  assert.equal(pair("--user"), "1000:1000");
  assert.equal(pair("--pids-limit"), "256");
  assert.equal(pair("--memory"), "512m");
  assert.equal(pair("-p"), "127.0.0.1:39100:39100");
  assert.equal(pair("--env-file"), "/srv/hosted/hs_x.env");
  assert(!run.some((a) => a.includes("SHOULD_STAY_IN_FILE")));
  assert.equal(pair("-v"), "/srv/hosted/hs_x:/data");
  assert(run.includes(NODE_IMAGE));
  assert.match(NODE_IMAGE, /^node@sha256:[a-f0-9]{64}$/);
  assert(
    !run.some((a) => a.startsWith("--privileged") || a === "--network=host"),
  );
  const image = docker.run({
    name: "agent-hs_y",
    dir: "/srv/hosted/hs_y",
    port: 39101,
    memoryMb: 256,
    env: {},
    program: {
      kind: "image",
      image: "example/mcp@sha256:" + "a".repeat(64),
      containerPort: 8080,
      args: [],
    },
  }).args;
  assert.equal(image[image.indexOf("-p") + 1], "127.0.0.1:39101:8080");
  assert(image.includes("--read-only") && image.includes("ALL"));
  const install = docker.install(
    "/srv/hosted/hs_x",
    "/srv/hosted/.npm-cache",
  ).args;
  assert(install.includes("--ignore-scripts") && install.includes(NODE_IMAGE));
  assert.equal(install[install.indexOf("--cap-drop") + 1], "ALL");
  assert.equal(
    maskLog('{"refresh_token":"abc123","other":1} Bearer xyz.def'),
    '{"refresh_token":"[redacted]","other":1} [redacted]',
  );
});

test("auto uses Docker when it answers and Node processes otherwise", async () => {
  const fake = (kind: "docker" | "process", works: boolean): Sandbox => ({
    kind,
    probe: () => node(`process.exit(${works ? 0 : 1})`),
    install: () => node(""),
    lock: () => node(""),
    run: () => node(""),
  });
  const kind = async (runtime: HostedRuntime, docker: boolean) => {
    const root = mkdtempSync(join(tmpdir(), "agent-hosted-"));
    try {
      return await new HostedServers(
        new DatabaseSync(":memory:"),
        join(root, "hosted"),
        [],
        "test-secret",
        {
          runtime,
          sandbox: fake("docker", docker),
          processSandbox: fake("process", true),
        },
      ).sandboxKind();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };
  assert.equal(await kind("auto", true), "docker");
  assert.equal(await kind("auto", false), "process");
  assert.equal(await kind("docker", false), undefined);
  assert.equal(await kind("process", true), "process");
  // The real probe: this Node supports the permission model.
  const probe = new ProcessSandbox().probe();
  const child = spawn(probe.command, probe.args, { stdio: "ignore" });
  assert.equal(
    await new Promise((done) => child.once("exit", (code) => done(code))),
    0,
  );
});

test("a process gets an explicit environment, the permission model and loopback", () => {
  process.env.AGENT_TEST_SECRET = "must-not-leak";
  try {
    const sandbox = new ProcessSandbox("/usr/bin/node", "npm");
    const run = sandbox.run({
      name: "agent-hs_x",
      dir: "/srv/hosted/hs_x",
      port: 39100,
      memoryMb: 512,
      env: {
        MS365_MCP_BODY_FORMAT: "html",
        NODE_OPTIONS: "--allow-child-process",
        LD_PRELOAD: "/srv/hosted/hs_x/evil.so",
        HOME: "/elsewhere",
      },
      program: {
        kind: "node",
        entry: "node_modules/p/dist/index.js",
        args: ["--http", "0.0.0.0:39100", "--host", "0.0.0.0", "--x=0.0.0.0"],
      },
    });
    assert.equal(run.command, "/usr/bin/node");
    assert.equal(run.cwd, "/srv/hosted/hs_x");
    assert.deepEqual(run.args.slice(0, 5), [
      "--permission",
      "--allow-fs-read=/srv/hosted/hs_x",
      "--allow-fs-write=/srv/hosted/hs_x/home",
      "--max-old-space-size=384",
      "--import",
    ]);
    assert.deepEqual(run.args.slice(6), [
      "/srv/hosted/hs_x/node_modules/p/dist/index.js",
      "--http",
      "127.0.0.1:39100",
      "--host",
      "127.0.0.1",
      "--x=0.0.0.0",
    ]);
    assert(
      !run.args.some((a) =>
        /^--allow-(child-process|worker|addons|wasi)/.test(a),
      ),
    );
    assert.deepEqual(run.env, {
      MS365_MCP_BODY_FORMAT: "html",
      PATH: process.env.PATH ?? "",
      HOME: "/srv/hosted/hs_x/home",
      TMPDIR: "/srv/hosted/hs_x/home/tmp",
      NODE_ENV: "production",
    });
    const install = sandbox.install(
      "/srv/hosted/hs_x",
      "/srv/hosted/hs_x/.npm-cache",
    );
    assert.equal(install.command, "npm");
    assert.equal(install.cwd, "/srv/hosted/hs_x");
    assert.deepEqual(install.args, [
      "ci",
      "--ignore-scripts",
      "--omit=dev",
      "--no-audit",
      "--no-fund",
    ]);
    assert.deepEqual(install.env, {
      PATH: process.env.PATH ?? "",
      HOME: "/srv/hosted/hs_x/home",
      TMPDIR: "/srv/hosted/hs_x/home/tmp",
      npm_config_cache: "/srv/hosted/hs_x/.npm-cache",
      npm_config_update_notifier: "false",
    });
    assert.throws(() =>
      sandbox.run({
        name: "agent-hs_y",
        dir: "/srv/hosted/hs_y",
        port: 39101,
        memoryMb: 256,
        env: {},
        program: {
          kind: "image",
          image: "example/mcp@sha256:" + "a".repeat(64),
          containerPort: 8080,
          args: [],
        },
      }),
    );
  } finally {
    delete process.env.AGENT_TEST_SECRET;
  }
});

// Runs under the real permission flags: reports what it can reach, then serves HTTP.
const confined = `
const fs = require("node:fs"), path = require("node:path");
const port = Number(process.argv.slice(2).find((a) => /:\\d+$/.test(a)).split(":").at(-1));
console.log("listen " + process.argv.slice(2).find((a) => /:\\d+$/.test(a)));
console.log("env " + Object.keys(process.env).sort().join(","));
const attempt = (name, fn) => { try { fn(); console.log(name + " ok"); } catch (e) { console.log(name + " " + e.code); } };
attempt("outside", () => fs.readFileSync(path.resolve(__dirname, "../../../../../../secret")));
attempt("sibling", () => fs.readdirSync(path.resolve(__dirname, "../../../../..")));
attempt("own", () => fs.readFileSync(path.resolve(__dirname, "../../../../package.json")));
attempt("home", () => fs.writeFileSync(path.join(process.env.HOME, "state.json"), "{}"));
attempt("dir", () => fs.writeFileSync(path.resolve(__dirname, "../../../../x"), ""));
attempt("child", () => require("node:child_process").execFileSync(process.execPath, ["-v"]));
require("node:http").createServer((q, s) => s.end("ok")).listen(port, "127.0.0.1");
`;
/** npm without the registry: a lockfile for `install --package-lock-only`, and for
 * `ci` each dependency of package.json laid out with one executable. */
function offlineNpm(
  calls: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv }[],
) {
  return (
    command: string,
    args: string[],
    options: Parameters<typeof spawn>[2],
  ) => {
    if (command !== "fake-npm") return spawn(command, args, options);
    calls.push({ args, cwd: options.cwd?.toString(), env: options.env! });
    const dir = String(options.cwd);
    return spawn(
      process.execPath,
      [
        "-e",
        `const fs = require("node:fs"), p = require("node:path"), dir = ${JSON.stringify(dir)};
        const deps = JSON.parse(fs.readFileSync(p.join(dir, "package.json"), "utf8")).dependencies;
        if (${JSON.stringify(args[0])} === "install") {
          fs.writeFileSync(p.join(dir, "package-lock.json"), JSON.stringify({ lockfileVersion: 3, packages: { "": { dependencies: deps } } }));
          process.exit(0);
        }
        for (const name of Object.keys(deps)) {
          const root = p.join(dir, "node_modules", name);
          fs.mkdirSync(p.join(root, "dist"), { recursive: true });
          fs.writeFileSync(p.join(root, "package.json"), JSON.stringify({ name, type: "commonjs", bin: { [name.split("/").at(-1)]: "dist/index.js" } }));
          fs.writeFileSync(p.join(root, "dist", "index.js"), ${JSON.stringify(confined)});
        }`,
      ],
      options,
    );
  };
}
test("without Docker npm definitions run as confined Node processes that cannot read the server's files", async () => {
  process.env.AGENT_TEST_SECRET = "must-not-leak";
  const root = mkdtempSync(join(tmpdir(), "agent-hosted-"));
  // Stands in for the identity directory's own files beside hosted/.
  writeFileSync(join(root, "secret"), "TEST-identity-secret", { mode: 0o600 });
  const installs: { args: string[]; cwd?: string; env: NodeJS.ProcessEnv }[] =
    [];
  const trusted: string[] = [];
  const hosted = new HostedServers(
    new DatabaseSync(":memory:"),
    join(root, "hosted"),
    trusted,
    "test-secret",
    {
      runtime: "process",
      processSandbox: new ProcessSandbox(process.execPath, "fake-npm"),
      ports: { first: 39150 + Math.floor(Math.random() * 40), last: 39199 },
      readyTimeoutMs: 8000,
      launch: offlineNpm(installs),
    },
  );
  try {
    assert.equal(await hosted.sandboxKind(), "process");
    const created = await hosted.create("org-a", "microsoft-365");
    const origin = new URL(created.url).origin;
    assert(trusted.includes(origin));
    await until(() => hosted.list("org-a")[0]!.status === "running", 15000);
    const response = await fetch(`${origin}/`);
    assert.equal(await response.text(), "ok");
    const dir = join(root, "hosted", created.id);
    assert.deepEqual(
      installs.map((i) => i.args[0]),
      ["ci"],
      "a built-in installs from its committed lockfile",
    );
    assert.equal(installs[0]!.cwd, dir);
    assert.equal(installs[0]!.env.npm_config_cache, join(dir, ".npm-cache"));
    assert.equal(installs[0]!.env.AGENT_TEST_SECRET, undefined);
    const log = hosted.logs("org-a", created.id);
    assert(log.includes(`listen 127.0.0.1:${new URL(origin).port}`));
    assert(
      log.includes("env HOME,MS365_MCP_BODY_FORMAT,NODE_ENV,PATH,TMPDIR"),
      log.join("\n"),
    );
    for (const line of [
      "outside ERR_ACCESS_DENIED",
      "sibling ERR_ACCESS_DENIED",
      "own ok",
      "home ok",
      "dir ERR_ACCESS_DENIED",
      "child ERR_ACCESS_DENIED",
    ])
      assert(log.includes(line), `${line}\n${log.join("\n")}`);
    assert(!existsSync(join(root, "hosted", `${created.id}.env`)));
    // Stopping ends the process; no leftover listens on the port.
    const stopped = hosted.command("org-a", created.id, 1, "stop")!;
    assert.equal(stopped.status, "stopped");
    await assert.rejects(
      (async () => {
        for (let i = 0; i < 40; i++) {
          await fetch(`${origin}/`);
          await new Promise((r) => setTimeout(r, 100));
        }
      })(),
    );
    // A link out of the directory would be followed, so it fails the start.
    symlinkSync(join(root, "secret"), join(dir, "home", "link"));
    hosted.command("org-a", created.id, stopped.revision, "start");
    await until(() => hosted.list("org-a")[0]!.status === "failed");
    assert.equal(hosted.list("org-a")[0]!.error, "install_failed");

    // A custom npm definition: pinned by a generated lockfile, then the same confinement.
    const own = await hosted.createCustom(
      "org-a",
      custom({
        args: ["--listen", "0.0.0.0:{port}"],
        env: { PLAIN: "visible" },
        secrets: ["SECRET_TOKEN"],
        memoryMb: 256,
      }),
      { SECRET_TOKEN: "TEST-process-secret" },
    );
    await until(
      () =>
        hosted.list("org-a").find((s) => s.id === own.id)?.status === "running",
      15000,
    );
    const ownDir = join(root, "hosted", own.id);
    const ownInstalls = installs.filter((i) => i.cwd === ownDir);
    assert.deepEqual(
      ownInstalls.map((i) => i.args.slice(0, 3)),
      [
        ["install", "--package-lock-only", "--ignore-scripts"],
        ["ci", "--ignore-scripts", "--omit=dev"],
      ],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(ownDir, "package.json"), "utf8"))
        .dependencies,
      { "@example/mcp": "1.2.3" },
    );
    assert(existsSync(join(ownDir, "package-lock.json")));
    const ownLog = hosted.logs("org-a", own.id);
    assert(
      ownLog.includes("env HOME,NODE_ENV,PATH,PLAIN,SECRET_TOKEN,TMPDIR"),
      ownLog.join("\n"),
    );
    for (const line of ["outside ERR_ACCESS_DENIED", "child ERR_ACCESS_DENIED"])
      assert(ownLog.includes(line), `${line}\n${ownLog.join("\n")}`);
    assert(!existsSync(join(root, "hosted", `${own.id}.env`)));
    assert.equal(
      await (await fetch(`${new URL(own.url).origin}/`)).text(),
      "ok",
    );
    // An image needs Docker: refused up front, and a stored one shows why it cannot run.
    const image = custom({
      name: "TEST image",
      source: { image: `example/mcp@sha256:${"a".repeat(64)}`, port: 8080 },
      args: [],
    });
    await assert.rejects(
      hosted.createCustom("org-a", image),
      /hosted_docker_required/,
    );
  } finally {
    delete process.env.AGENT_TEST_SECRET;
    await hosted.close();
    rmSync(root, { recursive: true, force: true });
  }
});
