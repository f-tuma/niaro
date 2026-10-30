import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  CommandResultSchema,
} from "../packages/protocol";
import {
  AttachmentCapabilitiesSchema,
  AttachmentDraftSchema,
  AttachmentUploadCreatedSchema,
  ATTACHMENT_PROFILE,
} from "../packages/protocol/attachments";
import { syntheticS3 } from "./helpers/storage-s3";
const query = `?profile=${encodeURIComponent(ATTACHMENT_PROFILE)}`;
const negotiated = `?chats=agent-conversation-projection%2F1&attachments=${encodeURIComponent(ATTACHMENT_PROFILE)}`;
const digest = (b: Buffer) => createHash("sha256").update(b).digest("hex");
async function setup(enabled = true, limits: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "niaro-attachments-http-")),
    s3 = await syntheticS3();
  let calls = 0;
  const server = createFixtureServer(dir, undefined, {
    objectStorage: { state: "configured", config: s3.config },
    attachments: loadAttachmentConfiguration({
      NIARO_ATTACHMENTS_ENABLED: String(enabled),
      ...limits,
    }),
    model: {
      timeZone: "UTC",
      decide: async () => {
        calls++;
        throw Error("PROVIDER_FORBIDDEN");
      },
    },
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/a`;
  async function pair(user = "alice") {
    const r = await fetch(`${base}/auth/pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authProfile: AUTH_PROFILE,
        profile: PROFILE,
        code: issuePairingCode(dir, user, "a"),
      }),
    });
    return CredentialSchema.parse(await r.json()).accessToken;
  }
  const token = await pair();
  const request = (
    path: string,
    body?: unknown,
    method = body ? "POST" : "GET",
    credential = token,
    headers: Record<string, string> = {},
  ) =>
    fetch(base + "/" + path, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  const draft = async (conversationId = "chat-files") => {
    const input = {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: { conversationId, expectedGeneration: null, mode: "current" },
    };
    const r = await request("attachment-drafts" + query, input);
    assert.equal(r.status, 201, await r.clone().text());
    return AttachmentDraftSchema.parse(await r.json());
  };
  return {
    dir,
    s3,
    server,
    base,
    token,
    pair,
    request,
    draft,
    calls: () => calls,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((ok) => server.close(() => ok()));
      await s3.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("real HTTP retention accepts once, negotiates before effects, replays receipts and serves only authorized original bytes", async () => {
  const h = await setup();
  try {
    const caps = AttachmentCapabilitiesSchema.parse(
      await (await h.request("attachments/capabilities" + query)).json(),
    );
    assert.equal(caps.enabled, true);
    assert.equal(caps.processingAvailable, false);
    assert.equal((await h.request("attachments/capabilities")).status, 406);
    assert.equal(
      (
        await h.request(
          "attachments/capabilities" + query + "&profile=agent-attachments%2F1",
        )
      ).status,
      406,
    );
    const draft = await h.draft(),
      bytes = Buffer.from("synthetic original evidence");
    const upload = await h.request(
      `attachment-drafts/${draft.draftId}/uploads${query}`,
      {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "evidence.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: digest(bytes),
      },
    );
    assert.equal(upload.status, 201, await upload.clone().text());
    const created = AttachmentUploadCreatedSchema.parse(await upload.json());
    const put = () =>
      fetch(
        `${h.base}/attachment-uploads/${created.upload.uploadId}/bytes${query}`,
        {
          method: "PUT",
          headers: {
            Authorization: `Bearer ${h.token}`,
            "Content-Type": "application/octet-stream",
            "Content-Length": String(bytes.length),
          },
          body: bytes,
        },
      );
    assert.equal((await put()).status, 200);
    assert.equal((await put()).status, 200);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
    assert.deepEqual(readdirSync(join(h.dir, "attachment-spool")), []);
    const create = {
      type: "conversation.create",
      commandId: "create-files",
      idempotencyKey: "create-files",
      conversationId: "chat-files",
    };
    assert.equal(
      (await h.request("commands" + negotiated, create)).status,
      202,
    );
    const send = {
      type: "message.send",
      commandId: "send-files",
      idempotencyKey: "send-files",
      conversationId: "chat-files",
      language: "en",
      text: "",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: draft.draftId,
        draftRevision: created.draft.revision,
        generation: draft.generation,
        items: [{ contentId: created.upload.contentId, sha256: digest(bytes) }],
      },
    };
    assert.equal((await h.request("commands", send)).status, 406);
    const accepted = await h.request("commands" + negotiated, send);
    assert.equal(accepted.status, 202, await accepted.clone().text());
    const result = CommandResultSchema.parse(await accepted.json()),
      conversation = result.snapshot.conversations.find(
        (c) => c.id === "chat-files",
      )!;
    assert.equal(conversation.messages.length, 1);
    assert.equal(
      conversation.messages[0]!.processing?.state,
      "blocked_capability",
    );
    assert.equal(h.calls(), 0);
    const processing = conversation.messages[0]!.processing!,
      retryPath = `attachment-ingestions/${processing.ingestionId}/retry-local${query}`,
      retry = {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedAttempt: processing.attempt,
        expectedVersion: processing.version,
      };
    assert.equal(
      (await h.request(retryPath, { ...retry, expectedVersion: 999 })).status,
      409,
    );
    assert.equal((await h.request(retryPath, retry)).status, 503);
    assert.equal(
      (await h.request(retryPath, { ...retry, extra: true })).status,
      400,
    );
    assert.equal((await put()).status, 200);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
    const repeat = await h.request("commands" + negotiated, send);
    assert.equal(repeat.status, 202);
    assert.equal(
      CommandResultSchema.parse(
        await repeat.json(),
      ).snapshot.conversations.find((c) => c.id === "chat-files")!.messages
        .length,
      1,
    );
    assert.equal(
      (await h.request("snapshot?conversationId=chat-files")).status,
      406,
    );
    assert.equal((await h.request("events?after=0")).status, 406);
    assert.equal(
      (
        await h.request("commands", {
          type: "conversation.rename",
          commandId: "old-client-rename",
          idempotencyKey: "old-client-rename",
          conversationId: "chat-files",
          title: "must not commit",
        })
      ).status,
      406,
    );
    assert.equal(
      (
        await h.request("commands" + negotiated, {
          type: "conversation.rename",
          commandId: "old-client-rename",
          idempotencyKey: "old-client-rename",
          conversationId: "chat-files",
          title: "negotiated rename commits",
        })
      ).status,
      202,
    );
    const path = `attachments/${created.upload.contentId}/original${query}`;
    const download = await h.request(path);
    assert.equal(download.status, 200);
    assert.equal(
      download.headers.get("content-type"),
      "application/octet-stream",
    );
    assert.match(download.headers.get("content-disposition")!, /^attachment;/);
    assert.equal(await download.text(), bytes.toString());
    const range = await h.request(path, undefined, "GET", h.token, {
      Range: "bytes=-8",
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), bytes.subarray(-8).toString());
    assert.equal((await h.request(path, undefined, "HEAD")).status, 200);
    assert.equal(
      (
        await h.request(path, undefined, "GET", h.token, {
          Range: "bytes=0-1,3-4",
        })
      ).status,
      416,
    );
    assert.equal(
      (await h.request(path, undefined, "GET", await h.pair("bob"))).status,
      404,
    );
    assert.equal(h.calls(), 0);
  } finally {
    await h.close();
  }
});
test("default off and raw duplicate JSON keys refuse mutation without provider or S3 calls", async () => {
  const h = await setup(false);
  try {
    const r = await h.request("attachment-drafts" + query, {
      profile: ATTACHMENT_PROFILE,
      requestId: randomUUID(),
      target: {
        conversationId: "chat-new",
        expectedGeneration: null,
        mode: "current",
      },
    });
    assert.equal(r.status, 503);
    assert.equal(h.s3.calls.length, 0);
    assert.equal(h.calls(), 0);
    const duplicate = await fetch(h.base + "/attachment-drafts" + query, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${h.token}`,
        "Content-Type": "application/json",
      },
      body: '{"profile":"agent-attachments/1","profile":"agent-attachments/1"}',
    });
    assert.equal(duplicate.status, 400);
  } finally {
    await h.close();
  }
});

test("simultaneous last-slot HTTP reservations admit one upload and reserve no partial losing handle", async () => {
  const h = await setup(true, {
    NIARO_ATTACHMENTS_MAX_FILE_BYTES: "1",
    NIARO_ATTACHMENTS_MAX_MESSAGE_BYTES: "1",
    NIARO_ATTACHMENTS_MAX_MESSAGE_FILES: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_FILES_PER_OWNER: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_FILES_GLOBAL: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_BYTES_PER_OWNER: "1",
    NIARO_ATTACHMENTS_MAX_STAGED_BYTES_GLOBAL: "1",
  });
  try {
    const drafts = await Promise.all([
      h.draft("TEST-race-a"),
      h.draft("TEST-race-b"),
    ]);
    const responses = await Promise.all(
      drafts.map((d) =>
        h.request(`attachment-drafts/${d.draftId}/uploads${query}`, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          expectedRevision: 1,
          filename: "one.txt",
          mediaType: "text/plain",
          size: 1,
          sha256: digest(Buffer.from("x")),
        }),
      ),
    );
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 429]);
    assert.equal(h.s3.calls.length, 0);
    assert.equal(h.calls(), 0);
  } finally {
    await h.close();
  }
});

test("LIR-1: rejected and aborted comparison retries preserve a consumed verified original and one remote PUT", async () => {
  const { request: rawRequest } = await import("node:http"),
    { setTimeout: delay } = await import("node:timers/promises");
  const h = await setup();
  try {
    const d = await h.draft(),
      bytes = Buffer.from("synthetic immutable original");
    const created = AttachmentUploadCreatedSchema.parse(
      await (
        await h.request(`attachment-drafts/${d.draftId}/uploads${query}`, {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          expectedRevision: 1,
          filename: "retained.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256: digest(bytes),
        })
      ).json(),
    );
    const url = `${h.base}/attachment-uploads/${created.upload.uploadId}/bytes${query}`,
      headers = {
        Authorization: `Bearer ${h.token}`,
        "Content-Type": "application/octet-stream",
        "Content-Length": String(bytes.length),
      },
      put = (body: Buffer) =>
        fetch(url, { method: "PUT", headers, body: new Uint8Array(body) });
    assert.equal((await put(bytes)).status, 200);
    assert.equal(
      (
        await h.request("commands" + negotiated, {
          type: "conversation.create",
          commandId: "LIR1-create",
          idempotencyKey: "LIR1-create",
          conversationId: "chat-files",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await h.request("commands" + negotiated, {
          type: "message.send",
          commandId: "LIR1-send",
          idempotencyKey: "LIR1-send",
          conversationId: "chat-files",
          language: "en",
          text: "",
          attachments: {
            profile: ATTACHMENT_PROFILE,
            draftId: d.draftId,
            draftRevision: created.draft.revision,
            generation: d.generation,
            items: [
              { contentId: created.upload.contentId, sha256: digest(bytes) },
            ],
          },
        })
      ).status,
      202,
    );
    const path = `attachments/${created.upload.contentId}/original${query}`,
      assertRetained = async () => {
        const status = await (
          await h.request(
            `attachment-uploads/${created.upload.uploadId}${query}`,
          )
        ).json();
        assert.equal(status.state, "complete");
        assert.equal(status.receivedBytes, bytes.length);
        assert.equal(status.failure, null);
        assert.equal((await h.request(path, undefined, "HEAD")).status, 200);
        const read = await h.request(path);
        assert.equal(read.status, 200);
        assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
      };
    const rejected = await put(Buffer.alloc(bytes.length, 120));
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error, "attachment_conflict");
    await assertRetained();
    assert.equal((await put(bytes)).status, 200);
    const aborted = rawRequest(url, { method: "PUT", headers });
    aborted.on("error", () => {});
    aborted.write(bytes.subarray(0, 5));
    const spool = join(h.dir, "attachment-spool"),
      deadline = Date.now() + 2000;
    while (!readdirSync(spool).length && Date.now() < deadline) await delay(5);
    assert.ok(readdirSync(spool).length);
    assert.equal((await put(bytes)).status, 429);
    aborted.destroy();
    while (readdirSync(spool).length && Date.now() < deadline) await delay(5);
    assert.deepEqual(readdirSync(spool), []);
    await assertRetained();
    assert.equal((await put(bytes)).status, 200);
    assert.equal(h.s3.calls.filter((c) => c.method === "PUT").length, 1);
    assert.equal(h.calls(), 0);
  } finally {
    await h.close();
  }
});
