import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { HostedServers, maskLog } from "../apps/server-hosting/manager";
import {
  DockerSandbox,
  HOSTED_NETWORK,
  NODE_IMAGE,
  type Sandbox,
} from "../apps/server-hosting/sandbox";
import { HOSTED_TEMPLATES } from "../apps/server-hosting/templates";

const template = HOSTED_TEMPLATES["microsoft-365"];
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
          fs.writeFileSync(p.join(root, "package.json"), JSON.stringify({ name, bin: { only: "dist/index.js" } }));
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

test("a curated template installs once from its lockfile and runs sandboxed on a trusted loopback port", async () => {
  process.env.AGENT_TEST_SECRET = "must-not-leak";
  const h = harness();
  try {
    const created = h.hosted.create("org-a", "microsoft-365");
    assert.match(created.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
    assert.equal(created.artifact, template.package);
    const origin = new URL(created.url).origin;
    assert(h.trusted.includes(origin));
    await until(() => h.hosted.list("org-a")[0]!.status === "running");
    const log = h.hosted.logs("org-a", created.id).join("\n");
    assert(!log.includes("AGENT_TEST_SECRET"), "no server environment leaks");
    assert(!log.includes("eyJabcdefghij") && !log.includes("very-secret"));
    assert.deepEqual(h.hosted.list("org-b"), []);
    assert.throws(() => h.hosted.logs("org-b", created.id), /hosted_not_found/);
    assert.throws(
      () => h.hosted.create("org-a", "microsoft-365"),
      /hosted_exists/,
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

test("custom servers need the operator's permission", async () => {
  const h = harness();
  try {
    assert.equal(h.hosted.allowCustom, false);
    assert.throws(
      () =>
        h.hosted.createCustom("org-a", "TEST", {
          source: "npm",
          package: "@example/mcp",
          version: "1.2.3",
          args: ["--port", "{port}"],
          env: [],
        }),
      /hosted_custom_disabled/,
    );
    await assert.rejects(
      h.hosted.resolve("@example/mcp"),
      /hosted_custom_disabled/,
    );
  } finally {
    await h.hosted.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a custom npm server keeps secrets sealed, in a private env file and out of the log", async () => {
  const h = harness({ allowCustom: true });
  try {
    const info = await h.hosted.resolve("@example/mcp", "1.2.3");
    assert.deepEqual(info.bins, ["one", "two"]);
    assert.equal(info.hasInstallScripts, true);
    assert.equal(info.publisher, "publisher");
    const created = h.hosted.createCustom("org-a", "TEST custom", {
      source: "npm",
      package: "@example/mcp",
      version: "1.2.3",
      args: ["--port", "{port}"],
      env: [
        {
          name: "SECRET_TOKEN",
          value: "TEST-very-private-value",
          secret: true,
        },
        { name: "PLAIN", value: "visible", secret: false },
      ],
    });
    assert.deepEqual(created.env, [
      { name: "SECRET_TOKEN", secret: true },
      { name: "PLAIN", secret: false, value: "visible" },
    ]);
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
    const log = h.hosted.logs("org-a", created.id).join("\n");
    assert.match(log, /SECRET_TOKEN=\[redacted\]/);
    assert(!log.includes("TEST-very-private-value"));
  } finally {
    await h.hosted.close();
    rmSync(h.root, { recursive: true, force: true });
  }
});

test("a crashing server is restarted with backoff; a missing sandbox fails closed", async () => {
  const crash = harness({ crash: true });
  const missing = harness({ missing: true });
  try {
    crash.hosted.create("org-a", "microsoft-365");
    await until(
      () => crash.calls.filter((c) => c === "run").length >= 3,
      10000,
    );
    const view = crash.hosted.list("org-a")[0]!;
    assert(view.restarts >= 2);
    assert.notEqual(view.status, "running");
    missing.hosted.create("org-a", "microsoft-365");
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
