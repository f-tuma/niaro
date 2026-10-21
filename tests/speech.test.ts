import {
  readerAudio,
  readsVerbatim,
  SpeechError,
  synthesizeSpeech,
  type SpeechSelection,
} from "../apps/server-integrations/speech";
import {
  CatalogModelSchema,
  ProviderSchema,
  Routing,
} from "../packages/protocol/service-catalog";
import type { IntegrationTransport } from "../apps/server-integrations/transport";
import {
  ReplySpeech,
  type SpeechPlayback,
} from "../packages/client-core/speech";
import { AudioSessionCoordinator } from "../packages/audio/coordinator";
const data = Buffer.alloc(482, 1);
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const chunk = (bytes: Buffer) =>
  event({
    choices: [{ delta: { audio: { data: bytes.toString("base64") } } }],
  });
const ending =
  event({ choices: [{ delta: {}, finish_reason: "stop" }] }) +
  "data: [DONE]\n\n";
const stream =
  chunk(data.subarray(0, 241)) + chunk(data.subarray(241)) + ending;
const audio = readerAudio(stream);
const selected: SpeechSelection = {
  model: CatalogModelSchema.parse({
    id: "reader",
    revision: 1,
    providerId: "provider",
    name: "Reader",
    model: "openai/gpt-audio-mini",
    tools: false,
    audioOutput: true,
    enabled: true,
  }),
  provider: ProviderSchema.parse({
    id: "provider",
    revision: 1,
    name: "OR",
    url: "https://openrouter.ai/api/v1",
    enabled: true,
    dailyRequestLimit: 10,
    hasCredential: true,
    requestsToday: 0,
  }),
  key: "TEST-key",
  method: "reader",
  voice: "alloy",
};
test("reader decodes independently padded chunks and returns a valid mono PCM WAV", () => {
  const wav = Buffer.from(audio.base64, "base64");
  expect(wav.subarray(0, 4).toString()).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(wav.readUInt32LE(40)).toBe(data.length);
  expect(wav.subarray(44)).toEqual(data);
});
test("reader accepts a large canonical independently padded PCM chunk within its remaining budget", () => {
  const large = Buffer.alloc(120 * 24000 * 2 - data.length, 0x7f);
  expect(large.toString("base64").endsWith("=")).toBe(true);
  const wav = Buffer.from(
    readerAudio(chunk(data) + chunk(large) + ending).base64,
    "base64",
  );
  expect(wav.readUInt32LE(40)).toBe(data.length + large.length);
  expect(wav.subarray(44, 44 + data.length)).toEqual(data);
  expect(wav.subarray(44 + data.length).equals(large)).toBe(true);
});
test("reader rejects oversized PCM before allocating a base64 decode", () => {
  const body = chunk(Buffer.alloc(6 * 1024 * 1024)) + ending;
  const decode = jest.spyOn(Buffer, "from");
  try {
    expect(() => readerAudio(body)).toThrow(SpeechError);
    expect(decode).not.toHaveBeenCalled();
  } finally {
    decode.mockRestore();
  }
});
test("reader applies the PCM budget across independently padded chunks", () => {
  const nearLimit = Buffer.alloc(120 * 24000 * 2 - 2);
  expect(() =>
    readerAudio(chunk(nearLimit) + chunk(Buffer.alloc(4)) + ending),
  ).toThrow("speech_too_long");
});
test.each([
  "A===",
  "====",
  "AA=A",
  "AA==AAAA",
  "AA=",
  "AA==\n",
  "AB==",
  "AAB=",
  "AA-_",
  "AAéA",
])(
  "reader rejects malformed or noncanonical padding in %j with a safe speech error",
  (encoded) => {
    const body =
      event({ choices: [{ delta: { audio: { data: encoded } } }] }) + ending;
    expect(() => readerAudio(body)).toThrow(SpeechError);
    expect(() => readerAudio(body)).toThrow("speech_response_invalid");
  },
);
test.each([
  stream.replace("data: [DONE]\n\n", ""),
  stream.slice(0, -1),
  stream.replace('"stop"', '"length"'),
  chunk(Buffer.alloc(481)) + ending,
  stream.replace(/"data":"[^"]+/, '"data":"not_base64'),
  stream + event({ choices: [] }),
  event({ error: { message: "provider secret" }, choices: [] }) + ending,
  chunk(Buffer.alloc(6 * 1024 * 1024)) + ending,
])("rejects incomplete, malformed or excessive reader audio", (body) => {
  expect(() => readerAudio(body)).toThrow(/speech_/);
});
test("reader uses literal text with no tools/temperature; dedicated TTS uses binary MP3 endpoint", async () => {
  const transport = jest.fn(async (req) => {
    await req.beforeDispatch?.(() => {});
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text: stream,
    };
  }) as jest.MockedFunction<IntegrationTransport>;
  const guard = jest.fn(async (start: () => void) => start());
  const text = 'Neodesílej pozvánku. "Co mám udělat?"';
  expect(
    await synthesizeSpeech(
      transport,
      selected,
      text,
      "cs",
      new AbortController().signal,
      guard,
    ),
  ).toEqual(audio);
  expect(transport.mock.calls[0]![0].body).toMatchObject({
    stream: true,
    modalities: ["text", "audio"],
    messages: [
      expect.anything(),
      { role: "user", content: JSON.stringify(text) },
    ],
  });
  expect(transport.mock.calls[0]![0].body).not.toHaveProperty("tools");
  expect(transport.mock.calls[0]![0].body).not.toHaveProperty("temperature");
  expect(guard).toHaveBeenCalledTimes(1);
  const bytes = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(200)]);
  transport.mockResolvedValue({
    status: 200,
    headers: { "content-type": "audio/mpeg" },
    bytes,
    text: "",
  });
  const result = await synthesizeSpeech(
    transport,
    { ...selected, method: "speech" },
    text,
    "cs",
    new AbortController().signal,
    guard,
  );
  expect(result.mimeType).toBe("audio/mpeg");
  expect(transport.mock.calls[1]![0]).toMatchObject({
    url: "https://openrouter.ai/api/v1/audio/speech",
    responseType: "bytes",
    body: { input: text, response_format: "mp3" },
  });
  transport.mockResolvedValue({
    status: 200,
    headers: { "content-type": "audio/mpeg" },
    bytes: Buffer.from("provider HTML response"),
    text: "",
  });
  await expect(
    synthesizeSpeech(
      transport,
      { ...selected, method: "speech" },
      text,
      "cs",
      new AbortController().signal,
      guard,
    ),
  ).rejects.toThrow("speech_response_invalid");
  const calls = transport.mock.calls.length;
  await expect(
    synthesizeSpeech(
      transport,
      selected,
      "x".repeat(2001),
      "cs",
      new AbortController().signal,
      guard,
    ),
  ).rejects.toThrow("speech_too_long");
  expect(transport.mock.calls).toHaveLength(calls);
});
test("legacy routing keeps speech disabled independently of transcription", () => {
  expect(
    Routing.parse({ revision: 0, modelId: null, services: [] }).speech,
  ).toEqual({
    modelId: null,
    method: "reader",
    voice: "alloy",
    zeroDataRetention: true,
  });
});
test("stop suppresses late synthesis, a newer reply owns playback and errors release it", async () => {
  let resolve!: (value: typeof audio) => void;
  const synthesize = jest.fn(
    () =>
      new Promise<typeof audio>((r) => {
        resolve = r;
      }),
  );
  const playback: SpeechPlayback = {
    start: jest.fn(async () => {}),
    stop: jest.fn(),
  };
  const player = new ReplySpeech(synthesize, playback);
  const pending = player.play("c", "m", "cs", "r1");
  expect(player.getSnapshot().phase).toBe("loading");
  player.stop();
  resolve(audio);
  await pending;
  expect(playback.start).not.toHaveBeenCalled();
  const next = player.play("c", "m2", "cs", "r2");
  resolve(audio);
  await next;
  expect(player.getSnapshot()).toMatchObject({
    phase: "playing",
    messageId: "m2",
  });
  (playback.start as jest.Mock).mock.calls[0][3]();
  expect(player.getSnapshot()).toMatchObject({
    phase: "error",
    messageId: "m2",
  });
  expect(playback.stop).toHaveBeenCalled();
});
test("playback and microphone share exclusive ownership", () => {
  const coordinator = new AudioSessionCoordinator();
  coordinator.acquire("playback");
  expect(() => coordinator.acquire("voice")).toThrow("audio_busy");
  coordinator.release("playback");
  coordinator.acquire("voice");
  expect(() => coordinator.acquire("playback")).toThrow("audio_busy");
});

test("audio completion metadata closes streams whose finish reason stays null", () => {
  const stream =
    chunk(data) +
    event({
      choices: [
        { delta: { audio: { expires_at: 1790440000 } }, finish_reason: null },
      ],
    }) +
    "data: [DONE]\n\n";
  expect(readerAudio(stream)).toEqual(audio);
  expect(() => readerAudio(stream.replace("data: [DONE]\n\n", ""))).toThrow(
    "speech_response_invalid",
  );
});

test("reader keeps privacy requirements and exposes a safe actionable policy error", async () => {
  const transport: IntegrationTransport = async (request) => {
    expect(request.body).toMatchObject({
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: true,
      },
    });
    return {
      status: 404,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        error: {
          message:
            "No endpoints found matching your data policy (Zero data retention)",
        },
      }),
    };
  };
  await expect(
    synthesizeSpeech(
      transport,
      selected,
      "TEST",
      "cs",
      new AbortController().signal,
      async (start) => start(),
    ),
  ).rejects.toThrow("speech_privacy_unavailable");
});

test("an explicit speech-only retention override keeps data collection denied", async () => {
  const transport: IntegrationTransport = async (request) => {
    expect(request.body).toMatchObject({
      provider: {
        require_parameters: true,
        data_collection: "deny",
        zdr: false,
      },
    });
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text: stream,
    };
  };
  await expect(
    synthesizeSpeech(
      transport,
      { ...selected, zeroDataRetention: false },
      "TEST",
      "cs",
      new AbortController().signal,
      async (start) => start(),
    ),
  ).resolves.toEqual(audio);
});

const withTranscript = (spoken: string) =>
  event({ choices: [{ delta: { audio: { transcript: spoken } } }] }) + stream;

test("a verbatim check accepts the same words and rejects a paraphrase", () => {
  const reply =
    "Příští úterý 14:00 v Praze je 29. září 2026, schůzka trvá 30 minut.";
  expect(readsVerbatim(reply, reply)).toBe(true);
  // Punctuation and casing differences are not paraphrase.
  expect(
    readsVerbatim(
      reply,
      "příští úterý 14 00 v praze je 29 září 2026 schůzka trvá 30 minut",
    ),
  ).toBe(true);
  expect(
    readsVerbatim(
      reply,
      "Schůzka bude v úterý 29. září ve 14:00 a potrvá půl hodiny.",
    ),
  ).toBe(false);
  // An invented number is never acceptable, even in otherwise equal text.
  expect(
    readsVerbatim("Schůzka trvá 30 minut.", "Schůzka trvá 45 minut."),
  ).toBe(false);
});

test("addresses and numbers read letter by letter still count as verbatim", () => {
  const reply =
    "Našel jsem kontakt Jan Novák s e-mailem jan.novak@example.cz a telefonem +420 600123456. Posílám kartu.";
  expect(
    readsVerbatim(
      reply,
      "Našel jsem kontakt Jan Novák s e-mailem jan tečka novák zavináč e iks a em pé el e tečka cé zet a telefonem plus čtyři sta dvacet, šest set, sto dvacet tři, čtyři sta padesát šest. Posílám kartu.",
    ),
  ).toBe(true);
  // Ordinary words must still all be there, and nothing may be added.
  expect(
    readsVerbatim(
      reply,
      "Kontakt nemám, ale posílám aspoň kartu s číslem plus čtyři sta dvacet.",
    ),
  ).toBe(false);
  expect(
    readsVerbatim(
      reply,
      "Našel jsem kontakt Jan Novák s e-mailem jan tečka novák zavináč example tečka cz a telefonem plus čtyři sta dvacet šest set sto dvacet tři čtyři sta padesát šest. Posílám kartu. Mimochodem, Jan má zítra narozeniny, nezapomeň mu popřát a koupit dárek, dort a květiny, a pozvat ho na oslavu do restaurace v centru města.",
    ),
  ).toBe(false);
});

test("a paraphrased reading is retried once and never played", async () => {
  const text = "Příští úterý ve 14:00 v Praze na 30 minut.";
  const responses = [
    withTranscript("V úterý ve dvě odpoledne na půl hodiny."),
    withTranscript(text),
  ];
  const transport = jest.fn(async () => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: responses.shift()!,
  })) as unknown as jest.MockedFunction<IntegrationTransport>;
  const run = () =>
    synthesizeSpeech(
      transport,
      selected,
      text,
      "cs",
      new AbortController().signal,
      async (start) => start(),
    );
  expect(await run()).toEqual(audio);
  expect(transport).toHaveBeenCalledTimes(2);

  transport.mockClear();
  const paraphrase = withTranscript("V úterý odpoledne na chvíli.");
  transport.mockImplementation(async () => ({
    status: 200,
    headers: { "content-type": "text/event-stream" },
    text: paraphrase,
  }));
  await expect(run()).rejects.toThrow(/speech_unavailable/);
  expect(transport).toHaveBeenCalledTimes(2);
});
