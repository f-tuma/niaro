import { createHash } from "node:crypto";
import { WorkItemSchema, type Scope } from "../packages/protocol";
import {
  ProcessInputCardSchema,
  ProcessInputFormSchema,
  type ProcessExecutionEntry,
} from "../packages/protocol/process-execution";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { ProcessStartAdmissionSchema } from "../packages/protocol/process-start";
import { PROCESS_INPUT_JSON_MAX_BYTES } from "../packages/protocol/service-processes";
import {
  canonicalProcessJson,
  processCommandDigest,
  sha256Utf8,
} from "../packages/client-core/process-command-digest";
import {
  ProcessCommandTargetSchema,
  captureProcessStartTarget,
  captureProcessResolveTarget,
  assertProcessCommandTarget,
  validateProcessCommandTarget,
  processStartCommand,
  processResolveCommand,
  assertProcessCommandResponse,
} from "../packages/client-core/process-commands";
import type { Store } from "../packages/client-core/store";

/** Actual Node SHA-256 over the canonicalization used by the server processDigest. */
function serverDigest(value: unknown): string {
  function canonical(item: unknown): string {
    if (Array.isArray(item)) return "[" + item.map(canonical).join(",") + "]";
    if (item && typeof item === "object")
      return (
        "{" +
        Object.keys(item)
          .sort()
          .map(
            (key) =>
              JSON.stringify(key) +
              ":" +
              canonical((item as Record<string, unknown>)[key]),
          )
          .join(",") +
        "}"
      );
    return JSON.stringify(item);
  }
  return createHash("sha256").update(canonical(value)).digest("hex");
}

const endpoint = "https://TEST.invalid/v1/TEST-workspace";
const scope: Scope = {
  connectionId: "TEST-connection",
  serverId: "TEST-server",
  userId: "TEST-user",
  workspaceId: "TEST-workspace",
};
function startFixture() {
  const form = ProcessInputFormSchema.parse({
    profile: "agent-process-input/1",
    scope,
    language: "cs",
    processId: "TEST-process",
    name: "TEST process",
    description: "TEST reviewed process",
    kind: "workflow",
    version: 2,
    artifactDigest: "a".repeat(64),
    inputSchema: {
      type: "object",
      required: ["name"],
      additionalProperties: false,
      properties: {
        name: { type: "string" },
        enabled: { type: "boolean" },
        payload: {
          type: "object",
          required: [],
          additionalProperties: false,
          properties: { amount: { type: "number" }, empty: { type: "null" } },
        },
      },
    },
    origin: {
      type: "command",
      conversationId: "TEST-conversation",
      requestId: "TEST-request",
    },
  });
  const card = ProcessInputCardSchema.parse({
    form,
    formDigest: serverDigest(form),
    intent: {
      intentId: "TEST-intent",
      origin: form.origin,
      processId: form.processId,
      version: form.version,
      artifactDigest: form.artifactDigest,
      formDigest: serverDigest(form),
      inputSchema: form.inputSchema,
      fields: {},
      createdAt: "2026-10-06T10:00:00.000Z",
    },
  });
  const entry: ProcessExecutionEntry = {
    processId: form.processId,
    name: form.name,
    description: form.description,
    kind: form.kind,
    version: form.version,
    artifactDigest: form.artifactDigest,
    availability: "ready",
    inputSchema: form.inputSchema,
  };
  const target = captureProcessStartTarget(endpoint, scope, entry, card);
  const input = {
    commandId: "TEST-start",
    idempotencyKey: "TEST-start-key",
    language: "cs" as const,
    input: {
      name: " Žluťoučký 🦊\n",
      enabled: false,
      payload: { amount: 0, empty: null },
    },
  };
  const command = processStartCommand(target, input);
  const admission = ProcessStartAdmissionSchema.parse({
    profile: "agent-process-start/1",
    status: "admitted",
    receiptId: "TEST-admission",
    intentId: command.intentId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandDigest: serverDigest(command),
    origin: card.intent.origin,
    processId: card.intent.processId,
    version: card.intent.version,
    artifactDigest: card.intent.artifactDigest,
    formDigest: card.intent.formDigest,
    input: command.input,
    inputDigest: serverDigest(command.input),
    compilerVersion: "niaro-native-workflow/3",
    runId: "TEST-run",
    parentRunId: "TEST-parent",
    createdAt: "2026-10-06T10:00:01.000Z",
  });
  const result = ProcessRuntimeResponseSchema.parse({
    profile: "agent-process-execution/2",
    scope,
    commandId: command.commandId,
    admission,
    process: {
      parentRunId: admission.parentRunId,
      runId: admission.runId,
      processId: admission.processId,
      version: admission.version,
      revision: 7,
      status: "waiting",
      approval: { nodeId: "TEST-node-A", operationId: "TEST-operation-A" },
    },
  });
  return { target, entry, card, input, command, admission, result };
}
function resolveFixture() {
  const start = startFixture();
  const work = WorkItemSchema.parse({
    id: "TEST-parent",
    revision: 99,
    conversationId: "TEST-conversation",
    title: "TEST native approval",
    context: "TEST awaiting decision",
    status: "waiting_approval",
    inputRequestIds: [],
    actionProposalIds: [],
    operationIds: [],
    demo: false,
    presentation: { type: "workflow.progress", version: 1, variant: "default" },
    native: {
      runId: "TEST-parent",
      revision: 7,
      process: {
        kind: "service-process-1",
        status: "waiting",
        journalStatus: "waiting",
        journalRevision: 3,
        detailsAvailable: true,
        approval: {
          nodeId: "TEST-node-A",
          serviceId: "TEST-service",
          serviceRevision: 2,
          actionId: "TEST-action",
          actionRevision: 3,
          result: {
            type: "service.action",
            version: 1,
            operationId: "TEST-operation-A",
            title: "TEST approval A",
            service: "TEST service",
            status: "awaiting_approval",
            effect: "write",
            fields: [{ label: "TEST name", value: "TEST" }],
            inputJson:
              '{"name":"  TEST exact input\\n","amount":0,"enabled":false,"empty":null}',
            reviewTruncated: false,
            summary: "TEST write params",
          },
        },
        provenance: {
          runId: start.admission.runId,
          processId: start.admission.processId,
          version: start.admission.version,
          artifactDigest: start.admission.artifactDigest,
          actorId: scope.userId,
          conversationId: "TEST-conversation",
          commandId: start.admission.commandId,
          admissionId: start.admission.receiptId,
        },
        receipts: [
          {
            operationId: "TEST-earlier",
            title: "TEST prior",
            service: "TEST service",
            effect: "read",
            status: "succeeded",
            summary: "TEST earlier result",
          },
          {
            operationId: "TEST-operation-A",
            title: "TEST approval A",
            service: "TEST service",
            effect: "write",
            status: "awaiting_approval",
            summary: "TEST write params",
          },
        ],
      },
    },
  });
  const store: Store = {
    connectionKey: endpoint,
    scope: { ...scope },
    cursor: 1,
    conversations: {},
    workItems: { [work.id]: work },
    inputRequests: {},
    actionProposals: {},
    operations: {},
    seen: [],
    stale: false,
    needsSnapshot: false,
  };
  const target = captureProcessResolveTarget(
    store,
    work.id,
    "TEST-operation-A",
    work.conversationId,
  );
  const input = {
    commandId: "TEST-resolve-A",
    idempotencyKey: "TEST-resolve-key-A",
    approved: true,
    language: "cs" as const,
  };
  const command = processResolveCommand(store, target, input);
  return { ...start, work, store, target, input, command };
}
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
function emptyStore(): Store {
  return resolveFixture().store;
}

test.each<[number, string, string]>([
  [0, "", "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"],
  [
    3,
    "abc",
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  ],
  [
    56,
    "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
    "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
  ],
  [
    1_000_000,
    "a".repeat(1_000_000),
    "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
  ],
])(
  "portable SHA-256 matches standard vector of length %i",
  (length, value, expected) => {
    expect(value.length).toBe(length);
    expect(sha256Utf8(value)).toBe(expected);
    expect(sha256Utf8(value)).toBe(
      createHash("sha256").update(value).digest("hex"),
    );
  },
);
test("canonical digest matches Node for Unicode, ordering, nested arrays and large inputs", () => {
  const values = [
    null,
    false,
    -0,
    1.25e-9,
    "Žluťoučký 🦊 中文\n\u2028\ud800",
    { z: [{ b: false, a: null }, [], {}, '"\\\n'], a: { d: 4, c: 3 } },
    {
      values: Array.from({ length: 100 }, (_, i) => ({
        index: i,
        text: "🦊ž".repeat(200),
      })),
    },
  ];
  for (const value of values)
    expect(processCommandDigest(value)).toBe(serverDigest(value));
  expect(processCommandDigest({ b: 1, a: 2 })).toBe(
    processCommandDigest({ a: 2, b: 1 }),
  );
  expect(canonicalProcessJson({ z: 1, a: [2, 1] })).toBe('{"a":[2,1],"z":1}');
  for (const length of [55, 56, 63, 64, 65, 127, 128]) {
    const text = "ž😀\ud800".repeat(length);
    expect(sha256Utf8(text)).toBe(
      createHash("sha256").update(text).digest("hex"),
    );
  }
});
test("digest requires neither Buffer nor TextEncoder in the mobile runtime", () => {
  const value = { nested: [{ text: "ž🦊\udfff", empty: null }] },
    expected = serverDigest(value);
  const buffer = Object.getOwnPropertyDescriptor(globalThis, "Buffer");
  const encoder = Object.getOwnPropertyDescriptor(globalThis, "TextEncoder");
  let actual: string;
  try {
    Object.defineProperty(globalThis, "Buffer", {
      value: undefined,
      configurable: true,
    });
    Object.defineProperty(globalThis, "TextEncoder", {
      value: undefined,
      configurable: true,
    });
    actual = processCommandDigest(value);
  } finally {
    if (buffer) Object.defineProperty(globalThis, "Buffer", buffer);
    else Reflect.deleteProperty(globalThis, "Buffer");
    if (encoder) Object.defineProperty(globalThis, "TextEncoder", encoder);
    else Reflect.deleteProperty(globalThis, "TextEncoder");
  }
  expect(actual!).toBe(expected);
});

test("start targets and commands clone and freeze complete forms and nested input before awaits", () => {
  const f = startFixture();
  expect(Object.isFrozen(f.target.card.form.inputSchema)).toBe(true);
  expect(Object.isFrozen(f.target.card.intent.origin)).toBe(true);
  expect(Object.isFrozen(f.target.entry.inputSchema)).toBe(true);
  expect(Object.isFrozen(f.command.input.payload)).toBe(true);
  f.card.form.name = "TEST mutated";
  f.entry.name = "TEST mutated inventory";
  f.input.input.payload.amount = 50;
  expect(f.target.card.form.name).toBe("TEST process");
  expect(f.target.entry.name).toBe("TEST process");
  expect(f.command.input.payload).toEqual({ amount: 0, empty: null });
  const store = emptyStore();
  store.workItems = {};
  expect(() => assertProcessCommandTarget(store, f.target)).not.toThrow();
});
test("start freezes nested arrays and needs fresh endpoint/scope without a Store inventory", () => {
  const f = startFixture(),
    store = emptyStore();
  store.workItems = {};
  const draft = { rows: [{ name: "TEST original" }] };
  const command = processStartCommand(f.target, { ...f.input, input: draft });
  expect(Object.isFrozen(command.input.rows)).toBe(true);
  expect(Object.isFrozen((command.input.rows as unknown[])[0])).toBe(true);
  draft.rows[0]!.name = "TEST changed";
  expect(command.input).toEqual({ rows: [{ name: "TEST original" }] });
  for (const changed of [
    { ...store, stale: true },
    { ...store, needsSnapshot: true },
    { ...store, connectionKey: endpoint + "/other" },
    { ...store, scope: { ...scope, connectionId: "TEST-other" } },
  ])
    expect(() => assertProcessCommandTarget(changed, f.target)).toThrow(
      "process_start_changed",
    );
});
test.each([
  "scope",
  "version",
  "artifact",
  "schema",
  "digest",
  "origin",
  "request",
  "language",
  "blocked",
])("start refuses a mismatched issued form or command: %s", (change) => {
  const f = startFixture(),
    card = clone(f.card),
    entry = clone(f.entry);
  switch (change) {
    case "scope":
      card.form.scope.userId = "TEST-other";
      break;
    case "version":
      card.form.version++;
      break;
    case "artifact":
      card.form.artifactDigest = "b".repeat(64);
      break;
    case "schema":
      entry.inputSchema = {
        type: "object",
        properties: {},
        required: [],
        additionalProperties: false,
      };
      break;
    case "digest":
      card.formDigest = card.intent.formDigest = "b".repeat(64);
      break;
    case "origin":
      card.intent.origin.conversationId = "TEST-other";
      break;
    case "request":
      if (card.form.origin.type === "command")
        card.form.origin.requestId = "TEST-request-B";
      break;
    case "language":
      expect(() =>
        processStartCommand(f.target, { ...f.input, language: "en" }),
      ).toThrow();
      return;
    case "blocked":
      expect(() =>
        captureProcessStartTarget(
          endpoint,
          scope,
          {
            ...entry,
            availability: "blocked",
            reason: "qualification_required",
          },
          card,
        ),
      ).toThrow();
      return;
  }
  expect(() =>
    captureProcessStartTarget(endpoint, scope, entry, card),
  ).toThrow();
});
test("start rejects non-JSON values while preserving exact ordinary input for server validation", () => {
  const f = startFixture();
  const accessor = Object.defineProperty({}, "name", {
    get: () => "TEST",
    enumerable: true,
  });
  const reserved = JSON.parse('{"constructor":"TEST"}');
  const invalid: unknown[] = [
    { name: undefined },
    { name: NaN },
    { name: Infinity },
    { name: new Date() },
    { name: sparseArray() },
    { name: BigInt(1) },
    accessor,
    reserved,
    { name: "x".repeat(PROCESS_INPUT_JSON_MAX_BYTES + 1) },
    { name: { [Symbol("TEST")]: "TEST" } },
  ];
  for (const input of invalid)
    expect(() =>
      processStartCommand(f.target, { ...f.input, input }),
    ).toThrow();
  // Business-schema errors remain an authoritative admission decision on the server.
  const command = processStartCommand(f.target, {
    ...f.input,
    input: { name: false },
  });
  expect(command.input).toEqual({ name: false });
  function sparseArray() {
    const value = Array<string>(2);
    value[1] = "TEST";
    return value;
  }
});

test("approval uses native parent revision, captures full receipt, and ignores outer/question generations", () => {
  const f = resolveFixture();
  expect(f.command.expectedWorkRevision).toBe(7);
  expect(f.work.revision).toBe(99);
  expect(f.work.native!.process!.journalRevision).toBe(3);
  expect(f.target.receipt.summary).toBe("TEST write params");
  expect(Object.isFrozen(f.target.receipt)).toBe(true);
  expect(Object.isFrozen(f.target.provenance)).toBe(true);
  f.work.revision++;
  f.work.native!.process!.journalRevision = 999;
  expect(processResolveCommand(f.store, f.target, f.input)).toEqual(f.command);
});
test.each([
  "revision",
  "operation",
  "summary",
  "receiptStatus",
  "details",
  "actor",
  "conversation",
  "artifact",
  "admission",
  "command",
  "run",
  "scope",
  "endpoint",
  "stale",
  "snapshot",
  "question",
  "workStatus",
  "multiple",
  "parameters",
  "node",
  "serviceRevision",
  "actionRevision",
  "serviceId",
  "actionId",
  "missingReview",
])("new approval cannot reuse frozen A after %s changes", (change) => {
  const f = resolveFixture(),
    p = f.work.native!.process!;
  switch (change) {
    case "revision":
      f.work.native!.revision++;
      break;
    case "operation":
      p.receipts[1]!.operationId = "TEST-operation-B";
      break;
    case "summary":
      p.receipts[1]!.summary = "TEST changed parameters";
      break;
    case "receiptStatus":
      p.receipts[1]!.status = "succeeded";
      break;
    case "details":
      p.detailsAvailable = false;
      break;
    case "actor":
      p.provenance.actorId = "TEST-other";
      break;
    case "conversation":
      p.provenance.conversationId = "TEST-other";
      break;
    case "artifact":
      p.provenance.artifactDigest = "b".repeat(64);
      break;
    case "admission":
      p.provenance.admissionId = "TEST-other";
      break;
    case "command":
      p.provenance.commandId = "TEST-other";
      break;
    case "run":
      p.provenance.runId = "TEST-other";
      break;
    case "scope":
      f.store.scope.connectionId = "TEST-other";
      break;
    case "endpoint":
      f.store.connectionKey = "https://TEST-other.invalid/v1/TEST-workspace";
      break;
    case "stale":
      f.store.stale = true;
      break;
    case "snapshot":
      f.store.needsSnapshot = true;
      break;
    case "question":
      p.question = {
        nodeId: "agent",
        childRunId: "TEST-child",
        toolCallId: "TEST-tool-call",
        questionId: "TEST-question",
        questionRevision: 1,
        question: "TEST question?",
      };
      break;
    case "workStatus":
      f.work.status = "waiting_system";
      break;
    case "multiple":
      p.receipts.push({ ...p.receipts[1]!, operationId: "TEST-operation-B" });
      break;
    case "parameters":
      p.approval!.result.inputJson = '{"name":"TEST B"}';
      break;
    case "node":
      p.approval!.nodeId = "TEST-node-B";
      break;
    case "serviceRevision":
      p.approval!.serviceRevision++;
      break;
    case "actionRevision":
      p.approval!.actionRevision++;
      break;
    case "serviceId":
      p.approval!.serviceId = "TEST-service-B";
      break;
    case "actionId":
      p.approval!.actionId = "TEST-action-B";
      break;
    case "missingReview":
      delete p.approval;
      break;
  }
  expect(() => assertProcessCommandTarget(f.store, f.target)).toThrow(
    "process_approval_changed",
  );
  expect(() => processResolveCommand(f.store, f.target, f.input)).toThrow(
    "process_approval_changed",
  );
  expect(f.target.receipt.operationId).toBe("TEST-operation-A");
  expect(f.target.receipt.summary).toBe("TEST write params");
});
test("fresh capture freezes the displayed review and historical targets remain retry-only", () => {
  const f = resolveFixture();
  const rendered = clone(f.work);
  expect(Object.isFrozen(f.target.approval!.result)).toBe(true);
  const { approval: _approval, ...historical } = f.target;
  expect(ProcessCommandTargetSchema.parse(historical)).toEqual(historical);
  validateProcessCommandTarget(f.command, historical, endpoint, scope);
  expect(() => processResolveCommand(f.store, historical, f.input)).toThrow(
    "process_approval_changed",
  );
  f.work.native!.process!.approval!.result.inputJson = '{"changed":true}';
  expect(() =>
    captureProcessResolveTarget(
      f.store,
      f.work.id,
      undefined,
      undefined,
      rendered,
    ),
  ).toThrow("process_approval_changed");
});
test("durable target validation binds endpoint, all scope parts and exact original command fields", () => {
  const start = startFixture(),
    resolve = resolveFixture();
  for (const f of [start, resolve]) {
    validateProcessCommandTarget(f.command, f.target, endpoint, scope);
    expect(() =>
      validateProcessCommandTarget(
        f.command,
        f.target,
        endpoint + "/other",
        scope,
      ),
    ).toThrow();
    for (const field of [
      "connectionId",
      "serverId",
      "userId",
      "workspaceId",
    ] as const)
      expect(() =>
        validateProcessCommandTarget(f.command, f.target, endpoint, {
          ...scope,
          [field]: "TEST-other",
        }),
      ).toThrow();
    expect(() =>
      ProcessCommandTargetSchema.parse({ ...f.target, unrelated: true }),
    ).toThrow();
    expect(() =>
      validateProcessCommandTarget(
        { ...f.command, conversationId: "TEST-other" },
        f.target,
        endpoint,
        scope,
      ),
    ).toThrow();
  }
  for (const changed of [
    { ...resolve.command, operationId: "TEST-operation-B" },
    { ...resolve.command, workItemId: "TEST-other" },
    { ...resolve.command, expectedWorkRevision: 99 },
  ])
    expect(() =>
      validateProcessCommandTarget(changed, resolve.target, endpoint, scope),
    ).toThrow();
  expect(() =>
    validateProcessCommandTarget(
      { ...start.command, intentId: "TEST-other" },
      start.target,
      endpoint,
      scope,
    ),
  ).toThrow();
  resolve.work.native!.process!.receipts[1]!.operationId = "TEST-operation-B";
  // Historical replay keeps the captured A target without asking current B for authority.
  expect(() =>
    validateProcessCommandTarget(
      resolve.command,
      resolve.target,
      endpoint,
      scope,
    ),
  ).not.toThrow();
});

test.each([
  "outerCommand",
  "profile",
  "scope",
  "command",
  "key",
  "commandDigest",
  "intent",
  "origin",
  "process",
  "version",
  "artifact",
  "form",
  "inputDigest",
  "input",
  "parent",
  "run",
  "runtimeProcess",
  "runtimeVersion",
  "noProcess",
])(
  "start response rejects another receipt or runtime identity: %s",
  (change) => {
    const f = startFixture(),
      result = clone(f.result);
    const receipt = result.admission;
    if (receipt.status !== "admitted") throw Error("TEST admitted fixture");
    switch (change) {
      case "outerCommand":
        result.commandId = "TEST-other";
        break;
      case "profile":
        result.profile = "agent-process-execution/1";
        break;
      case "scope":
        result.scope.workspaceId = "TEST-other";
        break;
      case "command":
        receipt.commandId = "TEST-other";
        break;
      case "key":
        receipt.idempotencyKey = "TEST-other";
        break;
      case "commandDigest":
        receipt.commandDigest = "b".repeat(64);
        break;
      case "intent":
        receipt.intentId = "TEST-other";
        break;
      case "origin":
        if (receipt.origin.type === "command")
          receipt.origin.requestId = "TEST-other";
        break;
      case "process":
        receipt.processId = "TEST-other";
        break;
      case "version":
        receipt.version++;
        break;
      case "artifact":
        receipt.artifactDigest = "b".repeat(64);
        break;
      case "form":
        receipt.formDigest = "b".repeat(64);
        break;
      case "inputDigest":
        receipt.inputDigest = "b".repeat(64);
        break;
      case "input":
        receipt.input = { name: "TEST other" };
        receipt.inputDigest = serverDigest(receipt.input);
        break;
      case "parent":
        result.process!.parentRunId = "TEST-other";
        break;
      case "run":
        result.process!.runId = "TEST-other";
        break;
      case "runtimeProcess":
        result.process!.processId = "TEST-other";
        break;
      case "runtimeVersion":
        result.process!.version++;
        break;
      case "noProcess":
        delete result.process;
        break;
    }
    expect(() =>
      assertProcessCommandResponse(
        f.command,
        f.target,
        result,
        "agent-process-execution/2",
      ),
    ).toThrow();
  },
);
test("rejected admission validates the exact start without requiring admitted input or a process", () => {
  const f = startFixture();
  const {
    input: _input,
    inputDigest: _digest,
    compilerVersion: _compiler,
    runId: _run,
    parentRunId: _parent,
    ...identity
  } = f.admission;
  const result = {
    ...f.result,
    process: undefined,
    admission: {
      ...identity,
      status: "rejected",
      reason: "process_input_invalid",
    },
  };
  delete result.process;
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      result,
      "agent-process-execution/2",
    ),
  ).not.toThrow();
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      { ...result, process: f.result.process },
      "agent-process-execution/2",
    ),
  ).toThrow();
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      {
        ...result,
        admission: { ...result.admission, commandDigest: "b".repeat(64) },
      },
      "agent-process-execution/2",
    ),
  ).toThrow();
});
test("resolve A validates its original start admission and may legitimately return B or a question", () => {
  const f = resolveFixture(),
    result = clone(f.result);
  result.commandId = f.command.commandId;
  result.process!.revision = 10;
  result.process!.approval = {
    nodeId: "TEST-node-B",
    operationId: "TEST-operation-B",
  };
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      result,
      "agent-process-execution/2",
    ),
  ).not.toThrow();
  delete result.process!.approval;
  result.process!.question = {
    nodeId: "agent",
    childRunId: "TEST-child",
    toolCallId: "TEST-tool",
    questionId: "TEST-question",
    questionRevision: 1,
    question: "TEST next question?",
  };
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      result,
      "agent-process-execution/2",
    ),
  ).not.toThrow();
  for (const field of [
    "receiptId",
    "commandId",
    "parentRunId",
    "runId",
    "processId",
    "artifactDigest",
  ] as const) {
    const changed = clone(result);
    if (changed.admission.status !== "admitted")
      throw Error("TEST admission fixture");
    changed.admission[field] =
      field === "artifactDigest" ? "b".repeat(64) : "TEST-other";
    expect(() =>
      assertProcessCommandResponse(
        f.command,
        f.target,
        changed,
        "agent-process-execution/2",
      ),
    ).toThrow();
  }
  expect(() =>
    assertProcessCommandResponse(
      f.command,
      f.target,
      { ...result, commandId: f.admission.commandId },
      "agent-process-execution/2",
    ),
  ).toThrow();
});
