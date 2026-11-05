import { z } from "zod";
import type { Language } from "../../packages/protocol";
import { VOICE_BYTES, VOICE_BODY_BYTES } from "../../packages/protocol/voice";
import { transcriptionPrompts } from "../fixture-server/voice-openrouter";
import { VoiceError } from "../fixture-server/voice";
import type {
  CatalogModel,
  Provider,
} from "../../packages/protocol/service-catalog";
import {
  IntegrationError,
  jsonResponse,
  type IntegrationTransport,
  type DispatchGuard,
} from "./transport";
import { providerFailure } from "./failures";
import {
  isOpenRouterDialect,
  providerEndpoint,
  providerHeaders,
} from "./provider-request";

type AudioFormat = "flac" | "mp3" | "wav";
const AUDIO_TYPES: Record<AudioFormat, string> = {
  flac: "audio/flac",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};
/**
 * One `POST /audio/transcriptions` in the provider's dialect: OpenRouter
 * takes the audio as JSON (`input_audio`), the OpenAI API and the servers
 * that follow it as a multipart upload (`file`). Extra fields go along as
 * given; arrays become repeated `name[]` parts in a multipart body.
 */
export function transcriptionRequest(
  selected: { provider: Provider; key: string; model: CatalogModel },
  audio: { data: Buffer; format: AudioFormat },
  fields: Record<string, string | string[] | Record<string, unknown>> = {},
) {
  const url = providerEndpoint(selected.provider, "/audio/transcriptions");
  const headers = providerHeaders(selected.provider, selected.key);
  if (isOpenRouterDialect(selected.provider))
    return {
      url,
      headers,
      body: {
        model: selected.model.model,
        input_audio: {
          data: audio.data.toString("base64"),
          format: audio.format,
        },
        ...fields,
      },
    };
  const parts: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(fields))
    if (typeof value === "string") parts[name] = value;
    else if (Array.isArray(value)) parts[`${name}[]`] = value;
  return {
    url,
    headers,
    bodyEncoding: "multipart" as const,
    body: {
      model: selected.model.model,
      ...parts,
      file: {
        filename: `audio.${audio.format}`,
        contentType: AUDIO_TYPES[audio.format],
        data: audio.data,
      },
    },
  };
}

const Reply = z.object({
  choices: z
    .array(
      z.object({
        finish_reason: z.literal("stop"),
        message: z.object({
          content: z.string().max(4000).nullable(),
          tool_calls: z.array(z.unknown()).max(0).optional(),
        }),
      }),
    )
    .length(1),
});

export async function transcribeAudio(
  transport: IntegrationTransport,
  selected: {
    provider: Provider;
    key: string;
    model: CatalogModel;
    method?: "interpreter" | "transcription";
  },
  wav: Buffer,
  language: Language,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
) {
  const direct = selected.method === "transcription";
  if (
    direct
      ? selected.model.kind !== "transcription"
      : !selected.model.audioInput || selected.model.kind !== "chat"
  )
    throw new VoiceError("voice_unavailable", 503);
  if (!wav.length || wav.length > VOICE_BYTES)
    throw new VoiceError("voice_duration");
  signal.throwIfAborted();
  const audio = { data: wav.toString("base64"), format: "wav" };
  const limits = {
    method: "POST",
    maxRequestBytes: VOICE_BODY_BYTES,
    timeoutMs: direct ? 60000 : 45000,
    maxResponseBytes: 65536,
    signal,
    beforeDispatch,
  };
  const raw = jsonResponse(
    await transport(
      direct
        ? {
            ...limits,
            // Omit the optional spoken-language hint: `language` is the UI
            // locale, so forcing it would corrupt speech in another language.
            // STT has a distinct API contract; chat provider/ZDR routing flags are not supported here.
            ...transcriptionRequest(selected, { data: wav, format: "wav" }),
          }
        : {
            ...limits,
            url: providerEndpoint(selected.provider, "/chat/completions"),
            headers: providerHeaders(selected.provider, selected.key),
            body: {
              model: selected.model.model,
              stream: false,
              messages: [
                { role: "system", content: transcriptionPrompts[language] },
                {
                  role: "user",
                  content: [
                    {
                      type: "input_audio",
                      input_audio: audio,
                    },
                  ],
                },
              ],
              // OpenRouter's routing flags; other dialects would refuse the field.
              ...(isOpenRouterDialect(selected.provider)
                ? {
                    provider: {
                      require_parameters: true,
                      data_collection: "deny",
                      zdr: true,
                    },
                  }
                : {}),
            },
          },
    ),
  );
  if (direct) {
    const reply = z.object({ text: z.string().max(4000) }).safeParse(raw);
    if (!reply.success) throw new VoiceError("voice_processing_failed", 503);
    signal.throwIfAborted();
    return reply.data.text;
  }
  const reply = Reply.safeParse(raw);
  if (!reply.success) throw new VoiceError("voice_processing_failed", 503);
  signal.throwIfAborted();
  return reply.data.choices[0]!.message.content ?? "";
}

/** One meeting chunk's request stays below the transport's 12 MB (OpenRouter takes 25 MB). */
export const MEETING_STT_REQUEST_BYTES = 12 * 1024 * 1024;
/** OpenRouter stops waiting for an upstream provider after about a minute. */
export const MEETING_STT_TIMEOUT_MS = 60_000;
const TimedSegment = z.object({
  start: z.number().min(0).max(36000),
  end: z.number().min(0).max(36000),
  text: z.string().max(20000),
});
const VerboseReply = z.object({
  text: z.string().max(400000),
  language: z.string().min(1).max(32).optional().catch(undefined),
  segments: z.array(TimedSegment).max(10000).optional(),
  words: z
    .array(
      z.object({
        word: z.string().max(400),
        start: z.number().min(0).max(36000),
        end: z.number().min(0).max(36000),
      }),
    )
    .max(100000)
    .optional()
    .catch(undefined),
});
export type MeetingChunkTranscript = {
  text: string;
  language?: string;
  /** Times in seconds from the start of the sent audio. */
  segments: z.infer<typeof TimedSegment>[];
  words?: { word: string; start: number; end: number }[];
  /** False when the provider returned text without timestamps. */
  timed: boolean;
};
/**
 * Transcribes one meeting chunk with `POST /audio/transcriptions`, asking
 * for timestamps (`verbose_json`) and only zero-data-retention endpoints
 * that do not collect data. A provider that refuses an optional part (the
 * context prompt, then timestamps) is asked again without it; privacy
 * flags are never dropped.
 */
export async function transcribeMeetingChunk(
  transport: IntegrationTransport,
  selected: { provider: Provider; key: string; model: CatalogModel },
  audio: { data: Buffer; format: "flac" | "mp3" | "wav" },
  prompt: string,
  signal: AbortSignal,
  beforeDispatch: DispatchGuard,
): Promise<MeetingChunkTranscript> {
  if (selected.model.kind !== "transcription")
    throw new VoiceError("voice_unavailable", 503);
  if (
    !audio.data.length ||
    (audio.data.length * 4) / 3 > MEETING_STT_REQUEST_BYTES - 65536
  )
    throw new VoiceError("voice_duration");
  // Richest first. A provider that refuses a field gets the next, plainer
  // request; the last one is the request chat voice already sends to the
  // same model (STT endpoints may not accept the routing privacy flags).
  // The privacy flags are OpenRouter's; other dialects never get them.
  const flagged = isOpenRouterDialect(selected.provider);
  const variants = [
    { verbose: true, prompt: !!prompt, flags: flagged },
    ...(prompt ? [{ verbose: true, prompt: false, flags: flagged }] : []),
    { verbose: false, prompt: false, flags: flagged },
    ...(flagged ? [{ verbose: false, prompt: false, flags: false }] : []),
  ];
  for (const [attempt, variant] of variants.entries()) {
    signal.throwIfAborted();
    const response = await transport({
      method: "POST",
      maxRequestBytes: MEETING_STT_REQUEST_BYTES,
      timeoutMs: MEETING_STT_TIMEOUT_MS,
      maxResponseBytes: 4 * 1024 * 1024,
      ...transcriptionRequest(selected, audio, {
        ...(variant.verbose
          ? {
              response_format: "verbose_json",
              timestamp_granularities: ["segment"],
            }
          : {}),
        // Names and terms only; the UI language is never forced on speech.
        ...(variant.prompt ? { prompt } : {}),
        ...(variant.flags
          ? { provider: { zdr: true, data_collection: "deny" } }
          : {}),
      }),
      signal,
      beforeDispatch,
    });
    // 400: a field is refused; 404: no endpoint matches the request.
    if (
      (response.status === 400 || response.status === 404) &&
      attempt < variants.length - 1
    )
      continue;
    if (response.status === 429)
      throw new IntegrationError("integration_rate_limited", 429);
    if (response.status >= 500)
      throw new IntegrationError("integration_provider_unavailable", 503);
    if (response.status < 200 || response.status >= 300)
      throw new IntegrationError(
        "integration_provider_failed",
        response.status >= 400 && response.status < 500 ? response.status : 502,
        providerFailure(response.text, {
          httpStatus: response.status,
          secretValues: [selected.key],
        }),
      );
    const reply = VerboseReply.safeParse(jsonResponse(response));
    if (!reply.success) throw new VoiceError("voice_processing_failed", 503);
    signal.throwIfAborted();
    const segments = (reply.data.segments ?? []).filter(
      (s) => s.end >= s.start && s.text.trim(),
    );
    return {
      text: reply.data.text,
      ...(reply.data.language ? { language: reply.data.language } : {}),
      segments,
      ...(reply.data.words?.length ? { words: reply.data.words } : {}),
      timed: segments.length > 0 || !reply.data.text.trim(),
    };
  }
  throw new VoiceError("voice_processing_failed", 503);
}
