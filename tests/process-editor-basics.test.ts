import {
  formatAgentInstructions,
  parseAgentInstructions,
} from "../apps/server-admin/web/lib/agent-instructions";
import {
  processIssueCopy,
  processIssues,
  processIssuesTruncated,
} from "../apps/server-admin/web/lib/process-issues";
import { designUiCandidate } from "./admin-design-fixtures";

const titles: Record<string, string> = {
  lookup: "Find contacts",
  check: "Condition",
  explain: "Agent",
  finish: "Return result",
};
const place = (
  issues: { code: string; path: string }[],
  language: "en" | "cs" = "en",
) =>
  processIssues(
    { issues: issues as never },
    designUiCandidate,
    processIssueCopy(language),
    (step) => titles[step.id]!,
  );

test("each validation issue lands on its step with a sentence naming the step and the fix", () => {
  const [binding, unproven, action, model, graph, limit] = place([
    { code: "binding_invalid", path: "/steps/0/input/name" },
    { code: "binding_type_unproven", path: "/steps/3/output/found" },
    { code: "resource_unavailable", path: "/steps/0/actionId" },
    { code: "resource_unavailable", path: "/steps/2/modelId" },
    { code: "graph_invalid", path: "/steps/check" },
    { code: "limit_exceeded", path: "/limits/maxSteps" },
  ]);
  expect(binding).toMatchObject({ stepId: "lookup" });
  expect(binding!.sentence).toBe(
    "Find contacts: give “name” a value from the process input or an earlier step.",
  );
  expect(unproven).toMatchObject({ stepId: "finish" });
  expect(unproven!.sentence).toContain("Return result: “found”");
  expect(action!.sentence).toBe(
    "Find contacts: its action is off or missing; turn it on in Services or choose another one.",
  );
  expect(model).toMatchObject({ stepId: "explain" });
  expect(model!.sentence).toContain("choose another model");
  // A graph issue addressed by step id is placed on that step too.
  expect(graph).toMatchObject({ stepId: "check" });
  // Limits concern the whole process.
  expect(limit).toMatchObject({ stepId: null });
  expect(limit!.sentence).toContain("Limits");
});

test("issues read in Czech and the 20-issue cut is said, not hidden", () => {
  const [issue] = place(
    [{ code: "binding_invalid", path: "/steps/0/input/name" }],
    "cs",
  );
  expect(issue!.sentence).toBe(
    "Find contacts: doplň „name“ hodnotou ze vstupu procesu nebo z dřívějšího kroku.",
  );
  const many = Array.from({ length: 20 }, () => ({
    code: "binding_invalid" as const,
    path: "/steps/0/input/name",
  }));
  expect(processIssuesTruncated({ issues: many })).toBe(true);
  expect(processIssuesTruncated({ issues: many.slice(1) })).toBe(false);
  // Every sentence exists in both languages.
  expect(Object.keys(processIssueCopy("cs")).sort()).toEqual(
    Object.keys(processIssueCopy("en")).sort(),
  );
});

test("agent instructions round-trip as Goal, Steps, Never and Done when", () => {
  const text = [
    "Goal: Summarise the open deals.",
    "Steps:",
    "1. Read the deals.",
    "2. Group them by owner",
    "   and stage.",
    "Never:",
    "- Change a deal.",
    "Done when: every owner has one line.",
  ].join("\n");
  const parts = parseAgentInstructions(text);
  expect(parts).toEqual({
    goal: "Summarise the open deals.",
    steps: ["Read the deals.", "Group them by owner and stage."],
    never: ["Change a deal."],
    doneWhen: "every owner has one line.",
  });
  expect(formatAgentInstructions(parts!)).toBe(
    [
      "Goal: Summarise the open deals.",
      "Steps:",
      "1. Read the deals.",
      "2. Group them by owner and stage.",
      "Never:",
      "- Change a deal.",
      "Done when: every owner has one line.",
    ].join("\n"),
  );
  // Free text and headings out of order stay free text.
  expect(parseAgentInstructions("Explain synthetic results")).toBeNull();
  expect(parseAgentInstructions("Steps:\n1. a\nGoal: b")).toBeNull();
  expect(parseAgentInstructions("")).toEqual({
    goal: "",
    steps: [],
    never: [],
    doneWhen: "",
  });
});
