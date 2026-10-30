import { randomBytes, randomUUID } from "node:crypto";
import { S3ObjectStore, storageFailure } from "./adapter";
import {
  createHandle,
  sha256,
  StorageError,
  type StorageConfig,
} from "./types";
export type ProbeResult = {
  ok: boolean;
  code?: string;
  cleanup: "confirmed" | "failed";
  cleanupCode?: string;
};
/** Explicit network operation only; never opens/activates a workflow database. */
export async function checkStorageContract(
  config: StorageConfig,
): Promise<ProbeResult> {
  const store = new S3ObjectStore(config);
  const bytes = randomBytes(113);
  const handle = createHandle(config, randomUUID(), {
    sha256: sha256(bytes),
    size: bytes.length,
  });
  let failure: StorageError | undefined,
    putUnknown = false;
  try {
    await store.checkBucket();
    await store.put(handle, bytes);
    await store.put(handle, bytes);
    await store.head(handle);
    await store.get(handle);
    const range = await store.range(handle, { start: 3, end: 19 });
    if (!Buffer.from(range).equals(bytes.subarray(3, 20)))
      throw new StorageError("integrity");
    await store.verifyConditional(handle);
    await store.anonymousDenied(handle);
    const missing = createHandle(config, randomUUID(), {
      sha256: sha256(bytes),
      size: bytes.length,
    });
    try {
      await store.get(missing);
      throw new StorageError("probe_failed");
    } catch (e) {
      if (storageFailure(e).code !== "not_found") throw e;
    }
  } catch (e) {
    failure = storageFailure(e);
    putUnknown = failure.outcome === "unknown";
  }
  let cleanup: ProbeResult["cleanup"] = "confirmed",
    cleanupCode: string | undefined;
  try {
    await store.delete(handle);
    await store.delete(handle);
    if (putUnknown) throw new StorageError("uncertain");
  } catch (e) {
    cleanup = "failed";
    cleanupCode = storageFailure(e).code;
  } finally {
    store.close();
  }
  return {
    ok: !failure && cleanup === "confirmed",
    ...(failure
      ? { code: failure.code }
      : cleanup === "failed"
        ? { code: "cleanup_failed" }
        : {}),
    cleanup,
    ...(cleanupCode ? { cleanupCode } : {}),
  };
}
