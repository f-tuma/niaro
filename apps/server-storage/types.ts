import { createHash, randomUUID } from "node:crypto";
export const MAX_OBJECT_BYTES = 25 * 1024 * 1024;
export type ErrorCode =
  | "invalid_config"
  | "unavailable"
  | "denied"
  | "not_found"
  | "conflict"
  | "integrity"
  | "location_mismatch"
  | "migration_required"
  | "bucket_not_erasable"
  | "invalid_handle"
  | "busy"
  | "timeout"
  | "uncertain"
  | "probe_failed"
  | "cleanup_failed";
export class StorageError extends Error {
  constructor(
    public readonly code: ErrorCode,
    public readonly retryable = false,
    public readonly outcome:
      | "not_started"
      | "confirmed"
      | "unknown" = "not_started",
  ) {
    super(`Object storage: ${code}`);
    this.name = "StorageError";
  }
}
export type StorageConfig = Readonly<{
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  forcePathStyle: boolean;
  allowHttp: boolean;
  credentialMode: "static" | "default";
  credentials?: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
}>;
export type StorageConfiguration =
  | { state: "disabled" }
  | { state: "invalid"; code: "invalid_config"; field?: string }
  | { state: "configured"; config: StorageConfig };
export type ObjectHandle = Readonly<{
  version: 1;
  id: string;
  locationId: string;
  key: string;
  owner: string;
  sha256: string;
  size: number;
}>;
export const sha256 = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export const descriptor = (c: StorageConfig) =>
  JSON.stringify([
    1,
    c.endpoint,
    c.region,
    c.bucket,
    c.prefix,
    c.forcePathStyle,
  ]);
export const locationId = (c: StorageConfig) => sha256(descriptor(c));
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function createHandle(
  c: StorageConfig,
  owner: string,
  digest: { sha256: string; size: number },
): ObjectHandle {
  const id = randomUUID();
  const h = Object.freeze({
    version: 1 as const,
    id,
    locationId: locationId(c),
    key: `${c.prefix}/objects/${sha256(owner)}/${id}`,
    owner,
    sha256: digest.sha256,
    size: digest.size,
  });
  validateHandle(c, h);
  return h;
}
export function validateHandle(c: StorageConfig, h: ObjectHandle) {
  if (
    !h ||
    h.version !== 1 ||
    !uuid.test(h.id) ||
    !uuid.test(h.owner) ||
    !/^[a-f0-9]{64}$/.test(h.sha256) ||
    !Number.isSafeInteger(h.size) ||
    h.size < 0 ||
    h.size > MAX_OBJECT_BYTES ||
    h.key !== `${c.prefix}/objects/${sha256(h.owner)}/${h.id}`
  )
    throw new StorageError("invalid_handle");
  if (h.locationId !== locationId(c))
    throw new StorageError("location_mismatch");
}
export const safeStatus = (s: StorageConfiguration) =>
  s.state === "invalid"
    ? { state: s.state, code: s.code, ...(s.field ? { field: s.field } : {}) }
    : { state: s.state };
