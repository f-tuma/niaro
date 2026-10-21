import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopToolDetailsSchema } from "../packages/protocol/loops";
import {
  startLoopToolDetails,
  finishLoopToolDetails,
  sanitizeLoopToolDetails,
} from "../apps/server-identity/loop-tool-details";
import {
  newLoopTrace,
  startLoopStep,
  finishLoopTrace,
} from "../apps/server-identity/loop-trace";

const values = (fields: { value: string }[]) =>
  fields.map((field) => field.value).join("\n");

test("discovery previews preserve actual tool identity, safe inputs and returned action names", () => {
  const tool = finishLoopToolDetails(
    startLoopToolDetails("find_actions", {
      service: "TEST CRM",
      need: "find contact",
      payload: "TEST RAW INPUT",
    }),
    {
      status: "succeeded",
      output: {
        service: "TEST CRM",
        actions: [
          {
            name: "Find contact",
            tool: "action_TEST_lookup",
            effect: "read",
            description: "TEST PRIVATE DESCRIPTION",
            headers: { authorization: "TEST AUTH" },
          },
        ],
        raw: "TEST RAW OUTPUT",
      },
    },
  );
  LoopToolDetailsSchema.parse(tool);
  assert.equal(tool.name, "find_actions");
  assert.equal(tool.outcome, "completed");
  assert.equal(tool.inputRecorded, true);
  assert.equal(tool.outputRecorded, true);
  assert(values(tool.input).includes("find contact"));
  assert(values(tool.output).includes("Find contact"));
  assert(values(tool.output).includes("action_TEST_lookup"));
  for (const secret of [
    "TEST RAW INPUT",
    "TEST RAW OUTPUT",
    "TEST PRIVATE DESCRIPTION",
    "TEST AUTH",
  ])
    assert(!JSON.stringify(tool).includes(secret));
});

test("an observed empty result is different from unavailable or unrecorded evidence", () => {
  const empty = finishLoopToolDetails(
    startLoopToolDetails("find_service", { need: "contacts" }),
    {
      status: "succeeded",
      output: { services: [] },
    },
  );
  assert.equal(empty.outputRecorded, true);
  assert.deepEqual(empty.output, [{ label: "Returned services", value: "0" }]);
  const missing = finishLoopToolDetails(startLoopToolDetails("find_service"), {
    status: "succeeded",
  });
  assert.equal(missing.inputRecorded, false);
  assert.equal(missing.outputRecorded, false);
  assert.deepEqual(missing.output, []);
});

test("questions, user answers, memory contents, cards and service bodies are never previews", () => {
  for (const name of [
    "ask_user",
    "memory_search",
    "memory_revise",
    "compose_card",
    "action_TEST_contact",
  ]) {
    const tool = finishLoopToolDetails(
      startLoopToolDetails(name, {
        question: "TEST PRIVATE QUESTION",
        answer: "TEST PRIVATE ANSWER",
        content: "TEST MEMORY BODY",
        input: "TEST SERVICE INPUT",
        document: "TEST CARD BODY",
      }),
      {
        status: "succeeded",
        output: {
          asked: true,
          answered: true,
          answer: "TEST PRIVATE ANSWER",
          memory: "TEST MEMORY BODY",
          status: name === "compose_card" ? "composed" : "active",
          revision: 2,
          body: "TEST PROVIDER BODY",
          document: "TEST CARD BODY",
          result: "TEST SERVICE RESULT",
        },
      },
    );
    assert.equal(tool.inputRecorded, false);
    assert.deepEqual(tool.input, []);
    for (const secret of [
      "TEST PRIVATE QUESTION",
      "TEST PRIVATE ANSWER",
      "TEST MEMORY BODY",
      "TEST SERVICE INPUT",
      "TEST CARD BODY",
      "TEST PROVIDER BODY",
      "TEST SERVICE RESULT",
    ])
      assert(
        !JSON.stringify(tool).includes(secret),
        `${name} leaked ${secret}`,
      );
  }
});

test("date previews validate input and allow only known computed scalars", () => {
  const tool = finishLoopToolDetails(
    startLoopToolDetails("internal_datetime_resolve", {
      when: { kind: "day_offset", days: 1 },
      time: "10:00",
      timeZone: "Europe/Prague",
    }),
    {
      status: "succeeded",
      output: {
        status: "resolved",
        values: {
          utc: "2026-10-05T08:00:00Z",
          iso: "2026-10-05T10:00:00+02:00",
          timeZone: "Europe/Prague",
          date: "2026-10-05",
          raw: "TEST PRIVATE VALUE",
          time: "TEST INVALID TIME",
        },
      },
    },
  );
  assert(values(tool.input).includes("day_offset"));
  assert(values(tool.output).includes("2026-10-05T08:00:00Z"));
  assert(!JSON.stringify(tool).includes("TEST PRIVATE VALUE"));
  assert(!JSON.stringify(tool).includes("TEST INVALID TIME"));
  const invalid = startLoopToolDetails("internal_datetime_resolve", {
    when: { kind: "unknown" },
    password: "TEST DATE SECRET",
  });
  assert.equal(invalid.inputRecorded, false);
  assert.deepEqual(invalid.input, []);
});

test("known credential values are redacted before clipping even when copied into public fields", () => {
  const token = "TEST SHORT PRIVATE TOKEN";
  const tool = finishLoopToolDetails(
    startLoopToolDetails("find_service", {
      need: `Find contacts ${token}; password="${"TEST LONG SECRET ".repeat(300)}"`,
      token,
    }),
    {
      status: "succeeded",
      output: {
        service: `${token} https://user:pass@example.test/path?secret=private#fragment`,
        headers: { authorization: `Bearer ${token}` },
      },
    },
  );
  const encoded = JSON.stringify(tool);
  for (const secret of [
    token,
    "TEST LONG SECRET",
    "user:pass",
    "secret=private",
    "#fragment",
  ])
    assert(!encoded.includes(secret));
  assert(encoded.includes("redacted"));
});

test("invalid arguments, unavailable tools and skipped calls remain distinct without raw errors", () => {
  const previous = startLoopToolDetails("find_actions");
  const invalid = finishLoopToolDetails(previous, {
    status: "failed",
    invalidArguments: true,
    error: new Error("TEST RAW ERROR"),
  });
  assert.equal(invalid.outcome, "invalid_arguments");
  assert.equal(invalid.failure?.code, "tool_input_invalid");
  assert.equal(invalid.outputRecorded, false);
  const diagnosed = finishLoopToolDetails(previous, {
    status: "failed",
    invalidArguments: true,
    output: {
      error: "invalid_arguments",
      failure: {
        code: "invalid_arguments",
        kind: "validation",
        stage: "validation",
        retry: "correct_input",
        fields: [{ path: "/select", issue: "Required field is missing." }],
      },
      input: "TEST PRIVATE INVALID INPUT",
    },
  });
  assert.deepEqual(diagnosed.failure?.fields, [
    { path: "/select", issue: "Required field is missing." },
  ]);
  assert(!JSON.stringify(diagnosed).includes("TEST PRIVATE INVALID INPUT"));
  const unavailable = finishLoopToolDetails(
    startLoopToolDetails("Unavailable tool"),
    {
      status: "failed",
      unavailable: true,
      error: { message: "TEST PRIVATE PROVIDER" },
    },
  );
  assert.equal(unavailable.name, "unknown");
  assert.equal(unavailable.outcome, "unavailable");
  assert.equal(
    finishLoopToolDetails(previous, {
      status: "cancelled",
      output: { skipped: true },
    }).outcome,
    "skipped",
  );
  assert(!JSON.stringify([invalid, unavailable]).includes("TEST RAW ERROR"));
  assert(
    !JSON.stringify([invalid, unavailable]).includes("TEST PRIVATE PROVIDER"),
  );
});

test("structured failures keep operational evidence without provider diagnostic text", () => {
  const tool = finishLoopToolDetails(
    startLoopToolDetails("action_TEST_contact"),
    {
      status: "failed",
      output: {
        failure: {
          code: "VALIDATION_ERROR",
          kind: "validation",
          stage: "validation",
          retry: "correct_input",
          httpStatus: 422,
          message: "TEST PRIVATE PROVIDER TEXT",
          fields: [
            { path: "email", issue: "Required" },
            { path: "password", issue: "TEST PASSWORD ISSUE" },
          ],
        },
      },
    },
  );
  assert.equal(tool.failure?.code, "VALIDATION_ERROR");
  assert.equal(tool.failure?.httpStatus, 422);
  assert.deepEqual(tool.failure?.fields, [
    { path: "email", issue: "Required" },
  ]);
  assert(!JSON.stringify(tool).includes("TEST PRIVATE PROVIDER TEXT"));
  assert(!JSON.stringify(tool).includes("TEST PASSWORD ISSUE"));
});

test("known credentials mirrored into failure fields are redacted before clipping", () => {
  const credential = "TEST_SHORT_CREDENTIAL";
  const tool = finishLoopToolDetails(
    startLoopToolDetails("action_TEST_contact"),
    {
      status: "failed",
      output: {
        headers: { authorization: `Bearer ${credential}` },
        failure: {
          code: "VALIDATION_ERROR",
          kind: "validation",
          stage: "validation",
          retry: "correct_input",
          fields: [
            {
              path: "email",
              issue: `Rejected value ${credential} ` + "x".repeat(600),
            },
          ],
          message: `TEST RAW PROVIDER MESSAGE ${credential}`,
        },
      },
    },
  );
  assert.equal(tool.failure?.code, "VALIDATION_ERROR");
  assert(tool.failure?.fields[0]?.issue.includes("[redacted]"));
  assert.equal(tool.failure?.fields[0]?.issue.length, 300);
  assert(!JSON.stringify(tool).includes(credential));
  assert(!JSON.stringify(tool).includes("TEST RAW PROVIDER MESSAGE"));
});

test("input credential context remains transient and protects later failure and output echoes", () => {
  const credential = "TEST_INPUT_CREDENTIAL";
  const previous = startLoopToolDetails("find_service", {
    need: "contacts",
    accessToken: credential,
  });
  assert(!JSON.stringify(previous).includes(credential));
  const tool = finishLoopToolDetails(previous, {
    status: "failed",
    output: {
      failure: {
        code: "VALIDATION_ERROR",
        kind: "validation",
        stage: "validation",
        retry: "correct_input",
        fields: [{ path: "email", issue: `Rejected value ${credential}` }],
      },
    },
  });
  assert.equal(tool.failure?.fields[0]?.issue, "Rejected value [redacted]");
  assert(!JSON.stringify(tool).includes(credential));
  const output = finishLoopToolDetails(
    startLoopToolDetails("find_service", {
      need: "contacts",
      secret: credential,
    }),
    {
      status: "succeeded",
      output: { service: `CRM ${credential}` },
    },
  );
  assert.equal(values(output.output), "CRM [redacted]");
});

test("persisted credential field metadata is dropped and redacts mirrored failure evidence", () => {
  const credential = "TEST_PERSISTED_CREDENTIAL";
  const raw = {
    ...startLoopToolDetails("find_service"),
    outcome: "failed",
    inputRecorded: true,
    input: [{ label: "Authorization", value: `Bearer ${credential}` }],
    failure: {
      code: "VALIDATION_ERROR",
      kind: "validation",
      stage: "validation",
      retry: "correct_input",
      fields: [{ path: "email", issue: `Rejected value ${credential}` }],
    },
  };
  const tool = sanitizeLoopToolDetails(raw)!;
  assert.deepEqual(tool.input, []);
  assert.equal(tool.failure?.fields[0]?.issue, "Rejected value [redacted]");
  assert(!JSON.stringify(tool).includes(credential));
  assert.equal(
    sanitizeLoopToolDetails({
      ...raw,
      headers: { authorization: `Bearer ${credential}` },
    }),
    undefined,
  );
});

test("recognizable inline tokens and untrusted failure paths are sanitized within diagnostic limits", () => {
  const credential = "TEST_GENERIC_CREDENTIAL";
  const tool = finishLoopToolDetails(
    startLoopToolDetails("action_TEST_contact"),
    {
      status: "failed",
      output: {
        failure: {
          code: "VALIDATION_ERROR",
          kind: "validation",
          stage: "validation",
          retry: "correct_input",
          fields: [
            {
              path: "email",
              issue: `password=${credential}; rejected ${credential}`,
            },
            {
              path: "contact." + "x".repeat(200) + ".authorization",
              issue: "TEST PRIVATE PATH ISSUE",
            },
            { path: 123, issue: "TEST INVALID PATH TYPE" },
            ...Array.from({ length: 9 }, (_, index) => ({
              path: `public.field_${index}`,
              issue: "Correct the value" + "x".repeat(600),
            })),
          ],
        },
      },
    },
  );
  assert(!JSON.stringify(tool).includes(credential));
  assert(!JSON.stringify(tool).includes("TEST PRIVATE PATH ISSUE"));
  assert(!JSON.stringify(tool).includes("TEST INVALID PATH TYPE"));
  assert((tool.failure?.fields.length ?? 0) <= 8);
  assert(
    tool.failure?.fields.every(
      (field) => field.path.length <= 160 && field.issue.length <= 300,
    ),
  );
});

test("large previews have bounded field counts, text budgets and truthful returned counts", () => {
  const actions = Array.from({ length: 60 }, (_, index) => ({
    name: `Action ${index} ` + "x".repeat(4000),
    tool: `action_TEST_${index}`,
    effect: "read",
  }));
  const tool = finishLoopToolDetails(
    startLoopToolDetails("find_actions", {
      service: "TEST CRM",
      need: "y".repeat(12000),
    }),
    {
      status: "succeeded",
      output: { service: "TEST CRM", actions },
    },
  );
  assert(tool.inputTruncated);
  assert(tool.outputTruncated);
  assert(tool.input.length <= 12 && tool.output.length <= 12);
  assert(
    [...tool.input, ...tool.output].every(
      (field) => field.value.length <= 1000,
    ),
  );
  assert(
    tool.input.reduce((sum, field) => sum + field.value.length, 0) <= 4000,
  );
  assert(
    tool.output.reduce((sum, field) => sum + field.value.length, 0) <= 4000,
  );
  assert(
    tool.output.some(
      (field) => field.label === "Returned actions" && field.value === "60",
    ),
  );
  assert(!values(tool.output).includes("Action 4"));
});

test("persisted metadata cannot promote arbitrary fields or service output into evidence", () => {
  const raw = {
    ...startLoopToolDetails("ask_user"),
    inputRecorded: true,
    outputRecorded: true,
    input: [{ label: "Need", value: "TEST PRIVATE QUESTION" }],
    output: [
      { label: "Status", value: "TEST PRIVATE ANSWER" },
      { label: "Payload", value: "TEST RAW BODY" },
    ],
  };
  const tool = sanitizeLoopToolDetails(raw)!;
  assert.equal(tool.inputRecorded, false);
  assert.equal(tool.outputRecorded, false);
  assert.deepEqual(tool.input, []);
  assert.deepEqual(tool.output, []);
  assert.equal(
    sanitizeLoopToolDetails({ ...raw, extra: "TEST RAW" }),
    undefined,
  );
  const action = sanitizeLoopToolDetails({
    ...raw,
    name: "action_TEST_contact",
  })!;
  assert.deepEqual(action.input, []);
  assert.deepEqual(action.output, []);
});

test("terminal trace closure settles pending tool metadata without inventing output", () => {
  const turn = { trace: newLoopTrace() };
  const step = startLoopStep(turn, "tool", "find_service")!;
  step.tool = startLoopToolDetails("find_service", { need: "contacts" });
  finishLoopTrace(turn, "interrupted");
  assert.equal(step.status, "interrupted");
  assert.equal(step.tool.outcome, "cancelled");
  assert.equal(step.tool.outputRecorded, false);
});
