import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import type { Scope } from "../../packages/protocol";
import {
  ATTACHMENT_PROFILE,
  attachmentRouteProfile,
  AttachmentCapabilitiesSchema,
} from "../../packages/protocol/attachments";
import { StorageError } from "../server-storage/types";
import { AttachmentStore } from "./store";
import { AttachmentError } from "./schema";
import { AttachmentAdmission, spoolAttachment } from "./admission";

/** JSON.parse alone discards duplicate object keys, including escaped spellings. */
export function noDuplicateKeys(raw: string) {
  const stack: ({ keys: Set<string>; key: boolean } | null)[] = [];
  for (let n = 0; n < raw.length; n++) {
    const c = raw[n];
    if (c === '"') {
      const start = n;
      for (n++; n < raw.length; n++) {
        if (raw[n] === "\\") {
          n++;
          continue;
        }
        if (raw[n] === '"') break;
      }
      const top = stack.at(-1);
      if (top?.key) {
        const key = JSON.parse(raw.slice(start, n + 1));
        if (top.keys.has(key)) throw new AttachmentError("attachment_invalid");
        top.keys.add(key);
        top.key = false;
      }
    } else if (c === "{") stack.push({ keys: new Set(), key: true });
    else if (c === "[") stack.push(null);
    else if (c === "}" || c === "]") stack.pop();
    else if (c === "," && stack.at(-1)) stack.at(-1)!.key = true;
  }
}
async function jsonBody(req: IncomingMessage) {
  if (
    req.headers["content-encoding"] ||
    !/^application\/json(?:;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new AttachmentError("attachment_invalid");
  if (Number(req.headers["content-length"] ?? 0) > 8192)
    throw new AttachmentError("attachment_too_large", 413);
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const value of req) {
    const b = Buffer.from(value);
    size += b.length;
    if (size > 8192) throw new AttachmentError("attachment_too_large", 413);
    chunks.push(b);
  }
  try {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw);
    noDuplicateKeys(raw);
    return body;
  } catch (error) {
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("attachment_invalid");
  }
}
export function attachmentStorageError(error: unknown): AttachmentError {
  if (error instanceof AttachmentError) return error;
  if (error instanceof StorageError) {
    if (error.code === "uncertain")
      return new AttachmentError("attachment_uncertain", 409);
    if (error.code === "busy")
      return new AttachmentError("attachment_busy", 429);
    if (error.code === "integrity")
      return new AttachmentError("attachment_integrity", 503);
    if (
      error.code === "not_found" ||
      error.code === "invalid_handle" ||
      error.code === "denied"
    )
      return new AttachmentError("attachment_unavailable", 404);
  }
  return new AttachmentError("attachment_unavailable", 503);
}
export type AttachmentAccess = {
  scope: Scope;
  run<T>(fn: () => T): Promise<T>;
};
export async function attachmentHttp(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  route: string,
  access: AttachmentAccess,
  store: AttachmentStore,
  admission: AttachmentAdmission,
  directory: string,
  respond: (status: number, body: unknown) => void,
) {
  if (!attachmentRouteProfile(url.searchParams))
    return respond(406, { error: "attachment_profile_required" });
  res.setHeader("Cache-Control", "private, no-store");
  if (
    ["GET", "HEAD"].includes(req.method ?? "") &&
    (req.headers["transfer-encoding"] ||
      Number(req.headers["content-length"] ?? 0) !== 0)
  )
    return respond(400, {
      error: "attachment_invalid",
      retryable: false,
      retryAfterSeconds: null,
    });
  const match = (pattern: RegExp) => pattern.exec(route);
  try {
    if (route === "attachments/capabilities" && req.method === "GET")
      return respond(
        200,
        await access.run(() =>
          AttachmentCapabilitiesSchema.parse({
            profile: ATTACHMENT_PROFILE,
            scope: access.scope,
            enabled: store.config.enabled,
            storageAvailable: store.available(),
            processingAvailable: false,
            reuseWithinGeneration: true,
            crossGenerationCopy: "upload",
            limits: store.config.limits,
          }),
        ),
      );
    if (route === "attachment-drafts" && req.method === "POST") {
      const body = await jsonBody(req),
        r = await access.run(() => store.createDraft(access.scope, body));
      return respond(r.replay ? 200 : 201, r.draft);
    }
    const draft = match(/^attachment-drafts\/([a-f0-9-]{36})$/);
    if (draft && req.method === "GET")
      return respond(
        200,
        await access.run(() => store.draft(access.scope, draft[1]!)),
      );
    const uploadCreate = match(/^attachment-drafts\/([a-f0-9-]{36})\/uploads$/);
    if (uploadCreate && req.method === "POST") {
      const body = await jsonBody(req),
        r = await access.run(() =>
          store.createUpload(access.scope, uploadCreate[1]!, body),
        );
      return respond(r.replay ? 200 : 201, {
        profile: ATTACHMENT_PROFILE,
        draft: r.draft,
        upload: r.upload,
      });
    }
    const upload = match(/^attachment-uploads\/([a-f0-9-]{36})$/);
    if (upload && req.method === "GET")
      return respond(
        200,
        await access.run(() => store.upload(access.scope, upload[1]!)),
      );
    const put = match(/^attachment-uploads\/([a-f0-9-]{36})\/bytes$/);
    if (put && req.method === "PUT") {
      const c = await access.run(() => {
        store.requireEnabled();
        return store.content(access.scope, put[1]!);
      });
      if (
        req.headers["content-type"] !== "application/octet-stream" ||
        req.headers["content-encoding"] ||
        req.headers.range
      )
        throw new AttachmentError("attachment_invalid");
      if (!req.headers["content-length"])
        throw new AttachmentError("attachment_invalid", 411);
      if (
        !/^[0-9]+$/.test(req.headers["content-length"]) ||
        Number(req.headers["content-length"]) !== c.size
      )
        throw new AttachmentError("attachment_invalid");
      if (c.size > store.config.limits.maxFileBytes)
        throw new AttachmentError("attachment_too_large", 413);
      const release = admission.claim("upload"),
        deadline =
          Date.now() + store.config.limits.uploadDeadlineSeconds * 1000;
      const absolute = setTimeout(
        () => {
          req.destroy();
          res.destroy();
        },
        Math.max(1, deadline - Date.now()),
      );
      let token: string | undefined,
        comparisonOnly = false;
      try {
        const receiving = await access.run(() =>
          store.beginReceive(access.scope, c.id),
        );
        token = receiving.token!;
        comparisonOnly = receiving.transfer === "complete";
        const original = await spoolAttachment(
          req,
          directory,
          token,
          c.size,
          c.sha256,
          c.media_type,
          store.config.limits.uploadDeadlineSeconds,
        );
        if (res.destroyed || Date.now() >= deadline)
          throw new AttachmentError("attachment_unavailable", 503);
        await access.run(() => {
          const current = store.content(access.scope, c.id);
          if (current.token !== token)
            throw new AttachmentError("attachment_stale", 409);
        });
        if (receiving.transfer === "unverified")
          await store.objectStore().get(store.handle(c));
        else if (receiving.transfer !== "complete") {
          await access.run(() => store.markPutting(access.scope, c.id, token!));
          await store.objectStore().put(store.handle(c), original.bytes);
        }
        if (res.destroyed || Date.now() >= deadline)
          throw new AttachmentError("attachment_unavailable", 503);
        await access.run(() =>
          store.finishTransfer(
            access.scope,
            c.id,
            token!,
            undefined,
            original.mediaType,
          ),
        );
        return respond(
          200,
          await access.run(() => store.upload(access.scope, c.id)),
        );
      } catch (error) {
        if (token) store.finishTransfer(access.scope, c.id, token, error);
        if (
          comparisonOnly &&
          error instanceof AttachmentError &&
          error.code === "attachment_integrity"
        )
          throw new AttachmentError("attachment_conflict", 409);
        throw error;
      } finally {
        clearTimeout(absolute);
        release();
      }
    }
    const reference = match(/^attachment-drafts\/([a-f0-9-]{36})\/references$/);
    if (reference && req.method === "POST") {
      const body = await jsonBody(req);
      return respond(
        200,
        await access.run(() =>
          store.reference(access.scope, reference[1]!, body),
        ),
      );
    }
    const remove = match(
      /^attachment-drafts\/([a-f0-9-]{36})\/(?:items\/([a-f0-9-]{36})\/)?remove$/,
    );
    if (remove && req.method === "POST") {
      const body = await jsonBody(req);
      return respond(
        200,
        await access.run(() =>
          store.remove(access.scope, remove[1]!, body, remove[2]),
        ),
      );
    }
    const ingestion = match(/^attachment-ingestions\/([a-f0-9-]{36})$/);
    if (ingestion && req.method === "GET")
      return respond(
        200,
        await access.run(() => ({
          profile: ATTACHMENT_PROFILE,
          processing: store.processing(access.scope, ingestion[1]!),
        })),
      );
    const retry = match(
      /^attachment-ingestions\/([a-f0-9-]{36})\/retry-local$/,
    );
    if (retry && req.method === "POST") {
      const body = await jsonBody(req);
      return await access.run(() =>
        store.retryLocal(access.scope, retry[1]!, body),
      );
    }
    const original = match(/^attachments\/([a-f0-9-]{36})\/original$/);
    if (original && ["GET", "HEAD"].includes(req.method ?? "")) {
      const c = await access.run(() =>
          store.authorizeRead(access.scope, original[1]!),
        ),
        release = admission.claim("download"),
        deadline = Date.now() + 120000;
      try {
        let start = 0,
          end = c.size - 1,
          partial = false;
        if (req.headers.range) {
          const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!m || (!m[1] && !m[2])) {
            res.setHeader("Content-Range", `bytes */${c.size}`);
            return respond(416, {
              error: "attachment_invalid",
              retryable: false,
              retryAfterSeconds: null,
            });
          }
          if (!m[1]) {
            const count = Number(m[2]);
            if (!Number.isSafeInteger(count) || count < 1) {
              res.setHeader("Content-Range", `bytes */${c.size}`);
              return respond(416, {
                error: "attachment_invalid",
                retryable: false,
                retryAfterSeconds: null,
              });
            }
            start = Math.max(0, c.size - count);
          } else {
            start = Number(m[1]);
            end = m[2] ? Math.min(c.size - 1, Number(m[2])) : c.size - 1;
          }
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < 0 ||
            start > end ||
            start >= c.size
          ) {
            res.setHeader("Content-Range", `bytes */${c.size}`);
            return respond(416, {
              error: "attachment_invalid",
              retryable: false,
              retryAfterSeconds: null,
            });
          }
          partial = true;
        }
        const bytes =
          req.method === "HEAD"
            ? (await store.objectStore().head(store.handle(c)), undefined)
            : partial
              ? await store.objectStore().range(store.handle(c), { start, end })
              : await store.objectStore().get(store.handle(c));
        await access.run(() => store.authorizeRead(access.scope, c.id));
        res.writeHead(partial ? 206 : 200, {
          "Content-Type": "application/octet-stream",
          "Content-Disposition": `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(c.filename).replace(/['()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`)}`,
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
          ...(partial
            ? { "Content-Range": `bytes ${start}-${end}/${c.size}` }
            : {}),
        });
        if (Date.now() >= deadline)
          throw new AttachmentError("attachment_unavailable", 503);
        for (let n = 0; bytes && n < bytes.length; n += 65536) {
          if (res.destroyed || Date.now() >= deadline)
            throw new AttachmentError("attachment_unavailable", 503);
          await access.run(() => store.authorizeRead(access.scope, c.id));
          if (!res.write(bytes.subarray(n, n + 65536))) {
            const controller = new AbortController(),
              closed = () => controller.abort();
            res.once("close", closed);
            const timeout = setTimeout(
              () => controller.abort(),
              Math.min(15000, Math.max(1, deadline - Date.now())),
            );
            try {
              await once(res, "drain", { signal: controller.signal });
            } finally {
              clearTimeout(timeout);
              res.off("close", closed);
            }
          }
        }
        res.end();
        return;
      } catch (error) {
        if (res.headersSent) {
          res.destroy();
          return;
        }
        throw error;
      } finally {
        release();
      }
    }
    return respond(405, { error: "method_not_allowed" });
  } catch (error) {
    const safe = attachmentStorageError(error);
    return respond(safe.status, safe.body);
  }
}
