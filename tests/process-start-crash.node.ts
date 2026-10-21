import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFixture } from "./helpers/process-start";
import { admin, scope, code } from "./helpers/service-process-runtime";
import type {
  ProcessStartCommand,
  ProcessStartIntent,
  ProcessStartReceipt,
} from "../packages/protocol/process-start";

for (const mode of ["pin", "seed", "receipt", "committed"] as const) {
  test(`actual SIGKILL at ${mode}: two reopens retain all-or-nothing admission without native dispatch`, async () => {
    const root = mkdtempSync(join(tmpdir(), "niaro-start-crash-"));
    const path = join(root, "identity.sqlite");
    try {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          fileURLToPath(
            new URL("./helpers/process-start-crash-worker.ts", import.meta.url),
          ),
          root,
          mode,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      child.stdout.on("data", (value) => {
        output += value;
      });
      child.stderr.on("data", (value) => {
        output += value;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 45000);
      const signal = await new Promise<string | null>((resolve, reject) => {
        child.on("error", reject);
        child.on("exit", (_, value) => resolve(value));
      }).finally(() => clearTimeout(timer));
      assert.equal(signal, "SIGKILL", output);
      assert(existsSync(join(root, "cut.json")), output);
      const cut = JSON.parse(readFileSync(join(root, "cut.json"), "utf8")) as {
        mode: string;
        counts: number[];
        effects: unknown[];
        models: unknown[];
        journalMode: string;
        synchronous: number;
      };
      assert.equal(cut.mode, mode);
      assert.equal(cut.journalMode, "wal");
      assert.equal(cut.synchronous, 2);
      assert.deepEqual(cut.effects, []);
      assert.deepEqual(cut.models, []);
      assert.deepEqual(
        cut.counts,
        mode === "pin" ? [0, 1, 0] : mode === "seed" ? [0, 1, 1] : [1, 1, 1],
      );
      const manifest = JSON.parse(
        readFileSync(join(root, "manifest.json"), "utf8"),
      ) as {
        intent: ProcessStartIntent;
        command: ProcessStartCommand;
        ids: Parameters<typeof startFixture>[1];
      };
      const expected =
        mode === "committed"
          ? (JSON.parse(
              readFileSync(join(root, "receipt.json"), "utf8"),
            ) as ProcessStartReceipt)
          : undefined;
      let firstRows: unknown;
      for (let reopen = 0; reopen < 2; reopen++) {
        const h = startFixture(path, manifest.ids);
        try {
          const rows = [
            "agent_process_start_command",
            "agent_service_process_run",
            "agent_service_turn",
          ].map((table) =>
            h.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
          );
          assert.deepEqual(
            rows.map((value) => value.length),
            expected ? [1, 1, 1] : [0, 0, 0],
          );
          if (reopen) assert.deepEqual(rows, firstRows);
          firstRows = rows;
          if (expected) {
            assert.deepEqual(
              h.starts.read(
                admin,
                scope,
                manifest.command.commandId,
                manifest.command.idempotencyKey,
              ),
              expected,
            );
            assert.deepEqual(
              h.starts.admit(
                admin,
                scope,
                manifest.intent.intentId,
                manifest.command,
                () => {
                  throw Error("TEST replay must not revalidate origin");
                },
              ),
              expected,
            );
          } else
            assert.throws(
              () =>
                h.starts.read(
                  admin,
                  scope,
                  manifest.command.commandId,
                  manifest.command.idempotencyKey,
                ),
              code("process_start_not_found"),
            );
          assert.deepEqual(h.counts(), []);
          assert.deepEqual(h.models(), []);
          assert.equal(
            Number(
              h.db
                .prepare("SELECT count(*) AS n FROM agent_service_invocation")
                .get()!.n,
            ),
            0,
          );
          assert(
            !existsSync(path + ".mastra.sqlite"),
            "passive admission/read must not initialize native persistence",
          );
        } finally {
          await h.close();
        }
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
