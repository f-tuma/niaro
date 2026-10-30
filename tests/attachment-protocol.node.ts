import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { AttachmentSendSchema ,
  AttachmentFilenameSchema,
  attachmentRouteProfile,
  ATTACHMENT_DEFAULT_LIMITS,
} from "../packages/protocol/attachments";

import { CommandSchema, MessageSchema } from "../packages/protocol";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import {
  messageDelivery,
  messageForClient,
  AttachmentProfileRequired,
} from "../packages/protocol/message-delivery";

test("attachment send refuses duplicate evidence, changed versions and unknown keys", () => {
  const ref = { contentId: randomUUID(), sha256: "a".repeat(64) };
  const valid = {
    profile: "agent-attachments/1",
    draftId: randomUUID(),
    draftRevision: 1,
    generation: randomUUID(),
    items: [ref],
  };
  assert.equal(AttachmentSendSchema.safeParse(valid).success, true);
  for (const value of [
    { ...valid, items: [ref, ref] },
    { ...valid, items: [] },
    {
      ...valid,
      items: Array.from({ length: 11 }, () => ({
        ...ref,
        contentId: randomUUID(),
      })),
    },
    { ...valid, profile: "agent-attachments/2" },
    { ...valid, storageKey: "forbidden" },
    { ...valid, draftRevision: "1" },
  ])
    assert.equal(AttachmentSendSchema.safeParse(value).success, false);
});

test("file-only sends preserve text/role boundaries and do not enlarge the command envelope", () => {
  const base = {
    type: "message.send",
    commandId: "send-1",
    idempotencyKey: "send-1",
    conversationId: "chat-1",
    language: "en",
    text: "",
  };
  const attachments = {
    profile: "agent-attachments/1",
    draftId: randomUUID(),
    generation: randomUUID(),
    draftRevision: 1,
    items: [{ contentId: randomUUID(), sha256: "a".repeat(64) }],
  };
  assert.equal(CommandSchema.safeParse(base).success, false);
  assert.equal(CommandSchema.safeParse({ ...base, attachments }).success, true);
  assert.equal(
    CommandSchema.safeParse({ ...base, text: "x".repeat(4000), attachments })
      .success,
    true,
  );
  assert.equal(
    CommandSchema.safeParse({ ...base, text: "x".repeat(4001), attachments })
      .success,
    false,
  );
  assert.equal(
    MessageSchema.safeParse({
      id: "m",
      role: "assistant",
      text: "answer",
      processing: {
        ingestionId: randomUUID(),
        attempt: 1,
        version: 1,
        state: "blocked_capability",
        failure: null,
      },
    }).success,
    false,
  );
});
test("filename, duplicate query and capability configuration checks refuse unsafe inputs", () => {
  for (const name of [
    "../secret",
    "a/b",
    "a\\b",
    "a\u202efile",
    "x".repeat(256),
    "e\u0301.pdf",
  ])
    assert.equal(AttachmentFilenameSchema.safeParse(name).success, false);
  assert.equal(
    AttachmentFilenameSchema.safeParse("Účet 2026.pdf").success,
    true,
  );
  assert.equal(
    attachmentRouteProfile(
      new URLSearchParams("profile=agent-attachments%2F1"),
    ),
    true,
  );
  for (const query of [
    "",
    "profile=agent-attachments%2F1&profile=agent-attachments%2F1",
    "profile=agent-attachments%2F1&x=1",
  ])
    assert.equal(attachmentRouteProfile(new URLSearchParams(query)), false);
  assert.deepEqual(loadAttachmentConfiguration({}), {
    enabled: false,
    limits: ATTACHMENT_DEFAULT_LIMITS,
    invalid: false,
  });
  assert.equal(
    loadAttachmentConfiguration({ NIARO_ATTACHMENTS_ENABLED: "true" }).enabled,
    true,
  );
  for (const env of [
    { NIARO_ATTACHMENTS_ENABLED: "1" },
    { NIARO_ATTACHMENTS_MAX_FILE_BYTES: "9999999999" },
    { NIARO_ATTACHMENTS_MAX_MESSAGE_BYTES: "1" },
  ])
    assert.equal(loadAttachmentConfiguration(env).invalid, true);
});
test("legacy delivery refuses evidence instead of stripping it into caption-only text", () => {
  const message = MessageSchema.parse({
    id: "m",
    role: "user",
    text: "",
    attachments: [
      {
        contentId: randomUUID(),
        filename: "a.txt",
        mediaType: "text/plain",
        size: 1,
        sha256: "a".repeat(64),
        availability: "available",
      },
    ],
  });
  assert.throws(
    () => messageForClient(message, messageDelivery(new URLSearchParams())),
    AttachmentProfileRequired,
  );
  assert.deepEqual(
    messageForClient(
      message,
      messageDelivery(new URLSearchParams("attachments=agent-attachments%2F1")),
    ),
    message,
  );
});
