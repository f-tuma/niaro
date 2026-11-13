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
import { CommandSchema } from "../packages/protocol";
import { createTrustHarness, toolResults } from "./agent-trust/harness";

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

test("an answer after an approval carries its receipt, also after a question moves the request", async () => {
  const h = createTrustHarness();
  try {
    const question = "TEST Which room?";
    h.onChat((body) =>
      toolResults(body).some((r) => r.data?.created)
        ? h.call("ask_user", { question })
        : h.writeScript(body),
    );
    const proposed = await h.send("TEST create a meeting", {
      id: "TEST-receipt-request",
    });
    const card = proposed.snapshot.conversations[0]!.messages.at(-1)!.result;
    assert(
      card?.type === "service.action" && card.status === "awaiting_approval",
    );
    const footers = async (result: Awaited<ReturnType<typeof h.execute>>) => {
      const answer = result.snapshot.conversations[0]!.messages.findLast(
        (message) => message.role === "assistant",
      )!;
      const receipts = await answerReceipts(
        sources(
          h.catalog.conversationTurns(
            h.scope.workspaceId,
            h.scope.userId,
            "conversation-1",
            8,
          ),
        ),
      );
      return [answer.replyToCommandId, receipts.map((r) => r.commandId)];
    };
    const approved = await h.execute(
      CommandSchema.parse({
        type: "service.resolve",
        commandId: "TEST-receipt-approve",
        idempotencyKey: "TEST-receipt-approve",
        conversationId: "conversation-1",
        operationId: card.operationId,
        approved: true,
        language: "en",
      }),
    );
    // The footer looks the receipt up by the stored answer's request.
    assert.deepEqual(await footers(approved), [
      "TEST-receipt-approve",
      ["TEST-receipt-approve"],
    ]);
    h.onChat(() => ({ content: "TEST Room B it is." }));
    const answered = await h.send("Room B", { id: "TEST-receipt-answer" });
    assert.deepEqual(await footers(answered), [
      "TEST-receipt-answer",
      ["TEST-receipt-answer"],
    ]);
  } finally {
    await h.close();
  }
});

test("a receipt under an approval keeps the files of the sent message", async () => {
  const [receipt] = await answerReceipts(
    sources([
      storedTurn("TEST-cmd-1", "TEST-chat", {
        aliases: [
          { commandId: "TEST-cmd-1", hash: "TEST-hash-cmd-1" },
          {
            commandId: "TEST-approve-key",
            outerCommandId: "TEST-approve",
            hash: "TEST-hash-approve",
          },
        ],
      }),
    ]),
  );
  assert.equal(receipt?.commandId, "TEST-approve");
  assert.deepEqual(
    receipt?.files.map((item) => item.title),
    ["offer.pdf"],
  );
});

test("a memory saved after a question answer sits under that answer", async () => {
  const h = createTrustHarness();
  try {
    const fact = "TEST I prefer Room B";
    let asked = false;
    h.onChat((body) => {
      if (!asked) {
        asked = true;
        return h.call("ask_user", { question: "TEST Which room?" });
      }
      return toolResults(body).some((result) => result.results)
        ? { content: "TEST Noted, Room B." }
        : h.call("memory_remember", {
            facts: [{ text: fact, kind: "preference" }],
          });
    });
    await h.send("TEST book a room", { id: "TEST-memory-request" });
    const answered = await h.send(`Remember: ${fact}`, {
      id: "TEST-memory-answer",
    });
    const answer = answered.snapshot.conversations[0]!.messages.findLast(
      (message) => message.role === "assistant",
    )!;
    const saved = (
      await h.memoryStore.list(h.memoryActor, { settings: h.memorySettings })
    ).find((item) => item.content === fact && item.status === "active");
    assert(saved?.source?.type === "user_message");
    assert.equal(answer.replyToCommandId, "TEST-memory-answer");
    // The chat shows a save under the reply whose request id it carries.
    assert.equal(saved.source.commandId, answer.replyToCommandId);
  } finally {
    await h.close();
  }
});

test("a memory saved after an approval sits under that answer", async () => {
  const h = createTrustHarness();
  try {
    const fact = "TEST I prefer Room B";
    h.onChat((body) => {
      const results = toolResults(body);
      if (results.some((result) => result.results))
        return { content: "TEST Created and noted." };
      return results.some((result) => result.data?.created)
        ? h.call("memory_remember", {
            facts: [{ text: fact, kind: "preference" }],
          })
        : h.writeScript(body);
    });
    const proposed = await h.send(`Remember: ${fact}. TEST create a meeting`, {
      id: "TEST-memory-approval-request",
    });
    const card = proposed.snapshot.conversations[0]!.messages.at(-1)!.result;
    assert(
      card?.type === "service.action" && card.status === "awaiting_approval",
    );
    const approved = await h.execute(
      CommandSchema.parse({
        type: "service.resolve",
        commandId: "TEST-memory-approve",
        idempotencyKey: "TEST-memory-approve",
        conversationId: "conversation-1",
        operationId: card.operationId,
        approved: true,
        language: "en",
      }),
    );
    const answer = approved.snapshot.conversations[0]!.messages.findLast(
      (message) => message.role === "assistant",
    )!;
    const saved = (
      await h.memoryStore.list(h.memoryActor, { settings: h.memorySettings })
    ).find((item) => item.content === fact && item.status === "active");
    assert(saved?.source?.type === "user_message");
    assert.equal(answer.replyToCommandId, "TEST-memory-approve");
    assert.equal(saved.source.commandId, answer.replyToCommandId);
  } finally {
    await h.close();
  }
});

test("a second approval of a settled card from another device changes nothing", async () => {
  const h = createTrustHarness();
  try {
    const fact = "TEST I prefer Room B";
    h.onChat((body) => {
      const results = toolResults(body);
      if (results.some((result) => result.results))
        return { content: "TEST Created and noted." };
      return results.some((result) => result.data?.created)
        ? h.call("memory_remember", {
            facts: [{ text: fact, kind: "preference" }],
          })
        : h.writeScript(body);
    });
    const proposed = await h.send(`Remember: ${fact}. TEST create a meeting`, {
      id: "TEST-twice-request",
    });
    const card = proposed.snapshot.conversations[0]!.messages.at(-1)!.result;
    assert(
      card?.type === "service.action" && card.status === "awaiting_approval",
    );
    const approve = (commandId: string) =>
      h.execute(
        CommandSchema.parse({
          type: "service.resolve",
          commandId,
          idempotencyKey: commandId,
          conversationId: "conversation-1",
          operationId: card.operationId,
          approved: true,
          language: "en",
        }),
      );
    const view = async (result: Awaited<ReturnType<typeof approve>>) => {
      const messages = result.snapshot.conversations[0]!.messages;
      const receipts = await answerReceipts(
        sources(
          h.catalog.conversationTurns(
            h.scope.workspaceId,
            h.scope.userId,
            "conversation-1",
            8,
          ),
        ),
      );
      const saved = (
        await h.memoryStore.list(h.memoryActor, { settings: h.memorySettings })
      ).find((item) => item.content === fact && item.status === "active");
      return {
        messages: messages.map((m) => [
          m.role,
          m.text,
          m.replyToCommandId,
          m.result?.type === "service.action" ? m.result.status : null,
        ]),
        receipts: receipts.map((r) => r.commandId),
        saved:
          saved?.source?.type === "user_message"
            ? saved.source.commandId
            : undefined,
      };
    };
    const first = await view(await approve("TEST-twice-a"));
    assert.deepEqual(first.receipts, ["TEST-twice-a"]);
    assert.equal(first.saved, "TEST-twice-a");
    assert.equal(first.messages.at(-1)?.[2], "TEST-twice-a");
    // The other device approves the same card under its own command.
    assert.deepEqual(await view(await approve("TEST-twice-b")), first);
  } finally {
    await h.close();
  }
});

test("a second approval of a declined card changes nothing", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) => h.writeScript(body));
    const proposed = await h.send("TEST create a meeting", {
      id: "TEST-declined-request",
    });
    const card = proposed.snapshot.conversations[0]!.messages.at(-1)!.result;
    assert(
      card?.type === "service.action" && card.status === "awaiting_approval",
    );
    const resolve = (commandId: string, approved: boolean) =>
      h.execute(
        CommandSchema.parse({
          type: "service.resolve",
          commandId,
          idempotencyKey: commandId,
          conversationId: "conversation-1",
          operationId: card.operationId,
          approved,
          language: "en",
        }),
      );
    const messages = (result: Awaited<ReturnType<typeof resolve>>) =>
      result.snapshot.conversations[0]!.messages.map((m) => [
        m.text,
        m.replyToCommandId,
        m.result?.type === "service.action" ? m.result.status : null,
      ]);
    const declined = messages(await resolve("TEST-declined-a", false));
    assert.deepEqual(
      messages(await resolve("TEST-declined-b", true)),
      declined,
    );
  } finally {
    await h.close();
  }
});
