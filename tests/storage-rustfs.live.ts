/** Opt-in isolated real-service test: creates/removes only uniquely named synthetic Docker resources. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteBucketCommand,
} from "@aws-sdk/client-s3";
import {
  bootstrapRustFS,
  bootstrapConfigurations,
} from "../apps/server-storage/bootstrap";
import { clientOptions, S3ObjectStore } from "../apps/server-storage/adapter";
import { StorageRegistry } from "../apps/server-storage/registry";
import { RegisteredObjectStore } from "../apps/server-storage/runtime";
import { sha256 } from "../apps/server-storage/types";
async function main() {
  const name = `niaro-s3-check-${randomBytes(6).toString("hex")}`,
    dir = mkdtempSync(join(tmpdir(), "niaro-s3-live-")),
    envFile = join(dir, "rustfs.env");
  const rootAccess = `root-${randomBytes(12).toString("hex")}`,
    rootSecret = randomBytes(32).toString("hex"),
    appAccess = `app-${randomBytes(12).toString("hex")}`,
    appSecret = randomBytes(32).toString("hex");
  writeFileSync(
    envFile,
    `RUSTFS_ACCESS_KEY=${rootAccess}\nRUSTFS_SECRET_KEY=${rootSecret}\nRUSTFS_CONSOLE_ENABLE=false\n`,
    { mode: 0o600 },
  );
  const docker = (args: string[]) =>
    execFileSync("docker", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  const start = () => {
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--env-file",
      envFile,
      "-p",
      "127.0.0.1::9000",
      "-v",
      `${name}:/data`,
      "rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2",
    ]);
    return "http://" + docker(["port", name, "9000/tcp"]);
  };
  let client: S3Client | undefined,
    store: RegisteredObjectStore | undefined,
    db: DatabaseSync | undefined;
  try {
    const endpoint = start();
    const env = {
      NIARO_S3_ENDPOINT: endpoint,
      NIARO_S3_REGION: "us-east-1",
      NIARO_S3_BUCKET: `synthetic-${randomBytes(6).toString("hex")}`,
      NIARO_S3_PREFIX: "isolated-attachments",
      NIARO_S3_CREDENTIAL_MODE: "static",
      NIARO_S3_ACCESS_KEY_ID: appAccess,
      NIARO_S3_SECRET_ACCESS_KEY: appSecret,
      NIARO_S3_FORCE_PATH_STYLE: "true",
      NIARO_S3_ALLOW_HTTP: "true",
      NIARO_RUSTFS_ROOT_ACCESS_KEY: rootAccess,
      NIARO_RUSTFS_ROOT_SECRET_KEY: rootSecret,
    };
    assert.equal((await bootstrapRustFS(env)).ok, true);
    console.log("PASS isolated bootstrap and application contract");
    assert.equal((await bootstrapRustFS(env)).ok, true);
    console.log("PASS repeat bootstrap");
    const { application, root } = bootstrapConfigurations(env);
    db = new DatabaseSync(join(dir, "workflow.sqlite"));
    const registry = new StorageRegistry(db);
    registry.activate(application);
    store = new RegisteredObjectStore(
      registry,
      application,
      new S3ObjectStore(application),
    );
    const body = randomBytes(1024 * 1024 + 17),
      h = store.reserve(randomUUID(), {
        sha256: sha256(body),
        size: body.length,
      });
    await store.put(h, body);
    assert.equal(sha256(await store.get(h)), sha256(body));
    client = new S3Client(clientOptions(root));
    const foreign = `foreign-${randomBytes(6).toString("hex")}`;
    await client.send(new CreateBucketCommand({ Bucket: foreign }));
    await client.send(
      new PutObjectCommand({
        Bucket: foreign,
        Key: "private",
        Body: "synthetic foreign",
      }),
    );
    await client.send(
      new PutObjectCommand({
        Bucket: application.bucket,
        Key: "outside-prefix",
        Body: "synthetic outside",
      }),
    );
    const app = new S3Client(clientOptions(application));
    try {
      for (const command of [
        new GetObjectCommand({ Bucket: foreign, Key: "private" }),
        new GetObjectCommand({
          Bucket: application.bucket,
          Key: "outside-prefix",
        }),
        new PutObjectCommand({
          Bucket: foreign,
          Key: "forbidden",
          Body: "synthetic",
        }),
        new PutObjectCommand({
          Bucket: application.bucket,
          Key: "outside-forbidden",
          Body: "synthetic",
        }),
      ])
        await assert.rejects(
          app.send(command),
          (e: { $metadata?: { httpStatusCode?: number } }) =>
            e.$metadata?.httpStatusCode === 403,
        );
    } finally {
      app.destroy();
    }
    console.log(
      "PASS foreign bucket/prefix read/write denial and anonymous denial",
    );
    await assert.rejects(
      bootstrapRustFS({
        ...env,
        NIARO_S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      }),
    );
    await assert.rejects(
      bootstrapRustFS({ ...env, NIARO_S3_PREFIX: "different-prefix" }),
      { code: "conflict" },
    );
    assert.equal(sha256(await store.get(h)), sha256(body));
    console.log(
      "PASS credential/policy conflict refuses without rotation or data loss",
    );
    store.close();
    client.destroy();
    docker(["rm", "-f", name]);
    // Keep the assigned host port stable so location identity remains unchanged.
    const port = new URL(endpoint).port;
    docker([
      "run",
      "-d",
      "--name",
      name,
      "--env-file",
      envFile,
      "-p",
      `127.0.0.1:${port}:9000`,
      "-v",
      `${name}:/data`,
      "rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2",
    ]);
    assert.equal((await bootstrapRustFS(env)).ok, true);
    store = new RegisteredObjectStore(
      registry,
      application,
      new S3ObjectStore(application),
    );
    assert.equal(sha256(await store.get(h)), sha256(body));
    await store.delete(h);
    await store.delete(h);
    console.log(
      "PASS container recreation preserves bucket, scoped principal and exact bytes; repeat deletion",
    );
    client = new S3Client(clientOptions(root));
    await client.send(
      new DeleteObjectCommand({ Bucket: foreign, Key: "private" }),
    );
    await client.send(new DeleteBucketCommand({ Bucket: foreign }));
    await client.send(
      new DeleteObjectCommand({
        Bucket: application.bucket,
        Key: "outside-prefix",
      }),
    );
    console.log("PASS synthetic cleanup");
  } finally {
    store?.close();
    client?.destroy();
    db?.close();
    try {
      docker(["rm", "-f", name]);
    } catch {}
    try {
      docker(["volume", "rm", name]);
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}
void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
