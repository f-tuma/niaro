import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  observeLegacyTuple,
  type LegacyInventoryManifest,
} from "../apps/server-identity/legacy-run-inventory";

// Derived empty SQLite tuple: CLI boundary evidence, not a genuine runtime run.
function cliFixture() {
  const root = mkdtempSync(join(tmpdir(), "niaro-inventory-cli-test-"));
  chmodSync(root, 0o700);
  const tuple = join(root, "tuple");
  mkdirSync(tuple, { mode: 0o700 });
  const roles: LegacyInventoryManifest["roles"] = {
    identityDatabase: "identity.sqlite",
    workflowDatabase: "workflow.sqlite",
    workflowServerId: "server-id",
    originalSecret: "secret",
    configuration: "configuration.json",
    administrationKey: "admin-key",
    nativeDatabases: [],
    ownerLocks: ["server-lock.sqlite"],
  };
  const database = (name: string, sql: string) => {
    const db = new DatabaseSync(join(tuple, name));
    try {
      db.exec(sql);
    } finally {
      db.close();
    }
    chmodSync(join(tuple, name), 0o600);
  };
  database(
    roles.identityDatabase,
    `CREATE TABLE agent_service_turn(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,data TEXT);
     CREATE TABLE agent_service_invocation(id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,data TEXT);
     CREATE TABLE agent_service_turn_operation(operation_id TEXT PRIMARY KEY,turn_id TEXT,workspace_id TEXT,user_id TEXT);
     CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT);`,
  );
  const serverId = "fixture-" + "a".repeat(24);
  database(
    roles.workflowDatabase,
    `CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT);
     INSERT INTO metadata VALUES('server_id','${serverId}');
     CREATE TABLE workflows(scope_key TEXT PRIMARY KEY,state TEXT);
     CREATE TABLE receipts(scope_key TEXT,command_id TEXT,idempotency_key TEXT,payload TEXT);
     CREATE TABLE conversation_sessions(scope_key TEXT,conversation_id TEXT);`,
  );
  database(roles.ownerLocks[0]!, "CREATE TABLE owner(id INTEGER PRIMARY KEY);");
  for (const [file, content] of [
    [roles.workflowServerId, serverId],
    [roles.originalSecret, "TEST-cli-secret-sentinel"],
    [roles.administrationKey, "TEST-cli-admin-key-sentinel"],
    [roles.configuration, '{"private":"TEST-cli-configuration-sentinel"}'],
  ]) {
    writeFileSync(join(tuple, file!), content!, { mode: 0o600 });
  }
  const manifest = observeLegacyTuple(tuple, roles);
  const file = join(root, "manifest.json");
  const writeManifest = (value: unknown) =>
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  writeManifest(manifest);
  const guard = join(root, "guard.mjs");
  writeFileSync(
    guard,
    `import net from 'node:net';
     import http from 'node:http';
     import https from 'node:https';
     import crypto from 'node:crypto';
     import processes from 'node:child_process';
     import fs from 'node:fs';
     import path from 'node:path';
     import os from 'node:os';
     import sqlite from 'node:sqlite';
     import {syncBuiltinESMExports} from 'node:module';
     const forbid = kind => () => {
       process.stderr.write('TEST_FORBIDDEN_'+kind+'\\n');
       throw new Error('TEST_FORBIDDEN_'+kind);
     };
     // Only the installed TSX loader's exact parent Unix pipe is permitted.
     const loaderDirectory = ${JSON.stringify(resolve("node_modules/tsx/dist"))};
     const loaderPipe = path.join(os.tmpdir(), 'tsx-'+process.geteuid(), process.ppid+'.pipe');
     const connect = net.Socket.prototype.connect;
     net.Socket.prototype.connect = function(...args) {
       const options = Array.isArray(args[0]) ? args[0][0] : args[0];
       const stack = new Error().stack ?? '';
       if (options && typeof options === 'object' && Object.keys(options).length === 1 &&
           options.path === loaderPipe && stack.includes(loaderDirectory+'/'))
         return connect.apply(this,args);
       return forbid('NETWORK')();
     };
     net.Server.prototype.listen = forbid('NETWORK');
     http.request = https.request = http.get = https.get = forbid('NETWORK');
     globalThis.fetch = forbid('NETWORK');
     crypto.createDecipheriv = forbid('DECRYPT');
     for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])
       processes[name] = forbid('PROCESS');
     const protectedRoot = path.resolve(process.env.TEST_INVENTORY_PROTECTED_ROOT);
     const protect = value => {
       if (typeof value !== 'string') return;
       const file = path.resolve(value);
       if (file === protectedRoot || file.startsWith(protectedRoot+path.sep))
         forbid('SOURCE_WRITE')();
     };
     for (const name of ['mkdirSync','mkdtempSync','chmodSync','rmSync','unlinkSync','writeFileSync','appendFileSync']) {
       const original = fs[name];
       fs[name] = (...args) => { protect(args[0]); return original(...args); };
     }
     const copy = fs.copyFileSync;
     fs.copyFileSync = (...args) => { protect(args[1]); return copy(...args); };
     const open = fs.openSync;
     fs.openSync = (...args) => {
       const flags = args[1];
       if (typeof flags === 'string' ? /[wa+]/.test(flags) :
           flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
         protect(args[0]);
       return open(...args);
     };
     const Database = sqlite.DatabaseSync;
     sqlite.DatabaseSync = function(...args) {
       protect(args[0]);
       return new Database(...args);
     };
     sqlite.DatabaseSync.prototype = Database.prototype;
     syncBuiltinESMExports();`,
    { mode: 0o600 },
  );
  const invoke = (args: string[], extraEnv: Record<string, string> = {}) => {
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        guard,
        "--import",
        "tsx",
        resolve("scripts/legacy-inventory.ts"),
        ...args,
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          TSX_DISABLE_CACHE: "1",
          FIXTURE_DATA_DIR: tuple,
          TEST_INVENTORY_PROTECTED_ROOT: tuple,
          ...extraEnv,
        },
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      },
    );
    assert.equal(result.error, undefined, "CLI must finish without hanging");
    assert.equal(result.signal, null);
    assert(!result.stderr.includes("TEST_FORBIDDEN_"), result.stderr);
    assert(
      !result.stdout.includes(root),
      "Output must not expose private paths",
    );
    assert(
      !result.stdout.includes("sentinel"),
      "Output must not expose private values",
    );
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines.length, 1, "CLI stdout must contain one JSON record");
    const output = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(output.profile, "niaro-legacy-inventory/4");
    assert.deepEqual(observeLegacyTuple(tuple, roles), manifest);
    return { result, output };
  };
  return {
    root,
    tuple,
    file,
    manifest,
    invoke,
    writeManifest,
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

test("CLI derived complete tuple is incomplete/exit2 without application transport, decryption or bootstrap", () => {
  const h = cliFixture();
  try {
    const { result, output } = h.invoke(["--manifest", h.file]);
    assert.equal(result.status, 2);
    assert.equal(output.status, "incomplete");
    assert.equal(output.scanComplete, true);
    assert.equal(output.classificationComplete, true);
    assert.deepEqual(output.nativeRuns, []);
    assert.deepEqual(output.nativeStorage, {
      profile: "@mastra/core@1.74.0+@mastra/libsql@1.25.0",
      databaseCount: 0,
      workflowSnapshots: 0,
      backgroundTasks: 0,
      scan: "not_declared",
    });
    assert.deepEqual(output.provenance, {
      ownerStop: "unverified",
      commonCheckpoint: "unverified",
      basis: "offline_manifest_only",
    });
    assert.deepEqual(output.blockers, [
      "common_checkpoint_unverified",
      "owner_stop_unverified",
    ]);
    assert(!("readyToRemove" in output));
    assert(!("cutover" in output));
  } finally {
    h.dispose();
  }
});

test("CLI rejects implicit profiles, missing and extra arguments with finite exit1", () => {
  const h = cliFixture();
  try {
    for (const args of [
      [],
      ["--profile", "TEST-server"],
      ["--manifest"],
      ["--manifest", h.file, "--force"],
    ]) {
      const { result, output } = h.invoke(args);
      assert.equal(result.status, 1);
      assert.equal(output.status, "invalid");
      assert.equal(output.code, "manifest_invalid");
      assert.deepEqual(Object.keys(output).sort(), [
        "code",
        "profile",
        "status",
      ]);
    }
  } finally {
    h.dispose();
  }
});

test("CLI does not promote owner-stop or common-checkpoint attestations", () => {
  const h = cliFixture();
  try {
    for (const attestation of [
      { ownerStopped: true },
      { commonCheckpoint: true },
      { provenance: { ownerStop: "verified" } },
    ]) {
      h.writeManifest({ ...h.manifest, ...attestation });
      const { result, output } = h.invoke(["--manifest", h.file]);
      assert.equal(result.status, 1);
      assert.equal(output.status, "invalid");
      assert.equal(output.code, "manifest_invalid");
    }
  } finally {
    h.dispose();
  }
});

test("CLI malformed and oversized manifest output stays finite and private", () => {
  const h = cliFixture();
  try {
    writeFileSync(h.file, '{"TEST-cli-private-malformed-sentinel":', {
      mode: 0o600,
    });
    const malformed = h.invoke(["--manifest", h.file]);
    assert.equal(malformed.result.status, 1);
    assert.equal(malformed.output.status, "invalid");
    assert.deepEqual(Object.keys(malformed.output).sort(), [
      "code",
      "profile",
      "status",
    ]);
    writeFileSync(h.file, " ".repeat(2 * 1024 * 1024 + 1), { mode: 0o600 });
    const oversized = h.invoke(["--manifest", h.file]);
    assert.equal(oversized.result.status, 1);
    assert.equal(oversized.output.code, "manifest_invalid");
  } finally {
    h.dispose();
  }
});

test("CLI refuses symlink and non-regular manifests before reading", () => {
  const h = cliFixture();
  try {
    const linked = join(h.root, "linked-manifest");
    symlinkSync(h.file, linked);
    const symbolic = h.invoke(["--manifest", linked]);
    assert.equal(symbolic.result.status, 1);
    assert.equal(symbolic.output.code, "manifest_invalid");
    const fifo = join(h.root, "manifest-fifo");
    const create = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
    assert.equal(create.status, 0, create.stderr);
    const nonRegular = h.invoke(["--manifest", fifo]);
    assert.equal(nonRegular.result.status, 1);
    assert.equal(nonRegular.output.code, "manifest_invalid");
    assert(readFileSync(h.file, "utf8").length > 0);
  } finally {
    h.dispose();
  }
});

test("CLI refuses a temp parent inside the protected tuple before any source write", () => {
  const h = cliFixture();
  try {
    for (const tupleRoot of [h.tuple, h.tuple + "/", h.tuple + "/."]) {
      h.writeManifest({ ...h.manifest, tupleRoot });
      const { result, output } = h.invoke(["--manifest", h.file], {
        TMPDIR: h.tuple,
      });
      assert.equal(result.status, 1);
      assert.equal(output.status, "invalid");
      assert.equal(output.code, "manifest_invalid");
      assert.deepEqual(Object.keys(output).sort(), [
        "code",
        "profile",
        "status",
      ]);
    }
  } finally {
    h.dispose();
  }
});
