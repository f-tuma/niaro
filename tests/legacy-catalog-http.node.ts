import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

// Each worker owns one genuine pair and all private fixture/copy roots. A fresh
// process preserves Better Auth's bootstrap limit instead of bypassing it.
for (const mode of ["agent", "progressive"] as const) {
  for (const outcome of [
    "succeeded",
    "rejected",
    "unknown",
    "question",
    "failed",
  ] as const) {
    test(
      outcome === "failed"
        ? `paired HTTP restores pre-existing canonical failed ${mode}-1 write through its first current public route, exact retry and two reopens without another attempt`
        : `paired HTTP restores authentic ${mode}-1 ${outcome} history from a complete stopped copy`,
      { timeout: 150_000 },
      async () => {
        const root = mkdtempSync(join(tmpdir(), "niaro-legacy-http-worker-"));
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
                  "./helpers/legacy-catalog-http-worker.ts",
                  import.meta.url,
                ),
              ),
              mode,
              outcome,
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
                "TEST legacy HTTP worker exceeded bounded output",
              );
              child!.kill("SIGKILL");
            }
          };
          child.stdout!.on("data", (chunk: Buffer) => collect(chunk, "stdout"));
          child.stderr!.on("data", (chunk: Buffer) => collect(chunk, "stderr"));
          deadline = setTimeout(() => {
            failure = Error("TEST legacy HTTP worker exceeded 120 seconds");
            child!.kill("SIGKILL");
          }, 120_000);
          const exit = await closed;
          if (failure) throw failure;
          assert.equal(exit.signal, null, stderr);
          assert.equal(exit.code, 0, stdout + stderr);
          const lines = stdout.trim().split("\n");
          const result: unknown = JSON.parse(lines.at(-1)!);
          assert(result && typeof result === "object");
          assert.deepEqual(
            { ...result, decisions: undefined, models: undefined },
            {
              mode,
              outcome,
              kind: mode + "-1",
              reopens: 2,
              dispatches:
                outcome === "rejected" ||
                outcome === "question" ||
                outcome === "failed"
                  ? []
                  : ["POST"],
              decisions: undefined,
              models: undefined,
              serviceAttempts:
                outcome === "rejected" || outcome === "question" ? 0 : 1,
              receiptStatusAtCopy:
                outcome === "question"
                  ? null
                  : outcome === "failed"
                    ? "failed"
                    : "awaiting_approval",
              firstPublicQuestionRoute: outcome === "question",
              firstPublicFailedRoute: outcome === "failed",
              protectedSource: true,
            },
          );
          assert.deepEqual(
            readdirSync(root),
            [],
            "TEST worker must close every fixture and remove all private roots before actual exit",
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
