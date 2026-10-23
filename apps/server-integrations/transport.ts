import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import ipaddr from "ipaddr.js";
import { ServiceUrl } from "../../packages/protocol/service-catalog";
import { providerFailure } from "./failures";
import { IntegrationError } from "./integration-error";
export { IntegrationError } from "./integration-error";
export type DispatchGuard = (start: () => void) => Promise<void>;
/** One request may wait this long at most; meeting records take minutes. */
export const MAX_TRANSPORT_TIMEOUT_MS = 15 * 60_000;
export type TransportRequest = {
  url: string;
  responseId?: number;
  responseType?: "bytes";
  maxResponseBytes?: number;
  maxRequestBytes?: number;
  timeoutMs?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyEncoding?: "json" | "form";
  signal?: AbortSignal;
  beforeDispatch?: DispatchGuard;
  /**
   * A page of the public web (the web plugin's reads): http or https, public
   * addresses only even for an origin trusted in Settings → Origins, and a
   * redirect is returned (status and Location) instead of refused, so the
   * caller checks the next address before it follows.
   */
  publicWeb?: boolean;
};
export type TransportResponse = {
  status: number;
  headers: Record<string, string>;
  text: string;
  bytes?: Buffer;
};
export type IntegrationTransport = (
  request: TransportRequest,
) => Promise<TransportResponse>;
export function publicAddress(value: string) {
  if (!ipaddr.isValid(value)) return false;
  let address = ipaddr.parse(value);
  if (
    address.kind() === "ipv6" &&
    (address as ipaddr.IPv6).isIPv4MappedAddress()
  )
    address = (address as ipaddr.IPv6).toIPv4Address();
  return address.range() === "unicast";
}
export function validateEndpoint(
  value: string,
  trustedOrigins: readonly string[],
) {
  const parsed = ServiceUrl.safeParse(value);
  if (!parsed.success) throw new IntegrationError("integration_url_invalid");
  const url = new URL(value);
  if (url.protocol !== "https:" && !trustedOrigins.includes(url.origin))
    throw new IntegrationError("integration_origin_denied", 403);
  return url;
}
/** Resolve once, validate every answer, then pin the connection. No redirects, proxies or decompression. */
export function createTransport(
  trustedOrigins: readonly string[] = [],
): IntegrationTransport {
  return async (input) => {
    const url = new URL(input.url);
    if (input.publicWeb) {
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password
      )
        throw new IntegrationError("integration_url_invalid");
    } else validateEndpoint(url.origin + url.pathname, trustedOrigins);
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const trusted = !input.publicWeb && trustedOrigins.includes(url.origin);
    const timeout = AbortSignal.timeout(
      Math.min(input.timeoutMs ?? 20000, MAX_TRANSPORT_TIMEOUT_MS),
    );
    const signal = AbortSignal.any([
      timeout,
      ...(input.signal ? [input.signal] : []),
    ]);
    // Running out of time is not the caller cancelling; logs and failures tell them apart.
    const failed = () =>
      timeout.aborted
        ? new IntegrationError("integration_timeout", 504)
        : signal.aborted
          ? new IntegrationError("integration_cancelled", 502)
          : new IntegrationError("integration_unavailable", 502);
    signal.throwIfAborted();
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    signal.throwIfAborted();
    if (
      !addresses.length ||
      (!trusted && addresses.some((a) => !publicAddress(a.address)))
    )
      throw new IntegrationError("integration_origin_denied", 403);
    const pinned = addresses[0]!;
    if (
      input.bodyEncoding === "form" &&
      (!input.body ||
        typeof input.body !== "object" ||
        Array.isArray(input.body) ||
        Object.values(input.body).some((value) => typeof value !== "string"))
    )
      throw new IntegrationError("integration_input_invalid");
    const bytes =
      input.body === undefined
        ? undefined
        : Buffer.from(
            input.bodyEncoding === "form"
              ? new URLSearchParams(
                  input.body as Record<string, string>,
                ).toString()
              : JSON.stringify(input.body),
          );
    if (
      bytes &&
      bytes.length > Math.min(input.maxRequestBytes ?? 262144, 12 * 1024 * 1024)
    )
      throw new IntegrationError("integration_input_too_large");
    return new Promise((resolve, reject) => {
      let started = false;
      const start = () => {
        if (started) return;
        signal.throwIfAborted();
        started = true;
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            method: input.method ?? "GET",
            agent: false,
            signal,
            lookup: (_host, options, callback) =>
              options.all
                ? callback(null, [pinned])
                : callback(null, pinned.address, pinned.family),
            headers: {
              Accept: "application/json",
              "Accept-Encoding": "identity",
              ...(bytes
                ? {
                    "Content-Type":
                      input.bodyEncoding === "form"
                        ? "application/x-www-form-urlencoded"
                        : "application/json",
                    "Content-Length": String(bytes.length),
                  }
                : {}),
              ...input.headers,
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            let size = 0;
            const status = res.statusCode ?? 0;
            if (
              input.publicWeb &&
              status >= 300 &&
              status < 400 &&
              typeof res.headers.location === "string"
            ) {
              res.destroy();
              resolve({
                status,
                headers: { location: res.headers.location },
                text: "",
              });
              return;
            }
            if (
              ((res.statusCode ?? 0) >= 300 && (res.statusCode ?? 0) < 400) ||
              (res.headers["content-encoding"] &&
                res.headers["content-encoding"] !== "identity")
            ) {
              res.destroy();
              reject(new IntegrationError("integration_response_invalid", 502));
              return;
            }
            res.on("data", (chunk: Buffer) => {
              size += chunk.length;
              if (
                size >
                Math.min(input.maxResponseBytes ?? 2_097_152, 12 * 1024 * 1024)
              ) {
                res.destroy();
                reject(
                  new IntegrationError("integration_response_too_large", 502),
                );
              } else {
                chunks.push(chunk);
                if (
                  input.responseId !== undefined &&
                  res.headers["content-type"]?.includes("text/event-stream")
                ) {
                  const partial = Buffer.concat(chunks).toString("utf8");
                  const complete = partial
                    .split(/\r?\n\r?\n/)
                    .slice(0, -1)
                    .some((event) => {
                      const data = event
                        .split(/\r?\n/)
                        .filter((line) => line.startsWith("data:"))
                        .map((line) => line.slice(5).trimStart())
                        .join("\n");
                      try {
                        return data && JSON.parse(data).id === input.responseId;
                      } catch {
                        return false;
                      }
                    });
                  if (complete) {
                    resolve({
                      status: res.statusCode ?? 502,
                      headers: Object.fromEntries(
                        Object.entries(res.headers).filter(
                          (entry): entry is [string, string] =>
                            typeof entry[1] === "string",
                        ),
                      ),
                      text: partial,
                    });
                    res.destroy();
                  }
                }
              }
            });
            res.on("error", () => reject(failed()));
            res.on("end", () =>
              resolve({
                status: res.statusCode ?? 502,
                headers: Object.fromEntries(
                  Object.entries(res.headers).filter(
                    (entry): entry is [string, string] =>
                      typeof entry[1] === "string",
                  ),
                ),
                text:
                  input.responseType === "bytes"
                    ? ""
                    : Buffer.concat(chunks).toString("utf8"),
                ...(input.responseType === "bytes"
                  ? { bytes: Buffer.concat(chunks) }
                  : {}),
              }),
            );
          },
        );
        req.on("error", () => reject(failed()));
        req.end(bytes);
      };
      if (input.beforeDispatch)
        void input.beforeDispatch(start).then(() => {
          if (!started)
            reject(new IntegrationError("integration_dispatch_denied", 403));
        }, reject);
      else {
        try {
          start();
        } catch (error) {
          reject(error);
        }
      }
    });
  };
}
export function jsonResponse(
  response: TransportResponse,
  secretValues: readonly string[] = [],
): unknown {
  if (response.status < 200 || response.status >= 300)
    throw new IntegrationError(
      "integration_provider_failed",
      502,
      providerFailure(response.text, {
        httpStatus: response.status,
        secretValues: [
          ...secretValues,
          ...Object.entries(response.headers)
            .filter(([name]) =>
              /cookie|authorization|token|session|api.?key/i.test(name),
            )
            .map(([, value]) => value),
        ],
      }),
    );
  try {
    return JSON.parse(response.text);
  } catch {
    throw new IntegrationError("integration_response_invalid", 502);
  }
}
export function sameEndpoint(base: string, value: string) {
  const root = new URL(base),
    url = new URL(value);
  const prefix = root.pathname.replace(/\/$/, "");
  if (
    url.origin !== root.origin ||
    (url.pathname !== prefix && !url.pathname.startsWith(prefix + "/")) ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new IntegrationError("integration_path_denied", 403);
  return url;
}
