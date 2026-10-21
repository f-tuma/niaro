import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Each process owns one genuine pair and its private SQLite tuple. This keeps
// the real auth bootstrap rate limit and waits for actual process termination.
for (const scenario of [
  "tools-unpriced",
  "decision-unpriced",
  "write-succeeded",
  "write-unknown",
  "exhausted",
  "continuity-preflight",
] as const) {
  for (const language of ["en", "cs"] as const) {
    test(
      `paired HTTP and ClientSession preserve ${scenario} budget failure in ${language}`,
      { timeout: 150_000 },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "niaro-budget-http-worker-"));
        chmodSync(root, 0o700);
        let child: ReturnType<typeof spawn> | undefined;
        let closed:
          | Promise<{ code: number | null; signal: NodeJS.Signals | null }>
          | undefined;
        let deadline: ReturnType<typeof setTimeout> | undefined;
        let stdout = "",
          stderr = "";
        let failure: Error | undefined;
        try {
          const env: NodeJS.ProcessEnv = {
            ...process.env,
            TMPDIR: root,
            TSX_DISABLE_CACHE: "1",
          };
          delete env.NODE_TEST_CONTEXT;
          child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              fileURLToPath(
                new URL(
                  "./helpers/native-budget-failure-http-worker.ts",
                  import.meta.url,
                ),
              ),
              scenario,
              language,
            ],
            { env, stdio: ["ignore", "pipe", "pipe"] },
          );
          closed = new Promise((resolve) => {
            child!.once("error", (error) => {
              failure = error;
            });
            child!.once("close", (code, signal) => resolve({ code, signal }));
          });
          const collect = (chunk: Buffer, stream: "stdout" | "stderr") => {
            if (stream === "stdout") stdout += chunk.toString();
            else stderr += chunk.toString();
            if (
              Buffer.byteLength(stdout) + Buffer.byteLength(stderr) >
              64 * 1024
            ) {
              failure = Error(
                "TEST budget HTTP worker exceeded bounded output",
              );
              child!.kill("SIGKILL");
            }
          };
          child.stdout!.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
          child.stderr!.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
          deadline = setTimeout(() => {
            failure = Error("TEST budget HTTP worker exceeded 120 seconds");
            child!.kill("SIGKILL");
          }, 120_000);
          const exit = await closed;
          if (failure) throw failure;
          assert.equal(exit.signal, null, stderr);
          assert.equal(exit.code, 0, stdout + stderr);
          const result: unknown = JSON.parse(stdout.trim().split("\n").at(-1)!);
          assert(result && typeof result === "object");
          assert.deepEqual(
            { ...result },
            {
              scenario,
              language,
              status: scenario === "continuity-preflight" ? 422 : 202,
              reason:
                scenario === "exhausted" || scenario.startsWith("write-")
                  ? "catalog_budget_exhausted"
                  : "catalog_budget_price_required",
              models: scenario.startsWith("write-")
                ? 3
                : scenario === "tools-unpriced"
                  ? 0
                  : 1,
              decisionCalls: scenario.startsWith("write-") ? 1 : 0,
              writes: scenario.startsWith("write-") ? ["POST"] : [],
              reopens: 2,
            },
          );
          assert.deepEqual(
            readdirSync(root),
            [],
            "TEST worker must close the tuple and remove its private roots before actual exit",
          );
        } finally {
          if (deadline) clearTimeout(deadline);
          if (child && child.exitCode === null && child.signalCode === null)
            child.kill("SIGKILL");
          if (closed) await closed;
          rmSync(root, { recursive: true, force: true });
        }
      },
    );
  }
}
