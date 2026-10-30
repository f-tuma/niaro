import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadStorageConfiguration } from "../../apps/server-storage/config";
export async function syntheticS3() {
  const objects = new Map<string, { body: Buffer; digest: string }>();
  const pendingPuts: (() => void)[] = [];
  const calls: { method: string; path: string; conditional?: string }[] = [];
  const faults = {
    versioning: false,
    lockDenied: false,
    corrupt: false,
    badRange: false,
    deny: false,
    slow: false,
    public: false,
    ignoreConditional: false,
    deleteFailure: false,
    losePutResponse: false,
    loseConditionalResponse: false,
    corruptRange: false,
    redirect: false,
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    const key = url.pathname.split("/").slice(2).join("/");
    calls.push({
      method: req.method!,
      path: req.url!,
      conditional: req.headers["if-none-match"] as string | undefined,
    });
    const error = (status: number, code: string) => {
      res.writeHead(status, { "content-type": "application/xml" });
      res.end(
        `<Error><Code>${code}</Code><Message>private-service-canary</Message></Error>`,
      );
    };
    if (faults.redirect) {
      res.writeHead(307, { location: "http://public.example/secret" });
      res.end();
      return;
    }
    if (faults.deny) return error(403, "AccessDenied");
    if (url.searchParams.has("versioning")) {
      res.end(
        `<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${faults.versioning ? "<Status>Suspended</Status>" : ""}</VersioningConfiguration>`,
      );
      return;
    }
    if (url.searchParams.has("object-lock"))
      return error(
        faults.lockDenied ? 403 : 404,
        faults.lockDenied
          ? "AccessDenied"
          : "ObjectLockConfigurationNotFoundError",
      );
    if (!req.headers.authorization && !faults.public)
      return error(403, "AccessDenied");
    if (req.method === "PUT") {
      const chunks: Buffer[] = [];
      for await (const b of req) chunks.push(Buffer.from(b));
      if (
        faults.loseConditionalResponse &&
        Buffer.concat(chunks).toString() === "synthetic-conflict"
      ) {
        const body = Buffer.concat(chunks),
          digest = String(req.headers["x-amz-meta-sha256"] ?? "");
        pendingPuts.push(() => {
          if (!objects.has(key)) objects.set(key, { body, digest });
        });
        res.destroy();
        return;
      }
      if (
        objects.has(key) &&
        req.headers["if-none-match"] === "*" &&
        !faults.ignoreConditional
      )
        return error(412, "PreconditionFailed");
      if (faults.losePutResponse) {
        const body = Buffer.concat(chunks),
          digest = String(req.headers["x-amz-meta-sha256"] ?? "");
        pendingPuts.push(() => objects.set(key, { body, digest }));
        res.destroy();
        return;
      }
      objects.set(key, {
        body: Buffer.concat(chunks),
        digest: String(req.headers["x-amz-meta-sha256"] ?? ""),
      });
      res.end();
      return;
    }
    if (req.method === "DELETE") {
      if (faults.deleteFailure) return error(503, "ServiceUnavailable");
      objects.delete(key);
      res.writeHead(204);
      res.end();
      return;
    }
    const object = objects.get(key);
    if (!object) return error(404, "NoSuchKey");
    if (faults.slow) return;
    let bytes = faults.corrupt
      ? Buffer.alloc(object.body.length, 88)
      : object.body;
    const headers: Record<string, string | number> = {
      "content-length": bytes.length,
      "x-amz-meta-sha256": object.digest,
    };
    let status = 200;
    if (req.headers.range) {
      const match = /bytes=(\d+)-(\d+)/.exec(req.headers.range)!;
      const start = Number(match[1]),
        end = Number(match[2]);
      bytes = bytes.subarray(start, end + 1);
      if (faults.corruptRange) {
        bytes = Buffer.from(bytes);
        bytes[0] = bytes[0]! ^ 255;
      }
      headers["content-range"] = `bytes ${start}-${end}/${object.body.length}`;
      headers["content-length"] = bytes.length;
      status = faults.badRange ? 200 : 206;
    }
    res.writeHead(status, headers);
    res.end(req.method === "HEAD" ? undefined : bytes);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const c = loadStorageConfiguration({
    NIARO_S3_ENDPOINT: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    NIARO_S3_REGION: "us-east-1",
    NIARO_S3_BUCKET: "synthetic-storage",
    NIARO_S3_CREDENTIAL_MODE: "static",
    NIARO_S3_ACCESS_KEY_ID: "synthetic-key",
    NIARO_S3_SECRET_ACCESS_KEY: "synthetic-secret",
    NIARO_S3_ALLOW_HTTP: "true",
    NIARO_S3_FORCE_PATH_STYLE: "true",
  });
  if (c.state !== "configured") throw Error("fixture config");
  return {
    pendingPuts,
    config: c.config,
    objects,
    calls,
    faults,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}
