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
  for (const scenario of ["direct", "interleaved"] as const) {
    test(
      `paired ClientSession continues an authentic restored ${mode}-1 read/question into one guarded native root (${scenario})`,
      { timeout: 240_000 },
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
                  "./helpers/legacy-native-continuity-http-worker.ts",
                  import.meta.url,
                ),
              ),
              mode,
              scenario,
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
            failure = Error("TEST legacy HTTP worker exceeded 210 seconds");
            child!.kill("SIGKILL");
          }, 210_000);
          const exit = await closed;
          if (failure) throw failure;
          assert.equal(exit.signal, null, stderr);
          assert.equal(exit.code, 0, stdout + stderr);
          const lines = stdout.trim().split("\n");
          const result: unknown = JSON.parse(lines.at(-1)!);
          assert(result && typeof result === "object");
          const proof = result as {
            mode: string;
            scenario: string;
            originalIdsDistinct: boolean;
            kind: string;
            native: string;
            reopens: number;
            positiveRead: number;
            positiveWrites: number;
            negativeResults: string[];
            protectedSource: boolean;
            interleavings: number;
          };
          assert.equal(proof.mode, mode);
          assert.equal(proof.scenario, scenario);
          assert.equal(proof.originalIdsDistinct, scenario === "interleaved");
          assert.equal(proof.kind, mode + "-1");
          assert.equal(proof.native, "mastra-1");
          assert.equal(proof.reopens, scenario === "interleaved" ? 3 : 2);
          if (scenario === "interleaved") {
            assert(proof.interleavings > 1);
            for (const name of [
              "public-C2-unknown-context-preserves-origin",
              "native-C2-completion-then-public-C1-after-reopen",
              "same-conversation-unrelated-native-work-fresh-handoff-thread",
              "settled-native-C2-failure-then-public-C1",
              "settled-native-C2-cancel-then-public-C1",
            ])
              assert(proof.negativeResults.includes(name), name);
          } else assert.equal(proof.interleavings, 0);
          assert.equal(proof.positiveRead, 1);
          assert.equal(proof.positiveWrites, 1);
          assert(proof.negativeResults.length >= 14);
          assert(
            proof.negativeResults.includes(
              "created-public-chat-isolated-from-missing-legacy-proof",
            ),
          );
          assert.equal(proof.protectedSource, true);
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
