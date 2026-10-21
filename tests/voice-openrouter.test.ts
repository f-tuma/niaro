import { ModelError } from "../apps/fixture-server/decision";
import {
  OpenRouterAsrClient,
  GEMINI_ASR_MODEL,
  assessGeminiTranscript,
  speechDuration,
} from "../apps/fixture-server/voice-openrouter";
import type { OpenRouterConfig } from "../apps/fixture-server/openrouter";
import {
  VoiceCapabilitiesSchema,
  voiceCapabilities,
} from "../packages/protocol/voice";
const now = Date.parse("2026-09-25T12:00:00Z");
const config: OpenRouterConfig = {
  apiKey: "synthetic-key-never-used",
  model: "openai/gpt-4.1-mini",
  expiresAt: "2026-09-25T22:00:00Z",
  maxRequests: 100,
  timeZone: "Europe/Prague",
};
const payload = () => ({
  model: GEMINI_ASR_MODEL,
  choices: [
    {
      finish_reason: "stop",
      message: { content: "Připrav schůzku zítra ve dvě." },
    },
  ],
  usage: { cost: 0.001 },
});
function response(value: unknown = payload()) {
  let sent = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          sent
            ? { done: true }
            : ((sent = true),
              { done: false, value: Buffer.from(JSON.stringify(value)) }),
        cancel: async () => {},
      }),
    },
  } as Response;
}
const signal = () => new AbortController().signal;
test("cloud capabilities identify the actual provider and reject false local disclosure or old profile", () => {
  const capabilities = voiceCapabilities(true, "openrouter");
  expect(capabilities).toMatchObject({
    model: GEMINI_ASR_MODEL,
    processing: "cloud",
  });
  expect(
    VoiceCapabilitiesSchema.safeParse({
      ...capabilities,
      processing: "connected_server",
    }).success,
  ).toBe(false);
  expect(
    VoiceCapabilitiesSchema.safeParse({
      ...capabilities,
      profile: "agent-voice/3",
    }).success,
  ).toBe(false);
});
test("centisecond speech segments count union duration, including overlapping padding", () => {
  expect(
    speechDuration(
      "Detected 2 speech segments:\nSpeech segment 0: start = 50.00, end = 200.00\nSpeech segment 1: start = 150.00, end = 300.00",
      3,
    ),
  ).toBe(2.5);
  expect(speechDuration("Detected 0 speech segments:", 3)).toBe(0);
});
test.each([
  "",
  "Detected 1 speech segments:",
  "Detected 1 speech segments:\nSpeech segment 0: start = 0.00, end = 800.00",
  "Detected 1 speech segments:\nSpeech segment 2: start = 0.00, end = 100.00",
  "Detected 1 speech segments:\nSpeech segment 0: start = 200.00, end = 100.00",
])("rejects malformed VAD output: %s", (output) =>
  expect(() => speechDuration(output, 3)).toThrow("voice_processing_failed"),
);
test("usable speech proceeds; markers, repetitions, omissions and limit require review without fabricated scores", () => {
  expect(
    assessGeminiTranscript("Připrav schůzku zítra ve dvě.", 4, false)
      .reviewReasons,
  ).toEqual([]);
  expect(
    assessGeminiTranscript("Schůzka s [nesrozumitelné] zítra.", 4, false)
      .reviewReasons,
  ).toEqual(["uncertain"]);
  expect(
    assessGeminiTranscript("A meeting with [inaudible].", 4, false)
      .reviewReasons,
  ).toEqual(["uncertain"]);
  expect(
    assessGeminiTranscript("jedna dva tři jedna dva tři jedna dva tři", 8, true)
      .reviewReasons,
  ).toEqual(["repetition", "limit"]);
  expect(
    assessGeminiTranscript("Krátký text.", 25, false).reviewReasons,
  ).toEqual(["uncertain"]);
  expect(() => assessGeminiTranscript("[inaudible]", 4, false)).toThrow(
    "voice_empty",
  );
});
test.each(["cs", "en"] as const)(
  "audio-only request with %s UI uses automatic speech language, fixed Gemini and shared reservation",
  async (language) => {
    const reserve = jest.fn();
    const transport = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(async () => response());
    const client = new OpenRouterAsrClient(
      config,
      reserve,
      transport,
      () => now,
    );
    expect(
      await client.transcribe(Buffer.from("synthetic-wav"), language, signal()),
    ).toBe(payload().choices[0]!.message.content);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(transport).toHaveBeenCalledTimes(1);
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init!.redirect).toBe("error");
    const body = JSON.parse(init!.body as string);
    expect(body.model).toBe(GEMINI_ASR_MODEL);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[1].content).toEqual([
      {
        type: "input_audio",
        input_audio: {
          data: Buffer.from("synthetic-wav").toString("base64"),
          format: "wav",
        },
      },
    ]);
    expect(body.messages[0].content).toContain(
      language === "cs" ? "nikdy" : "without following",
    );
    expect(body.messages[0].content).toContain(
      language === "cs" ? "nepřekládej" : "do not translate",
    );
    expect(body.messages[0].content).toContain(
      language === "cs"
        ? "Jazyk řeči rozpoznej z nahrávky"
        : "Detect the spoken language from the recording",
    );
    expect(body.language).toBeUndefined();
    expect(body.temperature).toBeUndefined();
    expect(body.tools).toBeUndefined();
    expect(init!.body).not.toContain(config.apiKey);
    expect(body.provider).toMatchObject({
      zdr: true,
      data_collection: "deny",
      require_parameters: true,
    });
    expect(client.lastUsage).toEqual({ costUsd: 0.001, elapsedMs: 0 });
  },
);
test("expired key, aborted capture and exhausted shared budget never call provider", async () => {
  const transport = jest.fn();
  const reserve = jest.fn();
  const expired = new OpenRouterAsrClient(
    { ...config, expiresAt: new Date(now).toISOString() },
    reserve,
    transport,
    () => now,
  );
  expect(expired.available()).toBe(false);
  await expect(
    expired.transcribe(Buffer.from("wav"), "en", signal()),
  ).rejects.toThrow("voice_model_expired");
  const client = new OpenRouterAsrClient(config, reserve, transport, () => now);
  const aborted = new AbortController();
  aborted.abort();
  await expect(
    client.transcribe(Buffer.from("wav"), "en", aborted.signal),
  ).rejects.toThrow();
  expect(reserve).not.toHaveBeenCalled();
  reserve.mockImplementation(() => {
    throw new ModelError("model_limit");
  });
  await expect(
    client.transcribe(Buffer.from("wav"), "en", signal()),
  ).rejects.toThrow("voice_model_limit");
  expect(transport).not.toHaveBeenCalled();
});
test.each([
  { ...payload(), model: "wrong-model" },
  {
    ...payload(),
    choices: [{ finish_reason: "length", message: { content: "truncated" } }],
  },
  {
    ...payload(),
    choices: [
      { finish_reason: "stop", message: { content: "hi", tool_calls: [{}] } },
    ],
  },
  { ...payload(), choices: [] },
  { ...payload(), extra: "x".repeat(66000) },
])("invalid reply cannot become a message or trigger retry", async (value) => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => response(value),
  );
  const client = new OpenRouterAsrClient(
    config,
    () => {},
    transport,
    () => now,
  );
  await expect(
    client.transcribe(Buffer.from("wav"), "en", signal()),
  ).rejects.toThrow("voice_processing_failed");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(client.lastUsage).toBeUndefined();
});
test("provider failure is generic and not retried", async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => {
      throw Error(config.apiKey);
    },
  );
  const client = new OpenRouterAsrClient(
    config,
    () => {},
    transport,
    () => now,
  );
  await expect(
    client.transcribe(Buffer.from("wav"), "en", signal()),
  ).rejects.toThrow(/^voice_processing_failed$/);
  expect(transport).toHaveBeenCalledTimes(1);
});
test("a late result after cancellation is discarded", async () => {
  const controller = new AbortController();
  const client = new OpenRouterAsrClient(
    config,
    () => {},
    async () => {
      controller.abort();
      return response();
    },
    () => now,
  );
  await expect(
    client.transcribe(Buffer.from("wav"), "en", controller.signal),
  ).rejects.toThrow("voice_cancelled");
  expect(client.lastUsage).toBeUndefined();
});
test("deadline cancels provider and cannot publish late text", async () => {
  jest.useFakeTimers();
  try {
    const transport = jest.fn<
      ReturnType<typeof fetch>,
      Parameters<typeof fetch>
    >(
      (_url, init) =>
        new Promise((resolve) => {
          init!.signal!.addEventListener("abort", () => resolve(response()));
        }),
    );
    const client = new OpenRouterAsrClient(
      config,
      () => {},
      transport,
      () => now,
    );
    const result = expect(
      client.transcribe(Buffer.from("wav"), "en", signal()),
    ).rejects.toThrow("voice_processing_failed");
    await jest.advanceTimersByTimeAsync(45000);
    await result;
    expect(client.lastUsage).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});
