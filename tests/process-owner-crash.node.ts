import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openIdentity } from "../apps/server-identity/service";
import { IdentityError } from "../apps/server-identity/error";
import type { CatalogContext } from "../apps/server-identity/catalog-controller";
import { PROCESS_ACTIVATION_PROFILE } from "../packages/protocol/process-activation";
import {
  nativePersistence,
  ownerPersistence,
  type OwnerCrashManifest,
  type OwnerCrashMode,
} from "./helpers/process-owner-crash";

const worker = fileURLToPath(
  new URL("./helpers/process-owner-crash-worker.ts", import.meta.url),
);
function launch(directory: string, mode: OwnerCrashMode | "contender") {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", worker, directory, mode],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let stderr = "",
    root: string | undefined,
    failed: Error | undefined;
  const messages: Record<string, unknown>[] = [];
  let wake: (() => void) | undefined;
  child.stderr!.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.on("message", (raw) => {
    const message = raw as Record<string, unknown>;
    if (message.type === "fixture") root = String(message.root);
    messages.push(message);
    wake?.();
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.on("close", (code, signal) => {
      resolve({ code, signal });
      wake?.();
    });
  });
  child.on("error", (error) => {
    failed = error;
    wake?.();
  });
  return {
    child,
    closed,
    get root() {
      return root;
    },
    get stderr() {
      return stderr;
    },
    async message(type: string, timeout = 90000) {
      const deadline = setTimeout(() => {
        child.kill("SIGKILL");
        wake?.();
      }, timeout);
      const until = Date.now() + timeout;
      try {
        while (true) {
          const found = messages.find((message) => message.type === type);
          if (found) return found;
          if (failed) throw failed;
          if (
            child.exitCode !== null ||
            child.signalCode !== null ||
            Date.now() >= until
          )
            throw Error(`TEST ${mode} worker did not reach ${type}: ${stderr}`);
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        clearTimeout(deadline);
        wake = undefined;
      }
    },
  };
}

const superseded = (error: unknown) =>
  error instanceof IdentityError &&
  error.status === 409 &&
  error.code === "process_test_superseded";
for (const mode of ["receipt", "report"] as const) {
  test(`exclusive OS identity owner survives contention; SIGKILL at ${mode} recovers a native experiment once`, async (t) => {
    const directory = mkdtempSync(join(tmpdir(), "niaro-process-owner-cut-"));
    const owner = launch(directory, mode);
    let manifest: OwnerCrashManifest | undefined;
    t.after(async () => {
      owner.child.kill("SIGKILL");
      await owner.closed;
      if (manifest?.native)
        rmSync(manifest.native.directory, { recursive: true, force: true });
      if (owner.root) rmSync(owner.root, { recursive: true, force: true });
      rmSync(directory, { recursive: true, force: true });
    });
    await owner.message("ready");
    manifest = JSON.parse(readFileSync(join(directory, "owner.json"), "utf8"));
    assert(manifest);
    assert.equal(manifest.mode, mode);
    assert.equal(manifest.running.status, "running");
    assert.equal(manifest.running.report, null);
    assert.equal(manifest.running.qualification, undefined);
    assert.equal(manifest.good.status, "completed");
    assert.equal(manifest.good.qualification?.status, "qualified");
    if (mode === "receipt") {
      assert.equal(manifest.site, "synthetic-action-receipt-before-native-ack");
      assert(manifest.native);
      assert.equal(manifest.native.modelAttempts, 1);
      assert.equal(manifest.native.receipts, 1);
      assert(manifest.native.checkpoints > 0);
    } else {
      assert.equal(
        manifest.site,
        "both-native-experiments-before-journal-publication",
      );
      assert(manifest.staged);
      assert.equal(manifest.staged.observations, 12);
      assert.equal(manifest.staged.configuredPassed, 6);
      assert.equal(manifest.staged.genericPassed, 6);
      assert.notEqual(
        manifest.staged.experiments.configured,
        manifest.staged.experiments.generic,
      );
    }
    const file = join(
      manifest.config.administration!.identity!.directory,
      "identity.sqlite",
    );
    const before = ownerPersistence(file);
    const production = Object.fromEntries(
      Object.keys(manifest.production).map((table) => [
        table,
        before[table]!.length,
      ]),
    );
    assert.deepEqual(production, manifest.production);
    // The prepared active v1 has one human activation metadata test record.
    // None of the actual execution namespaces may be used by this experiment.
    assert.equal(production.agent_service_process_test, 1);
    assert(
      Object.entries(production).every(
        ([table, count]) =>
          table === "agent_service_process_test" || count === 0,
      ),
    );
    const nativeBefore =
      manifest.native && nativePersistence(manifest.native.file);
    const contender = launch(directory, "contender");
    t.after(async () => {
      contender.child.kill("SIGKILL");
      await contender.closed;
    });
    const rejected = await contender.message("contended", 15000);
    const contenderExit = await contender.closed;
    assert.equal(contenderExit.code, 0, contender.stderr);
    assert.equal(contenderExit.signal, null);
    assert.match(String(rejected.error), /already in use/);
    assert.deepEqual(
      rejected.calls,
      [{ method: "exec", sql: "BEGIN EXCLUSIVE" }],
      "Lock rejection must precede identity SQL, migrations, and store construction",
    );
    assert.equal(owner.child.exitCode, null);
    assert.equal(owner.child.signalCode, null);
    assert.deepEqual(
      ownerPersistence(file),
      before,
      "A competing live OS process cannot recover the current job or mutate admission, qualification, active pointer, audit, or schema",
    );
    if (manifest.native)
      assert.deepEqual(nativePersistence(manifest.native.file), nativeBefore);

    assert(owner.child.kill("SIGKILL"));
    const killed = await owner.closed;
    assert.equal(killed.signal, "SIGKILL", owner.stderr);
    assert.equal(killed.code, null);
    // Killing the process itself releases its lock; this is not a close/reopen
    // fixture, and no terminal status was manufactured before recovery.
    assert.deepEqual(ownerPersistence(file), before);
    let calls = 0;
    const transport = async (): Promise<never> => {
      calls++;
      throw Error(
        "TEST passive recovery must not contact a provider or service",
      );
    };
    let recovered: typeof manifest.running | undefined;
    let firstReopen: ReturnType<typeof ownerPersistence> | undefined;
    for (let reopen = 0; reopen < 2; reopen++) {
      const identity = await openIdentity(manifest.config, {
        integrationTransport: transport,
        connectionTransport: transport,
        calendarTransport: transport,
        hosting: { autostart: false },
      });
      try {
        identity.attachWorkflow(manifest.serverId);
        const journal = identity["processTests"]!;
        const activation = identity["processActivation"]!;
        const job = journal.readNative(manifest.actor, manifest.running.testId);
        assert.equal(job.status, "interrupted");
        assert.equal(job.failure, "test_server_restarted");
        assert.equal(job.report, null);
        assert.equal(job.qualification, undefined);
        if (recovered) assert.deepEqual(job, recovered);
        recovered = job;
        assert.deepEqual(
          journal.replayNative(manifest.actor, manifest.request),
          job,
        );
        const context: CatalogContext = {
          serial: (run) => identity["serial"](run),
          actor: async () => ({
            userId: manifest!.actor.userId,
            role: manifest!.actor.role,
          }),
          epoch: () => {
            throw Error("TEST passive replay resolved authority epoch");
          },
          change: () => {
            throw Error("TEST passive replay changed authority");
          },
          audit: () => {
            throw Error("TEST passive replay appended audit");
          },
          finish: () => {
            throw Error("TEST passive replay finished audit");
          },
          transaction: (run) => identity["serial"](run),
        };
        const registry = identity["processes"];
        const artifact = registry.testArtifact;
        registry.testArtifact = () => {
          throw Error("TEST passive replay resolved a runtime artifact");
        };
        try {
          assert.deepEqual(
            await identity["processNativeTesting"]!.start(
              manifest.request,
              context,
              AbortSignal.timeout(5000),
            ),
            job,
          );
        } finally {
          registry.testArtifact = artifact;
        }
        assert.deepEqual(
          journal.readNative(manifest.actor, manifest.good.testId),
          manifest.good,
        );
        const admission = identity["db"]
          .prepare(
            "SELECT * FROM agent_process_native_test_admission ORDER BY seq",
          )
          .all();
        assert.deepEqual(admission, before.agent_process_native_test_admission);
        assert.equal(admission.at(-1)!.test_id, job.testId);
        const original = identity["processes"].get(
          manifest.actor,
          manifest.request.processId,
        );
        assert.equal(
          original.activeVersion,
          manifest.activate.expectedActiveVersion,
        );
        assert.throws(
          () =>
            activation.review(manifest!.actor, {
              ...manifest!.request,
              profile: PROCESS_ACTIVATION_PROFILE,
              testId: manifest!.good.testId,
            }),
          superseded,
        );
        assert.throws(
          () => activation.decide(manifest!.actor, manifest!.activate),
          superseded,
        );
        assert.deepEqual(
          identity["processes"].get(manifest.actor, manifest.request.processId),
          original,
        );
        const events = identity["db"]
          .prepare(
            "SELECT target_id,source,details FROM agent_audit WHERE json_extract(details,'$.processEvent')='native_test_interrupted'",
          )
          .all();
        assert.equal(events.length, 1);
        assert.equal(events[0]!.target_id, job.testId);
        assert.equal(events[0]!.source, "recovery");
        const after = ownerPersistence(file);
        for (const table of Object.keys(manifest.production))
          assert.deepEqual(after[table], before[table]);
        assert.deepEqual(
          after.agent_process_activation_command,
          before.agent_process_activation_command,
        );
        assert.deepEqual(
          after.agent_service_process,
          before.agent_service_process,
        );
        assert.deepEqual(
          after.agent_service_process_qualification,
          before.agent_service_process_qualification,
        );
        if (firstReopen)
          assert.deepEqual(
            after,
            firstReopen,
            "The second reopen and repeated passive reads cannot mutate persisted recovery evidence",
          );
        firstReopen = after;
      } finally {
        await identity.close();
      }
    }
    assert.equal(calls, 0);
    if (manifest.native)
      assert.deepEqual(
        nativePersistence(manifest.native.file),
        nativeBefore,
        "Owner recovery cannot resume an abandoned detached native model/action runtime",
      );
  });
}
