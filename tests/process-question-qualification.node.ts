import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NativeTestSuiteSchema,
  NativeTestQuestionFixturesSchema,
} from "../packages/protocol/process-native-testing";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { runProcessNativeComparison } from "../apps/server-identity/process-native-testing";
import { deriveNativeQualification } from "../apps/server-identity/process-native-qualification";
import { processNativeStamp } from "../apps/server-identity/process-native-environment";
import { processDigest } from "../apps/server-identity/process-validation";
import { fixture, admin } from "./helpers/service-process-runtime";
import { buildNativeTestFixture } from "./helpers/process-native-testing";
import { buildNativeQualificationSuite } from "./helpers/process-native-qualification";

const question = "TEST Which account should the process use?";
const answer = "  TEST canonical account\n";
async function setup(
  run: (x: ReturnType<typeof buildNativeTestFixture>) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "niaro-question-qualification-"));
  const h = fixture(join(root, "identity.sqlite"));
  try {
    await run(buildNativeTestFixture(h));
  } finally {
    await h.close();
    rmSync(root, { recursive: true, force: true });
  }
}
function questionArtifact(x: ReturnType<typeof buildNativeTestFixture>) {
  const draft = x.h.registry.saveDraft(admin, {
    serviceId: x.h.ids.serviceId,
    revision: 0,
    definition: ProcessDefinitionSchema.parse({
      ...x.artifact.definition,
      humanInput: "text",
    }),
  });
  return x.h.registry.freezeDraft(admin, draft.id, draft.revision);
}
function withQuestion(
  x: ReturnType<typeof buildNativeTestFixture>,
  item = x.read,
) {
  return {
    ...item,
    questions: {
      configured: [{ question, answer }],
      generic: [{ question, answer }],
    },
    models: {
      configured: [
        x.tool("ask_user", { question }, "TEST-configured-question"),
        ...item.models.configured,
      ],
      generic: [
        x.tool("ask_user", { question }, "TEST-generic-question"),
        ...item.models.generic,
      ],
    },
  };
}
function noProductionEffects(x: ReturnType<typeof buildNativeTestFixture>) {
  for (const table of [
    "test_dispatch",
    "test_model",
    "agent_service_invocation",
    "agent_inference_run",
    "agent_service_process_run",
    "agent_service_process_test",
    "agent_service_process_qualification",
  ])
    assert.equal(
      x.h.db.prepare(`SELECT count(*) AS n FROM ${table}`).get()!.n,
      0,
      table,
    );
  assert.equal(x.h.registry.get(admin, x.draft.id).activeVersion, null);
  assert.equal(
    x.h.db
      .prepare(
        "SELECT count(*) AS n FROM agent_service_process WHERE active_version IS NOT NULL",
      )
      .get()!.n,
    0,
  );
}

test("actual compiler3 question qualification completes all six families and resumes after suspended reopen", () =>
  setup(async (x) => {
    const artifact = questionArtifact(x);
    const suite = NativeTestSuiteSchema.parse({
      ...buildNativeQualificationSuite(x),
      cases: buildNativeQualificationSuite(x).cases.map((item) =>
        item.id === "read" || item.id === "restart"
          ? withQuestion(x, item)
          : item,
      ),
    });
    const report = await runProcessNativeComparison(
      artifact,
      x.catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    assert.equal(report.observations.length, 12);
    assert.equal(report.stamp.compilerVersion, "niaro-native-workflow/3");
    const qualification = deriveNativeQualification(
      artifact,
      suite,
      report,
      x.catalog,
    );
    assert.equal(
      qualification.status,
      "qualified",
      JSON.stringify(qualification),
    );
    for (const strategy of ["configured", "generic"] as const) {
      const restarted = report.observations.find(
        (item) => item.caseId === "restart" && item.strategy === strategy,
      )!;
      assert.equal(restarted.reopened, true);
      assert.equal(restarted.observed, "succeeded");
      assert.equal(restarted.approvals, 1);
      assert.equal(restarted.businessDispatches, 1);
      assert.equal(
        restarted.modelCalls,
        suite.cases.find((item) => item.id === "restart")!.models[strategy]
          .length,
      );
    }
    noProductionEffects(x);
  }));

test("missing question fixture leaves an incomplete native experiment", () =>
  setup(async (x) => {
    const item = withQuestion(x);
    const { questions: _questions, ...missing } = item;
    await assert.rejects(
      runProcessNativeComparison(
        questionArtifact(x),
        x.catalog,
        NativeTestSuiteSchema.parse({
          genericModelId: x.modelId,
          cases: [missing],
        }),
        new AbortController().signal,
        async () => {},
      ),
      /native_test_question_fixture_conflict/,
    );
    noProductionEffects(x);
  }));

test("wrong exact question fixture leaves an incomplete native experiment", () =>
  setup(async (x) => {
    const item = withQuestion(x);
    item.questions.configured[0]!.question = "TEST another question";
    await assert.rejects(
      runProcessNativeComparison(
        questionArtifact(x),
        x.catalog,
        NativeTestSuiteSchema.parse({
          genericModelId: x.modelId,
          cases: [item],
        }),
        new AbortController().signal,
        async () => {},
      ),
      /native_test_question_fixture_conflict/,
    );
    noProductionEffects(x);
  }));

test("generic question fixtures must also match the actual suspended question", () =>
  setup(async (x) => {
    const item = withQuestion(x);
    item.questions.generic[0]!.question = "TEST another generic question";
    await assert.rejects(
      runProcessNativeComparison(
        questionArtifact(x),
        x.catalog,
        NativeTestSuiteSchema.parse({
          genericModelId: x.modelId,
          cases: [item],
        }),
        new AbortController().signal,
        async () => {},
      ),
      /native_test_question_fixture_conflict/,
    );
    noProductionEffects(x);
  }));

test("successive questions consume each canonical fixture exactly once before terminal replay", () =>
  setup(async (x) => {
    const item = withQuestion(x);
    const second = {
      question: "TEST Which contact should be read?",
      answer: "TEST contact",
    };
    for (const strategy of ["configured", "generic"] as const) {
      item.questions[strategy].push(second);
      item.models[strategy].splice(
        1,
        0,
        x.tool(
          "ask_user",
          { question: second.question },
          "TEST-second-" + strategy,
        ),
      );
    }
    const suite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [item],
    });
    const report = await runProcessNativeComparison(
      questionArtifact(x),
      x.catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const observation of report.observations) {
      assert.equal(
        observation.modelCalls,
        item.models[observation.strategy].length,
      );
      assert.equal(observation.businessDispatches, 1);
      assert.deepEqual(observation.assertions, []);
    }
    noProductionEffects(x);
  }));

test("a canonical answer does not approve a later write", () =>
  setup(async (x) => {
    const rejected = buildNativeQualificationSuite(x).cases.find(
      (item) => item.id === "rejected",
    )!;
    const suite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [withQuestion(x, rejected)],
    });
    const report = await runProcessNativeComparison(
      questionArtifact(x),
      x.catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(
      report.status,
      "passed",
      JSON.stringify(report.observations, null, 2),
    );
    for (const observation of report.observations) {
      assert.equal(observation.observed, "rejected");
      assert.equal(observation.approvals, 1);
      assert.equal(observation.businessDispatches, 0);
    }
    noProductionEffects(x);
  }));

test("unconsumed question fixtures cannot pass a terminal native result", () =>
  setup(async (x) => {
    const item = { ...x.read, questions: withQuestion(x).questions };
    const suite = NativeTestSuiteSchema.parse({
      genericModelId: x.modelId,
      cases: [item],
    });
    const report = await runProcessNativeComparison(
      questionArtifact(x),
      x.catalog,
      suite,
      new AbortController().signal,
      async () => {},
    );
    assert.equal(report.status, "failed");
    assert(
      report.observations.every((item) =>
        item.assertions.includes("question_fixtures_unconsumed"),
      ),
    );
    noProductionEffects(x);
  }));

test("question fixtures are immutable bounded text and share canonical answers across strategies", () => {
  const fixtures = {
    configured: [{ question, answer }],
    generic: [{ question, answer }],
  };
  assert.deepEqual(NativeTestQuestionFixturesSchema.parse(fixtures), fixtures);
  for (const bad of [
    { ...fixtures, generic: [] },
    { ...fixtures, generic: [{ question, answer: "TEST different account" }] },
    { ...fixtures, configured: [{ question: " ", answer }] },
    { ...fixtures, configured: [{ question, answer: "a".repeat(4001) }] },
    { ...fixtures, configured: [{ question, answer, approved: true }] },
    {
      configured: Array(17).fill({ question, answer }),
      generic: Array(17).fill({ question, answer }),
    },
  ])
    assert.equal(
      NativeTestQuestionFixturesSchema.safeParse(bad).success,
      false,
    );
});

test("omitted question fixtures preserve legacy suite digests and compiler stamps", () =>
  setup(async (x) => {
    const suite = { genericModelId: x.modelId, cases: [x.read] };
    const parsed = NativeTestSuiteSchema.parse(suite);
    assert.equal(processDigest(parsed), processDigest(suite));
    assert.equal(Object.hasOwn(parsed.cases[0]!, "questions"), false);
    assert.equal(
      processNativeStamp(x.artifact, x.catalog, parsed).compilerVersion,
      "niaro-native-workflow/2",
    );
  }));
