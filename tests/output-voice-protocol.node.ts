import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import {
  OUTPUT_VOICE_PROFILE,
  OutputVoiceUpdateSchema,
  OutputVoiceSnapshotSchema,
} from "../packages/protocol/output-voice";
import {
  SpeechCapabilitiesSchema,
  SpeechRequestSchema,
  SpeechResultSchema,
} from "../packages/protocol/speech";

const scope = {
  connectionId: "connection",
  serverId: "server",
  userId: "user",
  workspaceId: "workspace",
};
const optionId = `ov_${"a".repeat(64)}`;
const update = {
  profile: OUTPUT_VOICE_PROFILE,
  requestId: randomUUID(),
  expectedRevision: 0,
  catalogueRevision: "b".repeat(64),
  choice: { kind: "catalogue", optionId },
};
const snapshot = {
  profile: OUTPUT_VOICE_PROFILE,
  scope,
  revision: 0,
  catalogueRevision: "b".repeat(64),
  availability: "selectable",
  route: {
    identity: "c".repeat(64),
    model: "openai/gpt-audio-mini",
    method: "reader",
  },
  serverDefault: { label: "Cedar" },
  options: [{ optionId, label: "Alloy" }],
  saved: null,
  effective: {
    choice: { kind: "server-default" },
    label: "Cedar",
    reason: "server-default",
  },
};
test("output settings accept the exact bounded contract and reject routing/actor injection", () => {
  assert.deepEqual(OutputVoiceUpdateSchema.parse(update), update);
  assert.deepEqual(OutputVoiceSnapshotSchema.parse(snapshot), snapshot);
  for (const field of [
    "voice",
    "provider",
    "model",
    "organizationId",
    "userId",
    "workspaceId",
    "scope",
    "endpoint",
  ]) {
    assert.equal(
      OutputVoiceUpdateSchema.safeParse({ ...update, [field]: "injected" })
        .success,
      false,
      field,
    );
  }
  for (const choice of [
    { kind: "catalogue", optionId: "alloy" },
    { kind: "server-default", voice: "echo" },
    { kind: "cloned", optionId },
  ])
    assert.equal(
      OutputVoiceUpdateSchema.safeParse({ ...update, choice }).success,
      false,
    );
  for (const expectedRevision of [
    -1,
    0.1,
    Number.MAX_SAFE_INTEGER + 1,
    Infinity,
  ])
    assert.equal(
      OutputVoiceUpdateSchema.safeParse({ ...update, expectedRevision })
        .success,
      false,
    );
  for (const requestId of ["request-1", "", "x".repeat(3000)])
    assert.equal(
      OutputVoiceUpdateSchema.safeParse({ ...update, requestId }).success,
      false,
    );
  for (const catalogueRevision of [
    "B".repeat(64),
    "b".repeat(63),
    "g".repeat(64),
  ])
    assert.equal(
      OutputVoiceUpdateSchema.safeParse({ ...update, catalogueRevision })
        .success,
      false,
    );
});
test("all snapshot nesting, label/count/byte limits and unavailable shape are bounded", () => {
  for (const bad of [
    { ...snapshot, unknown: true },
    { ...snapshot, scope: { ...scope, organizationId: "org" } },
    { ...snapshot, route: { ...snapshot.route, provider: "secret" } },
    { ...snapshot, serverDefault: { label: "a".repeat(201) } },
    { ...snapshot, options: [{ optionId, label: "a".repeat(101) }] },
    { ...snapshot, options: [{ optionId, label: " Alloy " }] },
    { ...snapshot, options: [{ optionId, label: "<b>Alloy</b>" }] },
    {
      ...snapshot,
      options: Array.from({ length: 33 }, (_, i) => ({
        optionId: `ov_${i.toString(16).padStart(64, "0")}`,
        label: "Alloy",
      })),
    },
    {
      ...snapshot,
      saved: { choice: { kind: "server-default" }, label: "Cedar" },
    },
    { ...snapshot, effective: { ...snapshot.effective, voice: "alloy" } },
  ])
    assert.equal(
      OutputVoiceSnapshotSchema.safeParse(bad).success,
      false,
      JSON.stringify(bad).slice(0, 120),
    );
  const unavailable = {
    ...snapshot,
    availability: "speech-unavailable",
    route: null,
    serverDefault: null,
    options: [],
    effective: {
      choice: { kind: "server-default" },
      label: "",
      reason: "speech-unavailable",
    },
  };
  assert.deepEqual(OutputVoiceSnapshotSchema.parse(unavailable), unavailable);
});
test("legacy speech field sets stay strict and unchanged", () => {
  const request = {
    profile: "agent-speech/1",
    requestId: "request",
    conversationId: "conversation",
    messageId: "message",
    language: "en",
  };
  const capabilities = {
    profile: "agent-speech/1",
    enabled: true,
    model: "model",
    processing: "cloud",
    maxTextLength: 2000,
  };
  const result = {
    ...request,
    scope,
    audio: { mimeType: "audio/wav", base64: "AAAA" },
  };
  for (const [schema, value] of [
    [SpeechRequestSchema, request],
    [SpeechCapabilitiesSchema, capabilities],
    [SpeechResultSchema, result],
  ] as const) {
    assert.deepEqual(schema.parse(value), value);
    for (const field of ["voice", "options", "catalogueRevision"])
      assert.equal(
        schema.safeParse({ ...value, [field]: "injected" }).success,
        false,
      );
  }
});
