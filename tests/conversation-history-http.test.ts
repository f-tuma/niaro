import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { VOICE_PROFILE, VoiceResultSchema } from "../packages/protocol/voice";
import {
  AUTH_PROFILE,
  PROFILE,
  CONVERSATION_HISTORY_PROFILE,
  CONVERSATION_PROJECTION_PROFILE,
  CredentialSchema,
  ConversationHistoryPageSchema,
  ConversationMessagePageSchema,
} from "../packages/protocol";

const json = (port: number, path: string, token?: string, body?: unknown) =>
  new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method: body ? "POST" : "GET",
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (c) => {
          text += String(c);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, body: JSON.parse(text) }),
        );
      },
    );
    req.setTimeout(2000, () => req.destroy(new Error(`TEST timeout ${path}`)));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });

test("real isolated HTTP history negotiates explicitly, pages authorized chats, preserves scope and refuses unsupported creation", async () => {
  const directory = mkdtempSync(join(tmpdir(), "TEST-history-http-"));
  const transcribe = jest.fn(async () => "TEST retained-chat transcription");
  const server = createFixtureServer(directory, undefined, {
    transcriber: { transcribe },
  });
  await new Promise<void>((r, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", r);
  });
  const port = (server.address() as AddressInfo).port;
  try {
    const pair = async (user: string, workspace: string) =>
      CredentialSchema.parse(
        (
          await json(port, `/v1/${workspace}/auth/pair`, undefined, {
            authProfile: AUTH_PROFILE,
            profile: PROFILE,
            code: issuePairingCode(directory, user, workspace),
          })
        ).body,
      ).accessToken;
    const a = await pair("alice", "a"),
      b = await pair("alice", "b"),
      other = await pair("bob", "a");
    const command = {
      type: "conversation.create",
      conversationId: "TEST-A",
      commandId: "TEST-new",
      idempotencyKey: "TEST-new",
    };
    expect((await json(port, "/v1/a/commands", a, command)).status).toBe(406);
    const path = `/v1/a/commands?chats=${CONVERSATION_PROJECTION_PROFILE}`;
    expect((await json(port, path, a, command)).status).toBe(202);
    expect((await json(port, path, a, command)).status).toBe(202);
    const index = `conversations?profile=${CONVERSATION_HISTORY_PROFILE}`;
    expect((await json(port, "/v1/a/conversations", a)).status).toBe(406);
    expect((await json(port, `/v1/a/${index}&scope=foreign`, a)).status).toBe(
      400,
    );
    expect(
      (await json(port, `/v1/a/${index}&after=9999999999999999`, a)).status,
    ).toBe(400);
    const page = ConversationHistoryPageSchema.parse(
      (await json(port, `/v1/a/${index}`, a)).body,
    );
    expect(page.conversations.filter((c) => c.id === "TEST-A")).toHaveLength(1);
    const details = `conversations/messages?profile=${CONVERSATION_HISTORY_PROFILE}&conversationId=TEST-A`;
    expect(
      ConversationMessagePageSchema.parse(
        (await json(port, `/v1/a/${details}`, a)).body,
      ).conversation.id,
    ).toBe("TEST-A");
    // The apps declare message times and generated UI on every history read.
    for (const declared of [
      "&messages=agent-message-time/1",
      "&ui=agent-openui/1",
      "&ui=agent-openui/1&messages=agent-message-time/1",
    ])
      expect((await json(port, `/v1/a/${details}${declared}`, a)).status).toBe(
        200,
      );
    expect((await json(port, `/v1/a/${details}&unknown=1`, a)).status).toBe(
      400,
    );
    expect((await json(port, `/v1/b/${details}`, b)).status).toBe(404);
    expect((await json(port, `/v1/a/${details}`, other)).status).toBe(404);
    expect((await json(port, `/v1/b/${details}`, a)).status).toBe(403);
    expect((await json(port, `/v1/a/${details}&revision=2`, a)).status).toBe(
      409,
    );
    expect((await json(port, `/v1/a/${index}`)).status).toBe(401);
    for (let n = 0; n < 75; n++)
      expect(
        (
          await json(port, path, a, {
            type: "conversation.create",
            conversationId: `TEST-later-${n}`,
            commandId: `TEST-later-${n}`,
            idempotencyKey: `TEST-later-${n}`,
          })
        ).status,
      ).toBe(202);
    const current = await json(
      port,
      `/v1/a/snapshot?chats=${CONVERSATION_PROJECTION_PROFILE}`,
      a,
    );
    expect(
      (current.body as { conversations: { id: string }[] }).conversations.some(
        (c) => c.id === "TEST-A",
      ),
    ).toBe(false);
    const voice = {
      profile: VOICE_PROFILE,
      requestId: "TEST-old-chat-voice",
      language: "en",
      context: { conversationId: "TEST-A" },
      audio: { mimeType: "audio/wav", base64: "YWJjZA==" },
    };
    const transcript = await json(port, "/v1/a/voice/transcriptions", a, voice);
    expect(transcript.status).toBe(200);
    expect(VoiceResultSchema.parse(transcript.body).text).toBe(
      "TEST retained-chat transcription",
    );
    expect(
      (
        await json(port, "/v1/a/voice/transcriptions", a, {
          ...voice,
          context: { conversationId: "archived-999999" },
        })
      ).status,
    ).toBe(409);
    expect(transcribe).toHaveBeenCalledTimes(1);
  } finally {
    server.closeIdleConnections();
    await new Promise<void>((r, reject) =>
      server.close((e) => (e ? reject(e) : r())),
    );
    rmSync(directory, { recursive: true, force: true });
  }
}, 20000);
