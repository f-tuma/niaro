import { lookup } from "node:dns";
import { isIP } from "node:net";
import { Agent as HttpAgent } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import { Transform, type Readable } from "node:stream";
import { NodeHttpHandler } from "@smithy/node-http-handler";
import type { HttpRequest } from "@smithy/protocol-http";
import { privateStorageAddress } from "./config";
import { MAX_OBJECT_BYTES, StorageError, type StorageConfig } from "./types";
/** The resolver's validated addresses are the exact addresses used by the socket. */
export function createPrivateLookup(
  resolve: typeof lookup = lookup,
): NonNullable<ConstructorParameters<typeof HttpAgent>[0]>["lookup"] {
  return (hostname, options, callback) => {
    resolve(hostname, { all: true, verbatim: true }, (error, addresses) => {
      if (
        error ||
        !addresses.length ||
        addresses.some((a) => !privateStorageAddress(a.address))
      )
        return callback(new StorageError("denied"), "", 0);
      if (options.all) callback(null, addresses);
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };
}
export const privateLookup = createPrivateLookup();
export function createStorageTransport(c: StorageConfig) {
  const origin = new URL(c.endpoint);
  const baseHost = origin.hostname.replace(/^\[|\]$/g, "");
  const handler = new NodeHttpHandler({
    connectionTimeout: 5000,
    socketTimeout: 30000,
    requestTimeout: 30000,
    throwOnRequestTimeout: true,
    httpAgent: new HttpAgent({
      keepAlive: false,
      maxSockets: 2,
      lookup: origin.protocol === "http:" ? privateLookup : undefined,
    }),
    httpsAgent: new HttpsAgent({
      keepAlive: false,
      maxSockets: 2,
      rejectUnauthorized: true,
    }),
  });
  return {
    async handle(
      request: HttpRequest,
      options: { abortSignal?: AbortSignal } = {},
    ) {
      if (
        request.protocol !== origin.protocol ||
        (request.port ?? (request.protocol === "https:" ? 443 : 80)) !==
          Number(origin.port || (origin.protocol === "https:" ? 443 : 80)) ||
        ![baseHost, `${c.bucket}.${baseHost}`].includes(
          request.hostname.replace(/^\[|\]$/g, ""),
        )
      )
        throw new StorageError("denied");
      if (
        request.protocol === "http:" &&
        (!c.allowHttp ||
          (isIP(baseHost) !== 0 && !privateStorageAddress(baseHost)))
      )
        throw new StorageError("denied");
      const result = await handler.handle(request, options);
      const body = result.response.body as Readable;
      if (
        result.response.statusCode >= 300 &&
        result.response.statusCode < 400
      ) {
        body?.destroy();
        throw new StorageError("denied", false, "confirmed");
      }
      if (body?.pipe) {
        let bytes = 0;
        const bounded = new Transform({
          transform(chunk: Buffer, _encoding, done) {
            bytes += chunk.length;
            done(
              bytes > MAX_OBJECT_BYTES + 65536
                ? new StorageError("integrity")
                : null,
              bytes > MAX_OBJECT_BYTES + 65536 ? undefined : chunk,
            );
          },
        });
        const abort = () => {
          body.destroy();
          bounded.destroy(new StorageError("timeout", true));
        };
        options.abortSignal?.addEventListener("abort", abort, { once: true });
        bounded.once("close", () => {
          options.abortSignal?.removeEventListener("abort", abort);
          body.destroy();
        });
        body.once("error", () =>
          bounded.destroy(new StorageError("unavailable", true)),
        );
        // A parser may reject before attaching a consumer; avoid an unhandled stream error.
        bounded.on("error", () => {});
        result.response.body = body.pipe(bounded);
      }
      return result;
    },
    destroy() {
      handler.destroy();
    },
  };
}
