import { createServer } from "node:http";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import {
  ATTACHMENT_PROFILE,
  ATTACHMENT_DEFAULT_LIMITS,
  type AttachmentDraft,
  type AttachmentUpload,
} from "../../packages/protocol/attachments";
import { FixtureEngine } from "../../apps/fixture-server/engine";
import { credential, authInfo } from "../auth-fixtures";
/** Isolated synthetic HTTP contract fixture. Tests use the real ClientSession/attachment runtime and never a replacement client state machine. */
export async function attachmentClientHttp() {
  const actor = credential();
  const engine = new FixtureEngine();
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const drafts = new Map<string, AttachmentDraft>();
  const uploads = new Map<string, AttachmentUpload>();
  const bytes = new Map<string, Uint8Array>();
  const mutations = new Map<string, unknown>();
  const generation = randomUUID();
  let enabled = true,
    supported = true,
    commands = 0,
    puts = 0;
  let putState: AttachmentUpload["state"] = "complete";
  let pausePut: Promise<void> | undefined;
  const snapshot = engine.snapshot();
  snapshot.scope = actor.scope;
  snapshot.conversations = [
    {
      id: "conversation-1",
      revision: 1,
      attachmentGeneration: generation,
      messages: [],
    },
  ];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://fixture");
    const path = url.pathname.replace(/^\/v1\/a\//, "");
    const method = req.method!;
    const reply = (body: unknown, status = 200) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path === "evidence") return reply({ calls, puts, commands });
    if (path === "bootstrap") return reply({ actor, generation });
    if (path === "auth/session") return reply(authInfo(actor));
    if (req.headers.authorization !== `Bearer ${actor.accessToken}`)
      return reply({ error: "auth_expired" }, 401);
    if (
      path.startsWith("attachment") &&
      (url.searchParams.size !== 1 ||
        url.searchParams.get("profile") !== ATTACHMENT_PROFILE)
    )
      return reply({ error: "attachment_profile_required" }, 406);
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    const body =
      raw.length && !path.endsWith("/bytes")
        ? JSON.parse(raw.toString())
        : undefined;
    calls.push({ method, path: req.url!, ...(body ? { body } : {}) });
    if (path === "attachments/capabilities")
      return supported
        ? reply({
            profile: ATTACHMENT_PROFILE,
            scope: actor.scope,
            enabled,
            storageAvailable: true,
            processingAvailable: false,
            reuseWithinGeneration: true,
            crossGenerationCopy: "upload",
            limits: ATTACHMENT_DEFAULT_LIMITS,
          })
        : reply({ error: "not_found" }, 404);
    const summary = {
      id: "conversation-1",
      revision: 1,
      title: "TEST attachments",
      createdAt: "2026-10-30T00:00:00.000Z",
      updatedAt: "2026-10-30T00:00:00.000Z",
      messageCount: snapshot.conversations[0]!.messages.length,
      readOnly: false,
      attachmentGeneration: generation,
    };
    if (path === "conversations/messages")
      return reply({
        profile: "agent-conversations/1",
        scope: actor.scope,
        conversation: summary,
        messages: snapshot.conversations[0]!.messages,
        nextAfter: null,
      });
    if (path === "conversations")
      return reply({
        profile: "agent-conversations/1",
        scope: actor.scope,
        conversations: [summary],
        nextAfter: null,
      });
    if (path === "mentions")
      return reply({ profile: "agent-mentions/1", items: [] });
    if (path === "voice")
      return reply({
        profile: "agent-voice/5",
        enabled: false,
        languages: ["en", "cs"],
        maxSeconds: 120,
        engine: "whisper.cpp",
        model: null,
        processing: "local",
      });
    if (path === "voice/speech")
      return reply({
        profile: "agent-speech/1",
        enabled: false,
        model: null,
        processing: "cloud",
        maxTextLength: 2000,
      });
    if (path === "snapshot") return reply(snapshot);
    if (path === "events")
      return reply({ scope: actor.scope, cursor: snapshot.cursor, events: [] });
    if (path === "commands") {
      commands++;
      const existing = mutations.get(body.commandId);
      if (existing) return reply(existing);
      if (body.attachments) {
        const draft = drafts.get(body.attachments.draftId)!;
        if (!draft || draft.state !== "open")
          return reply({
            commandId: body.commandId,
            status: "rejected",
            code: "unknown_context",
            snapshot,
          });
        draft.state = "consumed";
        snapshot.conversations[0]!.messages.push({
          id: body.commandId,
          role: "user",
          text: body.text,
          attachments: draft.items,
          processing: {
            ingestionId: randomUUID(),
            attempt: 1,
            version: 1,
            state: "blocked_capability",
            failure: "attachment_processing_unavailable",
          },
        });
      }
      const result = {
        commandId: body.commandId,
        status: "accepted",
        code: "accepted",
        snapshot,
      };
      mutations.set(body.commandId, result);
      return reply(result);
    }
    if (body?.requestId && mutations.has(body.requestId))
      return reply(mutations.get(body.requestId));
    if (path === "attachment-drafts" && method === "POST") {
      const draft: AttachmentDraft = {
        profile: ATTACHMENT_PROFILE,
        draftId: randomUUID(),
        target: body.target,
        generation,
        revision: 1,
        state: "open",
        expiresAt: "2099-01-01T00:00:00.000Z",
        items: [],
      };
      drafts.set(draft.draftId, draft);
      mutations.set(body.requestId, draft);
      return reply(draft, 201);
    }
    const d = /^attachment-drafts\/([^/]+)(?:\/(.*))?$/.exec(path);
    if (d) {
      const draft = drafts.get(d[1]!)!;
      if (!draft)
        return reply(
          {
            error: "attachment_unavailable",
            retryable: false,
            retryAfterSeconds: null,
          },
          404,
        );
      if (!d[2]) return reply(draft);
      if (d[2] === "uploads") {
        const contentId = randomUUID();
        const upload: AttachmentUpload = {
          profile: ATTACHMENT_PROFILE,
          uploadId: contentId,
          contentId,
          state: "created",
          size: body.size,
          sha256: body.sha256,
          receivedBytes: 0,
          expiresAt: draft.expiresAt,
          failure: null,
        };
        uploads.set(contentId, upload);
        draft.revision++;
        draft.items.push({
          contentId,
          filename: body.filename,
          mediaType: body.mediaType,
          size: body.size,
          sha256: body.sha256,
          availability: "unavailable",
        });
        const result = { profile: ATTACHMENT_PROFILE, draft, upload };
        mutations.set(body.requestId, result);
        return reply(result, 201);
      }
      if (d[2] === "references") {
        const file = snapshot.conversations[0]!.messages.find(
          (message) => message.id === body.source.messageId,
        )?.attachments?.find(
          (file) => file.contentId === body.source.contentId,
        );
        if (!file)
          return reply(
            {
              error: "attachment_unavailable",
              retryable: false,
              retryAfterSeconds: null,
            },
            404,
          );
        draft.items.push(file);
        draft.revision++;
        mutations.set(body.requestId, draft);
        return reply(draft);
      }
      const remove = /^items\/([^/]+)\/remove$/.exec(d[2]!);
      if (remove) {
        draft.items = draft.items.filter(
          (file) => file.contentId !== remove[1],
        );
        draft.revision++;
        mutations.set(body.requestId, draft);
        return reply(draft);
      }
    }
    const u = /^attachment-uploads\/([^/]+)(\/bytes)?$/.exec(path);
    if (u) {
      const upload = uploads.get(u[1]!)!;
      if (u[2] && method === "PUT") {
        puts++;
        if (pausePut) await pausePut;
        if (
          raw.length !== upload.size ||
          createHash("sha256").update(raw).digest("hex") !== upload.sha256
        )
          return reply(
            {
              error: "attachment_integrity",
              retryable: false,
              retryAfterSeconds: null,
            },
            503,
          );
        upload.state = putState;
        upload.receivedBytes = raw.length;
        bytes.set(upload.contentId, raw);
        for (const draft of drafts.values())
          for (const file of draft.items)
            if (file.contentId === upload.contentId && putState === "complete")
              file.availability = "available";
      }
      return reply(upload);
    }
    const original = /^attachments\/([^/]+)\/original$/.exec(path);
    if (original && bytes.has(original[1]!)) {
      const content = bytes.get(original[1]!)!;
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": content.length,
        "Content-Disposition": "attachment",
      });
      return res.end(content);
    }
    reply({ error: "not_found" }, 404);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture_address");
  return {
    address: `http://127.0.0.1:${address.port}/v1/a`,
    actor,
    generation,
    snapshot,
    calls,
    drafts,
    uploads,
    get puts() {
      return puts;
    },
    get commands() {
      return commands;
    },
    setEnabled: (value: boolean) => {
      enabled = value;
    },
    setSupported: (value: boolean) => {
      supported = value;
    },
    setPutState: (value: AttachmentUpload["state"]) => {
      putState = value;
    },
    holdPut: (value?: Promise<void>) => {
      pausePut = value;
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
