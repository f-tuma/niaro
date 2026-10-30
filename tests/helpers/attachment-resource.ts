import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { get, type IncomingMessage } from "node:http";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import type { StorageConfig } from "../../apps/server-storage/types";
import { sha256 } from "../../apps/server-storage/types";
import { ATTACHMENT_PROFILE } from "../../packages/protocol/attachments";
import { ClientSession } from "../../packages/client-core/session";
import type { Credential } from "../../packages/protocol";
import { PROCESS_QUESTION_EXECUTION_PROFILE } from "../../packages/protocol/process-questions";
import {
  MEETING_PROFILE,
  type MeetingCreate,
} from "../../packages/protocol/meetings";
export async function measureAttachmentResources(config: StorageConfig) {
  const child = fork(
    resolve("tests/helpers/attachment-resource-worker.ts"),
    [],
    { execArgv: ["--import", "tsx"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  child.stdout?.resume();
  child.stderr?.resume();
  let id = 0;
  const pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  child.on("message", (raw: any) => {
    const p = pending.get(raw.id);
    if (!p) return;
    pending.delete(raw.id);
    if (raw.error) p.reject(Error(raw.error));
    else p.resolve(raw.value);
  });
  const rpc = <T>(method: string, extra: Record<string, unknown> = {}) =>
    new Promise<T>((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject });
      child.send({ id: n, method, ...extra });
    });
  let stalledResponse: IncomingMessage | undefined;
  let client: ClientSession | undefined;
  let stalled: ReturnType<typeof get> | undefined;
  try {
    const env = {
      NIARO_S3_ENDPOINT: config.endpoint,
      NIARO_S3_REGION: config.region,
      NIARO_S3_BUCKET: config.bucket,
      NIARO_S3_PREFIX: config.prefix,
      NIARO_S3_FORCE_PATH_STYLE: "true",
      NIARO_S3_ALLOW_HTTP: "true",
      NIARO_S3_CREDENTIAL_MODE: "static",
      NIARO_S3_ACCESS_KEY_ID: config.credentials!.accessKeyId,
      NIARO_S3_SECRET_ACCESS_KEY: config.credentials!.secretAccessKey,
    };
    const setup = await rpc<{
      endpoint: string;
      credential: Credential;
      processCommand: unknown;
    }>("start", { env });
    const endpoint = setup.endpoint,
      token = setup.credential.accessToken,
      q = "?profile=" + encodeURIComponent(ATTACHMENT_PROFILE),
      neg =
        "?attachments=" +
        encodeURIComponent(ATTACHMENT_PROFILE) +
        "&chats=agent-conversation-projection%2F1";
    const req = (path: string, body?: unknown) =>
      fetch(endpoint + "/" + path, {
        method: body ? "POST" : "GET",
        headers: {
          Authorization: "Bearer " + token,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    const bytes = Buffer.alloc(25 * 1024 * 1024, 65),
      digest = sha256(bytes);
    async function upload(id: string) {
      const d = await req("attachment-drafts" + q, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        target: {
          conversationId: id,
          expectedGeneration: null,
          mode: "current",
        },
      });
      assert.equal(d.status, 201);
      const draft = await d.json();
      const create = await req("commands" + neg, {
        type: "conversation.create",
        commandId: "create-" + id,
        idempotencyKey: "create-" + id,
        conversationId: id,
      });
      assert.equal(create.status, 202);
      const u = await req(
        "attachment-drafts/" + draft.draftId + "/uploads" + q,
        {
          profile: ATTACHMENT_PROFILE,
          requestId: randomUUID(),
          expectedRevision: 1,
          filename: "synthetic-25m.txt",
          mediaType: "text/plain",
          size: bytes.length,
          sha256: digest,
        },
      );
      assert.equal(u.status, 201);
      const created = await u.json();
      const put = () =>
        fetch(
          endpoint +
            "/attachment-uploads/" +
            created.upload.uploadId +
            "/bytes" +
            q,
          {
            method: "PUT",
            headers: {
              Authorization: "Bearer " + token,
              "Content-Type": "application/octet-stream",
              "Content-Length": String(bytes.length),
            },
            body: bytes,
          },
        );
      return { contentId: created.upload.contentId, put };
    }
    const first = await upload("TEST-resource-a");
    const begin = performance.now();
    assert.equal((await first.put()).status, 200);
    const initialUploadMs = performance.now() - begin;
    const url = endpoint + "/attachments/" + first.contentId + "/original" + q;
    await new Promise<void>((ok, reject) => {
      stalled = get(
        url,
        { headers: { Authorization: "Bearer " + token } },
        (res) => {
          assert.equal(res.statusCode, 200);
          stalledResponse = res;
          res.pause();
          ok();
        },
      );
      stalled.on("error", () => {});
      setTimeout(reject, 10000, Error("stalled download failed")).unref();
    });
    const busy = await req("attachments/" + first.contentId + "/original" + q);
    assert.equal(busy.status, 429);
    const second = await upload("TEST-resource-b");
    const concurrentStart = performance.now(),
      secondPut = second.put();
    client = new ClientSession(
      endpoint,
      { getItem: async () => null, setItem: async () => {} },
      setup.credential,
    );
    const meeting: MeetingCreate = {
      profile: MEETING_PROFILE,
      id: randomUUID(),
      title: "SYNTHETIC coexistence",
      recordedAt: new Date().toISOString(),
      language: "en" as const,
      mimeType: "audio/wav" as const,
      bytes: 1024 * 1024,
    };
    const meetingStart = performance.now();
    await client.createMeeting(meeting);
    for (let n = 0; n < 4; n++)
      await client.uploadMeetingBlock(
        meeting.id,
        n * 262144,
        new Uint8Array(262144),
      );
    await client.sealMeeting(meeting.id);
    const meetingUploadMs = performance.now() - meetingStart;
    const modelStart = performance.now(),
      model = await req(
        "processes/commands?profile=" +
          encodeURIComponent(PROCESS_QUESTION_EXECUTION_PROFILE),
        setup.processCommand,
      );
    assert.ok([200, 202].includes(model.status), await model.clone().text());
    const modelMs = performance.now() - modelStart;
    assert.equal((await secondPut).status, 200);
    const concurrentUploadMs = performance.now() - concurrentStart;
    const stats = await rpc<any>("stats");
    assert.ok(stats.modelCalls > 0);
    assert.equal(stats.businessCalls, 0);
    await rpc("revoke");
    let revokedReadBytes = 0;
    const truncated = await new Promise<boolean>((ok, reject) => {
      const timeout = setTimeout(
        () => reject(Error("revoked read did not stop")),
        5000,
      );
      const finish = (value: boolean) => {
        clearTimeout(timeout);
        ok(value);
      };
      stalledResponse!.on("data", (b) => {
        revokedReadBytes += b.length;
      });
      stalledResponse!.once("aborted", () => finish(true));
      stalledResponse!.once("error", () => finish(true));
      stalledResponse!.once("end", () => finish(false));
      stalledResponse!.resume();
    });
    assert.equal(truncated, true);
    assert.ok(revokedReadBytes < bytes.length);
    stalled?.destroy();
    stalled = undefined;
    return {
      revokedReadTruncated: truncated,
      revokedReadBytes,

      initialUploadMs,
      concurrentUploadMs,
      meetingUploadMs,
      modelMs,
      modelProviderCalls: stats.modelCalls,
      businessCalls: stats.businessCalls,
      applicationPeakBytes: stats.peak,
      spoolPeakBytes: stats.spoolPeak,
      callerPayloadBytes: bytes.length,
      logicalMaximumCoexistenceBytes: 50 * 1024 * 1024,
      downloadBusyStatus: busy.status,
      applicationCapBytes: 2 * 1024 * 1024 * 1024,
      rssHeadroomBytes: 2 * 1024 * 1024 * 1024 - stats.peak.rss,
      qualification:
        "isolated application process; separate RustFS; synthetic current meeting upload and native process model traffic; no converter/OCR/model image activation; OS page cache not attributed",
    };
  } finally {
    stalled?.destroy();
    client?.stop();
    try {
      await rpc("close");
    } finally {
      child.kill("SIGKILL");
    }
  }
}
