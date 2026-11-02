import http from "node:http";
import https from "node:https";
import type { Readable } from "node:stream";

/**
 * One POST to a local service that may take many minutes to answer (the
 * diarizer, the document converter). node:http rather than fetch: fetch
 * gives up after five minutes without response headers, whatever its signal.
 * The answer is read up to `maxBytes`; the signal ends the request at any time.
 */
export function longPost(
  url: URL,
  headers: Record<string, string>,
  body: { bytes: Uint8Array } | { stream: Readable; size: number },
  signal: AbortSignal,
  maxBytes: number,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const size = "bytes" in body ? body.bytes.byteLength : body.size;
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: "POST",
        headers: { ...headers, "Content-Length": String(size) },
        signal,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > maxBytes) {
            response.destroy();
            reject(new Error("response_too_large"));
          } else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        response.on("error", reject);
      },
    );
    request.on("error", (error) =>
      reject(signal.aborted ? signal.reason : error),
    );
    if ("bytes" in body) request.end(body.bytes);
    else
      body.stream.on("error", (error) => request.destroy(error)).pipe(request);
  });
}
