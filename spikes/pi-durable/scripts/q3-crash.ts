/**
 * Q3: real SIGKILL of a child process at a scenario's crash point, then a fresh process
 * resumes the same SQLite storage. Usage: q3-crash.ts [scenario...]  (default: all)
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const child = fileURLToPath(new URL("./q3-child.ts", import.meta.url));
const root = fileURLToPath(new URL("../", import.meta.url));

type Plan = { title: string; killAt: string; delayMs: number };
const PLANS: Record<string, Plan> = {
  a: { title: "a) killed during a model request (streaming)", killAt: "streaming", delayMs: 1500 },
  "b-unsafe": { title: "b) killed after write side effect, before result commit — replay unsafe (Pi default) + content idempotency key", killAt: "side_effect_done", delayMs: 1300 },
  "b-none": { title: "b') same crash, replay unsafe, NO stable idempotency key (control)", killAt: "side_effect_done", delayMs: 1300 },
  "b-safe": { title: "b'') same crash, replay safe + per-task idempotency key", killAt: "side_effect_done", delayMs: 1300 },
  c: { title: "c) killed while waiting for approval", killAt: "approval_pending", delayMs: 300 },
  d: { title: "d) duplicate submission with the same requestId (concurrent, then again after a crash)", killAt: "submitted", delayMs: 400 },
};

function run(scenario: string, step: string, dir: string, killAt?: string, delayMs = 0) {
  return new Promise<{ code: number | null; signal: string | null; lines: string[] }>((resolve) => {
    const p = spawn(process.execPath, ["--no-warnings", "--import", "tsx", child, scenario, step, dir], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const lines: string[] = [];
    let killed = false;
    const timeout = setTimeout(() => p.kill("SIGKILL"), 30_000);
    createInterface({ input: p.stdout }).on("line", (line) => {
      lines.push(line);
      console.log(`  [${step} pid ${p.pid}] ${line}`);
      if (killAt && !killed && line.startsWith(`MARK ${killAt}`)) {
        killed = true;
        setTimeout(() => {
          console.log(`  [parent] SIGKILL pid ${p.pid} (${delayMs} ms after "${killAt}")`);
          p.kill("SIGKILL");
        }, delayMs);
      }
    });
    createInterface({ input: p.stderr }).on("line", (line) => console.log(`  [${step} stderr] ${line}`));
    p.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, lines });
    });
  });
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PLANS);
let failed = 0;
for (const scenario of wanted) {
  const plan = PLANS[scenario]!;
  console.log(`\n=== Q3 ${plan.title} ===`);
  const dir = `${root}.data/q3-${scenario}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const first = await run(scenario, "start", dir, plan.killAt, plan.delayMs);
  console.log(`  [parent] start process ended: code=${first.code} signal=${first.signal}`);
  if (first.signal !== "SIGKILL") console.log("  [parent] WARNING: start process was not killed");
  const second = await run(scenario, "resume", dir);
  console.log(`  [parent] resume process ended: code=${second.code}`);
  failed += second.lines.filter((l) => l.startsWith("FAIL")).length + (second.code === 0 ? 0 : 1);
}
console.log(`\nQ3 done: ${failed === 0 ? "all checks passed" : failed + " failure(s)"}`);
process.exitCode = failed ? 1 : 0;
