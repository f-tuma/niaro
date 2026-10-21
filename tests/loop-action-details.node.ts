import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { LoopsStore } from "../apps/server-identity/loops";
import {
  ServiceCatalogStore,
  type StoredInvocation,
} from "../apps/server-identity/service-catalog";
import {
  LoopActionDetailsSchema,
  LoopDetailSchema,
  type LoopActionDetails,
  type LoopStatus,
} from "../packages/protocol/loops";

const at = "2026-10-01T10:00:00.000Z";
const turnId = (value: string) =>
  createHash("sha256").update(`TEST-action-preview-${value}`).digest("hex");
const person = {
  name: "TEST Jana Nováková",
  email: "jana@example.test",
  phone: "+420 555 010 001",
};
const failure = {
  code: "VALIDATION_ERROR",
  kind: "validation" as const,
  stage: "provider_response" as const,
  retry: "correct_input" as const,
  httpStatus: 422,
  message:
    "TEST email rejected; password=TEST_PRIVATE_PASSWORD https://example.test/error?token=TEST_PRIVATE_URL#secret",
  fields: [
    { path: "emails.primaryEmail", issue: "TEST must be a valid email" },
  ],
};
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE user(id TEXT PRIMARY KEY,name TEXT NOT NULL) STRICT;
    CREATE TABLE member(id TEXT PRIMARY KEY,"organizationId" TEXT,"userId" TEXT) STRICT;
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY,organization_id TEXT NOT NULL,name TEXT NOT NULL) STRICT;
    INSERT INTO organization VALUES('org-a'),('org-b');
    INSERT INTO user VALUES('alice','TEST Alice'),('bob','TEST Bob');
    INSERT INTO agent_workspace VALUES('workspace-a','org-a','TEST One'),('workspace-a2','org-a','TEST Two'),('workspace-b','org-b','TEST Foreign');`);
  const catalog = new ServiceCatalogStore(db, "TEST-preview-only-secret", []);
  const store = new LoopsStore(db, catalog);
  let sequence = 0;
  const receipt = (
    changes: Partial<StoredInvocation> = {},
  ): StoredInvocation => ({
    id: `TEST-operation-${++sequence}`,
    organizationId: "org-a",
    workspaceId: "workspace-a",
    userId: "alice",
    serviceId: "TEST-service",
    actionId: "TEST-action",
    serviceRevision: 1,
    actionRevision: 1,
    policyRevision: 1,
    input: { name: "Jana Nováková" },
    result: { contacts: [person] },
    status: "succeeded",
    title: "TEST Find contact",
    serviceName: "TEST CRM",
    effect: "read",
    ...changes,
  });
  const detail = (
    operation: StoredInvocation,
    options: {
      mode?: "recorded" | "historical";
      observed?: LoopStatus;
      workspaceId?: string;
      actorId?: string;
      includeOperation?: boolean;
      includeReceipt?: boolean;
      saveReceipt?: boolean;
      receiptCallId?: string;
      recordedCallId?: string | false;
      nodeLabel?: string;
      nodeDetails?: { label: string; value: string }[];
    } = {},
  ) => {
    if (options.saveReceipt !== false) catalog.saveInvocation(operation);
    const runId = turnId(`run-${++sequence}`),
      observed = options.observed ?? "succeeded";
    const callId = "TEST-call";
    const resultContent =
      observed === "waiting"
        ? { status: "awaiting_approval" }
        : observed === "unknown"
          ? { status: "unknown" }
          : { status: observed };
    const data = {
      kind: "agent-1",
      text: "TEST lookup request",
      clock: { referenceNow: at },
      modelCalls: 1,
      calls: 1,
      inference: 1,
      answer: { reply: "TEST reply" },
      operations: options.includeOperation === false ? [] : [operation.id],
      receipts:
        options.includeReceipt === false
          ? []
          : [
              {
                callId: options.receiptCallId ?? callId,
                operationId: operation.id,
              },
            ],
      transcript: [
        {
          role: "assistant",
          content: "TEST PRIVATE MODEL PROSE",
          tool_calls: [
            {
              id: callId,
              function: {
                name: "TEST_unknown_provider_tool",
                arguments: '{"name":"TEST FORGED ARGUMENT"}',
              },
            },
          ],
        },
        {
          role: "tool",
          tool_call_id: callId,
          content: JSON.stringify(resultContent),
        },
      ],
      ...(options.mode === "historical"
        ? {}
        : {
            trace: {
              startedAt: at,
              finishedAt: at,
              status: observed,
              truncated: false,
              steps: [
                {
                  id: "tool-1",
                  kind: "tool",
                  label: options.nodeLabel ?? "TEST service tool",
                  status: observed,
                  startedAt: at,
                  finishedAt: at,
                  details: options.nodeDetails ?? [],
                  ...(options.recordedCallId === false
                    ? {}
                    : { callId: options.recordedCallId ?? callId }),
                },
                {
                  id: "result-1",
                  kind: "result",
                  label: options.nodeLabel ?? "TEST service result",
                  status: observed,
                  startedAt: at,
                  finishedAt: at,
                  details: options.nodeDetails ?? [],
                  ...(options.recordedCallId === false
                    ? {}
                    : { callId: options.recordedCallId ?? callId }),
                },
              ],
            },
          }),
    };
    catalog.saveTurn(
      runId,
      options.workspaceId ?? "workspace-a",
      options.actorId ?? "alice",
      data,
    );
    return LoopDetailSchema.parse(store.detail("org-a", runId));
  };
  return { db, catalog, store, receipt, detail };
}
const previews = (detail: ReturnType<ReturnType<typeof fixture>["detail"]>) =>
  detail.nodes
    .filter((node) => node.kind === "tool" || node.kind === "result")
    .map((node) => node.action);
function action(
  detail: ReturnType<ReturnType<typeof fixture>["detail"]>,
): LoopActionDetails {
  const value = detail.nodes.find((node) => node.kind === "result")?.action;
  assert(value, "A bound service result must contain a safe action preview");
  return LoopActionDetailsSchema.parse(value);
}
const values = (fields: LoopActionDetails["input"]) =>
  fields.map((field) => field.value).join("\n");

for (const mode of ["recorded", "historical"] as const)
  test(`${mode} action details show actual input and CRM business output rather than transcript arguments`, () => {
    const f = fixture();
    try {
      const receipt = f.receipt({
        input: {
          name: "Jana Nováková",
          email: person.email,
          phone: person.phone,
        },
      });
      const detail = f.detail(receipt, { mode });
      const preview = action(detail);
      assert.equal(preview.operationId, receipt.id);
      assert.equal(preview.serviceName, "TEST CRM");
      assert.equal(preview.actionName, "TEST Find contact");
      assert.equal(preview.effect, "read");
      assert.equal(preview.status, "succeeded");
      assert.equal(preview.phase, "execution");
      for (const value of ["Jana Nováková", person.email, person.phone])
        assert(values(preview.input).includes(value));
      for (const value of Object.values(person))
        assert(values(preview.output).includes(value));
      const serialized = JSON.stringify(detail);
      assert(!serialized.includes("TEST FORGED ARGUMENT"));
      assert(!serialized.includes("TEST PRIVATE MODEL PROSE"));
      assert.equal(preview.inputTruncated, false);
      assert.equal(preview.outputTruncated, false);
    } finally {
      f.db.close();
    }
  });

test("business HTTP body fields survive recursive secret/header sanitization", () => {
  const f = fixture();
  try {
    const secrets = [
      "TEST-body-secret",
      "TEST-header-basic-secret",
      "TEST-cookie-value",
      "TEST-deep-oauth-secret",
      "TEST-result-api-key",
      "TEST-result-private-key",
    ];
    const receipt = f.receipt({
      input: {
        body: {
          name: person.name,
          email: person.email,
          phone: person.phone,
          password: secrets[0],
          connection: { authorization: { access_token: secrets[3] } },
        },
        headers: {
          Authorization: `Basic ${secrets[1]}`,
          "X-Session": secrets[2],
        },
        cookie: secrets[2],
      },
      result: {
        data: {
          contacts: [
            {
              ...person,
              "api-key": secrets[4],
              credentials: { privateKey: secrets[5] },
            },
          ],
        },
        headers: { "Set-Cookie": secrets[2] },
      },
    });
    const detail = f.detail(receipt),
      preview = action(detail);
    for (const value of Object.values(person)) {
      assert(values(preview.input).includes(value));
      assert(values(preview.output).includes(value));
    }
    for (const secret of secrets)
      assert(!JSON.stringify(detail).includes(secret));
    assert.deepEqual(
      f.catalog.invocation(receipt.id, receipt.workspaceId, receipt.userId),
      receipt,
      "Projection must not rewrite original evidence",
    );
  } finally {
    f.db.close();
  }
});

test("MCP structured content wins over duplicate text; a JSON text envelope yields the same business facts", () => {
  const f = fixture();
  try {
    const data = { contacts: [person] };
    const structured = action(
      f.detail(
        f.receipt({
          result: {
            structuredContent: data,
            content: [{ type: "text", text: "TEST WRONG DUPLICATE TEXT" }],
          },
        }),
      ),
    );
    const text = action(
      f.detail(
        f.receipt({
          result: { content: [{ type: "text", text: JSON.stringify(data) }] },
        }),
      ),
    );
    for (const preview of [structured, text]) {
      for (const value of Object.values(person))
        assert(values(preview.output).includes(value));
      assert(!JSON.stringify(preview).includes("TEST WRONG DUPLICATE TEXT"));
    }
  } finally {
    f.db.close();
  }
});

test("binary/resource MCP content and header payloads never become raw previews", () => {
  const f = fixture();
  try {
    for (const result of [
      {
        content: [
          { type: "image", data: "TEST PRIVATE BINARY", mimeType: "image/png" },
        ],
      },
      {
        content: [
          {
            type: "resource",
            resource: {
              uri: "file:///TEST-PRIVATE-RESOURCE",
              text: "TEST PRIVATE RESOURCE BODY",
            },
          },
        ],
      },
      {
        content: [
          { type: "text", text: "TEST PUBLIC NOTE" },
          { type: "image", data: "TEST PRIVATE BINARY" },
        ],
      },
      {
        headers: {
          Authorization: "Basic TEST PRIVATE HEADER",
          "Set-Cookie": "TEST PRIVATE COOKIE",
        },
      },
    ]) {
      const preview = action(f.detail(f.receipt({ result })));
      const serialized = JSON.stringify(preview);
      for (const hidden of [
        "TEST PRIVATE BINARY",
        "TEST-PRIVATE-RESOURCE",
        "TEST PRIVATE RESOURCE BODY",
        "TEST PRIVATE HEADER",
        "TEST PRIVATE COOKIE",
      ])
        assert(!serialized.includes(hidden));
    }
  } finally {
    f.db.close();
  }
});

test("URL userinfo/query/fragment and free-text credentials are redacted in both directions", () => {
  const f = fixture();
  try {
    const url =
      "https://TEST-url-user:TEST-url-password@example.test/contacts?api_key=TEST-query-secret#TEST-fragment-secret";
    const receipt = f.receipt({
      input: {
        website: url,
        note: "Bearer TEST-bearer-secret",
        secret: "TEST-direct-secret",
      },
      result: { website: url, note: "password=TEST-result-password" },
    });
    const preview = action(f.detail(receipt));
    for (const value of [
      "TEST-url-user",
      "TEST-url-password",
      "TEST-query-secret",
      "TEST-fragment-secret",
      "TEST-bearer-secret",
      "TEST-direct-secret",
      "TEST-result-password",
    ])
      assert(!JSON.stringify(preview).includes(value));
    assert(values(preview.input).includes("example.test/contacts"));
    assert(values(preview.output).includes("example.test/contacts"));
  } finally {
    f.db.close();
  }
});

test("missing, unbound, foreign and another actor's receipts never expose action data", () => {
  const f = fixture();
  try {
    const operation = f.receipt({
      input: { name: "TEST PRIVATE OTHER INPUT" },
      result: { value: "TEST PRIVATE OTHER OUTPUT" },
    });
    for (const options of [
      { saveReceipt: false },
      { includeOperation: false },
      { includeReceipt: false },
      { receiptCallId: "TEST-other-call" },
      { workspaceId: "workspace-a2" },
      { actorId: "bob" },
    ]) {
      const detail = f.detail(operation, options);
      assert(previews(detail).every((preview) => preview === undefined));
      assert(!JSON.stringify(detail).includes("TEST PRIVATE OTHER INPUT"));
      assert(!JSON.stringify(detail).includes("TEST PRIVATE OTHER OUTPUT"));
    }
    const foreign = f.detail({ ...operation, organizationId: "org-b" });
    assert(previews(foreign).every((preview) => preview === undefined));
  } finally {
    f.db.close();
  }
});

test("historical awaiting-approval steps remain proposals after the operation later succeeds", () => {
  const f = fixture();
  try {
    for (const mode of ["recorded", "historical"] as const) {
      const preview = action(
        f.detail(
          f.receipt({
            effect: "write",
            status: "succeeded",
            result: { name: "TEST COMPLETED FUTURE RESULT" },
          }),
          { mode, observed: "waiting" },
        ),
      );
      assert.equal(preview.phase, "proposal");
      assert.equal(preview.status, "awaiting_approval");
      assert.deepEqual(preview.output, []);
      assert(!JSON.stringify(preview).includes("TEST COMPLETED FUTURE RESULT"));
      assert(values(preview.input).includes("Jana Nováková"));
    }
  } finally {
    f.db.close();
  }
});

test("resumed approved and declined steps use only their scoped Operation binding", () => {
  const f = fixture();
  try {
    for (const decision of ["approved", "declined"] as const) {
      const receipt = f.receipt({
        effect: "write",
        status: decision === "approved" ? "succeeded" : "rejected",
      });
      const options = {
        includeReceipt: false,
        recordedCallId: false as const,
        observed:
          decision === "approved"
            ? ("succeeded" as const)
            : ("cancelled" as const),
        nodeLabel: "TEST resumed operation",
        nodeDetails: [
          { label: "Operation", value: receipt.id },
          { label: "Person's decision", value: decision },
        ],
      };
      const preview = action(f.detail(receipt, options));
      assert.equal(preview.operationId, receipt.id);
      assert.equal(
        preview.status,
        decision === "approved" ? "succeeded" : "rejected",
      );
      assert.equal(
        preview.phase,
        decision === "approved" ? "execution" : "proposal",
      );
      assert(values(preview.input).includes("Jana Nováková"));
      if (decision === "approved")
        assert(values(preview.output).includes(person.email));
      else assert.deepEqual(preview.output, []);
      const unbound = f.detail(receipt, {
        ...options,
        includeOperation: false,
      });
      assert(previews(unbound).every((preview) => preview === undefined));
    }
  } finally {
    f.db.close();
  }
});

test("display labels cannot turn a completed operation into a declined proposal", () => {
  const f = fixture();
  try {
    const preview = action(
      f.detail(f.receipt(), { nodeLabel: "Declined action" }),
    );
    assert.equal(preview.status, "succeeded");
    assert.equal(preview.phase, "execution");
    assert(values(preview.output).includes(person.email));
  } finally {
    f.db.close();
  }
});

test("bracket-prefixed business text remains readable when it is not a JSON envelope", () => {
  const f = fixture();
  try {
    const preview = action(
      f.detail(
        f.receipt({
          input: { location: "[Office] Praha" },
          result: { note: "[Ready] Jana" },
        }),
      ),
    );
    assert(values(preview.input).includes("[Office] Praha"));
    assert(values(preview.output).includes("[Ready] Jana"));
    assert.equal(preview.inputTruncated, false);
    assert.equal(preview.outputTruncated, false);
  } finally {
    f.db.close();
  }
});

for (const status of [
  "awaiting_approval",
  "running",
  "failed",
  "unknown",
  "rejected",
] as const)
  test(`${status} receipt keeps its exact state and never presents a saved body as successful output`, () => {
    const f = fixture();
    try {
      const observed: LoopStatus =
        status === "awaiting_approval"
          ? "waiting"
          : status === "rejected"
            ? "cancelled"
            : status;
      const preview = action(
        f.detail(
          f.receipt({
            status,
            effect: "write",
            result: { name: "TEST MUST NOT APPEAR AS SUCCESS" },
          }),
          { observed },
        ),
      );
      assert.equal(preview.status, status);
      assert.deepEqual(preview.output, []);
      assert(
        !JSON.stringify(preview).includes("TEST MUST NOT APPEAR AS SUCCESS"),
      );
    } finally {
      f.db.close();
    }
  });

test("large input, JSON-text output, record count and nesting use bounded truthful previews", () => {
  const f = fixture();
  try {
    const input = Object.fromEntries(
      Array.from({ length: 30 }, (_, i) => [`field${i}`, "TEST".repeat(400)]),
    );
    const result = {
      contacts: Array.from({ length: 5 }, (_, index) => ({
        name: `TEST Person ${index + 1}`,
        email: `person${index + 1}@example.test`,
      })),
    };
    const preview = action(f.detail(f.receipt({ input, result })));
    assert(preview.input.length <= 12);
    assert(preview.output.length <= 12);
    assert(
      preview.input.every(
        (field) => field.label.length <= 80 && field.value.length <= 1000,
      ),
    );
    assert(
      preview.output.every(
        (field) => field.label.length <= 80 && field.value.length <= 1000,
      ),
    );
    assert(
      preview.input.reduce((size, field) => size + field.value.length, 0) <=
        4000,
    );
    assert.equal(preview.inputTruncated, true);
    assert.equal(preview.outputTruncated, true);
    assert(values(preview.output).includes("TEST Person 1"));
    assert(!values(preview.output).includes("TEST Person 5"));
    const oversized = action(
      f.detail(
        f.receipt({
          result: {
            content: [
              {
                type: "text",
                text: '"' + "TEST LARGE TEXT ".repeat(3000) + '"',
              },
            ],
          },
        }),
      ),
    );
    assert(oversized.output.length <= 12);
    assert(oversized.output.every((field) => field.value.length <= 1000));
    assert.equal(oversized.outputTruncated, true);
    let nested: Record<string, unknown> = { name: "TEST DEEPLY NESTED VALUE" };
    for (let i = 0; i < 30; i++) nested = { child: nested };
    const deep = action(f.detail(f.receipt({ input: nested, result: nested })));
    assert.equal(deep.inputTruncated, true);
    assert.equal(deep.outputTruncated, true);
    assert(!JSON.stringify(deep).includes("TEST DEEPLY NESTED VALUE"));
  } finally {
    f.db.close();
  }
});

test("business names and addresses have priority even after many provider metadata keys", () => {
  const f = fixture();
  try {
    const metadata = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `metadata${index}`,
        `TEST provider metadata ${index}`,
      ]),
    );
    const preview = action(
      f.detail(
        f.receipt({
          input: { ...metadata, ...person },
          result: { ...metadata, ...person },
        }),
      ),
    );
    for (const value of Object.values(person)) {
      assert(values(preview.input).includes(value));
      assert(values(preview.output).includes(value));
    }
    assert(preview.inputTruncated);
    assert(preview.outputTruncated);
  } finally {
    f.db.close();
  }
});

test("failed action details preserve bounded diagnostic evidence without success output", () => {
  const f = fixture();
  try {
    const operation = f.receipt({
      status: "failed",
      result: undefined,
      failure,
    });
    const preview = action(f.detail(operation, { observed: "failed" }));
    assert.equal(preview.failure?.code, "VALIDATION_ERROR");
    assert.equal(preview.failure?.httpStatus, 422);
    assert.equal(preview.failure?.fields[0]?.path, "emails.primaryEmail");
    assert.equal(preview.failure?.retry, "correct_input");
    assert.deepEqual(preview.output, []);
    assert(!JSON.stringify(preview).includes("TEST_PRIVATE_PASSWORD"));
    assert(!JSON.stringify(preview).includes("TEST_PRIVATE_URL"));
  } finally {
    f.db.close();
  }
});

test("unknown write diagnostic requires verification and never leaks into its earlier proposal", () => {
  const f = fixture();
  try {
    const operation = f.receipt({
      effect: "write",
      status: "unknown",
      result: undefined,
      failure,
    });
    const unknown = action(f.detail(operation, { observed: "unknown" }));
    assert.equal(unknown.failure?.retry, "verify_first");
    assert.deepEqual(unknown.output, []);
    const proposal = action(f.detail(operation, { observed: "waiting" }));
    assert.equal(proposal.status, "awaiting_approval");
    assert.equal(proposal.failure, undefined);
    assert.deepEqual(proposal.output, []);
  } finally {
    f.db.close();
  }
});

test("historical missing diagnostics and successful actions do not fabricate failure evidence", () => {
  const f = fixture();
  try {
    const old = f.receipt({ status: "unknown", result: undefined });
    assert.equal(
      action(f.detail(old, { observed: "unknown" })).failure,
      undefined,
    );
    const successful = f.receipt({ failure });
    assert.equal(action(f.detail(successful)).failure, undefined);
  } finally {
    f.db.close();
  }
});
