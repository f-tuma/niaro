import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reviewedSpeechVoices,
  type SpeechVoiceRoute,
} from "../apps/server-integrations/speech-voices";

const route: SpeechVoiceRoute = {
  provider: {
    id: "provider",
    revision: 1,
    url: "https://openrouter.ai/api/v1",
  },
  model: { id: "model", revision: 1, model: "openai/gpt-audio-mini" },
  method: "reader",
  format: "pcm16",
  zeroDataRetention: false,
  voice: "cedar",
};
test("only the accepted exact mini reader PCM16 route admits the three reviewed voices", () => {
  const entry = reviewedSpeechVoices(route) as null | {
    revision: string;
    provenance: string;
    voices: { voice: string; label: string }[];
  };
  assert(entry, "accepted exact route must provide personal alternatives");
  assert.equal(entry.revision, "openrouter-gpt-audio-mini-reader-20261030-1");
  assert.match(entry.provenance, /inference/i);
  assert.deepEqual(entry.voices, [
    { voice: "alloy", label: "Alloy" },
    { voice: "echo", label: "Echo" },
    { voice: "shimmer", label: "Shimmer" },
  ]);
  assert(
    reviewedSpeechVoices({
      ...route,
      provider: { ...route.provider, url: route.provider.url + "/" },
    }),
  );
  assert(reviewedSpeechVoices({ ...route, zeroDataRetention: true }));
});
test("unreviewed providers, identifiers, methods and formats stay default-only", () => {
  assert.equal(reviewedSpeechVoices(null), null);
  for (const url of [
    "https://openrouter.ai.evil/api/v1",
    "https://openrouter.ai/api/v1?x=1",
    "http://openrouter.ai/api/v1",
    "https://api.openai.com/v1",
    "https://user@openrouter.ai/api/v1",
  ])
    assert.equal(
      reviewedSpeechVoices({ ...route, provider: { ...route.provider, url } }),
      null,
      url,
    );
  for (const model of [
    "openai/gpt-audio",
    "openai/gpt-audio-mini-2026-10-30",
    "openai/gpt-audio-mini:free",
    "openai/gpt-audio-*",
    "gpt-audio-mini",
    "x-ai/grok-voice-tts-1.0",
    "microsoft/mai-voice-2",
    "openai/gpt-4o-mini-tts",
  ])
    assert.equal(
      reviewedSpeechVoices({ ...route, model: { ...route.model, model } }),
      null,
      model,
    );
  assert.equal(
    reviewedSpeechVoices({ ...route, method: "speech", format: "mp3" }),
    null,
  );
  assert.equal(reviewedSpeechVoices({ ...route, format: "mp3" }), null);
});
