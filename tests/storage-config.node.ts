import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadStorageConfiguration } from "../apps/server-storage/config";
import { locationId } from "../apps/server-storage/types";
export const storageEnv = {
  NIARO_S3_ENDPOINT: "http://127.0.0.1:19000",
  NIARO_S3_REGION: "us-east-1",
  NIARO_S3_BUCKET: "niaro-synthetic",
  NIARO_S3_CREDENTIAL_MODE: "static",
  NIARO_S3_ACCESS_KEY_ID: "synthetic-application",
  NIARO_S3_SECRET_ACCESS_KEY: "synthetic-secret-for-tests-only",
  NIARO_S3_FORCE_PATH_STYLE: "true",
  NIARO_S3_ALLOW_HTTP: "true",
};
test("absent storage is disabled, partial and unknown settings are invalid", () => {
  assert.deepEqual(loadStorageConfiguration({}), { state: "disabled" });
  assert.equal(
    loadStorageConfiguration({ NIARO_S3_BUCKET: "test" }).state,
    "invalid",
  );
  assert.equal(
    loadStorageConfiguration({ NIARO_S3_UNRECOGNIZED: "secret" }).state,
    "invalid",
  );
});
test("explicit static configuration defaults and credential rotation preserve location", () => {
  const a = loadStorageConfiguration(storageEnv);
  const b = loadStorageConfiguration({
    ...storageEnv,
    NIARO_S3_SECRET_ACCESS_KEY: "rotated-test-secret",
  });
  assert.equal(a.state, "configured");
  assert.equal(b.state, "configured");
  if (a.state !== "configured" || b.state !== "configured")
    throw Error("not configured");
  assert.equal(a.config.prefix, "attachments");
  assert.equal(locationId(a.config), locationId(b.config));
  assert.ok(!JSON.stringify(a).includes(storageEnv.NIARO_S3_SECRET_ACCESS_KEY));
});
test("invalid endpoint, TLS, booleans, namespace and credential modes fail safely", () => {
  for (const values of [
    { NIARO_S3_ENDPOINT: "http://8.8.8.8" },
    { NIARO_S3_ENDPOINT: "http://169.254.169.254" },
    { NIARO_S3_ALLOW_HTTP: "false" },
    { NIARO_S3_FORCE_PATH_STYLE: "yes" },
    { NIARO_S3_PREFIX: "../secret" },
    { NIARO_S3_ENDPOINT: "https://user:secret@example.com" },
    { NODE_TLS_REJECT_UNAUTHORIZED: "0" },
    { NIARO_S3_CREDENTIAL_MODE: "ambient" },
    { NIARO_S3_SECRET_ACCESS_KEY: undefined },
  ])
    assert.equal(
      loadStorageConfiguration({ ...storageEnv, ...values }).state,
      "invalid",
    );
  const c = loadStorageConfiguration({
    NIARO_S3_REGION: "eu-central-1",
    NIARO_S3_BUCKET: "niaro-test",
    NIARO_S3_CREDENTIAL_MODE: "default",
  });
  assert.equal(c.state, "configured");
  assert.equal(
    loadStorageConfiguration({
      ...storageEnv,
      NIARO_S3_CREDENTIAL_MODE: "default",
    }).state,
    "invalid",
  );
});
test("secret files are bounded, exact alternatives and paths/contents never appear in errors", () => {
  const d = mkdtempSync(join(tmpdir(), "niaro-s3-secret-"));
  const file = join(d, "private-secret-canary");
  try {
    writeFileSync(file, "file-secret-canary\r\n", { mode: 0o600 });
    const env = {
      ...storageEnv,
      NIARO_S3_SECRET_ACCESS_KEY: undefined,
      NIARO_S3_SECRET_ACCESS_KEY_FILE: file,
    };
    const c = loadStorageConfiguration(env);
    assert.equal(c.state, "configured");
    if (c.state === "configured")
      assert.equal(c.config.credentials?.secretAccessKey, "file-secret-canary");
    assert.equal(
      loadStorageConfiguration({ ...env, NIARO_S3_SECRET_ACCESS_KEY: "other" })
        .state,
      "invalid",
    );
    writeFileSync(file, "s".repeat(16385));
    const invalid = loadStorageConfiguration(env);
    assert.equal(invalid.state, "invalid");
    assert.ok(!JSON.stringify(invalid).includes(file));
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test(
  "a FIFO secret is rejected without blocking the production loader (FR3)",
  { skip: process.platform === "win32" },
  async () => {
    const { execFileSync, spawnSync } = await import("node:child_process");
    const dir = mkdtempSync(join(tmpdir(), "niaro-s3-fifo-")),
      file = join(dir, "secret.fifo");
    try {
      execFileSync("mkfifo", [file]);
      const script = `const {loadStorageConfiguration}=require('./apps/server-storage/config');console.log(JSON.stringify(loadStorageConfiguration(process.env)));`;
      const result = spawnSync(
        process.execPath,
        ["--import", "tsx", "-e", script],
        {
          encoding: "utf8",
          timeout: 3000,
          env: {
            ...process.env,
            ...storageEnv,
            NIARO_S3_SECRET_ACCESS_KEY: undefined,
            NIARO_S3_SECRET_ACCESS_KEY_FILE: file,
          },
        },
      );
      assert.equal(result.error, undefined, String(result.error));
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).state, "invalid");
      assert.ok(!result.stdout.includes(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
