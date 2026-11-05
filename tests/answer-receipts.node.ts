import assert from "node:assert/strict";
import { test } from "node:test";
import {
  answerReceipts,
  type ReceiptSources,
} from "../apps/server-identity/answer-receipts";
import type { StoredInvocation } from "../apps/server-identity/service-catalog";
import { AnswerReceiptSchema } from "../packages/protocol/answer-receipts";
import {
  receiptLine,
  receiptSections,
  receiptVisible,
} from "../packages/client-core/answer-receipts";
import { translate } from "../packages/i18n";
import { storedTurn } from "./helpers/answer-receipts";

const meeting = "11111111-2222-4333-8444-555555555555";
const hidden = "99999999-2222-4333-8444-555555555555";

function call(
  id: string,
  extra: Partial<StoredInvocation> = {},
): StoredInvocation {
  return {
    id,
    organizationId: "TEST-org",
    workspaceId: "TEST-ws",
    userId: "TEST-user",
    serviceId: "TEST-crm",
    actionId: "TEST-find",
    serviceRevision: 1,
    actionRevision: 1,
    policyRevision: 1,
    input: {},
    status: "succeeded",
    title: "TEST Find contacts",
    serviceName: "TEST CRM",
    effect: "read",
    ...extra,
  };
}

function sources(
  turns: unknown[],
  overrides: Partial<ReceiptSources> = {},
): ReceiptSources {
  const calls = new Map(
    [
      call("op-read"),
      call("op-write", {
        actionId: "TEST-create",
        title: "TEST Create note",
        effect: "write",
      }),
      call("op-waiting", {
        actionId: "TEST-delete",
        title: "TEST Delete",
        effect: "write",
        status: "awaiting_approval",
      }),
      call("op-unknown", {
        actionId: "TEST-send",
        title: "TEST Send",
        effect: "write",
        status: "unknown",
      }),
      call("op-gone", { serviceId: "TEST-revoked", title: "TEST Hidden" }),
    ].map((value) => [value.id, value]),
  );
  return {
    run: async (fn) => fn(),
    turns: () => turns,
    invocation: (id) => calls.get(id),
    usableServices: () => new Set(["TEST-crm"]),
    modelName: (id) =>
      id === "TEST-model" ? "TEST Thorough model" : undefined,
    skills: () => new Map([["TEST-skill", "TEST Offers"]]),
    meetingTitle: (id) => (id === meeting ? "TEST Weekly" : undefined),
    taskTitle: (id) => (id === "TEST-task" ? "TEST Call Anna" : undefined),
    memories: async (ids) =>
      new Map(
        ids.flatMap((id) =>
          id === "TEST-memory" || id === "TEST-saved"
            ? [[id, id === "TEST-memory" ? "Prefers mornings" : "Has a dog"]]
            : [],
        ),
      ),
    files: (commandId) =>
      commandId === "TEST-cmd-1"
        ? [{ id: "TEST-file", name: "offer.pdf" }]
        : [],
    ...overrides,
  };
}

test("a receipt lists only what the server recorded and the person can open now", async () => {
  const turns = [
    // Newest first, as the store returns them.
    storedTurn("TEST-cmd-2", "TEST-chat"),
    storedTurn("TEST-cmd-1", "TEST-chat", {
      operations: [
        "op-read",
        "op-write",
        "op-waiting",
        "op-unknown",
        "op-gone",
      ],
      replyBasis: { items: ["TEST-memory", "TEST-forgotten"] },
      memoryReceipts: [
        {
          toolCallId: "TEST-call",
          name: "memory_remember",
          result: { id: "TEST-saved", revision: 1, status: "active" },
        },
      ],
      humanTaskReceipts: [
        {
          toolCallId: "TEST-task-call",
          inputHash: "a".repeat(64),
          result: { taskId: "TEST-task", revision: 1, status: "open" },
        },
      ],
      skillLoads: [
        { skillId: "TEST-skill", revision: 1, source: "tool" },
        { skillId: "TEST-private-skill", revision: 1, source: "tool" },
      ],
      mentions: [{ kind: "meeting", id: meeting }],
      meetingReads: [meeting, hidden],
      answerModel: {
        modelId: "TEST-model",
        role: "preset:thorough",
        reason: "fallback: provider_limit",
      },
      preset: { id: "thorough", name: "Thorough" },
    }),
    "not a turn",
  ];
  const [first, second] = await answerReceipts(sources(turns));
  assert(first && second);
  AnswerReceiptSchema.parse(first);
  assert.equal(first.commandId, "TEST-cmd-1");
  assert.deepEqual(
    first.read.map((item) => [item.title, item.detail]),
    [["TEST Find contacts", "TEST CRM"]],
  );
  // A waiting approval, an unknown outcome and a revoked service never show.
  assert.deepEqual(
    first.changed.map((item) => [item.kind, item.title]),
    [
      ["service", "TEST Create note"],
      ["memory", "Has a dog"],
      ["task", "TEST Call Anna"],
    ],
  );
  assert.deepEqual(
    first.memories.map((item) => item.title),
    ["Prefers mornings"],
  );
  assert.deepEqual(
    first.skills.map((item) => item.title),
    ["TEST Offers"],
  );
  assert.deepEqual(
    first.meetings.map((item) => item.title),
    ["TEST Weekly"],
  );
  assert.deepEqual(
    first.files.map((item) => item.title),
    ["offer.pdf"],
  );
  // The administrator's model name, never the provider's id, and why.
  assert.deepEqual(first.model, {
    name: "TEST Thorough model",
    reason: "fallback",
  });
  assert.deepEqual(first.preset, { id: "thorough", name: "Thorough" });
  // A turn with nothing recorded has an empty receipt and shows no line.
  assert.equal(second.commandId, "TEST-cmd-2");
  assert.equal(receiptVisible(second), false);

  const tr = translate("en");
  assert.equal(
    receiptLine(first, tr),
    "Read 1 · Changed 3 · Memories 1 · Skills 1 · Meetings 1 · Files 1 · Answered by Thorough · TEST Thorough model, fallback model",
  );
  assert.deepEqual(
    receiptSections(first, tr).map((section) => section.title),
    [
      "Read",
      "Changed",
      "Memories",
      "Skills",
      "Meetings",
      "Files",
      "Answered by",
    ],
  );
  assert.match(receiptLine(first, translate("cs")), /^Čteno 1 · Změněno 3/);
});

test("an escalated answer says so, and a removed model leaves only the counts", async () => {
  const [escalated] = await answerReceipts(
    sources([
      storedTurn("TEST-cmd-3", "TEST-chat", {
        operations: ["op-read"],
        answerModel: {
          modelId: "TEST-model",
          role: "escalation",
          reason: "escalated after checker mismatch",
        },
      }),
    ]),
  );
  assert.deepEqual(escalated?.model, {
    name: "TEST Thorough model",
    reason: "escalation",
  });
  const [removed] = await answerReceipts(
    sources(
      [
        storedTurn("TEST-cmd-4", "TEST-chat", {
          operations: ["op-read"],
          answerModel: {
            modelId: "TEST-gone",
            role: "chat",
            reason: "primary",
          },
        }),
      ],
      { usableServices: () => new Set<string>() },
    ),
  );
  // The service is no longer usable and the model is gone: nothing to show.
  assert.equal(removed?.model, undefined);
  assert.deepEqual(removed?.read, []);
  assert.equal(receiptVisible(removed), false);
});
