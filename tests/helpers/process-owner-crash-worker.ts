// Test-only OS owner. Account HTTP/stores and the native experiment are real;
// the detached native comparison resolves only closed synthetic model/actions.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { CatalogController } from "../../apps/server-identity/catalog-controller";
import { openIdentity } from "../../apps/server-identity/service";
import { NativeTestRequestSchema } from "../../packages/protocol/process-native-testing";
import { ProcessActivationCommandSchema } from "../../packages/protocol/process-activation";
import {
  activationHttpFixture,
  activationHttpPath,
} from "./process-activation-http";
import { nativeHttpPath } from "./process-native-http";
import {
  nativePersistence,
  type OwnerCrashManifest,
  type OwnerCrashMode,
} from "./process-owner-crash";

const directory = process.argv[2];
const mode = process.argv[3];
if (!directory || !["receipt", "report", "contender"].includes(mode ?? ""))
  throw Error("TEST owner crash arguments invalid");

async function contend() {
  const manifest: OwnerCrashManifest = JSON.parse(
    readFileSync(join(directory!, "owner.json"), "utf8"),
  );
  const calls: { method: string; sql: string }[] = [];
  const exec = DatabaseSync.prototype.exec;
  const prepare = DatabaseSync.prototype.prepare;
  // These spies cover the SQLite boundary before auth migrations or any store
  // initialization. Only the OS owner lock may execute SQL in this process.
  DatabaseSync.prototype.exec = function (sql) {
    calls.push({ method: "exec", sql });
    return exec.call(this, sql);
  };
  DatabaseSync.prototype.prepare = function (sql) {
    calls.push({ method: "prepare", sql });
    return prepare.call(this, sql);
  };
  let error: string | null = null;
  try {
    const identity = await openIdentity(manifest.config, {
      hosting: { autostart: false },
    });
    await identity.close();
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    DatabaseSync.prototype.exec = exec;
    DatabaseSync.prototype.prepare = prepare;
  }
  process.send?.({ type: "contended", error, calls });
}

async function own(cut: OwnerCrashMode) {
  const h = await activationHttpFixture();
  process.send?.({ type: "fixture", root: h.root });
  const runtime = h.identity["processNativeTesting"]!;
  const start = runtime.start;
  runtime.start = async (...args) => {
    try {
      return await start(...args);
    } catch (error) {
      console.error("TEST actual native runner failed:", error);
      throw error;
    }
  };
  const first = await h.fresh();
  const qualified = await h.runNative(first);
  assert.equal(qualified.qualification?.status, "qualified");
  const activated = await h.request(
    "owner",
    activationHttpPath,
    h.command(first, qualified),
  );
  assert.equal(activated.status, 200, JSON.stringify(activated.data));
  const second = await h.fresh(first.processId);
  const good = await h.runNative(second);
  assert.equal(good.qualification?.status, "qualified");
  const current = await h.process(second.processId);
  assert.equal(current.activeVersion, first.version);
  const activate = ProcessActivationCommandSchema.parse({
    ...h.command(second, good, "TEST-owner-after-crash-activate"),
    revision: current.revision,
    expectedActiveVersion: current.activeVersion,
  });
  const request = NativeTestRequestSchema.parse({
    ...second,
    requestId: "TEST-owner-crash-running-" + cut,
  });
  const journal = h.identity["processTests"]!;
  let entered = false;
  const hold = new Promise<void>(() => {});
  const ready = (evidence: Pick<OwnerCrashManifest, "native" | "staged">) => {
    const row = h.identity["db"]
      .prepare(
        "SELECT data FROM agent_process_contract_test WHERE json_extract(data,'$.request.requestId')=?",
      )
      .get(request.requestId)!;
    const stored = JSON.parse(String(row.data));
    assert.equal(stored.job.status, "running");
    const manifest: OwnerCrashManifest = {
      mode: cut,
      site:
        cut === "receipt"
          ? "synthetic-action-receipt-before-native-ack"
          : "both-native-experiments-before-journal-publication",
      root: h.root,
      config: h.config,
      serverId: h.identity["workflowServerId"]!,
      actor: stored.creator,
      request,
      running: journal.readNative(stored.creator, stored.job.testId),
      good,
      activate,
      production: h.production(),
      ...evidence,
    };
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
    writeFileSync(join(directory!, "owner.json"), JSON.stringify(manifest));
    process.send?.({ type: "ready" });
  };
  if (cut === "receipt") {
    const invoke = CatalogController.prototype.invoke;
    CatalogController.prototype.invoke = async function (...args) {
      const result = await invoke.apply(this, args);
      // Dataset item order is intentionally irrelevant: select the successful
      // read receipt, not whichever rejection/restart case happens to run first.
      if (
        this !== h.identity["catalog"] &&
        !entered &&
        result.effect === "read" &&
        result.status === "succeeded"
      ) {
        entered = true;
        const file = String(
          this.store["db"]
            .prepare("PRAGMA database_list")
            .all()
            .find((r) => r.name === "main")!.file,
        );
        let durable: ReturnType<typeof nativePersistence>;
        try {
          durable = nativePersistence(file);
        } catch (error) {
          console.error("TEST durable native receipt cut failed:", error);
          process.exit(1);
        }
        const native = new DatabaseSync(
          fileURLToPath(this.store.nativeStorageUrl),
          { readOnly: true },
        );
        const checkpoints = Number(
          native
            .prepare("SELECT COUNT(*) AS n FROM mastra_workflow_snapshot")
            .get()!.n,
        );
        native.close();
        assert(
          checkpoints > 0,
          "Actual native execution must have persisted its checkpoint",
        );
        ready({
          native: {
            directory: dirname(file),
            file,
            checkpoints,
            modelAttempts: durable.attempts.length,
            receipts: durable.receipts.length,
          },
        });
        await hold;
      }
      return result;
    };
  } else {
    // Delay the actual publication call after its two real experiments return.
    // No job/report/qualification rows are rewritten to manufacture an orphan.
    Object.defineProperty(journal, "completeNative", {
      value: async (...args: Parameters<typeof journal.completeNative>) => {
        const report = args[2];
        assert.equal(report.status, "passed");
        assert.equal(report.observations.length, 12);
        ready({
          staged: {
            datasetId: report.datasetId,
            experiments: {
              configured: report.experiments.configured,
              generic: report.experiments.generic!,
            },
            observations: report.observations.length,
            configuredPassed: report.comparison.configuredPassed,
            genericPassed: report.comparison.genericPassed,
          },
        });
        await hold;
      },
    });
  }
  await h.request("owner", nativeHttpPath, request);
  throw Error("TEST crash cut was not held");
}

void (mode === "contender" ? contend() : own(mode as OwnerCrashMode)).catch(
  (error: unknown) => {
    console.error(error);
    // A failed HTTP fixture may retain its server handle. Fail immediately so
    // the parent sees the setup error instead of waiting for its timeout.
    process.exit(1);
  },
);
