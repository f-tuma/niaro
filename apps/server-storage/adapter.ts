import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectLockConfigurationCommand,
} from "@aws-sdk/client-s3";
import { HttpRequest } from "@smithy/protocol-http";
import type { Readable } from "node:stream";
import { createStorageTransport } from "./transport";
import {
  MAX_OBJECT_BYTES,
  sha256,
  StorageError,
  validateHandle,
  type ObjectHandle,
  type StorageConfig,
} from "./types";
export function storageFailure(error: unknown): StorageError {
  if (error instanceof StorageError) return error;
  const e = error as
    | { name?: string; $metadata?: { httpStatusCode?: number } }
    | undefined;
  const status = e?.$metadata?.httpStatusCode;
  if (status === 404) return new StorageError("not_found", false, "confirmed");
  if (status === 401 || status === 403)
    return new StorageError("denied", false, "confirmed");
  if (status === 409 || status === 412)
    return new StorageError("conflict", false, "confirmed");
  if (status) return new StorageError("unavailable", true, "confirmed");
  return new StorageError(
    e?.name?.includes("Timeout") || e?.name === "AbortError"
      ? "timeout"
      : "unavailable",
    true,
  );
}
export const clientOptions = (c: StorageConfig) => ({
  endpoint: c.endpoint,
  region: c.region,
  forcePathStyle: c.forcePathStyle,
  credentials:
    c.credentialMode === "static" ? { ...c.credentials! } : undefined,
  maxAttempts: 1,
  followRegionRedirects: false,
  useAccelerateEndpoint: false,
  useDualstackEndpoint: false,
  useFipsEndpoint: false,
  requestChecksumCalculation: "WHEN_REQUIRED" as const,
  responseChecksumValidation: "WHEN_REQUIRED" as const,
});
type Operation = { signal: AbortSignal; dispatched: boolean; settled: boolean };
export class S3ObjectStore {
  private readonly transport;
  private readonly client;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  constructor(
    readonly config: StorageConfig,
    private readonly timeoutMs = 30000,
  ) {
    this.transport = createStorageTransport(config);
    this.client = new S3Client({
      ...clientOptions(config),
      requestHandler: this.transport,
    });
  }
  private async operation<T>(action: (o: Operation) => Promise<T>): Promise<T> {
    if (this.closed) throw new StorageError("unavailable");
    if (this.controllers.size >= 2) throw new StorageError("busy", true);
    const controller = new AbortController();
    this.controllers.add(controller);
    const o: Operation = {
      signal: controller.signal,
      dispatched: false,
      settled: false,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => {
          controller.abort();
          reject(new StorageError("timeout", true));
        },
        Math.min(this.timeoutMs, 30000),
      );
    });
    try {
      return await Promise.race([action(o), timeout]);
    } catch (error) {
      const safe = storageFailure(error);
      if (o.dispatched && !o.settled && safe.outcome !== "confirmed")
        throw new StorageError(safe.code, safe.retryable, "unknown");
      if (o.settled)
        throw new StorageError(safe.code, safe.retryable, "confirmed");
      throw safe;
    } finally {
      if (timer) clearTimeout(timer);
      this.controllers.delete(controller);
    }
  }
  private params(h: ObjectHandle) {
    validateHandle(this.config, h);
    return { Bucket: this.config.bucket, Key: h.key };
  }
  private version(value: { VersionId?: string; DeleteMarker?: boolean }) {
    if ((value.VersionId && value.VersionId !== "null") || value.DeleteMarker)
      throw new StorageError("bucket_not_erasable", false, "confirmed");
  }
  private async erasable(o: Operation) {
    const v = await this.client.send(
      new GetBucketVersioningCommand({ Bucket: this.config.bucket }),
      { abortSignal: o.signal },
    );
    if (v.Status) throw new StorageError("bucket_not_erasable");
    try {
      const lock = await this.client.send(
        new GetObjectLockConfigurationCommand({ Bucket: this.config.bucket }),
        { abortSignal: o.signal },
      );
      if (lock.ObjectLockConfiguration)
        throw new StorageError("bucket_not_erasable");
    } catch (e) {
      const error = e as {
        name?: string;
        $metadata?: { httpStatusCode?: number };
      };
      if (
        error.$metadata?.httpStatusCode !== 404 ||
        ![
          "ObjectLockConfigurationNotFoundError",
          "NoSuchObjectLockConfiguration",
        ].includes(error.name ?? "")
      )
        throw e;
    }
  }
  checkBucket() {
    return this.operation((o) => this.erasable(o));
  }
  private async bytes(body: unknown, expected: number): Promise<Uint8Array> {
    if (!body || !(Symbol.asyncIterator in Object(body)))
      throw new StorageError("integrity");
    const stream = body as Readable;
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      for await (const chunk of stream) {
        const b = Buffer.from(chunk);
        size += b.length;
        if (size > expected || size > MAX_OBJECT_BYTES)
          throw new StorageError("integrity");
        chunks.push(b);
      }
      if (size !== expected) throw new StorageError("integrity");
      return Buffer.concat(chunks, size);
    } finally {
      stream.destroy();
    }
  }
  private async read(
    h: ObjectHandle,
    o: Operation,
    range?: { start: number; end: number },
  ) {
    const r = await this.client.send(
      new GetObjectCommand({
        ...this.params(h),
        ...(range ? { Range: `bytes=${range.start}-${range.end}` } : {}),
      }),
      { abortSignal: o.signal },
    );
    try {
      this.version(r);
      const size = range ? range.end - range.start + 1 : h.size;
      if (
        r.ContentLength !== size ||
        (range &&
          (r.$metadata.httpStatusCode !== 206 ||
            r.ContentRange !== `bytes ${range.start}-${range.end}/${h.size}`))
      )
        throw new StorageError("integrity");
      const bytes = await this.bytes(r.Body, size);
      if (!range && sha256(bytes) !== h.sha256)
        throw new StorageError("integrity");
      return bytes;
    } finally {
      (r.Body as Readable | undefined)?.destroy();
    }
  }
  put(
    h: ObjectHandle,
    bytes: Uint8Array,
  ): Promise<"created" | "already-present"> {
    this.params(h);
    if (bytes.length !== h.size || sha256(bytes) !== h.sha256)
      return Promise.reject(new StorageError("integrity"));
    // Copy caller-owned bytes before the first await; callers cannot mutate an admitted payload.
    const body = Buffer.from(bytes);
    return this.operation(async (o) => {
      await this.erasable(o);
      o.dispatched = true;
      try {
        const result = await this.client.send(
          new PutObjectCommand({
            ...this.params(h),
            Body: body,
            ContentLength: body.length,
            ContentType: "application/octet-stream",
            IfNoneMatch: "*",
            Metadata: { sha256: h.sha256 },
          }),
          { abortSignal: o.signal },
        );
        o.settled = true;
        this.version(result);
      } catch (e) {
        if (
          (e as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode !== 412
        )
          throw e;
        o.settled = true;
        await this.read(h, o);
        return "already-present";
      }
      await this.read(h, o);
      return "created";
    });
  }
  head(h: ObjectHandle) {
    this.params(h);
    return this.operation(async (o) => {
      const result = await this.client.send(
        new HeadObjectCommand(this.params(h)),
        { abortSignal: o.signal },
      );
      this.version(result);
      if (
        result.ContentLength !== h.size ||
        result.Metadata?.sha256 !== h.sha256
      )
        throw new StorageError("integrity");
      return { size: h.size, sha256: h.sha256 };
    });
  }
  get(h: ObjectHandle) {
    this.params(h);
    return this.operation((o) => this.read(h, o));
  }
  range(h: ObjectHandle, range: { start: number; end: number }) {
    this.params(h);
    if (
      !Number.isSafeInteger(range.start) ||
      !Number.isSafeInteger(range.end) ||
      range.start < 0 ||
      range.end < range.start ||
      range.end >= h.size
    )
      return Promise.reject(new StorageError("invalid_handle"));
    return this.operation((o) => this.read(h, o, range));
  }
  delete(h: ObjectHandle) {
    this.params(h);
    return this.operation(async (o) => {
      await this.erasable(o);
      o.dispatched = true;
      const result = await this.client.send(
        new DeleteObjectCommand(this.params(h)),
        { abortSignal: o.signal },
      );
      o.settled = true;
      this.version(result);
      try {
        const head = await this.client.send(
          new HeadObjectCommand(this.params(h)),
          { abortSignal: o.signal },
        );
        this.version(head);
        throw new StorageError("integrity");
      } catch (e) {
        if (
          (e as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode !== 404
        )
          throw e;
      }
    });
  }
  /** Probe-only negative request: prove the endpoint itself refuses conditional replacement. */
  verifyConditional(h: ObjectHandle) {
    this.params(h);
    return this.operation(async (o) => {
      o.dispatched = true;
      try {
        await this.client.send(
          new PutObjectCommand({
            ...this.params(h),
            IfNoneMatch: "*",
            Body: Buffer.from("synthetic-conflict"),
            ContentType: "application/octet-stream",
          }),
          { abortSignal: o.signal },
        );
        o.settled = true;
      } catch (e) {
        if (
          (e as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 412
        ) {
          o.settled = true;
          return;
        }
        throw e;
      }
      throw new StorageError("probe_failed");
    });
  }
  anonymousDenied(h: ObjectHandle) {
    this.params(h);
    return this.operation(async (o) => {
      const anonymous = new S3Client({
        ...clientOptions(this.config),
        credentials: { accessKeyId: "anonymous", secretAccessKey: "anonymous" },
        requestHandler: {
          handle: (
            request: HttpRequest,
            options: { abortSignal?: AbortSignal },
          ) => {
            const headers = Object.fromEntries(
              Object.entries(request.headers).filter(
                ([key]) =>
                  key.toLowerCase() !== "authorization" &&
                  !key.toLowerCase().startsWith("x-amz-"),
              ),
            );
            return this.transport.handle(
              new HttpRequest({ ...request, headers }),
              options,
            );
          },
          destroy() {},
        },
      });
      try {
        const result = await anonymous.send(
          new GetObjectCommand(this.params(h)),
          { abortSignal: o.signal },
        );
        (result.Body as Readable | undefined)?.destroy();
        throw new StorageError("probe_failed");
      } catch (e) {
        if (
          ![401, 403, 404].includes(
            (e as { $metadata?: { httpStatusCode?: number } }).$metadata
              ?.httpStatusCode ?? 0,
          )
        )
          throw e;
      } finally {
        anonymous.destroy();
      }
    });
  }
  close() {
    this.closed = true;
    for (const c of this.controllers) c.abort();
    this.client.destroy();
    this.transport.destroy();
  }
}
