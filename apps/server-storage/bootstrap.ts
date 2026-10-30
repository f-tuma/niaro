import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
} from "@aws-sdk/client-s3";
import { SignatureV4 } from "@smithy/signature-v4";
import { Hash } from "@smithy/hash-node";
import { HttpRequest } from "@smithy/protocol-http";
import type { Readable } from "node:stream";
import { setTimeout as pause } from "node:timers/promises";
import { clientOptions } from "./adapter";
import { loadStorageConfiguration } from "./config";
import { createStorageTransport } from "./transport";
import { checkStorageContract } from "./probe";
import { StorageError, type StorageConfig } from "./types";
export function applicationPolicy(c: StorageConfig) {
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Effect: "Allow",
        Action: [
          "s3:GetBucketVersioning",
          "s3:GetBucketObjectLockConfiguration",
          "s3:GetBucketLocation",
        ],
        Resource: [`arn:aws:s3:::${c.bucket}`],
      },
      {
        Effect: "Allow",
        Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
        Resource: [`arn:aws:s3:::${c.bucket}/${c.prefix}/*`],
      },
    ],
  };
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical).sort());
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => [k, canonical(v)]),
      ),
    );
  return JSON.stringify(value);
}
export function bootstrapConfigurations(
  env: Readonly<Record<string, string | undefined>>,
) {
  const application = loadStorageConfiguration(env);
  const root = loadStorageConfiguration({
    ...Object.fromEntries(
      Object.entries(env).filter(([k]) => !k.startsWith("NIARO_S3_")),
    ),
    NIARO_S3_ENDPOINT: env.NIARO_S3_ENDPOINT,
    NIARO_S3_REGION: env.NIARO_S3_REGION,
    NIARO_S3_BUCKET: env.NIARO_S3_BUCKET,
    NIARO_S3_PREFIX: env.NIARO_S3_PREFIX,
    NIARO_S3_FORCE_PATH_STYLE: env.NIARO_S3_FORCE_PATH_STYLE,
    NIARO_S3_ALLOW_HTTP: env.NIARO_S3_ALLOW_HTTP,
    NIARO_S3_CREDENTIAL_MODE: "static",
    NIARO_S3_ACCESS_KEY_ID: env.NIARO_RUSTFS_ROOT_ACCESS_KEY,
    NIARO_S3_SECRET_ACCESS_KEY: env.NIARO_RUSTFS_ROOT_SECRET_KEY,
    NIARO_S3_ACCESS_KEY_ID_FILE: env.NIARO_RUSTFS_ROOT_ACCESS_KEY_FILE,
    NIARO_S3_SECRET_ACCESS_KEY_FILE: env.NIARO_RUSTFS_ROOT_SECRET_KEY_FILE,
  });
  if (application.state !== "configured" || root.state !== "configured")
    throw new StorageError("invalid_config");
  const a = application.config,
    r = root.config;
  if (
    a.credentialMode !== "static" ||
    a.region !== "us-east-1" ||
    !a.forcePathStyle ||
    !a.credentials ||
    !r.credentials ||
    a.credentials.sessionToken ||
    a.credentials.accessKeyId === r.credentials.accessKeyId ||
    a.credentials.secretAccessKey === r.credentials.secretAccessKey
  )
    throw new StorageError("invalid_config");
  for (const c of [a, r])
    if (
      !c.credentials ||
      c.credentials.accessKeyId.length < 8 ||
      c.credentials.secretAccessKey.length < 16 ||
      ["rustfsadmin", "minioadmin", "admin", "password"].includes(
        c.credentials.accessKeyId.toLowerCase(),
      ) ||
      ["rustfsadmin", "minioadmin", "password"].includes(
        c.credentials.secretAccessKey.toLowerCase(),
      )
    )
      throw new StorageError("invalid_config");
  return { application: a, root: r };
}
async function admin(
  c: StorageConfig,
  method: string,
  path: string,
  query: Record<string, string> = {},
  data?: unknown,
) {
  const url = new URL(c.endpoint),
    transport = createStorageTransport(c);
  const body = data === undefined ? undefined : JSON.stringify(data);
  try {
    const signer = new SignatureV4({
      credentials: { ...c.credentials! },
      region: c.region,
      service: "s3",
      sha256: Hash.bind(null, "sha256"),
    });
    const request = await signer.sign(
      new HttpRequest({
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ""),
        port: Number(url.port || (url.protocol === "https:" ? 443 : 80)),
        method,
        path,
        query,
        headers: {
          host: url.host,
          ...(body
            ? {
                "content-type": "application/json",
                "content-length": String(Buffer.byteLength(body)),
              }
            : {}),
        },
        body,
      }),
    );
    const response = await transport.handle(request as HttpRequest, {
      abortSignal: AbortSignal.timeout(30000),
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const stream = response.response.body as Readable;
    try {
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 65536) throw new StorageError("unavailable");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      stream.destroy();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (
      response.response.statusCode === 404 &&
      text.includes("<Code>NoSuchResource</Code>")
    )
      return undefined;
    if (
      response.response.statusCode < 200 ||
      response.response.statusCode >= 300
    )
      throw new StorageError(
        response.response.statusCode === 403 ? "denied" : "conflict",
      );
    try {
      return text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      throw new StorageError("unavailable");
    }
  } finally {
    transport.destroy();
  }
}
export async function bootstrapRustFS(
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const { application, root } = bootstrapConfigurations(env);
  const transport = createStorageTransport(root);
  const client = new S3Client({
    ...clientOptions(root),
    requestHandler: transport,
  });
  try {
    const deadline = Date.now() + 60000;
    for (;;) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: root.bucket }), {
          abortSignal: AbortSignal.timeout(
            Math.max(1, Math.min(5000, deadline - Date.now())),
          ),
        });
        break;
      } catch (e) {
        const status = (e as { $metadata?: { httpStatusCode?: number } })
          .$metadata?.httpStatusCode;
        if (status === 404) {
          try {
            await client.send(
              new CreateBucketCommand({ Bucket: root.bucket }),
              { abortSignal: AbortSignal.timeout(5000) },
            );
            break;
          } catch (create) {
            if (
              (create as { name?: string }).name !== "BucketAlreadyOwnedByYou"
            )
              throw new StorageError("unavailable");
          }
        } else if (status === 401 || status === 403)
          throw new StorageError("denied");
        if (Date.now() >= deadline) throw new StorageError("timeout", true);
        await pause(500);
      }
    }
    // Check properties with root before principal creation; never modify existing bucket policy/versioning.
    const { S3ObjectStore } = await import("./adapter");
    const rootStore = new S3ObjectStore(root);
    try {
      await rootStore.checkBucket();
    } finally {
      rootStore.close();
    }
    const query = { accessKey: application.credentials!.accessKeyId };
    const path = "/rustfs/admin/v3/info-service-account";
    const policy = applicationPolicy(application);
    let info = await admin(root, "GET", path, query);
    if (!info) {
      await admin(
        root,
        "PUT",
        "/rustfs/admin/v3/add-service-account",
        {},
        {
          accessKey: application.credentials!.accessKeyId,
          secretKey: application.credentials!.secretAccessKey,
          policy,
        },
      );
      info = await admin(root, "GET", path, query);
    }
    if (
      !info ||
      !["on", "enabled"].includes(String(info.accountStatus)) ||
      info.impliedPolicy !== false ||
      typeof info.policy !== "string"
    )
      throw new StorageError("conflict");
    let actual: unknown;
    try {
      actual = JSON.parse(info.policy);
    } catch {
      throw new StorageError("conflict");
    }
    if (canonical(actual) !== canonical(policy))
      throw new StorageError("conflict");
    const check = await checkStorageContract(application);
    if (!check.ok)
      throw new StorageError(
        check.cleanup === "failed" ? "cleanup_failed" : "probe_failed",
      );
    return {
      ok: true,
      state: "ready",
      principal: "scoped",
      cleanup: check.cleanup,
    };
  } finally {
    client.destroy();
    transport.destroy();
  }
}
