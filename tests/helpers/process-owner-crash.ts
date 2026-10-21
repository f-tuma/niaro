import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import type { ServerConfig } from "../../apps/reference-server/config";
import type { ProcessActor } from "../../apps/server-identity/service-processes";
import type {
  NativeTestJob,
  NativeTestRequest,
} from "../../packages/protocol/process-native-testing";
import type { ProcessActivationCommand } from "../../packages/protocol/process-activation";

export type OwnerCrashMode = "receipt" | "report";
export type OwnerCrashManifest = {
  mode: OwnerCrashMode;
  site: string;
  root: string;
  config: ServerConfig;
  serverId: string;
  actor: ProcessActor;
  request: NativeTestRequest;
  running: NativeTestJob;
  good: NativeTestJob;
  activate: ProcessActivationCommand;
  production: Record<string, unknown>;
  native?: {
    directory: string;
    file: string;
    checkpoints: number;
    modelAttempts: number;
    receipts: number;
  };
  staged?: {
    datasetId: string;
    experiments: { configured: string; generic: string };
    observations: number;
    configuredPassed: number;
    genericPassed: number;
  };
};

/** Read through a separate SQLite connection: this cannot construct/recover a store. */
type SqlRows = ReturnType<ReturnType<DatabaseSync["prepare"]>["all"]>;
export function ownerPersistence(file: string): Record<string, SqlRows> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      schema: db
        .prepare(
          "SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name",
        )
        .all(),
      ...Object.fromEntries(
        [
          "agent_process_contract_test",
          "agent_process_native_test_admission",
          "agent_service_process",
          "agent_service_process_version",
          "agent_service_process_test",
          "agent_service_process_qualification",
          "agent_process_activation_command",
          "agent_audit",
          "agent_service_invocation",
          "agent_service_process_run",
          "agent_inference_run",
          "agent_inference_attempt",
          "agent_memory",
          "agent_memory_request",
        ].map((table) => [
          table,
          db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),
        ]),
      ),
    };
  } finally {
    db.close();
  }
}

export function nativePersistence(file: string) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const receipts = db
      .prepare("SELECT data FROM agent_service_invocation ORDER BY rowid")
      .all();
    const attempts = db
      .prepare("SELECT * FROM agent_inference_attempt ORDER BY rowid")
      .all();
    assert.equal(receipts.length, 1);
    assert.equal(JSON.parse(String(receipts[0]!.data)).status, "succeeded");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.status, "settled");
    const native = new DatabaseSync(file + ".mastra.sqlite", {
      readOnly: true,
    });
    try {
      const checkpoints = native
        .prepare("SELECT * FROM mastra_workflow_snapshot ORDER BY rowid")
        .all();
      const messages = native
        .prepare("SELECT * FROM mastra_messages ORDER BY rowid")
        .all();
      assert(checkpoints.length > 0);
      return { receipts, attempts, checkpoints, messages };
    } finally {
      native.close();
    }
  } finally {
    db.close();
  }
}
