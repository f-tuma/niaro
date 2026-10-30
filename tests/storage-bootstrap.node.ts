import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applicationPolicy,
  bootstrapConfigurations,
} from "../apps/server-storage/bootstrap";
import { checkStorageContract } from "../apps/server-storage/probe";
import { syntheticS3 } from "./helpers/storage-s3";
test("bootstrap rejects missing/default/shared credentials before network I/O", () => {
  const e = {
    NIARO_S3_ENDPOINT: "http://127.0.0.1:1",
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: "synthetic-storage",
    NIARO_S3_CREDENTIAL_MODE: "static",
    NIARO_S3_ACCESS_KEY_ID: "application-key",
    NIARO_S3_SECRET_ACCESS_KEY: "application-secret-synthetic",
    NIARO_S3_ALLOW_HTTP: "true",
    NIARO_S3_FORCE_PATH_STYLE: "true",
    NIARO_RUSTFS_ROOT_ACCESS_KEY: "synthetic-root",
    NIARO_RUSTFS_ROOT_SECRET_KEY: "synthetic-root-secret",
  };
  const c = bootstrapConfigurations(e);
  const policy = applicationPolicy(c.application);
  assert.equal(
    policy.Statement[1]!.Resource[0],
    "arn:aws:s3:::synthetic-storage/attachments/*",
  );
  for (const override of [
    { NIARO_RUSTFS_ROOT_ACCESS_KEY: "rustfsadmin" },
    { NIARO_RUSTFS_ROOT_SECRET_KEY: undefined },
    { NIARO_RUSTFS_ROOT_ACCESS_KEY: "application-key" },
    { NIARO_S3_CREDENTIAL_MODE: "default" },
  ])
    assert.throws(() => bootstrapConfigurations({ ...e, ...override }), {
      code: "invalid_config",
    });
});
test("contract probe cleans unique synthetic objects and detects public access/cleanup failure", async () => {
  const s = await syntheticS3();
  try {
    assert.deepEqual(await checkStorageContract(s.config), {
      ok: true,
      cleanup: "confirmed",
    });
    assert.equal(s.objects.size, 0);
    s.faults.public = true;
    assert.equal((await checkStorageContract(s.config)).ok, false);
    assert.equal(s.objects.size, 0);
    s.faults.public = false;
    s.faults.deleteFailure = true;
    const result = await checkStorageContract(s.config);
    assert.equal(result.ok, false);
    assert.equal(result.cleanup, "failed");
    assert.ok(!JSON.stringify(result).includes("private-service-canary"));
  } finally {
    await s.close();
  }
});

test("a lost negative conditional PUT cannot claim cleanup before its delayed creation is settled (FR1)", async () => {
  const s = await syntheticS3();
  try {
    s.faults.loseConditionalResponse = true;
    const result = await checkStorageContract(s.config);
    assert.equal(result.ok, false);
    assert.equal(result.cleanup, "failed");
    assert.equal(result.cleanupCode, "uncertain");
    assert.equal(s.objects.size, 0);
    assert.equal(s.pendingPuts.length, 1);
    s.pendingPuts[0]!();
    assert.equal(s.objects.size, 1);
  } finally {
    await s.close();
  }
});
test("the contract probe refuses corrupted range bytes despite valid status and range headers (FR2)", async () => {
  const s = await syntheticS3();
  try {
    s.faults.corruptRange = true;
    const result = await checkStorageContract(s.config);
    assert.equal(result.ok, false);
    assert.equal(result.code, "integrity");
    assert.equal(result.cleanup, "confirmed");
    assert.equal(s.objects.size, 0);
  } finally {
    await s.close();
  }
});
