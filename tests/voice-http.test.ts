import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { createFixtureServer } from "../apps/fixture-server/http";
import { issuePairingCode } from "../apps/fixture-server/auth";
import { VoiceError, type Transcriber } from "../apps/fixture-server/voice";
import {
  AUTH_PROFILE,
  PROFILE,
  CredentialSchema,
  SnapshotSchema,
} from "../packages/protocol";
import {
  VOICE_PROFILE,
  VoiceResultSchema,
  type VoiceRequest,
} from "../packages/protocol/voice";
import {
  messageCommand,
  answerCommand,
} from "../packages/client-core/commands";
async function setup(transcriber?: Transcriber) {
  const directory = mkdtempSync(join(tmpdir(), "agent-voice-http-"));
  const server = createFixtureServer(directory, undefined, { transcriber });
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
  const input = SnapshotSchema.parse(created.value.snapshot).inputRequests[0]!;
  const voice: VoiceRequest = {
    profile: VOICE_PROFILE,
    requestId: "voice-1",
    language: "en",
    context: {
      conversationId: input.conversationId,
      workItemId: input.workItemId,
      inputRequestId: input.id,
      expectedInputRevision: input.revision,
    },
    audio: { mimeType: "audio/wav", base64: "YWJjZA==" },
  };
  return {
    call,
    json,
    voice,
    input,
    pair,
    credential,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
test("authenticated transcription returns draft only; explicit same-command answer creates no operation", async () => {
  const transcribe = jest.fn(async () => "Choose Peter Novak.");
  const app = await setup({ transcribe });
  try {
    expect((await app.json("voice")).status).toBe(401);
    expect((await app.json("voice/transcriptions", app.voice)).status).toBe(
      401,
    );
    expect((await app.call("voice")).value.enabled).toBe(true);
    const before = (await app.call("snapshot")).value;
    const result = await app.call("voice/transcriptions", app.voice);
    expect(result.status).toBe(200);
    const transcript = VoiceResultSchema.parse(result.value);
    expect(transcript.reviewReasons).toEqual(["uncertain"]);
    expect(transcript.scope.userId).toBe("alice");
    expect((await app.call("snapshot")).value).toEqual(before);
    const answered = await app.call(
      "commands",
      messageCommand(transcript.text, "en", "answer", app.input),
    );
    expect(answered.value.snapshot.inputRequests[0].status).toBe("resolved");
    expect(answered.value.snapshot.operations).toEqual([]);
    expect(
      (
        await app.call(
          "commands",
          messageCommand("yes", "en", "approval", app.input),
        )
      ).status,
    ).toBe(409);
    expect((await app.call("voice/transcriptions", app.voice)).status).toBe(
      409,
    );
    expect(transcribe).toHaveBeenCalledTimes(1);
  } finally {
    await app.close();
  }
});

test("general voice context is distinct from an open question and transcription still cannot approve work", async () => {
  const app = await setup({
    transcribe: async () => ({ text: "Choose Peter", reviewReasons: [] }),
  });
  try {
    const before = (await app.call("snapshot")).value;
    const general = {
      ...app.voice,
      context: { conversationId: "conversation-1" },
    };
    const response = await app.call("voice/transcriptions", general);
    const transcript = VoiceResultSchema.parse(response.value);
    expect(response.status).toBe(200);
    expect(transcript.context).toEqual(general.context);
    expect(transcript.reviewReasons).toEqual([]);
    expect((await app.call("snapshot")).value).toEqual(before);
    const sent = await app.call(
      "commands",
      messageCommand(transcript.text, "en", "new-voice"),
    );
    expect(sent.value.snapshot.workItems).toHaveLength(2);
    expect(sent.value.snapshot.inputRequests[0].status).toBe("open");
    expect(sent.value.snapshot.operations).toEqual([]);
    expect(
      (
        await app.call("voice/transcriptions", {
          ...general,
          context: { conversationId: "foreign" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.call("voice/transcriptions", {
          ...general,
          profile: "agent-voice/1",
        })
      ).status,
    ).toBe(400);
    const limited = VoiceResultSchema.parse(
      (
        await app.call("voice/transcriptions", {
          ...general,
          stopReason: "limit",
        })
      ).value,
    );
    expect(limited.reviewReasons).toEqual(["limit"]);
  } finally {
    await app.close();
  }
});
test("another principal, forged context and stale revision cannot use transcription", async () => {
  const transcribe = jest.fn(async () => "Choose Peter Novak");
  const app = await setup({ transcribe });
  try {
    const bob = await app.pair("bob");
    expect(
      (await app.json("voice/transcriptions", app.voice, bob.accessToken))
        .status,
    ).toBe(409);
    expect(
      (
        await app.call("voice/transcriptions", {
          ...app.voice,
          context: { ...app.voice.context, conversationId: "foreign" },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.call("voice/transcriptions", {
          ...app.voice,
          context: { ...app.voice.context, expectedInputRevision: 2 },
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await app.call("voice/transcriptions", {
          ...app.voice,
          scope: app.credential.scope,
        })
      ).status,
    ).toBe(400);
    expect(transcribe).not.toHaveBeenCalled();
  } finally {
    await app.close();
  }
});
test("a question resolved during inference invalidates the returned transcript", async () => {
  let finish!: (text: string) => void;
  let started!: () => void;
  const ready = new Promise<void>((r) => {
    started = r;
  });
  const app = await setup({
    transcribe: async () => {
      started();
      return new Promise<string>((r) => {
        finish = r;
      });
    },
  });
  try {
    const pending = app.call("voice/transcriptions", app.voice);
    await ready;
    await app.call(
      "commands",
      answerCommand(app.input, "peter-svoboda", "other-answer"),
    );
    finish("Choose Peter Novak.");
    expect((await pending).status).toBe(409);
    expect(
      (await app.call("snapshot")).value.inputRequests[0].resolution
        .selectedContactId,
    ).toBe("peter-svoboda");
  } finally {
    await app.close();
  }
});
test("unavailable and failed STT keep the question open", async () => {
  for (const transcriber of [
    undefined,
    {
      transcribe: async () => {
        throw new VoiceError("voice_processing_failed", 503);
      },
    },
  ]) {
    const app = await setup(transcriber);
    try {
      expect((await app.call("voice")).value.enabled).toBe(!!transcriber);
      expect((await app.call("voice/transcriptions", app.voice)).status).toBe(
        503,
      );
      expect((await app.call("snapshot")).value.inputRequests[0].status).toBe(
        "open",
      );
    } finally {
      await app.close();
    }
  }
});

test("cloud capabilities preserve identity when temporarily unavailable", async () => {
  let enabled = true;
  const app = await setup({
    engine: "openrouter",
    available: () => enabled,
    transcribe: async () => ({ text: "Hello", reviewReasons: [] }),
  });
  try {
    expect((await app.call("voice")).value).toMatchObject({
      engine: "openrouter",
      model: "google/gemini-3.1-flash-lite",
      processing: "cloud",
      enabled: true,
    });
    enabled = false;
    expect((await app.call("voice")).value).toMatchObject({
      engine: "openrouter",
      processing: "cloud",
      enabled: false,
    });
  } finally {
    await app.close();
  }
});
