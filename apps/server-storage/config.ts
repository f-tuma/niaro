import { constants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import type { StorageConfig, StorageConfiguration } from "./types";
const names = [
  "ENDPOINT",
  "REGION",
  "BUCKET",
  "PREFIX",
  "FORCE_PATH_STYLE",
  "CREDENTIAL_MODE",
  "ACCESS_KEY_ID",
  "SECRET_ACCESS_KEY",
  "SESSION_TOKEN",
  "ACCESS_KEY_ID_FILE",
  "SECRET_ACCESS_KEY_FILE",
  "SESSION_TOKEN_FILE",
  "ALLOW_HTTP",
].map((n) => `NIARO_S3_${n}`);
/** Only loopback, RFC1918 and ULA: link-local/metadata and mapped-public addresses fail. */
export function privateStorageAddress(value: string) {
  if (!ipaddr.isValid(value)) return false;
  let address = ipaddr.parse(value);
  if (
    address.kind() === "ipv6" &&
    (address as ipaddr.IPv6).isIPv4MappedAddress()
  )
    address = (address as ipaddr.IPv6).toIPv4Address();
  return ["loopback", "private", "uniqueLocal"].includes(address.range());
}
class InvalidField extends Error {
  constructor(readonly field?: string) {
    super("invalid_config");
  }
}
export function loadStorageConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): StorageConfiguration {
  const get = (suffix: string) =>
    env[`NIARO_S3_${suffix}`]?.trim() || undefined;
  if (
    !Object.entries(env).some(
      ([k, v]) => k.startsWith("NIARO_S3_") && v?.trim(),
    )
  )
    return { state: "disabled" };
  try {
    if (
      Object.entries(env).some(
        ([k, v]) =>
          k.startsWith("NIARO_S3_") && v?.trim() && !names.includes(k),
      )
    )
      throw new InvalidField();
    const fail = (field: string): never => {
      throw new InvalidField(`NIARO_S3_${field}`);
    };
    const bool = (field: string) => {
      const v = get(field) ?? "false";
      if (!["true", "false"].includes(v)) fail(field);
      return v === "true";
    };
    const region = get("REGION");
    if (!region || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(region)) fail("REGION");
    const bucket = get("BUCKET");
    if (
      !bucket ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket.includes("..") ||
      bucket.includes(".-") ||
      bucket.includes("-.") ||
      isIP(bucket)
    )
      fail("BUCKET");
    const prefix = get("PREFIX") ?? "attachments";
    if (
      prefix.length > 256 ||
      !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(prefix)
    )
      fail("PREFIX");
    const mode = get("CREDENTIAL_MODE");
    if (mode !== "static" && mode !== "default") fail("CREDENTIAL_MODE");
    const forcePathStyle = bool("FORCE_PATH_STYLE"),
      allowHttp = bool("ALLOW_HTTP");
    const raw = get("ENDPOINT") ?? `https://s3.${region}.amazonaws.com`;
    let endpoint: URL;
    try {
      endpoint = new URL(raw);
    } catch {
      return {
        state: "invalid",
        code: "invalid_config",
        field: "NIARO_S3_ENDPOINT",
      };
    }
    if (
      !["https:", "http:"].includes(endpoint.protocol) ||
      endpoint.username ||
      endpoint.password ||
      endpoint.pathname !== "/" ||
      endpoint.search ||
      endpoint.hash
    )
      fail("ENDPOINT");
    if (env.NODE_TLS_REJECT_UNAUTHORIZED === "0")
      throw new InvalidField("NODE_TLS_REJECT_UNAUTHORIZED");
    const host = endpoint.hostname.replace(/^\[|\]$/g, "");
    if (
      endpoint.protocol === "http:" &&
      (!allowHttp ||
        (isIP(host) ? !privateStorageAddress(host) : !forcePathStyle))
    )
      fail("ENDPOINT");
    if (endpoint.protocol !== "http:" && allowHttp) fail("ALLOW_HTTP");
    const secret = (field: string) => {
      const direct = env[`NIARO_S3_${field}`];
      const file = get(`${field}_FILE`);
      const value = direct?.trim() ? direct : undefined;
      if (value && file) fail(field);
      if (mode === "default" && (value || file)) fail("CREDENTIAL_MODE");
      let result = value;
      if (file) {
        let fd: number | undefined;
        try {
          fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK);
          const stat = fstatSync(fd);
          if (!stat.isFile() || stat.size > 16384) fail(field);
          const buffer = Buffer.alloc(16385);
          const n = readSync(fd, buffer, 0, buffer.length, 0);
          if (n > 16384) fail(field);
          result = buffer
            .subarray(0, n)
            .toString("utf8")
            .replace(/\r?\n$/, "");
        } catch {
          fail(field);
        } finally {
          if (fd !== undefined) closeSync(fd);
        }
      }
      if (
        result !== undefined &&
        (!result.trim() ||
          Buffer.byteLength(result) > 16384 ||
          /[\x00-\x1f\x7f]/.test(result))
      )
        fail(field);
      return result;
    };
    const accessKeyId = secret("ACCESS_KEY_ID"),
      secretAccessKey = secret("SECRET_ACCESS_KEY"),
      sessionToken = secret("SESSION_TOKEN");
    if (mode === "static" && (!accessKeyId || !secretAccessKey))
      fail(!accessKeyId ? "ACCESS_KEY_ID" : "SECRET_ACCESS_KEY");
    const config = {
      endpoint: endpoint.origin,
      region: region!,
      bucket: bucket!,
      prefix,
      forcePathStyle,
      allowHttp,
      credentialMode: mode!,
    } as StorageConfig;
    // Neither JSON nor ordinary object inspection accidentally prints static secrets.
    if (mode === "static")
      Object.defineProperty(config, "credentials", {
        value: Object.freeze({
          accessKeyId: accessKeyId!,
          secretAccessKey: secretAccessKey!,
          ...(sessionToken ? { sessionToken } : {}),
        }),
        enumerable: false,
      });
    Object.defineProperty(config, "toJSON", {
      value: () => ({ state: "configured" }),
      enumerable: false,
    });
    return { state: "configured", config: Object.freeze(config) };
  } catch (error) {
    return {
      state: "invalid",
      code: "invalid_config",
      ...(error instanceof InvalidField && error.field
        ? { field: error.field }
        : {}),
    };
  }
}
