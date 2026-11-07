/**
 * Crash harness for the Pi agent core, for every wave that moves work onto
 * it (NIAR-302 onward): a real SIGKILL of a child process at a named point,
 * then a fresh process reopening the same files.
 *
 * Parent side: `crashAndResume()` starts `<child> <scenario> start <dir>`,
 * waits for the line `MARK <name> ...`, kills the child with SIGKILL after
 * `delayMs`, then runs `<child> <scenario> resume <dir>` to completion and
 * returns the `RESULT <json>` it printed for the test to assert on.
 *
 * Child side: `crashChild()` reads the arguments and offers `mark()`,
 * `state()` (small JSON files that survive the kill) and `result()`.
 */
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type StepOutcome = {
  code: number | null;
  signal: NodeJS.Signals | null;
  lines: string[];
  stderr: string[];
};

/** Run one child step; with `killAt`, SIGKILL it `delayMs` after that mark. */
export function runStep(
  child: string,
  scenario: string,
  step: "start" | "resume",
  dir: string,
  options: { killAt?: string; delayMs?: number; timeoutMs?: number } = {},
) {
  return new Promise<StepOutcome>((resolve) => {
    const process_ = spawn(
      process.execPath,
      ["--no-warnings", "--import", "tsx", child, scenario, step, dir],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env } },
    );
    const lines: string[] = [];
    const stderr: string[] = [];
    let killed = false;
    const timeout = setTimeout(
      () => process_.kill("SIGKILL"),
      options.timeoutMs ?? 30_000,
    );
    createInterface({ input: process_.stdout }).on("line", (line) => {
      lines.push(line);
      if (
        options.killAt &&
        !killed &&
        line.startsWith(`MARK ${options.killAt}`)
      ) {
        killed = true;
        setTimeout(() => process_.kill("SIGKILL"), options.delayMs ?? 0);
      }
    });
    createInterface({ input: process_.stderr }).on("line", (line) =>
      stderr.push(line),
    );
    process_.on("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, lines, stderr });
    });
  });
}

export type CrashRun<R> = {
  start: StepOutcome;
  resume: StepOutcome;
  /** What the resumed process reported with `result()`. */
  result: R;
};

/** Kill the start step at `killAt`, resume in a fresh process, return its result. */
export async function crashAndResume<R = unknown>(
  child: string,
  scenario: string,
  plan: { killAt: string; delayMs?: number; timeoutMs?: number },
): Promise<CrashRun<R>> {
  const dir = mkdtempSync(join(tmpdir(), `niaro-pi-crash-${scenario}-`));
  try {
    const start = await runStep(child, scenario, "start", dir, plan);
    if (start.signal !== "SIGKILL")
      throw new Error(
        `start step of ${scenario} was not killed at ${plan.killAt}: code=${start.code}\n${[...start.lines, ...start.stderr].join("\n")}`,
      );
    const resume = await runStep(child, scenario, "resume", dir, {
      timeoutMs: plan.timeoutMs,
    });
    const line = resume.lines.find((value) => value.startsWith("RESULT "));
    if (resume.code !== 0 || !line)
      throw new Error(
        `resume step of ${scenario} failed: code=${resume.code}\n${[...resume.lines, ...resume.stderr].join("\n")}`,
      );
    return { start, resume, result: JSON.parse(line.slice(7)) as R };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The child process's side. */
export function crashChild() {
  const [scenario, step, dir] = process.argv.slice(2) as [
    string,
    "start" | "resume",
    string,
  ];
  if (!scenario || !dir || (step !== "start" && step !== "resume"))
    throw new Error("usage: <child> <scenario> <start|resume> <dir>");
  return {
    scenario,
    step,
    dir,
    /** Tell the parent a crash point was reached. */
    mark(name: string, data: unknown = {}) {
      console.log(`MARK ${name} ${JSON.stringify(data)}`);
    },
    /** Write (with a value) or read a JSON value that outlives the process. */
    state<T>(key: string, value?: T): T {
      const file = join(dir, `${key}.state.json`);
      if (value !== undefined) writeFileSync(file, JSON.stringify(value));
      return value ?? (JSON.parse(readFileSync(file, "utf8")) as T);
    },
    /** Report what the resumed process found; the parent asserts on it. */
    result(value: unknown) {
      console.log(`RESULT ${JSON.stringify(value)}`);
    },
    /** Hold the process (and its event loop) until it is killed. */
    hang: () =>
      new Promise<never>(() => {
        setInterval(() => {}, 1_000);
      }),
  };
}
