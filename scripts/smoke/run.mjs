#!/usr/bin/env node
// Pilot smoke test (docs/goal.md, checklist item 14): builds the image (or
// uses NIARO_IMAGE), starts a fresh container on a fresh volume and a free
// loopback port, runs the API journey and the browser journey, prints a
// PASS / FAIL summary per step and always removes the container and volume.
//
//   npm run smoke
//   NIARO_IMAGE=niaro:local npm run smoke                 skip the build
//   PLAYWRIGHT_CORE=/path/to/node_modules/playwright-core \
//   CHROMIUM=~/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell \
//     npm run smoke                                        with the browser part
//
// Other settings: SMOKE_PORT (default: a free port), SMOKE_OUTPUT (screenshots
// and logs; default a new temporary directory), SMOKE_KEEP=1 (leave the
// container and volume running for inspection), SMOKE_SKIP_BROWSER=1.
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  createWriteStream,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { apiJourney, smokeAccounts } from "./api-journey.mjs";
import { browserJourney } from "./browser-journey.mjs";
import { assert, delay, Report, StepFailed } from "./lib.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const id = randomBytes(4).toString("hex");
const name = `niaro-smoke-${id}`;
const volume = `${name}-data`;
const output = process.env.SMOKE_OUTPUT
  ? resolve(process.env.SMOKE_OUTPUT)
  : mkdtempSync(join(tmpdir(), "niaro-smoke-"));
mkdirSync(output, { recursive: true });
const report = new Report();
const J = "container";

const docker = (...args) =>
  execFileSync("docker", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
const rawLogs = () => {
  try {
    return execFileSync("docker", ["logs", name], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 << 20,
    });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`;
  }
};
/** The log without the administrator key, for printing and saving. */
const logs = () =>
  rawLogs().replace(/acadmin_[A-Za-z0-9_-]+/g, "acadmin_<redacted>");
const freePort = () =>
  new Promise((ok, fail) => {
    const server = createServer();
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => ok(port));
    });
  });

let started = false;
let keySource = "";
let cleaned = false;
function cleanup() {
  if (cleaned || !started) return;
  cleaned = true;
  if (process.env.SMOKE_KEEP === "1") {
    console.log(
      `\nSMOKE_KEEP=1: container ${name} and volume ${volume} left running.`,
    );
    return;
  }
  for (const args of [
    ["rm", "-f", name],
    ["volume", "rm", "-f", volume],
  ])
    try {
      docker(...args);
    } catch (error) {
      console.error(
        `cleanup: docker ${args.join(" ")} failed: ${error.message.split("\n")[0]}`,
      );
    }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });

async function build(image) {
  const log = join(output, "docker-build.log");
  const file = createWriteStream(log);
  const child = spawn("docker", ["build", "-t", image, "."], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(file);
  child.stderr.pipe(file);
  const code = await new Promise((ok) => child.on("close", ok));
  file.end();
  if (code !== 0) {
    const tail = readFileSync(log, "utf8").split("\n").slice(-25).join("\n");
    throw new Error(`docker build exited with ${code} (log: ${log})\n${tail}`);
  }
}

async function main() {
  console.log(`Niaro pilot smoke test ${id}; output in ${output}`);
  const image = process.env.NIARO_IMAGE || "niaro:smoke";
  const port = Number(process.env.SMOKE_PORT) || (await freePort());
  const base = `http://localhost:${port}`;

  await report.step(
    J,
    process.env.NIARO_IMAGE ? `use image ${image}` : `build image ${image}`,
    async () => {
      if (process.env.NIARO_IMAGE) docker("image", "inspect", image);
      else await build(image);
    },
  );

  await report.step(J, `start a fresh container on ${base}`, async () => {
    // The example profile, listening on the published port so the public
    // origin http://localhost:<port> matches the container's listen port.
    const profile = JSON.parse(
      readFileSync(join(root, "examples/self-hosted/server.json"), "utf8"),
    );
    profile.listen.port = port;
    const profilePath = join(output, "server.json");
    writeFileSync(profilePath, JSON.stringify(profile, null, 2), {
      mode: 0o644,
    });
    docker("volume", "create", volume);
    started = true;
    docker(
      "run",
      "-d",
      "--init",
      "--name",
      name,
      "-v",
      `${volume}:/data`,
      "-v",
      `${profilePath}:/config/server.json:ro`,
      "-e",
      `NIARO_PUBLIC_URL=${base}`,
      "-e",
      "NIARO_TRUST_PROXY=0",
      "-p",
      `127.0.0.1:${port}:${port}`,
      // The hardened compose setup: read-only root, no capabilities.
      "--read-only",
      "--tmpfs",
      "/tmp",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      image,
    );
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        const response = await fetch(`${base}/healthz`, {
          signal: AbortSignal.timeout(2000),
        });
        if (response.ok) break;
      } catch {
        /* still starting */
      }
      const state = docker("inspect", "-f", "{{.State.Running}}", name).trim();
      if (state !== "true")
        throw new Error(`container exited:\n${logs().slice(-3000)}`);
      if (Date.now() > deadline)
        throw new Error(`no /healthz within 90 s:\n${logs().slice(-3000)}`);
      await delay(500);
    }
    // The image's own health probe works too.
    docker("exec", name, "niaro", "healthcheck");
  });

  const adminKey = await report.step(
    J,
    "first-run administrator key is handed out once",
    async () => {
      // Current images keep the key out of the log when stdout is not a
      // terminal: `niaro admin-key --initial` prints and deletes
      // /data/admin-key.initial. Older images print it once in the log.
      let initial = "";
      try {
        initial = docker("exec", name, "niaro", "admin-key", "--initial");
      } catch {
        /* older image or no initial file */
      }
      const fromFile = initial.match(/acadmin_[A-Za-z0-9_-]+/)?.[0];
      const keysInLog = rawLogs().match(/acadmin_[A-Za-z0-9_-]+/g) ?? [];
      if (fromFile) {
        assert.equal(keysInLog.length, 0, "the key must not be in the log");
        let again = "";
        try {
          again = docker("exec", name, "niaro", "admin-key", "--initial");
        } catch {
          /* expected: the file is gone */
        }
        assert.ok(
          !again.includes(fromFile),
          "admin-key --initial printed the key a second time",
        );
        keySource = "admin-key --initial";
        return fromFile;
      }
      assert.ok(
        rawLogs().includes("=== First start: administrator key"),
        "no key from admin-key --initial and no first-start banner in the log",
      );
      assert.equal(
        keysInLog.length,
        1,
        `expected the key exactly once in the log, found ${keysInLog.length}`,
      );
      keySource = "first-start log";
      return keysInLog[0];
    },
  );
  console.log(`  (administrator key from ${keySource})`);

  const accounts = smokeAccounts();
  let ctx;
  console.log("\nAPI journey");
  try {
    ctx = await apiJourney(report, { base, adminKey, accounts });
    if (ctx.chat)
      console.log(
        `  (chat outcome: HTTP ${ctx.chat.httpStatus} ${ctx.chat.commandStatus}: "${ctx.chat.reply}")`,
      );
  } catch (error) {
    if (!(error instanceof StepFailed)) throw error;
  }

  console.log("\nBrowser journey");
  if (process.env.SMOKE_SKIP_BROWSER === "1")
    report.skip("browser", "browser journey", "SMOKE_SKIP_BROWSER=1");
  else if (!ctx)
    report.skip(
      "browser",
      "browser journey",
      "the API journey did not create the accounts",
    );
  else
    try {
      await browserJourney(report, {
        base,
        accounts,
        outputDir: join(output, "screenshots"),
      });
    } catch (error) {
      if (!(error instanceof StepFailed)) throw error;
    }

  await report.step(
    J,
    "server log carries no passwords, tokens or message text",
    async () => {
      const text = logs();
      writeFileSync(join(output, "container.log"), text, { mode: 0o600 });
      const secrets = [
        accounts.owner.password,
        accounts.member.password,
        ctx?.inviteToken,
        ctx?.bearer,
        "Smoke test message",
        "tohle je smoke test",
      ].filter(Boolean);
      const leaked = secrets.filter((s) => text.includes(s));
      assert.deepEqual(
        leaked.map((s) => s.slice(0, 12) + "…"),
        [],
        "secrets in the container log",
      );
      const errors = text
        .split("\n")
        .filter((line) => line.startsWith("{") && /"level":"error"/.test(line));
      assert.deepEqual(errors, [], "error lines in the container log");
    },
    { soft: true },
  );
}

try {
  await main();
} catch (error) {
  if (!(error instanceof StepFailed)) {
    console.error(error);
    report.results.push({
      journey: "runner",
      name: "unexpected error",
      status: "FAIL",
      ms: 0,
      detail: String(error?.message ?? error),
    });
  }
} finally {
  if (report.failed && started) {
    const text = logs();
    writeFileSync(join(output, "container.log"), text, { mode: 0o600 });
    console.log(
      `\nLast container log lines (full log: ${join(output, "container.log")}):`,
    );
    console.log(text.split("\n").slice(-30).join("\n"));
  }
  cleanup();
}
console.log(report.summary());
console.log(`Output: ${output}`);
process.exitCode = report.failed ? 1 : 0;
