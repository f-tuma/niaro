import { S3ObjectStore, storageFailure } from "./adapter";
import { StorageRegistry } from "./registry";
import {
  StorageError,
  type ObjectHandle,
  type StorageConfiguration,
  type StorageConfig,
} from "./types";
export class RegisteredObjectStore {
  constructor(
    private readonly registry: StorageRegistry,
    private readonly config: StorageConfig,
    private readonly adapter: S3ObjectStore,
  ) {}
  reserve(owner: string, digest: { sha256: string; size: number }) {
    return this.local(() => this.registry.reserve(this.config, owner, digest));
  }
  private local<T>(run: () => T): T {
    try {
      return run();
    } catch (error) {
      throw storageFailure(error);
    }
  }
  private async mutation<T>(
    h: ObjectHandle,
    kind: "put" | "delete",
    run: () => Promise<T>,
  ): Promise<T | undefined> {
    const token = this.local(() => this.registry.begin(this.config, h, kind));
    if (!token) return;
    let value: T;
    try {
      value = await run();
    } catch (e) {
      const safe = storageFailure(e);
      this.local(() => this.registry.finish(this.config, h, token, kind, safe));
      throw safe;
    }
    this.local(() => this.registry.finish(this.config, h, token, kind));
    return value;
  }
  async put(h: ObjectHandle, bytes: Uint8Array) {
    return (await this.mutation(h, "put", () => this.adapter.put(h, bytes)))!;
  }
  async delete(h: ObjectHandle) {
    await this.mutation(h, "delete", () => this.adapter.delete(h));
  }
  head(h: ObjectHandle) {
    this.local(() => this.registry.check(this.config, h));
    return this.adapter.head(h);
  }
  get(h: ObjectHandle) {
    this.local(() => this.registry.check(this.config, h));
    return this.adapter.get(h);
  }
  range(h: ObjectHandle, bounds: { start: number; end: number }) {
    this.local(() => this.registry.check(this.config, h));
    return this.adapter.range(h, bounds);
  }
  close() {
    this.adapter.close();
  }
}
export type StorageRuntime =
  | { state: "disabled" }
  | { state: "unavailable"; code: string }
  | { state: "configured"; store: RegisteredObjectStore };
export function initializeObjectStorage(
  registry: StorageRegistry,
  configuration: StorageConfiguration,
): StorageRuntime {
  if (configuration.state === "disabled") return { state: "disabled" };
  if (configuration.state === "invalid")
    return { state: "unavailable", code: "invalid_config" };
  try {
    registry.activate(configuration.config);
    return {
      state: "configured",
      store: new RegisteredObjectStore(
        registry,
        configuration.config,
        new S3ObjectStore(configuration.config),
      ),
    };
  } catch (e) {
    return {
      state: "unavailable",
      code: e instanceof StorageError ? e.code : "unavailable",
    };
  }
}
