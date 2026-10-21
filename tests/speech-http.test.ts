import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import type { SpeechSynthesizer } from "../apps/server-integrations/speech";
import { SPEECH_PROFILE } from "../packages/protocol/speech";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  SnapshotSchema,
} from "../packages/protocol";
import { messageCommand } from "../packages/client-core/commands";
import { replyCorrelationPath } from "../packages/protocol/reply-correlation";
async function setup(synthesizer?: SpeechSynthesizer) {
  const directory = mkdtempSync(join(tmpdir(), "agent-voice-http-"));
  const server = createFixtureServer(directory, undefined, { synthesizer });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const json = (path: string, value?: unknown, token?: string) =>
    new Promise<{ status: number; value: any }>((resolve, reject) => {
      const request = httpRequest(
        {
          hostname: "127.0.0.1",
          port,
          path: `/v1/a/${path}`,
          method: value === undefined ? "GET" : "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () =>
            resolve({ status: res.statusCode!, value: JSON.parse(body) }),
          );
        },
      );
      request.on("error", reject);
      request.end(value === undefined ? undefined : JSON.stringify(value));
    });
  const pair = async (user: string) =>
    CredentialSchema.parse(
      (
        await json("auth/pair", {
          profile: PROFILE,
          authProfile: AUTH_PROFILE,
          code: issuePairingCode(directory, user, "a"),
        })
      ).value,
    );
  const credential = await pair("alice");
  const call = (path: string, value?: unknown) =>
    json(path, value, credential.accessToken);
  const created = await call(
    "commands",
    messageCommand("Choose Peter", "en", "start"),
  );
  const snapshot = SnapshotSchema.parse(created.value.snapshot);
  const conversation = snapshot.conversations[0]!;
  const message = conversation.messages.find((m) => m.role === "assistant")!;
  return {
    call,
    json,
    pair,
    credential,
    conversation,
    message,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("reply correlation is opt-in for snapshots, events and command replays", async () => {
  const s = await setup();
  try {
    const legacy = (await s.call("snapshot")).value;
    const extended = (await s.call(replyCorrelationPath("snapshot"))).value;
    const messages = (snapshot: typeof legacy) =>
      snapshot.conversations.flatMap(
        (c: { messages: unknown[] }) => c.messages,
      );
    expect(
      messages(legacy).every((m: object) => !("replyToCommandId" in m)),
    ).toBe(true);
    expect(messages(extended)).toContainEqual(
      expect.objectContaining({ role: "assistant", replyToCommandId: "start" }),
    );
    const oldEvents = (await s.call("events?after=0")).value.events;
    const newEvents = (await s.call(replyCorrelationPath("events?after=0")))
      .value.events;
    for (const event of oldEvents.filter(
      (e: { type: string }) => e.type === "conversation.upserted",
    ))
      expect(
        event.entity.messages.every((m: object) => !("replyToCommandId" in m)),
      ).toBe(true);
    expect(
      newEvents
        .filter((e: { type: string }) => e.type === "conversation.upserted")
        .at(-1).entity.messages,
    ).toContainEqual(expect.objectContaining({ replyToCommandId: "start" }));
    const command = messageCommand("Choose Peter", "en", "start");
    const oldReplay = await s.call("commands", command);
    const newReplay = await s.call(replyCorrelationPath("commands"), command);
    expect(oldReplay.value.snapshot).toEqual(legacy);
    expect(newReplay.value.snapshot).toEqual(extended);
    expect((await s.call(replyCorrelationPath("snapshot"))).value).toEqual(
      extended,
    );
  } finally {
    await s.close();
  }
});
test("speech is scoped, assistant-only, read-only and rejects arbitrary client text", async () => {
  const synthesize = jest.fn(async (_text, _language, _signal, guard) => {
    await guard(() => {});
    return { mimeType: "audio/wav" as const, base64: "AAAA" };
  });
  const s = await setup({ model: "TEST reader", synthesize });
  try {
    const request = {
      profile: SPEECH_PROFILE,
      requestId: "r",
      language: "en",
      conversationId: s.conversation.id,
      messageId: s.message.id,
    };
    expect((await s.call("voice/speech")).value.enabled).toBe(true);
    const before = (await s.call("snapshot")).value;
    const response = await s.call("voice/speech", request);
    expect(response.status).toBe(200);
    expect(synthesize.mock.calls[0]![0]).toBe(s.message.text);
    expect((await s.call("snapshot")).value).toEqual(before);
    expect(
      (await s.call("voice/speech", { ...request, text: "client injected" }))
        .status,
    ).toBe(400);
    expect(
      (
        await s.call("voice/speech", {
          ...request,
          messageId: s.conversation.messages.find((m) => m.role === "user")!.id,
        })
      ).status,
    ).toBe(409);
    const other = await s.pair("bob");
    expect(
      (await s.json("voice/speech", request, other.accessToken)).status,
    ).toBe(409);
    expect(synthesize).toHaveBeenCalledTimes(1);
  } finally {
    await s.close();
  }
});
test("disabled speech never dispatches and simultaneous requests are bounded", async () => {
  const disabled = await setup();
  try {
    expect((await disabled.call("voice/speech")).value.enabled).toBe(false);
  } finally {
    await disabled.close();
  }
  let release!: () => void;
  let entered!: () => void;
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const s = await setup({
    model: "TEST",
    synthesize: async () => {
      entered();
      await new Promise<void>((r) => {
        release = r;
      });
      return { mimeType: "audio/wav", base64: "AAAA" };
    },
  });
  try {
    const req = {
      profile: SPEECH_PROFILE,
      requestId: "r",
      conversationId: s.conversation.id,
      messageId: s.message.id,
      language: "en",
    };
    const first = s.call("voice/speech", req);
    await ready;
    expect((await s.call("voice/speech", req)).status).toBe(429);
    release();
    expect((await first).status).toBe(200);
  } finally {
    release?.();
    await s.close();
  }
});
