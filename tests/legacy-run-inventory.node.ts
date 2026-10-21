import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { CommandSchema, ScopeSchema } from "../packages/protocol";
import {
  classifyLegacyInventory,
  LEGACY_INVENTORY_LIMITS,
  type InventoryRows,
} from "../apps/server-identity/legacy-run-inventory";
import { processDigest } from "../apps/server-identity/process-validation";
import { ProcessQuestionSchema } from "../packages/protocol/process-questions";
import { JournalSchema } from "../apps/server-identity/service-process-journal";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scope = ScopeSchema.parse({
  connectionId: "account-TEST-workspace",
  serverId: "fixture-123456789012345678901234",
  userId: "TEST-user",
  workspaceId: "TEST-workspace",
});
const organizationId = "TEST-organization";
const scopeKey = JSON.stringify([
  scope.connectionId,
  scope.serverId,
  scope.userId,
  scope.workspaceId,
]);
const command = (id: string, text = "TEST original goal") =>
  CommandSchema.parse({
    type: "message.send",
    commandId: id,
    idempotencyKey: id,
    conversationId: "conversation-1",
    text,
    language: "en",
  });
const key = (id: string) =>
  hash([scope.serverId, scope.workspaceId, scope.userId, id]);
function fixture(kind: "agent-1" | "progressive-1" | "legacy" = "agent-1") {
  const original = command("TEST-original");
  assert.equal(original.type, "message.send");
  const value: Record<string, unknown> = {
    hash: hash([original.text, original.language]),
    answer: { reply: "TEST final reply" },
  };
  if (kind !== "legacy")
    Object.assign(value, {
      kind,
      commandId: original.idempotencyKey,
      text: original.text,
      language: original.language,
      paused: false,
    });
  if (kind === "agent-1")
    Object.assign(value, {
      requestHash: hash(original),
      operations: [],
      pendingCalls: [],
      continuityPending: false,
    });
  if (kind === "progressive-1")
    Object.assign(value, { steps: [], pendingInput: false });
  const data: InventoryRows = {
    serverId: scope.serverId,
    turns: [
      {
        id: key(original.idempotencyKey),
        workspace_id: scope.workspaceId,
        user_id: scope.userId,
        data: JSON.stringify(value),
      },
    ],
    invocations: [],
    links: [],
    workspaces: [{ id: scope.workspaceId, organization_id: organizationId }],
    workflows: [
      {
        scope_key: scopeKey,
        state: JSON.stringify({
          snapshot: {
            scope,
            conversations: [
              {
                id: "conversation-1",
                messages: [
                  {
                    role: "assistant",
                    text: "TEST final reply",
                    replyToCommandId: original.commandId,
                  },
                ],
              },
            ],
          },
        }),
      },
    ],
    receipts: [
      {
        scope_key: scopeKey,
        command_id: original.commandId,
        idempotency_key: original.idempotencyKey,
        payload: JSON.stringify({ status: "accepted", command: original }),
      },
    ],
  };
  const save = () => {
    data.turns[0]!.data = JSON.stringify(value);
  };
  return { data, value, original, save };
}
function addOperation(
  h: ReturnType<typeof fixture>,
  status:
    | "awaiting_approval"
    | "running"
    | "succeeded"
    | "failed"
    | "unknown"
    | "rejected",
  id = "TEST-operation",
) {
  const receipt = {
    id,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    organizationId,
    status,
    effect: "write",
  };
  h.data.invocations.push({
    id,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(receipt),
  });
  if (h.value.kind === "agent-1") h.value.operations = [id];
  else if (h.value.kind === "progressive-1")
    h.value.steps = [{ plan: { operationId: id } }];
  else h.value.plan = { operationId: id };
  h.save();
}
function consumedFixture() {
  const h = fixture();
  Object.assign(h.value, {
    epoch: 1,
    clock: { referenceNow: "2026-10-07T12:00:00.000Z" },
    paused: true,
    working: {
      conversationId: "conversation-1",
      goal: "TEST original goal",
      openedAt: "2026-10-07T12:00:00.000Z",
      question: "TEST original question",
      sources: [],
    },
    answer: { reply: "TEST original question" },
  });
  h.save();
  h.data.workflows[0]!.state = JSON.stringify({
    snapshot: {
      scope,
      conversations: [
        {
          id: "conversation-1",
          messages: [
            {
              role: "assistant",
              text: "TEST original question",
              replyToCommandId: h.original.commandId,
            },
          ],
        },
      ],
    },
  });
  const answer = command("TEST-answer", "TEST human answer");
  assert.equal(answer.type, "message.send");
  const root: Record<string, unknown> = {
    kind: "mastra-1",
    runId: key(answer.idempotencyKey),
    goal: "TEST original goal",
    conversationId: "conversation-1",
    operations: [],
    aliases: [
      {
        commandId: answer.idempotencyKey,
        hash: hash([answer.text, answer.language]),
        requestHash: hash(answer),
      },
    ],
    legacyQuestion: {
      kind: "agent-1",
      turnId: key(h.original.idempotencyKey),
      turnHash: hash(h.value),
      commandId: h.original.commandId,
      requestHash: hash(h.original),
      scopeHash: hash([scope, organizationId]),
      conversationId: "conversation-1",
      question: "TEST original question",
      decision: "accepted",
      sources: [],
    },
  };
  h.data.turns.push({
    id: root.runId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(root),
  });
  h.data.receipts.push({
    scope_key: scopeKey,
    command_id: answer.commandId,
    idempotency_key: answer.idempotencyKey,
    payload: JSON.stringify({ status: "accepted", command: answer }),
  });
  const saveRoot = () => {
    for (const row of h.data.turns.slice(1)) row.data = JSON.stringify(root);
  };
  return { ...h, root, answer, saveRoot };
}

function nativeReceiptFixture() {
  const h = fixture();
  const runId = "TEST-native-process",
    scopeDigest = processDigest([
      scope.serverId,
      organizationId,
      scope.workspaceId,
      scope.userId,
    ]),
    turnId = processDigest(["service-process-1", scopeDigest, runId]),
    callId = "TEST-native-call",
    operationId = processDigest([turnId, "action", callId]);
  const journal = JournalSchema.parse({
    kind: "service-process-1",
    runId,
    processId: "TEST-native-definition",
    version: 1,
    artifactDigest: "0".repeat(64),
    compilerVersion: "niaro-native-workflow/3",
    scopeDigest,
    inputDigest: processDigest({ private: "TEST-private-native-input" }),
    input: { private: "TEST-private-native-input" },
    text: "TEST-private-native-goal",
    status: "succeeded",
    startedAt: 1,
    visited: [],
    operations: [operationId],
    receipts: [{ callId, operationId }],
    sources: [],
    trace: {
      startedAt: new Date(0).toISOString(),
      finishedAt: new Date(1).toISOString(),
      status: "succeeded",
      steps: [],
      truncated: false,
    },
  });
  h.data.turns.push({
    id: turnId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(journal),
  });
  h.data.invocations.push({
    id: operationId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify({
      id: operationId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId,
      status: "succeeded",
      effect: "write",
    }),
  });
  h.data.links.push({
    operation_id: operationId,
    turn_id: turnId,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
  });
  return { h, journal, turnId, operationId, callId };
}

function finishNativeJournal(
  journal: ReturnType<typeof nativeReceiptFixture>["journal"],
  status: "succeeded" | "failed" | "cancelled" | "waiting",
) {
  journal.status = status;
  journal.trace.status = status;
  journal.trace.finishedAt = new Date(1).toISOString();
  if (status === "succeeded" || status === "waiting") delete journal.failure;
  else journal.failure = { code: `TEST-process-${status}` };
}

function nativeApprovalWaitFixture() {
  const fixture = nativeReceiptFixture();
  const { h, journal, operationId, callId } = fixture;
  finishNativeJournal(journal, "waiting");
  journal.pending = { nodeId: "approval_step", operationId };
  h.data.invocations[0]!.data = JSON.stringify({
    id: operationId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    organizationId,
    status: "awaiting_approval",
    effect: "write",
  });
  journal.trace.steps.push({
    id: "approval-step",
    kind: "tool",
    label: "TEST approval",
    status: "waiting",
    startedAt: new Date(0).toISOString(),
    finishedAt: new Date(1).toISOString(),
    details: [],
    callId,
    action: {
      operationId,
      serviceName: "TEST service",
      actionName: "TEST action",
      effect: "write",
      status: "awaiting_approval",
      phase: "proposal",
      input: [],
      output: [],
      inputTruncated: false,
      outputTruncated: false,
    },
  });
  h.data.turns[1]!.data = JSON.stringify(journal);
  return fixture;
}

function nativeQuestionWaitFixture() {
  const fixture = nativeReceiptFixture();
  const { h, journal } = fixture;
  finishNativeJournal(journal, "waiting");
  const proof = ProcessQuestionSchema.parse({
    kind: "question",
    questionId: processDigest([
      fixture.turnId,
      "question",
      "meeting_step",
      processDigest([fixture.turnId, "agent", "meeting_step"]),
      "TEST-native-question-call",
    ]),
    questionRevision: 1,
    parentRunId: fixture.turnId,
    nodeId: "meeting_step",
    childRunId: processDigest([fixture.turnId, "agent", "meeting_step"]),
    childThreadId: processDigest([
      fixture.turnId,
      journal.scopeDigest,
      "agent-thread",
      "meeting_step",
    ]),
    resourceId: journal.scopeDigest,
    toolCallId: "TEST-native-question-call",
    question: "TEST missing detail?",
    questionDigest: processDigest("TEST missing detail?"),
    artifactDigest: journal.artifactDigest,
    compilerVersion: journal.compilerVersion,
    inputDigest: journal.inputDigest,
    issuedWorkRevision: 1,
  });
  journal.pending = proof;
  journal.agents[proof.nodeId] = {
    runId: proof.childRunId,
    threadId: proof.childThreadId,
    inputDigest: journal.inputDigest,
    questionRevision: proof.questionRevision,
    decisions: [],
    pending: {
      kind: "question",
      toolCallId: proof.toolCallId,
      question: proof.question,
      questionProof: proof,
    },
  };
  h.data.turns[1]!.data = JSON.stringify(journal);
  return fixture;
}

for (const kind of ["agent-1", "progressive-1", "legacy"] as const) {
  test(`supported ${kind} recorded text completion is passive without reading transcript semantics`, () => {
    const h = fixture(kind),
      before = structuredClone(h.data);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, true);
    assert.equal(result.counts.passiveTurns, 1);
    assert.deepEqual(h.data, before);
  });
  for (const status of [
    "succeeded",
    "unknown",
    "failed",
    "rejected",
  ] as const) {
    test(`${kind} canonical ${status} receipt stays passive while an unfinished enclosing turn blocks`, () => {
      const h = fixture(kind);
      addOperation(h, status);
      delete h.value.answer;
      h.save();
      const result = classifyLegacyInventory(h.data);
      assert.equal(result.counts.passiveReceipts, 1);
      assert.equal(result.counts.passiveTurns, 0);
      assert.equal(result.classificationComplete, false);
      assert(
        result.entries[0]!.blockers.includes("completed_control_unproven"),
      );
    });
  }
}
test("a persisted executable batch is counted without inspecting or exporting tool arguments", () => {
  const h = fixture();
  addOperation(h, "succeeded");
  delete h.value.answer;
  h.value.pendingCalls = [
    {
      function: {
        name: "TEST-PRIVATE-NAME",
        arguments: "TEST-PRIVATE-ARGUMENTS",
      },
    },
  ];
  h.save();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.counts.passiveReceipts, 1);
  assert(!JSON.stringify(result).includes("TEST-PRIVATE"));
});
test("shared canonical receipts are counted once; unrelated native rows cannot cover an orphan", () => {
  const h = fixture();
  addOperation(h, "unknown");
  const second = command("TEST-second");
  assert.equal(second.type, "message.send");
  h.data.turns.push({
    ...h.data.turns[0]!,
    id: key(second.idempotencyKey),
    data: JSON.stringify({ ...h.value, commandId: second.idempotencyKey }),
  });
  assert.equal(classifyLegacyInventory(h.data).counts.passiveReceipts, 1);
  h.data.turns = [
    {
      id: key("TEST-unrelated"),
      workspace_id: "TEST-other-workspace",
      user_id: "TEST-other-user",
      data: JSON.stringify({ kind: "mastra-1", operations: [] }),
    },
  ];
  assert(classifyLegacyInventory(h.data).blockers.includes("unowned_receipt"));
});
test("a waiting question without public proof is active and blocks classification", () => {
  const h = consumedFixture();
  h.data.turns.pop();
  h.data.receipts = [];
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.classificationComplete, false);
  assert(result.entries[0]!.blockers.includes("question_proof_missing"));
});
test("a genuine-shaped canonical singleton can have multiple separately owned aliases", () => {
  const h = consumedFixture(),
    next = command("TEST-alias", "TEST further answer");
  assert.equal(next.type, "message.send");
  (h.root.aliases as unknown[]).push({
    commandId: next.idempotencyKey,
    hash: hash([next.text, next.language]),
    requestHash: hash(next),
  });
  h.data.turns.push({ ...h.data.turns[1]!, id: key(next.idempotencyKey) });
  h.data.receipts.push({
    scope_key: scopeKey,
    command_id: next.commandId,
    idempotency_key: next.idempotencyKey,
    payload: JSON.stringify({ status: "accepted", command: next }),
  });
  h.saveRoot();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.classificationComplete, false);
  assert(result.blockers.includes("native_unclassified"));
  assert.deepEqual(
    result.nativeRuns,
    h.data.turns
      .slice(1)
      .map((turn) => ({
        id: String(turn.id),
        kind: "mastra-1" as const,
        classification: "unclassified" as const,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  );
  assert.equal(result.counts.passiveTurns, 1);
  assert.equal(result.counts.activeTurns, 0);
});
const consumedMutations: Record<
  string,
  (h: ReturnType<typeof consumedFixture>) => void
> = {
  scopeHash: (h) => {
    (h.root.legacyQuestion as Record<string, unknown>).scopeHash = "0".repeat(
      64,
    );
    h.saveRoot();
  },
  "outer request": (h) => {
    const value = JSON.parse(String(h.data.receipts[0]!.payload));
    value.command.text = "TEST changed original command";
    h.data.receipts[0]!.payload = JSON.stringify(value);
  },
  "correlated question": (h) => {
    const value = JSON.parse(String(h.data.workflows[0]!.state));
    value.snapshot.conversations[0].messages[0].text =
      "TEST different question";
    h.data.workflows[0]!.state = JSON.stringify(value);
  },
  "missing alias": (h) => {
    (h.root.aliases as unknown[]).push({
      commandId: "TEST-missing",
      hash: "0".repeat(64),
      requestHash: "0".repeat(64),
    });
    h.saveRoot();
  },
  "alias request": (h) => {
    (h.root.aliases as Record<string, unknown>[])[0]!.requestHash = "0".repeat(
      64,
    );
    h.saveRoot();
  },
  "alias scope": (h) => {
    h.data.turns[1]!.user_id = "TEST-other-user";
  },
  "alias connection": (h) => {
    h.data.receipts[1]!.scope_key = JSON.stringify([
      "TEST-foreign-connection",
      scope.serverId,
      scope.userId,
      scope.workspaceId,
    ]);
  },
  "duplicate canonical root": (h) => {
    const other = { ...h.root, runId: key("TEST-duplicate") };
    h.data.turns.push({
      ...h.data.turns[1]!,
      id: other.runId,
      data: JSON.stringify(other),
    });
  },
  "unsupported origin": (h) => {
    h.data.turns.push({
      ...h.data.turns[1]!,
      id: key("TEST-bad-origin"),
      data: JSON.stringify({
        kind: "mastra-1",
        legacyQuestion: h.root.legacyQuestion,
      }),
    });
  },
};
for (const [name, mutate] of Object.entries(consumedMutations))
  test(`derived ${name} mismatch cannot consume a legacy question`, () => {
    const h = consumedFixture();
    mutate(h);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.counts.activeTurns, 1);
    assert.equal(result.counts.passiveTurns, 0);
  });
test("consumption cannot clear a separate awaiting operation linked to the old question", () => {
  const h = consumedFixture();
  const receipt = {
    id: "TEST-extra",
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    organizationId,
    status: "awaiting_approval",
    effect: "write",
  };
  h.data.invocations.push({
    id: receipt.id,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(receipt),
  });
  h.data.links.push({
    operation_id: receipt.id,
    turn_id: h.data.turns[0]!.id,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
  });
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.counts.awaitingReceipts, 1);
  assert.equal(result.classificationComplete, false);
});
test("absent-kind delegation stays unclassified, including a terminal receipt", () => {
  const h = fixture("legacy");
  addOperation(h, "succeeded");
  h.value.delegate = true;
  h.save();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.passiveReceipts, 1);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.counts.passiveTurns, 0);
  assert.equal(result.classificationComplete, false);
});
test("malformed decisive states and arbitrary kinds/keys never leak into output", () => {
  const h = fixture();
  h.value.paused = "false";
  h.save();
  assert.equal(classifyLegacyInventory(h.data).classificationComplete, false);
  h.data.turns[0]!.data = JSON.stringify({ kind: "SECRET-RAW-KIND" });
  h.data.turns[0]!.id = "SECRET-RAW-KEY";
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.entries[0]!.id, null);
  assert.equal(result.entries[0]!.kind, "unsupported");
  assert(!JSON.stringify(result).includes("SECRET"));
});
test("overflow and large scope keys cannot establish complete classification", () => {
  const h = consumedFixture();
  h.data.turns = Array.from(
    { length: LEGACY_INVENTORY_LIMITS.rows + 1 },
    () => h.data.turns[0]!,
  );
  assert.equal(classifyLegacyInventory(h.data).classificationComplete, false);
  const large = fixture();
  large.data.receipts[0]!.scope_key = "X".repeat(
    LEGACY_INVENTORY_LIMITS.rowBytes + 1,
  );
  assert.equal(
    classifyLegacyInventory(large.data).classificationComplete,
    false,
  );
});

test("an old persisted receipt mapping cannot hide an awaiting operation omitted from operations", () => {
  const h = fixture();
  addOperation(h, "awaiting_approval");
  h.value.operations = [];
  h.value.receipts = [{ callId: "TEST-call", operationId: "TEST-operation" }];
  h.save();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.counts.awaitingReceipts, 1);
  assert.equal(result.classificationComplete, false);
  assert(result.entries[0]!.blockers.includes("unclaimed_receipt"));
});
test("a terminal old answer cannot borrow a stale public result with the same reply text", () => {
  const h = fixture();
  addOperation(h, "succeeded");
  h.value.answer = {
    reply: "TEST final reply",
    result: { operationId: "TEST-operation", status: "succeeded" },
  };
  h.save();
  const value = JSON.parse(String(h.data.workflows[0]!.state));
  value.snapshot.conversations[0].messages[0].result = {
    operationId: "TEST-operation",
    status: "awaiting_approval",
  };
  h.data.workflows[0]!.state = JSON.stringify(value);
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.passiveReceipts, 1);
  assert.equal(result.counts.passiveTurns, 0);
  assert.equal(result.classificationComplete, false);
});
test("historical progressive paused prose does not by itself prove active continuation", () => {
  const h = fixture("progressive-1");
  h.value.paused = true;
  h.save();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.activeTurns, 0);
  assert.equal(result.counts.passiveTurns, 0);
  assert.equal(result.classificationComplete, false);
  assert(result.entries[0]!.blockers.includes("continuation_unclassified"));
});
test("unknown or malformed native journals block old consumption across the full scan", () => {
  for (const value of [
    { kind: "TEST-private-native-kind" },
    {
      kind: "mastra-1",
      runId: key("TEST-unrelated"),
      operations: [],
      aliases: [42],
    },
    {
      kind: "service-process-1",
      runId: "TEST-process",
      operations: "TEST-malformed",
    },
  ]) {
    const h = consumedFixture();
    h.data.turns.push({
      id: key("TEST-unrelated"),
      workspace_id: scope.workspaceId,
      user_id: scope.userId,
      data: JSON.stringify(value),
    });
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.counts.passiveTurns, 0);
    assert.equal(result.counts.activeTurns, 1);
    assert.equal(
      result.nativeRuns.length,
      value.kind === "mastra-1" || value.kind === "service-process-1" ? 2 : 1,
    );
    assert(!JSON.stringify(result).includes("TEST-private"));
  }
});
test("an unrelated observed service process blocks classification without hiding an exact consumed question", () => {
  const h = consumedFixture(),
    native = nativeReceiptFixture();
  native.journal.operations = [];
  native.journal.receipts = [];
  native.h.data.turns[1]!.data = JSON.stringify(native.journal);
  h.data.turns.push({ ...native.h.data.turns[1]! });

  const result = classifyLegacyInventory(h.data);
  assert.equal(result.counts.passiveTurns, 1);
  assert.equal(result.counts.activeTurns, 0);
  assert.equal(result.classificationComplete, false);
  assert.deepEqual(result.nativeRuns.map(({ kind }) => kind).sort(), [
    "mastra-1",
    "service-process-1",
  ]);
  assert(result.blockers.includes("native_unclassified"));
});
test("native service-process terminal journal claims require consistent trace and settled receipts", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const { h, journal } = nativeReceiptFixture();
    finishNativeJournal(journal, status);
    h.data.turns[1]!.data = JSON.stringify(journal);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, true, status);
    assert.deepEqual(result.nativeRuns, [
      {
        id: String(h.data.turns[1]!.id),
        kind: "service-process-1",
        classification: "terminal_candidate",
        status,
      },
    ]);
    assert.equal(result.counts.activeTurns, 0, status);
    assert(!result.blockers.includes("unowned_receipt"), status);
    assert(!result.blockers.includes("native_unclassified"), status);
    assert(
      !JSON.stringify(result).includes("TEST-private-native-input") &&
        !JSON.stringify(result).includes("TEST-private-native-goal"),
      status,
    );
  }
});
test("succeeded claims reject failed receipts even when trace actions are omitted", () => {
  for (const withTraceAction of [false, true]) {
    const { h, journal, operationId, callId } = nativeReceiptFixture();
    h.data.invocations[0]!.data = JSON.stringify({
      id: operationId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId,
      status: "failed",
      effect: "write",
    });
    if (withTraceAction)
      journal.trace.steps.push({
        id: "failed-action",
        kind: "tool",
        label: "TEST failed action",
        status: "failed",
        startedAt: new Date(0).toISOString(),
        finishedAt: new Date(1).toISOString(),
        details: [],
        callId,
        action: {
          operationId,
          serviceName: "TEST service",
          actionName: "TEST action",
          effect: "write",
          status: "failed",
          phase: "execution",
          input: [],
          output: [],
          inputTruncated: false,
          outputTruncated: false,
        },
      });
    h.data.turns[1]!.data = JSON.stringify(journal);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false, String(withTraceAction));
    assert(result.blockers.includes("native_lifecycle_invalid"));
    assert.equal(result.nativeRuns[0]!.classification, "unclassified");
  }
});
test("native waiting approval and question claims are classified but still block completion", () => {
  for (const fixture of [
    nativeApprovalWaitFixture(),
    nativeQuestionWaitFixture(),
  ]) {
    const { h } = fixture;
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert(result.blockers.includes("native_waiting"));
    assert(!result.blockers.includes("native_unclassified"));
    assert.deepEqual(result.nativeRuns, [
      {
        id: String(h.data.turns[1]!.id),
        kind: "service-process-1",
        classification: "waiting",
        status: "waiting",
      },
    ]);
    assert(!JSON.stringify(result).includes("TEST-private-native-input"));
    assert(!JSON.stringify(result).includes("TEST-private-native-goal"));
  }
});
test("native question waits require the proof to bind to the parent journal", () => {
  const { h, journal } = nativeQuestionWaitFixture();
  if (!journal.pending || !("kind" in journal.pending))
    throw new Error("fixture question missing");
  const stale = { ...journal.pending, parentRunId: "TEST-stale-parent" };
  journal.pending = stale;
  const child = journal.agents[stale.nodeId]!;
  if (!child.pending || child.pending.kind !== "question")
    throw new Error("fixture child question missing");
  child.pending = { ...child.pending, questionProof: stale };
  h.data.turns[1]!.data = JSON.stringify(journal);
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.classificationComplete, false);
  assert(result.blockers.includes("native_lifecycle_invalid"));
  assert.equal(result.nativeRuns[0]!.classification, "unclassified");
});
test("native question waits require a deterministic proof and node-keyed child", () => {
  for (const mismatch of [
    "question id",
    "child node key",
    "future work revision",
  ] as const) {
    const { h, journal } = nativeQuestionWaitFixture();
    if (!journal.pending || !("kind" in journal.pending))
      throw new Error("fixture question missing");
    if (mismatch === "question id") {
      const stale = { ...journal.pending, questionId: "TEST-stale-question" };
      journal.pending = stale;
      const child = journal.agents[stale.nodeId]!;
      if (!child.pending || child.pending.kind !== "question")
        throw new Error("fixture child question missing");
      child.pending = { ...child.pending, questionProof: stale };
    } else if (mismatch === "future work revision") {
      const stale = {
        ...journal.pending,
        issuedWorkRevision: journal.revision + 1,
      };
      journal.pending = stale;
      const child = journal.agents[stale.nodeId]!;
      if (!child.pending || child.pending.kind !== "question")
        throw new Error("fixture child question missing");
      child.pending = { ...child.pending, questionProof: stale };
    } else {
      journal.agents.wrong_node = journal.agents[journal.pending.nodeId]!;
      delete journal.agents[journal.pending.nodeId];
    }
    h.data.turns[1]!.data = JSON.stringify(journal);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false, mismatch);
    assert(result.blockers.includes("native_lifecycle_invalid"), mismatch);
    assert.equal(
      result.nativeRuns[0]!.classification,
      "unclassified",
      mismatch,
    );
  }
});
test("unknown, running, pending and contradictory service-process journals remain unclassified", () => {
  const faults: {
    name: string;
    update(fixture: ReturnType<typeof nativeReceiptFixture>): void;
    blocker: string;
  }[] = [
    {
      name: "running",
      update: ({ journal }) => {
        journal.status = "running";
        journal.trace.status = "running";
        journal.trace.finishedAt = null;
      },
      blocker: "native_lifecycle_invalid",
    },
    {
      name: "unknown",
      update: ({ journal }) => finishNativeJournal(journal, "waiting"),
      blocker: "native_lifecycle_invalid",
    },
    {
      name: "unknown status",
      update: ({ journal }) => {
        journal.status = "unknown";
        journal.trace.status = "unknown";
        journal.failure = { code: "TEST-unknown" };
      },
      blocker: "native_status_unknown",
    },
    {
      name: "trace drift",
      update: ({ journal }) => {
        journal.trace.status = "failed";
      },
      blocker: "native_lifecycle_invalid",
    },
    {
      name: "pending on terminal",
      update: ({ journal }) => {
        journal.pending = { nodeId: "approval_step", operationId: "TEST-op" };
      },
      blocker: "native_lifecycle_invalid",
    },
    {
      name: "running receipt",
      update: ({ h, operationId }) => {
        h.data.invocations[0]!.data = JSON.stringify({
          id: operationId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          organizationId,
          status: "running",
          effect: "write",
        });
      },
      blocker: "native_lifecycle_invalid",
    },
    {
      name: "unknown receipt",
      update: ({ h, operationId }) => {
        h.data.invocations[0]!.data = JSON.stringify({
          id: operationId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
          organizationId,
          status: "unknown",
          effect: "write",
        });
      },
      blocker: "native_lifecycle_invalid",
    },
  ];
  for (const fault of faults) {
    const fixture = nativeReceiptFixture();
    if (fault.name === "unknown")
      finishNativeJournal(fixture.journal, "waiting");
    fault.update(fixture);
    fixture.h.data.turns[1]!.data = JSON.stringify(fixture.journal);
    const result = classifyLegacyInventory(fixture.h.data);
    assert.equal(result.classificationComplete, false, fault.name);
    assert(result.blockers.includes(fault.blocker), fault.name);
    assert(result.blockers.includes("native_unclassified"), fault.name);
    assert.equal(result.nativeRuns[0]!.classification, "unclassified");
    assert(!JSON.stringify(result).includes("TEST-private-native-input"));
  }
});
test("a cancelled native journal is not terminal when its operation identity contradicts the failed receipt", () => {
  const { h, journal, operationId } = nativeReceiptFixture();
  finishNativeJournal(journal, "cancelled");
  journal.failure = { code: "process_action_rejected", operationId };
  h.data.turns[1]!.data = JSON.stringify(journal);
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.classificationComplete, false);
  assert(result.blockers.includes("native_lifecycle_invalid"));
  assert.deepEqual(result.nativeRuns[0]!.classification, "unclassified");
});
test("legacy and native journals cannot both claim the same native receipt", () => {
  const { h, operationId } = nativeReceiptFixture();
  h.value.operations = [operationId];
  h.save();
  const result = classifyLegacyInventory(h.data);
  assert(result.blockers.includes("native_receipt_ambiguous"));
  assert(result.blockers.includes("unowned_receipt"));
  assert.equal(result.classificationComplete, false);
});
test("native receipt ownership fails closed for broken journal, receipt, link, and scope bindings", () => {
  const faults = [
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.h.data.turns[1]!.id = key("TEST-wrong-native-root");
      },
      unowned: true,
    },
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.journal.scopeDigest = "0".repeat(64);
        h.h.data.turns[1]!.data = JSON.stringify(h.journal);
      },
      unowned: true,
    },
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.h.data.links[0]!.turn_id = key("TEST-other-owner");
      },
      unowned: true,
    },
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.h.data.invocations[0]!.workspace_id = "TEST-foreign-workspace";
      },
      unowned: false,
    },
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.journal.receipts.push({ ...h.journal.receipts[0]! });
        h.h.data.turns[1]!.data = JSON.stringify(h.journal);
      },
      unowned: true,
    },
    {
      mutate: (h: ReturnType<typeof nativeReceiptFixture>) => {
        h.h.data.turns.push({ ...h.h.data.turns[1]! });
      },
      unowned: true,
    },
  ];
  for (const fault of faults) {
    const h = nativeReceiptFixture();
    fault.mutate(h);
    const result = classifyLegacyInventory(h.h.data);
    assert.equal(result.classificationComplete, false);
    assert(result.blockers.includes("native_unclassified"));
    assert.equal(result.blockers.includes("unowned_receipt"), fault.unowned);
  }
  const missing = nativeReceiptFixture();
  missing.h.data.invocations.length = 0;
  const missingResult = classifyLegacyInventory(missing.h.data);
  assert(missingResult.blockers.includes("native_receipt_unproven"));
  assert(!missingResult.blockers.includes("unowned_receipt"));
  const orphan = nativeReceiptFixture();
  orphan.h.data.invocations.push({
    id: "TEST-orphan-native-receipt",
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify({
      id: "TEST-orphan-native-receipt",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId,
      status: "succeeded",
      effect: "write",
    }),
  });
  assert(
    classifyLegacyInventory(orphan.h.data).blockers.includes("unowned_receipt"),
  );
});
test("consumed read-source proof must match every original source exactly", () => {
  const h = consumedFixture();
  const receipt = {
    id: "TEST-read",
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    organizationId,
    status: "succeeded",
    effect: "read",
  };
  h.value.operations = [receipt.id];
  (h.value.working as Record<string, unknown>).sources = [receipt.id];
  h.save();
  h.data.invocations.push({
    id: receipt.id,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(receipt),
  });
  Object.assign(h.root.legacyQuestion as Record<string, unknown>, {
    turnHash: hash(h.value),
    sources: [{ id: receipt.id, hash: hash(receipt) }],
  });
  h.saveRoot();
  const accepted = classifyLegacyInventory(h.data);
  assert.equal(accepted.classificationComplete, false);
  assert.equal(accepted.counts.passiveTurns, 1);
  assert.equal(accepted.counts.activeTurns, 0);
  assert.equal(accepted.nativeRuns.length, 1);
  (h.root.legacyQuestion as Record<string, unknown>).sources = [];
  h.saveRoot();
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.classificationComplete, false);
  assert.equal(result.counts.activeTurns, 1);
  assert.equal(result.counts.passiveReceipts, 1);
});

test("duplicate canonical journal identities globally deny passive entries and consumption", () => {
  for (const question of [false, true]) {
    const h = question ? consumedFixture() : fixture();
    h.data.turns.push({ ...h.data.turns[0]! });
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.counts.passiveTurns, 0);
    assert(result.blockers.includes("journal_identity_ambiguous"));
    if (question) assert(result.counts.activeTurns > 0);
  }
});
test("unsupported native process identity/scope never establishes old question consumption", () => {
  for (const shape of ["malformed", "plausible"] as const) {
    const h = consumedFixture(),
      scopeDigest = hash([
        scope.serverId,
        organizationId,
        scope.workspaceId,
        scope.userId,
      ]),
      input = {};
    const value =
      shape === "malformed"
        ? {
            kind: "service-process-1",
            runId: "TEST-process",
            scopeDigest: "TEST-bad-scope",
            operations: [],
          }
        : {
            kind: "service-process-1",
            runId: "TEST-process",
            processId: "TEST-definition",
            version: 1,
            artifactDigest: "0".repeat(64),
            compilerVersion: "TEST-compiler",
            scopeDigest,
            inputDigest: hash(input),
            input,
            text: "TEST native process",
            status: "succeeded",
            startedAt: 1,
            visited: [],
            operations: [],
            receipts: [],
            sources: [],
            trace: { steps: [] },
          };
    h.data.turns.push({
      id: hash(["service-process-1", scopeDigest, "TEST-process"]),
      workspace_id: scope.workspaceId,
      user_id: scope.userId,
      data: JSON.stringify(value),
    });
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.counts.passiveTurns, 0);
    assert.equal(result.counts.activeTurns, 1);
    assert(result.blockers.includes("native_unclassified"));
  }
});
test("an omitted old answer result cannot hide contradictory or malformed public control", () => {
  for (const publicResult of [
    { operationId: "TEST-operation", status: "awaiting_approval" },
    { operationId: "TEST-operation", status: "running" },
    { operationId: "TEST-operation", status: "failed" },
    { operationId: "TEST-other", status: "succeeded" },
    { status: "succeeded" },
    { operationId: "TEST-operation", status: "TEST-private-malformed" },
  ]) {
    const h = fixture();
    addOperation(h, "succeeded");
    const workflow = JSON.parse(String(h.data.workflows[0]!.state));
    workflow.snapshot.conversations[0].messages[0].result = publicResult;
    h.data.workflows[0]!.state = JSON.stringify(workflow);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, false);
    assert.equal(result.counts.passiveTurns, 0);
    assert.equal(result.counts.passiveReceipts, 1);
    assert(result.entries[0]!.blockers.includes("completed_control_unproven"));
    assert(!JSON.stringify(result).includes("TEST-private"));
  }
});
test("an omitted old answer result permits only correlated canonical terminal public control", () => {
  for (const status of [
    "succeeded",
    "unknown",
    "failed",
    "rejected",
  ] as const) {
    const h = fixture();
    addOperation(h, status);
    const workflow = JSON.parse(String(h.data.workflows[0]!.state));
    workflow.snapshot.conversations[0].messages[0].result = {
      type: "service.action",
      operationId: "TEST-operation",
      status,
      effect: "write",
    };
    h.data.workflows[0]!.state = JSON.stringify(workflow);
    const result = classifyLegacyInventory(h.data);
    assert.equal(result.classificationComplete, true);
    assert.equal(result.counts.passiveTurns, 1);
    assert.equal(result.counts.passiveReceipts, 1);
  }
});

test("pure row-count preflight returns finite empty output before row serialization or parsing", () => {
  const h = fixture();
  let serialized = 0,
    parsed = 0;
  const row = {
    ...h.data.turns[0]!,
    toJSON() {
      serialized++;
      return h.data.turns[0]!;
    },
  };
  h.data.turns = Array.from(
    { length: LEGACY_INVENTORY_LIMITS.rows + 1 },
    () => row,
  );
  const original = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsed++;
    return original(...args);
  }) as typeof JSON.parse;
  let result: ReturnType<typeof classifyLegacyInventory>;
  try {
    result = classifyLegacyInventory(h.data);
  } finally {
    JSON.parse = original;
  }
  assert.equal(serialized, 0);
  assert.equal(parsed, 0);
  assert.equal(result.classificationComplete, false);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.blockers, ["row_limit"]);
  assert(Object.values(result.counts).every((value) => value === 0));
});
test("pure aggregate flat-column byte preflight rejects individually bounded rows before any payload parse", () => {
  const h = fixture(),
    data = JSON.stringify({
      ...h.value,
      padding: "X".repeat(LEGACY_INVENTORY_LIMITS.rowBytes - 1024),
    });
  h.data.turns = Array.from({ length: 66 }, (_, i) => ({
    ...h.data.turns[0]!,
    id: key("TEST-large-" + i),
    data,
  }));
  assert(
    Buffer.byteLength(JSON.stringify(h.data.turns[0])) <
      LEGACY_INVENTORY_LIMITS.rowBytes,
  );
  let parsed = 0;
  const original = JSON.parse;
  JSON.parse = ((...args: Parameters<typeof JSON.parse>) => {
    parsed++;
    return original(...args);
  }) as typeof JSON.parse;
  let result: ReturnType<typeof classifyLegacyInventory>;
  try {
    result = classifyLegacyInventory(h.data);
  } finally {
    JSON.parse = original;
  }
  assert.equal(parsed, 0);
  assert.equal(result.classificationComplete, false);
  assert.deepEqual(result.entries, []);
  assert.deepEqual(result.blockers, ["payload_limit"]);
  assert(Object.values(result.counts).every((value) => value === 0));
});
test("consumption cannot hide a missing awaiting operation in either original raw or public question control", () => {
  for (const location of ["raw", "public"] as const) {
    const h = consumedFixture(),
      result = {
        type: "service.action",
        operationId: "TEST-missing-approval",
        status: "awaiting_approval",
        effect: "write",
      };
    if (location === "raw") {
      (h.value.answer as Record<string, unknown>).result = result;
      h.save();
      (h.root.legacyQuestion as Record<string, unknown>).turnHash = hash(
        h.value,
      );
      h.saveRoot();
    } else {
      const workflow = JSON.parse(String(h.data.workflows[0]!.state));
      workflow.snapshot.conversations[0].messages[0].result = result;
      h.data.workflows[0]!.state = JSON.stringify(workflow);
    }
    const observed = classifyLegacyInventory(h.data);
    assert.equal(observed.classificationComplete, false);
    assert.equal(observed.counts.passiveTurns, 0);
    assert.equal(observed.counts.activeTurns, 1);
  }
});
test("consumption retains matched original raw/public succeeded read control and exact source hashes", () => {
  const h = consumedFixture(),
    receipt = {
      id: "TEST-read",
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      organizationId,
      status: "succeeded",
      effect: "read",
    },
    control = {
      type: "service.action",
      operationId: receipt.id,
      status: "succeeded",
      effect: "read",
    };
  h.value.operations = [receipt.id];
  (h.value.working as Record<string, unknown>).sources = [receipt.id];
  (h.value.answer as Record<string, unknown>).result = control;
  h.save();
  h.data.invocations.push({
    id: receipt.id,
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    data: JSON.stringify(receipt),
  });
  Object.assign(h.root.legacyQuestion as Record<string, unknown>, {
    turnHash: hash(h.value),
    sources: [{ id: receipt.id, hash: hash(receipt) }],
  });
  h.saveRoot();
  const workflow = JSON.parse(String(h.data.workflows[0]!.state));
  workflow.snapshot.conversations[0].messages[0].result = control;
  h.data.workflows[0]!.state = JSON.stringify(workflow);
  const result = classifyLegacyInventory(h.data);
  assert.equal(result.classificationComplete, false);
  assert(result.blockers.includes("native_unclassified"));
  assert.equal(result.nativeRuns.length, 1);
  assert.equal(result.counts.passiveTurns, 1);
  assert.equal(result.counts.passiveReceipts, 1);
  assert.equal(result.counts.activeTurns, 0);
});
