import { test } from "node:test";
import assert from "node:assert/strict";
import {
  outputVoiceCatalogue,
  reviewedSpeechVoices,
  speechVoiceCompatibility,
  type SpeechVoiceRoute,
} from "../apps/server-integrations/speech-voices";

const route: SpeechVoiceRoute = {
  provider: {
    id: "provider",
    revision: 1,
    url: "https://openrouter.ai/api/v1",
  },
  model: {
    id: "model",
    revision: 1,
    model: "test/reader",
    voices: [
      { voice: "test-low", label: "Low" },
      { voice: "test-high", label: "High" },
    ],
  },
  method: "reader",
  format: "pcm16",
  zeroDataRetention: false,
  voice: "test-low",
};
const actor = {
  organizationId: "TEST-org",
  workspaceId: "TEST-workspace",
  userId: "TEST-user",
};
test("the voices offered are the ones an administrator listed on the model", () => {
  const entry = reviewedSpeechVoices(route);
  assert(entry, "a model with reviewed voices offers them");
  assert.deepEqual(entry.voices, route.model.voices);
  assert.match(entry.revision, /^[0-9a-f]{64}$/);
  // Any model and method may list voices; no model is recognized by its ID.
  assert(
    reviewedSpeechVoices({
      ...route,
      method: "speech",
      format: "mp3",
      model: { ...route.model, model: "other/speech" },
    }),
  );
  const catalogue = outputVoiceCatalogue(actor, route, 0);
  assert.deepEqual(
    catalogue.options.map(({ voice, label }) => ({ voice, label })),
    route.model.voices,
  );
  assert.equal(catalogue.defaultLabel, "Low");
});
test("a model without reviewed voices stays default-only", () => {
  assert.equal(reviewedSpeechVoices(null), null);
  assert.equal(
    reviewedSpeechVoices({ ...route, model: { ...route.model, voices: [] } }),
    null,
  );
  const catalogue = outputVoiceCatalogue(
    actor,
    { ...route, voice: "test-other", model: { ...route.model, voices: [] } },
    0,
  );
  assert.deepEqual(catalogue.options, []);
  assert.equal(catalogue.defaultLabel, "Test-other");
});
test("editing the reviewed list changes the route's compatibility", () => {
  const before = JSON.stringify(speechVoiceCompatibility(route));
  const after = JSON.stringify(
    speechVoiceCompatibility({
      ...route,
      model: {
        ...route.model,
        voices: [...route.model.voices, { voice: "test-mid", label: "Mid" }],
      },
    }),
  );
  assert.notEqual(before, after);
});
