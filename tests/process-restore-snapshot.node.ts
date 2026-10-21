import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const worker = fileURLToPath(
  new URL("./helpers/process-restore-snapshot-worker.ts", import.meta.url),
);

test(
  "a real qualified stopped native copy keeps its entire original manifest through explicit deferred-finalizer GC and passive paired reopen",
  { timeout: 90000 },
  async (t) => {
    const child = spawn(
      process.execPath,
      ["--expose-gc", "--import", "tsx", worker],
      {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      },
    );
    const roots = new Set<string>();
    let stderr = "";
    let failed: Error | undefined;
    let verified: Record<string, unknown> | undefined;
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-32768);
    });
    child.on("error", (error) => {
      failed = error;
    });
    child.on("message", (raw) => {
      assert(raw && typeof raw === "object" && !Array.isArray(raw));
      const message = raw as Record<string, unknown>;
      if (message.type === "fixture") roots.add(String(message.root));
      if (message.type === "copy") roots.add(String(message.destination));
      if (message.type === "verified") verified = message;
    });
    const closed = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolve) =>
      child.once("close", (code, signal) => resolve({ code, signal })),
    );
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null)
        child.kill("SIGKILL");
      await closed;
      for (const root of roots) rmSync(root, { recursive: true, force: true });
    });
    const exit = await closed;
    if (failed) throw failed;
    assert.equal(exit.signal, null, stderr);
    assert.equal(exit.code, 0, stderr);
    assert(verified, "TEST snapshot worker must publish its verified proof");
    assert.equal(verified.qualificationObservations, 12);
    assert.equal(verified.suspendedCheckpoint, true);
    assert.equal(verified.busyReaderRefused, true);
    assert.equal(verified.orphanSidecarsRefused, true);
    assert.equal(verified.sourceStableAfterGc, true);
    assert.equal(verified.passivePairedReopen, true);
  },
);
