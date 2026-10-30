/** Opt-in Compose/runtime test; every project, volume and network is unique synthetic state. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const image = "niaro:s3-foundation-checkpoint";
function command(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync("docker", args, { encoding: "utf8", env });
  if (r.status !== 0)
    throw Error(`Docker command failed (${r.status}): ${r.stderr}`);
  return r.stdout;
}
async function main() {
  const unknown = spawnSync("docker", ["run", "--rm", image, "migrate"], {
    encoding: "utf8",
  });
  assert.equal(unknown.status, 64);
  assert.match(unknown.stderr, /storage-check/);
  assert.match(unknown.stderr, /storage-bootstrap/);
  console.log(
    "PASS packaged entrypoint unknown-command exit 64 and supported command list",
  );
  const variants = process.argv[2]
    ? [process.argv[2]]
    : ["compose.yml", "compose.dokploy.yml"];
  if (
    variants.some(
      (file) => !["compose.yml", "compose.dokploy.yml"].includes(file),
    )
  )
    throw Error("Unknown Compose test variant");
  for (const file of variants) {
    const name = `niaro-s3-compose-${randomBytes(6).toString("hex")}`,
      dir = mkdtempSync(join(tmpdir(), "niaro-s3-compose-")),
      override = join(dir, "override.json"),
      network = `${name}-proxy`;
    const env = {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([k]) => !k.startsWith("NIARO_S3_") && !k.startsWith("NIARO_RUSTFS_"),
        ),
      ),
      NODE_ENV: process.env.NODE_ENV,
      NIARO_IMAGE: image,
      NIARO_RUSTFS_PORT: "0",
      NIARO_PUBLIC_URL: "https://synthetic.example",
      NIARO_CONFIG: "./examples/self-hosted/server.json",
      NIARO_DATA_VOLUME: `${name}-niaro-data`,
      NIARO_S3_ENDPOINT: "http://rustfs:9000",
      NIARO_S3_REGION: "us-east-1",
      NIARO_S3_BUCKET: `synthetic-${randomBytes(6).toString("hex")}`,
      NIARO_S3_PREFIX: "profile-test",
      NIARO_S3_CREDENTIAL_MODE: "static",
      NIARO_S3_ACCESS_KEY_ID: `app-${randomBytes(12).toString("hex")}`,
      NIARO_S3_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
      NIARO_S3_FORCE_PATH_STYLE: "true",
      NIARO_S3_ALLOW_HTTP: "true",
      NIARO_RUSTFS_ROOT_ACCESS_KEY: `root-${randomBytes(12).toString("hex")}`,
      NIARO_RUSTFS_ROOT_SECRET_KEY: randomBytes(32).toString("hex"),
    };
    // An ephemeral published port avoids the user's pilot or live service ports.
    writeFileSync(
      override,
      JSON.stringify({
        services: {},
        ...(file.includes("dokploy")
          ? {
              networks: {
                "dokploy-network": { name: network, external: true },
              },
            }
          : {}),
      }),
    );
    const args = ["compose", "-p", name, "-f", file, "-f", override];
    const compose = (tail: string[]) => command([...args, ...tail], env);
    try {
      if (file.includes("dokploy")) command(["network", "create", network]);
      const config = JSON.parse(
        compose(["--profile", "object-storage", "config", "--format", "json"]),
      );
      assert.equal(
        config.services.rustfs.environment.RUSTFS_CONSOLE_ENABLE,
        "false",
      );
      assert.ok(
        !Object.keys(config.services.niaro.environment).some((k) =>
          k.startsWith("NIARO_RUSTFS_ROOT_"),
        ),
      );
      assert.deepEqual(config.services.rustfs.networks, { default: null });
      const defaults = compose(["config", "--services"]);
      assert.ok(!defaults.split("\n").includes("rustfs"));
      assert.ok(!defaults.split("\n").includes("rustfs-bootstrap"));
      compose([
        "--profile",
        "object-storage",
        "run",
        "--rm",
        "rustfs-bootstrap",
      ]);
      compose([
        "--profile",
        "object-storage",
        "run",
        "--rm",
        "rustfs-bootstrap",
      ]);
      compose(["run", "--rm", "--no-deps", "niaro", "storage-check"]);
      const script = (operation: "put" | "get-delete") =>
        `(async()=>{const{S3Client,PutObjectCommand,GetObjectCommand,DeleteObjectCommand}=require('@aws-sdk/client-s3');const p=process.env;const c=new S3Client({endpoint:p.NIARO_S3_ENDPOINT,region:p.NIARO_S3_REGION,forcePathStyle:true,credentials:{accessKeyId:p.NIARO_S3_ACCESS_KEY_ID,secretAccessKey:p.NIARO_S3_SECRET_ACCESS_KEY},requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED',maxAttempts:1});const input={Bucket:p.NIARO_S3_BUCKET,Key:p.NIARO_S3_PREFIX+'/persistent-synthetic'};try{${operation === "put" ? "await c.send(new PutObjectCommand({...input,Body:'synthetic profile persistence'}));" : "const r=await c.send(new GetObjectCommand(input));if(await r.Body.transformToString()!=='synthetic profile persistence')throw Error('bytes differ');await c.send(new DeleteObjectCommand(input));"}}finally{c.destroy()}})().catch(()=>process.exit(1))`;
      const run = (code: string) =>
        compose([
          "run",
          "--rm",
          "--no-deps",
          "--entrypoint",
          "node",
          "niaro",
          "-e",
          code,
        ]);
      run(script("put"));
      compose([
        "--profile",
        "object-storage",
        "rm",
        "--stop",
        "--force",
        "rustfs",
      ]);
      compose([
        "--profile",
        "object-storage",
        "run",
        "--rm",
        "rustfs-bootstrap",
      ]);
      run(script("get-delete"));
      console.log(
        `PASS ${file}: optional profile, scoped repeat bootstrap, packaged contract and container recreation persistence`,
      );
    } finally {
      try {
        compose([
          "--profile",
          "object-storage",
          "down",
          "--volumes",
          "--remove-orphans",
        ]);
      } finally {
        if (file.includes("dokploy")) command(["network", "rm", network]);
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
}
void main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
