import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createReferenceServer } from "../apps/reference-server/runtime";
import type { ServerConfig } from "../apps/reference-server/config";
import {
  loadStorageConfiguration,
  privateStorageAddress,
} from "../apps/server-storage/config";
import { sha256 } from "../apps/server-storage/types";
function profile(dir: string): ServerConfig {
  return {
    version: 1,
    name: "Storage test",
    listen: { host: "127.0.0.1", port: 8793 },
    dataDirectory: dir,
    allowedOrigins: [],
    sessionSeconds: 1800,
    adapters: {
      model: { provider: "fixture" },
      voice: { provider: "disabled" },
      crm: { provider: "disabled" },
      calendar: { provider: "simulated" },
    },
  };
}
const configuration = (bucket = "synthetic-storage") =>
  loadStorageConfiguration({
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: bucket,
    NIARO_S3_CREDENTIAL_MODE: "default",
  });
async function listen(server: ReturnType<typeof createReferenceServer>) {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const close = (server: ReturnType<typeof createReferenceServer>) =>
  new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok())));
test("real reference-server startup keeps HTTP usable on invalid S3 and refuses retained-location replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-s3-start-"));
  let server: ReturnType<typeof createReferenceServer> | undefined;
  try {
    server = createReferenceServer(profile(dir), undefined, undefined, {
      objectStorage: { state: "invalid", code: "invalid_config" },
    });
    let base = await listen(server);
    assert.equal(server.objectStorage.state, "unavailable");
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    await close(server);
    server = undefined;
    server = createReferenceServer(profile(dir), undefined, undefined, {
      objectStorage: configuration(),
    });
    await listen(server);
    assert.equal(server.objectStorage.state, "configured");
    if (server.objectStorage.state !== "configured")
      throw Error("not configured");
    server.objectStorage.store.reserve(randomUUID(), {
      sha256: sha256("retained"),
      size: 8,
    });
    await close(server);
    server = undefined;
    server = createReferenceServer(profile(dir), undefined, undefined, {
      objectStorage: configuration("replacement-storage"),
    });
    base = await listen(server);
    assert.deepEqual(server.objectStorage, {
      state: "unavailable",
      code: "migration_required",
    });
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
  } finally {
    if (server) await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("offline CLI validates configuration with network APIs forbidden and no data-directory creation", () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-s3-offline-"));
  try {
    const file = join(dir, "profile.json"),
      block = join(dir, "no-network.cjs");
    writeFileSync(file, JSON.stringify(profile(join(dir, "must-not-exist"))));
    writeFileSync(
      block,
      `for(const m of ['node:http','node:https','node:net','node:dns']){const api=require(m);for(const k of ['request','connect','lookup'])if(api[k])api[k]=()=>{throw Error('NETWORK_FORBIDDEN')};}global.fetch=()=>{throw Error('NETWORK_FORBIDDEN')};require('node:module').syncBuiltinESMExports();`,
    );
    const env = {
      ...process.env,
      NIARO_S3_REGION: "us-east-1",
      NIARO_S3_BUCKET: "synthetic-storage",
      NIARO_S3_CREDENTIAL_MODE: "default",
    };
    const run = spawnSync(
      process.execPath,
      [
        "--require",
        block,
        "--import",
        "tsx",
        "apps/reference-server/cli.ts",
        "check",
        file,
      ],
      { encoding: "utf8", env },
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).objectStorage.state, "configured");
    const invalid = spawnSync(
      process.execPath,
      [
        "--require",
        block,
        "--import",
        "tsx",
        "apps/reference-server/cli.ts",
        "check",
        file,
      ],
      {
        encoding: "utf8",
        env: { ...env, NIARO_S3_CREDENTIAL_MODE: "invalid" },
      },
    );
    assert.equal(invalid.status, 1);
    assert.equal(JSON.parse(invalid.stdout).objectStorage.state, "invalid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("private endpoint classification rejects metadata/public/mapped-public addresses", () => {
  for (const ip of [
    "127.0.0.1",
    "::1",
    "10.1.2.3",
    "172.16.1.1",
    "192.168.1.1",
    "fd00::1",
    "::ffff:10.1.2.3",
  ])
    assert.equal(privateStorageAddress(ip), true, ip);
  for (const ip of [
    "8.8.8.8",
    "169.254.169.254",
    "::ffff:8.8.8.8",
    "0.0.0.0",
    "fe80::1",
    "224.0.0.1",
    "2001:4860:4860::8888",
  ])
    assert.equal(privateStorageAddress(ip), false, ip);
});

test("private DNS validates every answer and passes only the checked addresses to the socket", async () => {
  const { createPrivateLookup } = await import(
    "../apps/server-storage/transport"
  );
  const addresses = [
    { address: "10.1.2.3", family: 4 },
    { address: "fd00::1", family: 6 },
  ];
  const resolve = ((
    _name: unknown,
    _options: unknown,
    callback: (e: null, a: typeof addresses) => void,
  ) => callback(null, addresses)) as typeof import("node:dns").lookup;
  const pinned = createPrivateLookup(resolve)!;
  const got = await new Promise((ok, fail) =>
    pinned("rustfs.internal", { all: true }, (error, a) =>
      error ? fail(error) : ok(a),
    ),
  );
  assert.deepEqual(got, addresses);
  const mixed = ((
    _name: unknown,
    _options: unknown,
    callback: (e: null, a: typeof addresses) => void,
  ) =>
    callback(null, [
      ...addresses,
      { address: "8.8.8.8", family: 4 },
    ])) as typeof import("node:dns").lookup;
  await assert.rejects(
    new Promise((ok, fail) =>
      createPrivateLookup(mixed)!("rustfs.internal", {}, (error, a) =>
        error ? fail(error) : ok(a),
      ),
    ),
    { code: "denied" },
  );
});
