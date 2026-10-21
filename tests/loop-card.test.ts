import { loopStepContent } from "../apps/server-admin/web/lib/loop-card";
import {
  loopFieldValue,
  loopNodeLabel,
  loopsCopy,
} from "../apps/server-admin/web/loops-copy";
import { readableName } from "../packages/protocol/display-name";
import { loopsFixtureDetail } from "./loops-admin-fixtures";

const copy = loopsCopy.en;
const facts = (step: ReturnType<typeof loopStepContent>) =>
  step.facts.map((fact) => `${fact.label}: ${fact.value}`);

test.each(["en", "cs"] as const)(
  "%s labels distinguish unverified running records and unconfirmed outcomes",
  (language) => {
    const copy = loopsCopy[language];
    expect(copy.runningUnverified).toBe(
      language === "en"
        ? "Saved status · not verified live"
        : "Uložený stav · živě neověřen",
    );
    expect(copy.unconfirmedOutcome).toBeTruthy();
    expect(
      loopNodeLabel({ kind: "error", label: "Unconfirmed outcome" }, copy),
    ).toBe(copy.unconfirmedOutcome);
    expect(loopFieldValue("Outcome", "unconfirmed_failure", copy)).toBe(
      copy.unconfirmedOutcomeHint,
    );
  },
);

test("service action steps lead with the readable action, service and key facts", () => {
  const action = loopsFixtureDetail.nodes.find((node) => node.action)!;
  const step = loopStepContent(action, copy);
  expect(step.kind).toBe(
    action.action!.effect === "write" ? copy.serviceWrite : copy.serviceRead,
  );
  expect(step.title).toBe(readableName(action.action!.actionName));
  expect(step.meta).toBe(action.action!.serviceName);
  expect(facts(step)).toEqual(["Query: Demo contact", "Contacts returned: 2"]);
  expect(JSON.stringify(step)).not.toContain(action.action!.operationId);
});

test("missing evidence is omitted instead of announced, and failures explain the outcome", () => {
  const discovery = loopsFixtureDetail.nodes.find(
    (node) => node.id === "discovery",
  )!;
  const bare = loopStepContent(
    { ...discovery, tool: undefined, details: [] },
    copy,
  );
  expect(bare).toMatchObject({ title: copy.findService, facts: [] });
  expect(bare.note).toBeUndefined();
  const failed = loopStepContent(
    {
      ...discovery,
      status: "failed",
      tool: {
        ...discovery.tool!,
        outcome: "failed",
        failure: {
          code: "TEST_FAILED",
          kind: "connection",
          stage: "dispatch",
          retry: "later",
          fields: [],
        },
      },
    },
    copy,
  );
  expect(failed.note).toBe(copy.failureConnection);
  expect(JSON.stringify(failed)).not.toContain("TEST_FAILED");
});

test("model steps name their model; envelope flags are not shown as results", () => {
  const model = loopsFixtureDetail.nodes.find((node) => node.kind === "model")!;
  const action = loopsFixtureDetail.nodes.find((node) => node.action)!;
  const step = loopStepContent(
    { ...model, details: [{ label: "Model", value: "TEST/demo-model-1" }] },
    copy,
  );
  expect(step).toMatchObject({ title: copy.agentTurn, meta: "Demo Model 1" });
  expect(step.facts).toEqual([]);
  const flagged = loopStepContent(
    {
      ...action,
      action: {
        ...action.action!,
        output: [
          { label: "success", value: "true" },
          { label: "value · Returned items", value: "15" },
        ],
      },
    },
    copy,
  );
  expect(facts(flagged)).toEqual(["Query: Demo contact", "Returned items: 15"]);
});

test.each(["en", "cs"] as const)(
  "%s action and tool steps with only envelope flags have no result facts",
  (language) => {
    const action = loopsFixtureDetail.nodes.find((node) => node.action)!;
    const discovery = loopsFixtureDetail.nodes.find(
      (node) => node.id === "discovery",
    )!;
    const output = [
      { label: "success", value: "true" },
      { label: "ok", value: "true" },
      { label: "isError", value: "false" },
      { label: "value · success", value: "true" },
      { label: "value · is error", value: "false" },
      { label: "value · OK", value: "true" },
    ];
    const nodes = [
      {
        ...action,
        action: { ...action.action!, input: [], output },
      },
      {
        ...discovery,
        tool: {
          ...discovery.tool!,
          input: [],
          output,
          inputRecorded: true,
          outputRecorded: true,
        },
      },
    ];
    const saved = JSON.parse(JSON.stringify(nodes));
    for (const node of nodes) {
      const step = loopStepContent(node, loopsCopy[language]);
      expect(step.facts).toEqual([]);
      expect(step.status).toBe(loopsCopy[language].succeeded);
    }
    expect(nodes).toEqual(saved);
  },
);

test.each(["en", "cs"] as const)(
  "%s genuine returned fields survive envelope flags and absent tool evidence stays omitted",
  (language) => {
    const discovery = loopsFixtureDetail.nodes.find(
      (node) => node.id === "discovery",
    )!;
    const recorded = {
      ...discovery,
      tool: {
        ...discovery.tool!,
        input: [],
        inputRecorded: true,
        outputRecorded: true,
        output: [
          { label: "success", value: "true" },
          { label: "value · Returned items", value: "15" },
          { label: "isError", value: "false" },
        ],
      },
    };
    const saved = JSON.parse(JSON.stringify(recorded));
    expect(facts(loopStepContent(recorded, loopsCopy[language]))).toEqual([
      "Returned items: 15",
    ]);
    expect(
      loopStepContent(
        {
          ...recorded,
          tool: { ...recorded.tool, outputRecorded: false },
        },
        loopsCopy[language],
      ).facts,
    ).toEqual([]);
    expect(recorded).toEqual(saved);
  },
);

test("conversation steps quote the recorded message", () => {
  const request = loopsFixtureDetail.nodes.find(
    (node) => node.kind === "request",
  )!;
  const step = loopStepContent(
    { ...request, details: [{ label: "Message", value: "TEST question" }] },
    copy,
  );
  expect(step).toMatchObject({ title: "TEST question", message: true });
});

test("decision steps name the chosen option instead of its recorded id", () => {
  const decision = {
    ...loopsFixtureDetail.nodes.find((node) => node.id === "discovery")!,
    kind: "decision" as const,
    tool: undefined,
    action: undefined,
  };
  const titled = (details: { label: string; value: string }[]) =>
    loopStepContent({ ...decision, details }, copy).title;
  expect(titled([{ label: "Choice", value: "service_0" }])).toBe(
    copy.choiceService,
  );
  expect(
    titled([
      { label: "Choice", value: "service_1" },
      { label: "Selected criterion", value: "TEST CRM: Contacts" },
    ]),
  ).toBe("TEST CRM");
  expect(titled([{ label: "Choice", value: "fallback" }])).toBe(
    copy.choiceNone,
  );
});

test("rejected tool input is said once", () => {
  const discovery = loopsFixtureDetail.nodes.find(
    (node) => node.id === "discovery",
  )!;
  const step = loopStepContent(
    {
      ...discovery,
      status: "failed",
      tool: {
        ...discovery.tool!,
        outcome: "invalid_arguments",
        failure: {
          code: "TEST_INVALID",
          kind: "validation",
          stage: "validation",
          retry: "correct_input",
          fields: [],
        },
      },
    },
    copy,
  );
  expect(step.status).toBe(copy.toolInvalid);
  expect(step.note).toBeUndefined();
});
