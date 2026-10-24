import assert from "node:assert/strict";
import { test } from "node:test";
import {
  toolResults,
  type LiveTrustModel,
  type ModelRequest,
} from "./agent-trust/harness";
import { evaluateTrust } from "./agent-trust/runner";
import {
  amountClaims,
  sentences,
  supportedAmount,
  trustUiScenarios,
} from "./agent-trust/ui-scenarios";
import { validateBalancedQualitySelection } from "./agent-trust/quality-scenarios";

test("live UI matrix has paired English and Czech cases", () => {
  const cases = [
    "deal-list",
    "general-question",
    "plan-comparison",
    "sales-numbers",
    "schedule",
    "single-fact",
  ];
  for (const language of ["en", "cs"])
    assert.deepEqual(
      trustUiScenarios
        .filter((scenario) => scenario.quality.language === language)
        .map((scenario) => scenario.quality.caseId)
        .sort(),
      cases,
    );
  assert.throws(
    () => validateBalancedQualitySelection([trustUiScenarios[0]!]),
    /both EN and CS/,
  );
});

test("amount claims read grouped, decimal and scaled numbers and skip years and percentages", () => {
  assert.deepEqual(
    amountClaims(
      "Revenue 1 234 567 Kč, 412,000 CZK, 1,2 M, 455 k, +12 % in 2026, Q3, 09:30",
    ).map((claim) => claim.value),
    [1_234_567, 412_000, 1_200_000, 455_000],
  );
  assert(supportedAmount({ value: 412, scaled: false }, [412_000]));
  assert(supportedAmount({ value: 1_200_000, scaled: true }, [1_160_000]));
  assert(!supportedAmount({ value: 999_000, scaled: false }, [412_000]));
});

test("sentence count ignores ordinals and abbreviations", () => {
  assert.equal(
    sentences(
      "Tržby ve 3. čtvrtletí rostly z 731 tis. Kč na 835 tis. Kč, tedy o 14,2 %. Největší byla Praha.",
    ),
    2,
  );
  assert.equal(sentences("One. Two. Three."), 3);
});

/** A scripted provider in place of a paid model: it reads the data and writes a reply. */
function scriptedModel(
  reply: (results: Record<string, any>[]) => string,
  need: string,
): LiveTrustModel {
  return {
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-live-ui",
    apiKey: "TEST-key",
    maxOutputTokensPerRequest: 4000,
    reserve: async () => {},
    transport: async (req) => {
      const body = req.body as ModelRequest;
      const tools = (body.tools ?? []) as {
        function: { name: string; description?: string };
      }[];
      const results = toolResults(body).filter(
        (result) => result.currentTurn === true && result.data,
      );
      const action = tools.find((tool) =>
        tool.function.description?.includes(need),
      );
      const message = results.length
        ? { content: reply(results) }
        : action
          ? {
              content: null,
              tool_calls: [
                {
                  id: `TEST-call-${body.messages?.length ?? 0}`,
                  type: "function",
                  function: {
                    name: action.function.name,
                    arguments: JSON.stringify({ quarter: "2026-Q3" }),
                  },
                },
              ],
            }
          : {
              content: null,
              tool_calls: [
                {
                  id: `TEST-find-${body.messages?.length ?? 0}`,
                  type: "function",
                  function: {
                    name: "find_actions",
                    arguments: JSON.stringify({
                      service: "TEST Business data",
                      need,
                    }),
                  },
                },
              ],
            };
      return {
        status: 200,
        headers: {},
        text: JSON.stringify({
          model: "TEST-live-ui",
          choices: [{ message, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      };
    },
  };
}

const salesReply = (amount: number) => () =>
  [
    "Sales grew in September, mainly in Praha.",
    "",
    "```openui-lang",
    "root = Stack([kpi, chart])",
    `kpi = Row([Metric("Q3 revenue", "${amount.toLocaleString("en-US")}", "CZK")])`,
    'chart = BarChart(["Jul", "Aug", "Sep"], [Series("Praha", [412, 398, 455]), Series("Brno", [198, 224, 241]), Series("Ostrava", [121, 117, 139])])',
    "```",
  ].join("\n");

test("a grounded sales visual passes every UI check", async () => {
  const scenario = trustUiScenarios.find(
    (entry) => entry.id === "ui.sales-numbers.en",
  )!;
  const model = scriptedModel(salesReply(2_305_000), "Revenue in CZK");
  const systems: string[] = [];
  const report = await evaluateTrust([scenario], undefined, {
    liveModel: {
      ...model,
      transport: (req) => {
        for (const message of (req.body as ModelRequest).messages ?? [])
          if (message.role === "system" && message.content)
            systems.push(message.content);
        return model.transport(req);
      },
    },
    timeoutMs: 60_000,
  });
  assert(
    systems.some((content) =>
      content.includes("The person's app language is English"),
    ),
    "The model is told the person's language",
  );
  const result = report.scenarios[0]!;
  assert.equal(result.status, "passed", JSON.stringify(result.checks, null, 2));
  assert.deepEqual(
    result.checks.map((check) => check.id),
    [
      "ui.turn.answered",
      "ui.use.when-helpful",
      "ui.admission.first-try",
      "ui.facts.grounded",
      "ui.text.brief",
      "ui.language.matches",
    ],
  );
  const ui = result.observations.ui as {
    present: boolean;
    components: string[];
  };
  assert.equal(ui.present, true);
  assert.deepEqual(ui.components, [
    "Stack",
    "Row",
    "Metric",
    "BarChart",
    "Series",
  ]);
});

test("an invented amount fails grounding and Czech UI in an English answer fails language", async () => {
  const scenario = trustUiScenarios.find(
    (entry) => entry.id === "ui.sales-numbers.en",
  )!;
  const report = await evaluateTrust([scenario], undefined, {
    liveModel: scriptedModel(
      () =>
        salesReply(9_999_000)().replace('"Q3 revenue"', '"Tržby za čtvrtletí"'),
      "Revenue in CZK",
    ),
    timeoutMs: 60_000,
  });
  const failed = report.scenarios[0]!.checks.filter(
    (check) => check.status === "failed",
  ).map((check) => check.id);
  assert.deepEqual(failed, ["ui.facts.grounded", "ui.language.matches"]);
});

test("UI for a simple question counts as needless", async () => {
  const scenario = trustUiScenarios.find(
    (entry) => entry.id === "ui.general-question.en",
  )!;
  const report = await evaluateTrust([scenario], undefined, {
    liveModel: {
      ...scriptedModel(() => "", "never"),
      transport: async () => ({
        status: 200,
        headers: {},
        text: JSON.stringify({
          model: "TEST-live-ui",
          choices: [
            {
              message: {
                content:
                  'The capital is Prague.\n\n```openui-lang\nroot = Stack([Metric("Capital", "Prague")])\n```',
              },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      }),
    },
    timeoutMs: 60_000,
  });
  const checks = report.scenarios[0]!.checks;
  assert.equal(
    checks.find((check) => check.id === "ui.use.not-needless")?.status,
    "failed",
  );
  assert.equal(
    checks.find((check) => check.id === "ui.facts.grounded")?.status,
    "passed",
  );
});
