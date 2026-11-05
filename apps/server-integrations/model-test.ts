import type {
  CatalogModel,
  ModelCapabilityProbeValue,
  ModelTestResult,
  Provider,
} from "../../packages/protocol/service-catalog";
import { transcriptionRequest } from "./transcription";
import {
  IntegrationError,
  type DispatchGuard,
  type IntegrationTransport,
  type TransportResponse,
} from "./transport";
import { providerEndpoint, providerHeaders } from "./provider-request";

/**
 * The capability test an administrator starts for one catalog model: a few
 * small requests, each asking one thing the model's kind could offer, so the
 * administrator can declare what the provider really supports. It changes
 * nothing; its requests are model calls like any other (the caller budgets
 * the chat ones and counts all of them against the provider's daily limit).
 */
type Selected = { provider: Provider; key: string; model: CatalogModel };
type Result = ModelTestResult["results"][number];

/** A 16×16 red square. */
const RED_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAAFklEQVR42mO4IyJCEmIY1TCqYfhqAAACcQQQFd0BdQAAAABJRU5ErkJggg==";
/** Half a second of a 440 Hz tone, 16 kHz mono PCM16. */
export function testTone() {
  const rate = 16000,
    samples = rate / 2;
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(36 + samples * 2, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000),
      44 + i * 2,
    );
  return wav;
}

/** Which probes fit a model, by its kind. Decision models have none. */
export function capabilityProbes(
  model: Pick<CatalogModel, "kind">,
): ModelCapabilityProbeValue[] {
  switch (model.kind) {
    case "chat":
      return ["tools", "imageInput", "audioInput", "audioOutput"];
    case "router":
      return ["tools", "imageInput"];
    case "transcription":
      return ["transcription"];
    case "speech":
      return ["speech"];
    default:
      return [];
  }
}

/** The provider refused the request itself: it does not offer this. */
const refused = (status: number) =>
  [400, 404, 405, 415, 422, 501].includes(status);
function failure(response: TransportResponse): Result["error"] {
  if (response.status === 401 || response.status === 403)
    return "integration_provider_denied";
  if (response.status === 429) return "integration_rate_limited";
  if (response.status >= 500) return "integration_provider_unavailable";
  return "integration_provider_failed";
}
function json(response: TransportResponse): unknown {
  try {
    return JSON.parse(response.text);
  } catch {
    return undefined;
  }
}
type Message = {
  content?: unknown;
  tool_calls?: { function?: { name?: unknown } }[];
};
const message = (body: unknown): Message | undefined =>
  (body as { choices?: { message?: Message }[] } | undefined)?.choices?.[0]
    ?.message;
const text = (body: unknown) => {
  const content = message(body)?.content;
  return typeof content === "string" ? content : "";
};

export async function testModelCapabilities(
  /** Budgeted transport for chat completions. */
  chatTransport: IntegrationTransport,
  /** Transport for the audio endpoints, which are not ledgered model calls. */
  audioTransport: IntegrationTransport,
  selected: Selected,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
): Promise<Result[]> {
  const { provider, key, model } = selected;
  const headers = providerHeaders(provider, key);
  const chat = (body: Record<string, unknown>, stream = false) =>
    chatTransport({
      url: providerEndpoint(provider, "/chat/completions"),
      method: "POST",
      headers: stream ? { ...headers, Accept: "text/event-stream" } : headers,
      body: { model: model.model, ...body },
      timeoutMs: 60_000,
      maxRequestBytes: 262_144,
      maxResponseBytes: 4 * 1024 * 1024,
      signal,
      beforeDispatch,
    });
  const voice = model.voices?.[0]?.voice;
  const probes: Record<
    ModelCapabilityProbeValue,
    () => Promise<Result["status"] | TransportResponse>
  > = {
    async tools() {
      const response = await chat({
        messages: [
          {
            role: "user",
            content:
              "Call the function record_color with the color red. Do not answer in text.",
          },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "record_color",
              description: "Records a color.",
              parameters: {
                type: "object",
                properties: { color: { type: "string" } },
                required: ["color"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 200,
      });
      if (response.status !== 200) return response;
      return message(json(response))?.tool_calls?.some(
        (call) => call.function?.name === "record_color",
      )
        ? "supported"
        : "unsupported";
    },
    async imageInput() {
      const response = await chat({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "What color is this square? Answer with one English word.",
              },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${RED_PNG}` },
              },
            ],
          },
        ],
        max_tokens: 20,
      });
      if (response.status !== 200) return response;
      // A server that drops the image still answers; only the color proves it saw it.
      return /red/i.test(text(json(response))) ? "supported" : "unsupported";
    },
    async audioInput() {
      const response = await chat({
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text: "Is there a sound in this audio? Answer yes or no.",
              },
              {
                type: "input_audio",
                input_audio: {
                  data: testTone().toString("base64"),
                  format: "wav",
                },
              },
            ],
          },
        ],
        max_tokens: 20,
      });
      if (response.status !== 200) return response;
      return text(json(response)).trim() ? "supported" : "unsupported";
    },
    async audioOutput() {
      if (!voice) return "skipped";
      const response = await chat(
        {
          messages: [{ role: "user", content: "Say the word test." }],
          modalities: ["text", "audio"],
          audio: { voice, format: "pcm16" },
          stream: true,
          max_tokens: 200,
        },
        true,
      );
      if (response.status !== 200) return response;
      // Any audio delta in the stream shows the model speaks.
      for (const line of response.text.split(/\r?\n/)) {
        if (!line.startsWith("data:")) continue;
        try {
          const event = JSON.parse(line.slice(5)) as {
            choices?: { delta?: { audio?: { data?: unknown } } }[];
          };
          const data = event.choices?.[0]?.delta?.audio?.data;
          if (typeof data === "string" && data.length) return "supported";
        } catch {
          // Not JSON ([DONE] or a comment): keep reading.
        }
      }
      return "unsupported";
    },
    async transcription() {
      const response = await audioTransport({
        method: "POST",
        timeoutMs: 60_000,
        maxRequestBytes: 262_144,
        maxResponseBytes: 65_536,
        ...transcriptionRequest(selected, { data: testTone(), format: "wav" }),
        signal,
        beforeDispatch,
      });
      if (response.status !== 200) return response;
      const body = json(response) as { text?: unknown } | undefined;
      return typeof body?.text === "string" ? "supported" : "unsupported";
    },
    async speech() {
      if (!voice) return "skipped";
      const response = await audioTransport({
        url: providerEndpoint(provider, "/audio/speech"),
        method: "POST",
        headers: { ...headers, Accept: "audio/mpeg" },
        body: {
          model: model.model,
          input: "Test.",
          voice,
          response_format: "mp3",
        },
        responseType: "bytes",
        timeoutMs: 60_000,
        maxResponseBytes: 4 * 1024 * 1024,
        signal,
        beforeDispatch,
      });
      if (response.status !== 200) return response;
      const type = response.headers["content-type"] ?? "";
      return /^audio\//i.test(type) && (response.bytes?.length ?? 0) > 0
        ? "supported"
        : "unsupported";
    },
  };
  const results: Result[] = [];
  for (const capability of capabilityProbes(model)) {
    signal.throwIfAborted();
    try {
      const outcome = await probes[capability]();
      if (typeof outcome === "string") {
        results.push({
          capability,
          status: outcome,
          ...(outcome === "skipped" ? { error: "voice_required" } : {}),
        });
        continue;
      }
      results.push(
        refused(outcome.status)
          ? { capability, status: "unsupported" }
          : { capability, status: "failed", error: failure(outcome) },
      );
    } catch (error) {
      // Budget, authority and cancellation end the whole test.
      if (!(error instanceof IntegrationError) || signal.aborted) throw error;
      results.push({ capability, status: "failed", error: error.code });
    }
  }
  return results;
}
