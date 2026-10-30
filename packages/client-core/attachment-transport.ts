import { z } from "zod";
import {
  ATTACHMENT_PROFILE,
  AttachmentCapabilitiesSchema,
  AttachmentDraftSchema,
  AttachmentUploadCreatedSchema,
  AttachmentUploadSchema,
  AttachmentProcessingResponseSchema,
  AttachmentFailureSchema,
  AttachmentUuidSchema,
  type AttachmentCapabilities,
  type AttachmentDraft,
  type AttachmentUpload,
} from "../protocol/attachments";

export class AttachmentClientError extends Error {
  constructor(
    readonly code: string,
    readonly retryable = false,
    readonly status = 0,
    /** A closed attachment failure DTO, distinct from an uncorrelated HTTP error. */
    readonly knownFailure = false,
  ) {
    super(code);
  }
}
export type AttachmentOpen = (
  path: string,
  init: RequestInit,
  timeoutMs: number,
) => Promise<{
  response: Response;
  done: () => void;
}>;
const route = (path: string) =>
  `${path}?profile=${encodeURIComponent(ATTACHMENT_PROFILE)}`;
const id = (value: string) => AttachmentUuidSchema.parse(value);
/** Only authenticated Niaro routes. No storage locations, credentials or redirects escape this port. */
export class AttachmentTransport {
  constructor(private open: AttachmentOpen) {}
  private async json<T>(
    path: string,
    schema: z.ZodType<T>,
    signal: AbortSignal,
    body?: unknown,
    method = "POST",
  ): Promise<T> {
    const { response, done } = await this.open(
      route(path),
      {
        signal,
        method: body === undefined ? "GET" : method,
        ...(body === undefined
          ? {}
          : {
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            }),
      },
      30_000,
    );
    try {
      const text = await response.text();
      if (text.length > 16_384)
        throw new AttachmentClientError("attachment_invalid");
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const failure = AttachmentFailureSchema.safeParse(value);
        throw new AttachmentClientError(
          failure.success ? failure.data.error : "attachment_unavailable",
          failure.success &&
            failure.data.retryable &&
            failure.data.error !== "attachment_uncertain",
          response.status,
          failure.success,
        );
      }
      return schema.parse(value);
    } finally {
      done();
    }
  }
  async capabilities(
    signal: AbortSignal,
  ): Promise<AttachmentCapabilities | null> {
    try {
      return await this.json(
        "attachments/capabilities",
        AttachmentCapabilitiesSchema,
        signal,
      );
    } catch (error) {
      if (
        error instanceof AttachmentClientError &&
        [404, 406].includes(error.status)
      )
        return null;
      throw error;
    }
  }
  createDraft(body: unknown, signal: AbortSignal) {
    return this.json("attachment-drafts", AttachmentDraftSchema, signal, body);
  }
  draft(draftId: string, signal: AbortSignal) {
    return this.json(
      `attachment-drafts/${id(draftId)}`,
      AttachmentDraftSchema,
      signal,
    );
  }
  createUpload(draftId: string, body: unknown, signal: AbortSignal) {
    return this.json(
      `attachment-drafts/${id(draftId)}/uploads`,
      AttachmentUploadCreatedSchema,
      signal,
      body,
    );
  }
  async put(
    upload: AttachmentUpload,
    bytes: Uint8Array,
    signal: AbortSignal,
    deadline: number,
  ) {
    const { response, done } = await this.open(
      route(`attachment-uploads/${id(upload.uploadId)}/bytes`),
      {
        method: "PUT",
        signal,
        headers: { "Content-Type": "application/octet-stream" },
        // fetch sets Content-Length from this exact body on web and native; browser forbids setting it manually.
        body: bytes.slice().buffer,
      },
      deadline * 1000,
    );
    try {
      const text = await response.text();
      if (text.length > 8192)
        throw new AttachmentClientError("attachment_invalid");
      const value: unknown = JSON.parse(text);
      if (!response.ok) {
        const failure = AttachmentFailureSchema.safeParse(value);
        throw new AttachmentClientError(
          failure.success ? failure.data.error : "attachment_unavailable",
          failure.success &&
            failure.data.retryable &&
            failure.data.error !== "attachment_uncertain",
          response.status,
        );
      }
      return AttachmentUploadSchema.parse(value);
    } finally {
      done();
    }
  }
  upload(uploadId: string, signal: AbortSignal) {
    return this.json(
      `attachment-uploads/${id(uploadId)}`,
      AttachmentUploadSchema,
      signal,
    );
  }
  reference(draftId: string, body: unknown, signal: AbortSignal) {
    return this.json(
      `attachment-drafts/${id(draftId)}/references`,
      AttachmentDraftSchema,
      signal,
      body,
    );
  }
  remove(
    draftId: string,
    contentId: string | null,
    body: unknown,
    signal: AbortSignal,
  ) {
    return this.json(
      `attachment-drafts/${id(draftId)}/${contentId ? `items/${id(contentId)}/remove` : "remove"}`,
      AttachmentDraftSchema,
      signal,
      body,
    );
  }
  processing(ingestionId: string, signal: AbortSignal) {
    return this.json(
      `attachment-ingestions/${id(ingestionId)}`,
      AttachmentProcessingResponseSchema,
      signal,
    );
  }
  retryLocal(ingestionId: string, body: unknown, signal: AbortSignal) {
    return this.json(
      `attachment-ingestions/${id(ingestionId)}/retry-local`,
      AttachmentProcessingResponseSchema,
      signal,
      body,
    );
  }
  async original(
    contentId: string,
    size: number,
    signal: AbortSignal,
  ): Promise<Uint8Array> {
    const { response, done } = await this.open(
      route(`attachments/${id(contentId)}/original`),
      { signal },
      120_000,
    );
    try {
      if (
        !response.ok ||
        response.headers.get("content-type")?.split(";")[0] !==
          "application/octet-stream"
      )
        throw new AttachmentClientError("attachment_unavailable");
      // Bound downloads even when a response lies about Content-Length. Native fetch may not expose streams.
      if (response.body?.getReader) {
        const reader = response.body.getReader();
        const result = new Uint8Array(size);
        let offset = 0;
        try {
          while (true) {
            const { value, done: ended } = await reader.read();
            if (ended) break;
            if (signal.aborted || offset + value.length > size)
              throw new AttachmentClientError("attachment_integrity");
            result.set(value, offset);
            offset += value.length;
          }
          if (offset !== size)
            throw new AttachmentClientError("attachment_integrity");
          return result;
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      if (Number(response.headers.get("content-length")) !== size)
        throw new AttachmentClientError("attachment_integrity");
      const result = new Uint8Array(await response.arrayBuffer());
      if (result.length !== size)
        throw new AttachmentClientError("attachment_integrity");
      return result;
    } finally {
      done();
    }
  }
}
export type { AttachmentCapabilities, AttachmentDraft, AttachmentUpload };
