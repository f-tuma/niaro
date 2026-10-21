import assert from "node:assert/strict";
import { test } from "node:test";
import { NativeTestSuiteSchema } from "../packages/protocol/process-native-testing";
import { ProcessTestScenarioSchema } from "../packages/protocol/process-testing";
import {
  newCaseDraft,
  newModelDraft,
  newQuestionDraft,
  parseSuiteDraft,
  readSuiteDraft,
  suiteToDraft,
} from "../apps/server-admin/web/lib/process-test-suite";
import { processDigest } from "../apps/server-identity/process-validation";

test("structured suite roundtrips exact script whitespace, arbitrary nested data, tool names, order, revisions and all scenario families", () => {
  const cases = ProcessTestScenarioSchema.options.map((scenario, i) => ({
    id: `TEST_case_${i}`,
    scenario,
    input: { nested: { arbitrary: [1, true, "  TEST\n"] } },
    actions: [],
    models: {
      configured: [
        {
          modelId: "TEST-model",
          requiredTools: ["TEST tool\nnewline", " name with spaces "],
          reply: {
            type: "text",
            text: "  **TEST**\n\n<script>literal</script>  ",
          },
          usage: { inputTokens: 0, outputTokens: 7 },
        },
      ],
      generic: [
        {
          modelId: "TEST-model",
          requiredTools: ["find_actions"],
          reply: {
            type: "tool",
            name: "TEST-tool",
            callId: `TEST-call-${i}`,
            input: { arbitrary: "input" },
          },
          usage: { inputTokens: 1, outputTokens: 0 },
        },
      ],
    },
    expected: {
      outcome: (
        {
          success: "succeeded",
          restart: "succeeded",
          rejection: "rejected",
          missing_input: "input_invalid",
          failure: "failed",
          unknown: "unknown",
        } as const
      )[scenario],
      ...(["success", "restart"].includes(scenario)
        ? { output: { shape: [false, { deep: 3 }] } }
        : { codes: { configured: "TEST_failure", generic: "TEST_failure" } }),
      receipts: [],
    },
    ...(scenario === "restart" ? { reopenAt: "suspended" } : {}),
  }));
  const suite = NativeTestSuiteSchema.parse({
    genericModelId: "TEST-model",
    cases,
  });
  assert.deepEqual(parseSuiteDraft(suiteToDraft(suite)), suite);
});
test("incomplete structured fields remain editable but cannot become a native command", () => {
  const draft = {
    genericModelId: "TEST-model",
    cases: [newCaseDraft("success", 1)],
  };
  draft.cases[0]!.configured.push(newModelDraft("TEST-model"));
  const raw = JSON.stringify(draft);
  assert.equal(readSuiteDraft(raw).cases.length, 1);
  assert.equal(
    parseSuiteDraft(raw).cases[0]?.models.configured[0]?.requiredTools.length,
    0,
  );
  draft.cases[0]!.configured[0]!.inputTokens = "NaN";
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  draft.cases[0]!.input = "[]";
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
});
test("suite command bounds reject malformed models, excessive cases, poison keys and oversized recovery drafts", () => {
  const draft = {
    genericModelId: "TEST-model",
    cases: [newCaseDraft("success", 1)],
  };
  draft.cases[0]!.input = '{"constructor":{}}';
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  assert.throws(() => readSuiteDraft(" ".repeat(250001)));
  assert.throws(() =>
    readSuiteDraft(
      JSON.stringify({
        ...draft,
        cases: Array.from({ length: 17 }, () => draft.cases[0]),
      }),
    ),
  );
  draft.cases[0]!.input = "{}";
  draft.cases[0]!.configured = [newModelDraft("TEST-model")];
  draft.cases[0]!.configured[0]!.requiredTools = '{"TEST":"tool"}';
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
});

test("question fixture reload preserves exact text, independent strategy questions, matching answers and order", () => {
  const original = {
    configured: [
      {
        question: "  TEST exact question\n<script>literal</script>  ",
        answer: "  TEST exact answer\n",
      },
      { question: "TEST second question?", answer: "TEST second answer" },
    ],
    generic: [
      { question: "TEST generic question\n", answer: "  TEST exact answer\n" },
      {
        question: "TEST another generic question?",
        answer: "TEST second answer",
      },
    ],
  };
  const draft = {
    genericModelId: "TEST-model",
    cases: [{ ...newCaseDraft("success", 1), questions: original }],
  };
  const suite = parseSuiteDraft(JSON.stringify(draft));
  const recovered = readSuiteDraft(suiteToDraft(suite));
  assert.deepEqual(recovered.cases[0]!.questions, original);
  assert.deepEqual(parseSuiteDraft(suiteToDraft(suite)), suite);
  assert.equal(
    processDigest(parseSuiteDraft(suiteToDraft(suite))),
    processDigest(suite),
  );
  recovered.cases[0]!.questions!.configured[0]!.answer = "TEST human edit";
  assert.equal(
    suite.cases[0]!.questions!.configured[0]!.answer,
    original.configured[0]!.answer,
  );
});

test("omitted legacy questions and explicit empty fixtures survive draft conversion without digest changes", () => {
  const legacy = parseSuiteDraft(
    JSON.stringify({
      genericModelId: "TEST-model",
      cases: [newCaseDraft("success", 1)],
    }),
  );
  assert.equal(Object.hasOwn(newCaseDraft("success", 1), "questions"), false);
  assert.equal(
    Object.hasOwn(readSuiteDraft(suiteToDraft(legacy)).cases[0]!, "questions"),
    false,
  );
  assert.equal(
    Object.hasOwn(parseSuiteDraft(suiteToDraft(legacy)).cases[0]!, "questions"),
    false,
  );
  assert.equal(
    processDigest(parseSuiteDraft(suiteToDraft(legacy))),
    processDigest(legacy),
  );
  const explicit = NativeTestSuiteSchema.parse({
    ...legacy,
    cases: [{ ...legacy.cases[0], questions: { configured: [], generic: [] } }],
  });
  assert.deepEqual(parseSuiteDraft(suiteToDraft(explicit)), explicit);
  assert.equal(
    processDigest(parseSuiteDraft(suiteToDraft(explicit))),
    processDigest(explicit),
  );
});

test("blank question fields remain editable while submission requires complete matching canonical fixtures", () => {
  const blank = newQuestionDraft();
  assert.deepEqual(blank, { question: "", answer: "" });
  const draft = {
    genericModelId: "TEST-model",
    cases: [
      {
        ...newCaseDraft("success", 1),
        questions: { configured: [blank], generic: [newQuestionDraft()] },
      },
    ],
  };
  assert.deepEqual(
    readSuiteDraft(JSON.stringify(draft)).cases[0]!.questions,
    draft.cases[0]!.questions,
  );
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  draft.cases[0]!.questions = {
    configured: [{ question: "TEST configured?", answer: "TEST answer" }],
    generic: [{ question: "TEST generic?", answer: "TEST different answer" }],
  };
  assert.doesNotThrow(() => readSuiteDraft(JSON.stringify(draft)));
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  draft.cases[0]!.questions.generic[0]!.answer = "TEST answer";
  assert.deepEqual(
    parseSuiteDraft(JSON.stringify(draft)).cases[0]!.questions,
    draft.cases[0]!.questions,
  );
  draft.cases[0]!.questions.generic = [];
  assert.doesNotThrow(() => readSuiteDraft(JSON.stringify(draft)));
  assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  for (const replacement of [
    { question: " ", answer: "TEST answer" },
    { question: "TEST question", answer: "\n " },
  ]) {
    draft.cases[0]!.questions = {
      configured: [replacement],
      generic: [{ ...replacement }],
    };
    assert.doesNotThrow(() => readSuiteDraft(JSON.stringify(draft)));
    assert.throws(() => parseSuiteDraft(JSON.stringify(draft)));
  }
});

test("draft recovery caps question arrays and text and rejects partial or permission-shaped fixtures", () => {
  const fixture = { question: "TEST question?", answer: "TEST answer" };
  const draft = {
    genericModelId: "TEST-model",
    cases: [newCaseDraft("success", 1)],
  };
  const raw = (questions: unknown) =>
    JSON.stringify({ ...draft, cases: [{ ...draft.cases[0], questions }] });
  const maximum = {
    configured: Array.from({ length: 16 }, () => ({
      question: "q".repeat(2000),
      answer: "a".repeat(4000),
    })),
    generic: Array.from({ length: 16 }, () => ({
      question: "q".repeat(2000),
      answer: "a".repeat(4000),
    })),
  };
  assert.doesNotThrow(() => readSuiteDraft(raw(maximum)));
  assert.throws(() => parseSuiteDraft(raw(maximum))); // The aggregate native JSON budget still applies.
  assert.doesNotThrow(() =>
    parseSuiteDraft(
      raw({
        configured: [maximum.configured[0]],
        generic: [maximum.generic[0]],
      }),
    ),
  );
  assert.doesNotThrow(() =>
    parseSuiteDraft(
      raw({
        configured: Array(16).fill(fixture),
        generic: Array(16).fill(fixture),
      }),
    ),
  );
  for (const questions of [
    { configured: [fixture] },
    { configured: [fixture], generic: [fixture], approved: true },
    { configured: [{ ...fixture, approved: true }], generic: [fixture] },
    {
      configured: [{ ...fixture, question: "q".repeat(2001) }],
      generic: [fixture],
    },
    {
      configured: [fixture],
      generic: [{ ...fixture, answer: "a".repeat(4001) }],
    },
    { configured: Array(17).fill(fixture), generic: [fixture] },
    { configured: [fixture], generic: Array(17).fill(fixture) },
  ])
    assert.throws(() => readSuiteDraft(raw(questions)));
});
