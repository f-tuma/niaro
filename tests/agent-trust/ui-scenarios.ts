import assert from "node:assert/strict";
import { createTrustHarness, type TrustHarness } from "./harness";
import {
  parseProgram,
  programText,
} from "../../packages/openui-library/program";
import type { TrustQualityScenario } from "./quality-scenarios";

/**
 * Live generated-UI matrix: when and how a real model adds an OpenUI program.
 * Paired EN/CS cases over synthetic business data; deterministic checks only.
 */
type Language = "en" | "cs";
type UiFixture = {
  caseId: string;
  title: string;
  prompts: Record<Language, string>;
  /** The service a correct router picks for this request, if any. */
  service?: string;
  /** Whether a visual helps here (several records, numbers, a schedule). */
  expectsUi: boolean;
  /** Facts the reply (text and UI) must carry, checked against the data. */
  grounded(evidence: UiEvidence): void;
};
export type UiEvidence = {
  text: string;
  program?: string;
  ui: string;
  /** Text and UI together: a fact may sit in either. */
  all: string;
};

const DAY = 24 * 60 * 60 * 1000;
const sales = [
  ["2026-07", "Praha", 412_000],
  ["2026-07", "Brno", 198_000],
  ["2026-07", "Ostrava", 121_000],
  ["2026-08", "Praha", 398_000],
  ["2026-08", "Brno", 224_000],
  ["2026-08", "Ostrava", 117_000],
  ["2026-09", "Praha", 455_000],
  ["2026-09", "Brno", 241_000],
  ["2026-09", "Ostrava", 139_000],
] as const;
const deals = [
  { id: "D-101", name: "Acme renewal", amount: 240_000, stage: "Proposal" },
  {
    id: "D-102",
    name: "Globex rollout",
    amount: 185_000,
    stage: "Negotiation",
  },
  { id: "D-103", name: "Initech pilot", amount: 64_000, stage: "Discovery" },
  {
    id: "D-104",
    name: "Umbrella expansion",
    amount: 410_000,
    stage: "Proposal",
  },
  { id: "D-105", name: "Hooli training", amount: 38_000, stage: "Negotiation" },
  { id: "D-106", name: "Stark audit", amount: 126_000, stage: "Discovery" },
  { id: "D-107", name: "Wayne support", amount: 92_000, stage: "Proposal" },
];
const plans = [
  { name: "Basic", priceCzk: 290, users: 3, storageGb: 50 },
  { name: "Pro", priceCzk: 790, users: 15, storageGb: 500 },
  { name: "Business", priceCzk: 1890, users: 100, storageGb: 2000 },
];
const events = (date: string) => [
  {
    title: "Acme Q4 review",
    start: `${date}T09:30:00Z`,
    end: `${date}T10:30:00Z`,
  },
  {
    title: "Globex onboarding",
    start: `${date}T13:00:00Z`,
    end: `${date}T14:00:00Z`,
  },
  {
    title: "Initech demo",
    start: `${date}T16:15:00Z`,
    end: `${date}T16:45:00Z`,
  },
];

const normalize = (value: string) =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLocaleLowerCase();
const has = (text: string, value: string) =>
  normalize(text).includes(normalize(value));

/**
 * Numbers a reader would take as amounts: years, small counts, times and
 * percentages are left out. A k/M suffix scales the value.
 */
export function amountClaims(text: string) {
  const claims: { value: number; scaled: boolean; source: string }[] = [];
  const pattern =
    /(?<![\d.,])(\d{1,3}(?:[   .,]\d{3}(?!\d))+|\d+)(?:[.,](\d+))?(?:\s*(k|K|tis\.?|M|mil\.?|mln\.?)(?!\p{L}))?(\s*%)?/gu;
  for (const match of text.matchAll(pattern)) {
    if (match[4]) continue;
    const whole = Number(match[1]!.replace(/[   .,]/g, ""));
    const value = Number(`${whole}${match[2] ? `.${match[2]}` : ""}`);
    const unit = match[3]?.toLowerCase();
    const scale = !unit
      ? 1
      : unit.startsWith("k") || unit.startsWith("tis")
        ? 1e3
        : 1e6;
    const amount = value * scale;
    if (!unit && (amount < 100 || (amount >= 1900 && amount <= 2100))) continue;
    claims.push({ value: amount, scaled: !!unit, source: match[0] });
  }
  return claims;
}
/** Whether a claimed amount is one of the allowed values, as written or in thousands. */
export function supportedAmount(
  claim: { value: number; scaled: boolean },
  allowed: number[],
) {
  const candidates = claim.scaled
    ? [claim.value]
    : [claim.value, claim.value * 1e3, claim.value * 1e6];
  return candidates.some((candidate) =>
    allowed.some(
      (value) =>
        Math.abs(candidate - value) <=
        Math.abs(value) * (claim.scaled ? 0.06 : 0.01),
    ),
  );
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
const salesAllowed = (() => {
  const months = [...new Set(sales.map(([month]) => month))];
  const branches = [...new Set(sales.map(([, branch]) => branch))];
  const byMonth = months.map((month) =>
    sum(sales.filter(([m]) => m === month).map(([, , v]) => v)),
  );
  const byBranch = branches.map((branch) =>
    sum(sales.filter(([, b]) => b === branch).map(([, , v]) => v)),
  );
  const series = [
    byMonth,
    ...branches.map((branch) =>
      sales.filter(([, b]) => b === branch).map(([, , v]) => v),
    ),
  ];
  // Changes between any two months, e.g. July to September.
  const differences = series.flatMap((values) =>
    values.flatMap((value, index) =>
      values.slice(index + 1).map((later) => later - value),
    ),
  );
  return [
    ...sales.map(([, , v]) => v),
    ...byMonth,
    ...byBranch,
    sum(byMonth),
    ...byMonth.map((v) => Math.round(v / branches.length)),
    ...byBranch.map((v) => Math.round(v / months.length)),
    Math.round(sum(byMonth) / months.length),
    ...differences.map(Math.abs),
  ];
})();

const fixtures: UiFixture[] = [
  {
    caseId: "sales-numbers",
    title: "Monthly numbers by branch become a grounded visual",
    prompts: {
      en: "How did our sales develop in Q3 2026 by month and branch?",
      cs: "Jak se vyvíjely naše tržby ve 3. čtvrtletí 2026 po měsících a pobočkách?",
    },
    service: "TEST Business data",
    expectsUi: true,
    grounded({ ui, all }) {
      for (const branch of ["Praha", "Brno", "Ostrava"])
        assert(
          has(ui, branch) || has(ui, branch === "Praha" ? "Prague" : branch),
          `The UI omits branch ${branch}`,
        );
      const unsupported = amountClaims(all).filter(
        (claim) => !supportedAmount(claim, salesAllowed),
      );
      assert.deepEqual(
        unsupported.map((claim) => claim.source),
        [],
        "Amounts not derivable from the sales records",
      );
    },
  },
  {
    caseId: "deal-list",
    title: "A filtered set of records lists exactly the matching ones",
    prompts: {
      en: "Show my open deals worth more than 100,000 CZK.",
      cs: "Ukaž moje otevřené obchody v hodnotě nad 100 000 Kč.",
    },
    service: "TEST Business data",
    expectsUi: true,
    grounded({ all }) {
      for (const deal of deals)
        assert.equal(
          has(all, deal.name),
          deal.amount > 100_000,
          `${deal.name} (${deal.amount}) is ${deal.amount > 100_000 ? "missing" : "shown although below the limit"}`,
        );
      const unsupported = amountClaims(all).filter(
        (claim) =>
          !supportedAmount(claim, [
            100_000,
            ...deals.map((deal) => deal.amount),
            sum(deals.filter((d) => d.amount > 100_000).map((d) => d.amount)),
          ]),
      );
      assert.deepEqual(
        unsupported.map((claim) => claim.source),
        [],
        "Amounts not in the deal records",
      );
    },
  },
  {
    caseId: "schedule",
    title: "A day's schedule shows each event at its time",
    prompts: {
      en: "What is on my calendar tomorrow?",
      cs: "Co mám zítra v kalendáři?",
    },
    service: "TEST Business data",
    expectsUi: true,
    grounded({ all }) {
      for (const [title, time] of [
        ["Acme Q4 review", "9:30"],
        ["Globex onboarding", "13:00"],
        ["Initech demo", "16:15"],
      ] as const) {
        assert(has(all, title), `Missing event ${title}`);
        assert(
          new RegExp(`(?<!\\d)0?${time.replace(":", "[:.]")}`).test(all),
          `Missing start time ${time} of ${title}`,
        );
      }
    },
  },
  {
    caseId: "plan-comparison",
    title: "A comparison of options carries every option and its price",
    prompts: {
      en: "Compare our Basic, Pro and Business plans.",
      cs: "Porovnej naše tarify Basic, Pro a Business.",
    },
    service: "TEST Business data",
    expectsUi: true,
    grounded({ ui, all }) {
      for (const plan of plans) {
        assert(has(ui, plan.name), `The UI omits plan ${plan.name}`);
        assert(
          amountClaims(all).some((claim) => claim.value === plan.priceCzk) ||
            new RegExp(`(?<![\\d ])${plan.priceCzk}(?!\\d)`).test(all) ||
            all.includes(plan.priceCzk.toLocaleString("cs-CZ")),
          `Missing price ${plan.priceCzk} of ${plan.name}`,
        );
      }
    },
  },
  {
    caseId: "general-question",
    title: "A general one-fact question stays text only",
    prompts: {
      en: "What is the capital of Czechia?",
      cs: "Jaké je hlavní město Česka?",
    },
    expectsUi: false,
    grounded({ text }) {
      assert(/prague|praha/u.test(normalize(text)), "Expected Prague");
    },
  },
  {
    caseId: "single-fact",
    title: "One looked-up fact stays text only",
    prompts: {
      en: "What is Jane Test's email address?",
      cs: "Jaký e-mail má Jane Testová?",
    },
    service: "TEST Calendar and contacts",
    expectsUi: false,
    grounded({ text }) {
      assert(
        text.includes("jane@example.test"),
        "Expected the looked-up email",
      );
    },
  },
];

/** Read actions over synthetic business data, answered by the scenario. */
function configureBusinessData(h: TrustHarness) {
  const serviceId = h.command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST Business data",
      description:
        "Company sales by month and branch (CZK), open deals, the calendar and the price list of plans",
      url: "https://services.example.test/business",
      protocol: "openapi",
      icon: "database",
      auth: { type: "bearer" },
      enabled: true,
    },
    apiKey: "TEST-service-key",
  });
  const actions = [
    {
      name: "List monthly sales",
      description:
        "Revenue in CZK for each month and branch of a quarter, e.g. 2026-Q3",
      path: "/sales",
      parameter: { name: "quarter", schema: { type: "string" } },
    },
    {
      name: "List open deals",
      description: "The person's open deals with amount in CZK and stage",
      path: "/deals",
    },
    {
      name: "List calendar events",
      description: "The person's calendar events on one day (YYYY-MM-DD, UTC)",
      path: "/events",
      parameter: { name: "date", schema: { type: "string" } },
      required: true,
    },
    {
      name: "Get price list",
      description: "The plans the company sells with monthly price in CZK",
      path: "/plans",
    },
  ];
  const tools: Record<string, string> = {};
  for (const action of actions) {
    const id = h.command({
      type: "saveAction",
      serviceId,
      serviceRevision: h.catalog.service(h.target.workspaceId, serviceId)
        .revision,
      revision: 0,
      settings: {
        name: `TEST ${action.name}`,
        description: action.description,
        inputSchema: {
          type: "object",
          properties: action.parameter
            ? { [action.parameter.name]: action.parameter.schema }
            : {},
          ...(action.required ? { required: [action.parameter!.name] } : {}),
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: "GET",
          path: action.path,
          parameters: action.parameter
            ? [
                {
                  name: action.parameter.name,
                  in: "query",
                  required: !!action.required,
                },
              ]
            : [],
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["member"], users: [] },
      },
    });
    tools[action.name] = "action_" + String(id).replaceAll("-", "_");
  }
  const tomorrow = new Date(h.now() + DAY).toISOString().slice(0, 10);
  h.onService(({ path, search }) => {
    if (path.endsWith("/sales"))
      return {
        currency: "CZK",
        quarter: "2026-Q3",
        rows: sales.map(([month, branch, revenue]) => ({
          month,
          branch,
          revenue,
        })),
      };
    if (path.endsWith("/deals")) return { currency: "CZK", deals };
    if (path.endsWith("/plans"))
      return { currency: "CZK", period: "month", plans };
    if (path.endsWith("/events")) {
      const date = search.get("date") ?? "";
      return {
        timeZone: "UTC",
        date,
        events: date === tomorrow ? events(date) : [],
      };
    }
    return undefined;
  });
  return { tools, tomorrow };
}

const UI_REFUSED = "openui-lang program was refused";
const CZECH = /[áčďéěíňóřšťúůýž]/iu;
/** English labels a Czech UI would translate; record values are left alone. */
const ENGLISH_LABELS =
  /\b(?:revenue|sales|total|price|users|storage|month|branch|deals?|stage|amount|value|events?|time|schedule|monthly|start|end)\b/iu;
/** Sentences, not counting the dots of ordinals ("3. čtvrtletí") and abbreviations ("tis. Kč"). */
export const sentences = (text: string) =>
  text
    .replace(/\d[.,]\d/g, "0")
    .replace(
      /(?:\d|\b(?:tis|mil|mld|mln|resp|tzv|např|atd|apod|e\.g|i\.e|vs))\./giu,
      "$&\u0000",
    )
    .split(/(?<=[.!?])(?<!\.\u0000)\s+(?=[\p{Lu}*])/u)
    .filter((part) => part.trim()).length;

export const trustUiScenarios: TrustQualityScenario[] = fixtures.flatMap(
  (fixture) =>
    (Object.entries(fixture.prompts) as [Language, string][]).map(
      ([language, prompt]) => ({
        id: `ui.${fixture.caseId}.${language}`,
        title: `${fixture.title} (${language.toUpperCase()})`,
        quality: { caseId: fixture.caseId, language },
        async run(probe) {
          const h = createTrustHarness({ signal: probe.signal });
          probe.defer(() => h.close());
          configureBusinessData(h);
          // Service routing is a scripted decision in this harness: it picks
          // the service a correct router would, so the run measures the UI.
          h.onDecision((body) => {
            const criteria = body.questions?.route.criteria ?? {};
            if (!("fallback" in criteria)) return undefined;
            const services = Object.entries(criteria).filter(([key]) =>
              key.startsWith("service_"),
            );
            if (!services.length) return undefined;
            return (
              services.find(([, value]) =>
                fixture.service ? value.startsWith(fixture.service) : false,
              )?.[0] ?? "fallback"
            );
          });
          const turn = await h.send(prompt, {
            id: `TEST-ui-${fixture.caseId}-${language}`,
            language,
          });
          const reply = turn.snapshot.conversations
            .flatMap((conversation) => conversation.messages)
            .find(
              (message) =>
                message.role === "assistant" &&
                message.replyToCommandId === turn.commandId,
            );
          const program = reply?.ui?.program;
          const root = program ? parseProgram(program).root : null;
          const ui = root ? programText(root) : "";
          const text = reply?.text ?? "";
          const repairs = h.requests.filter((request) =>
            (request.messages ?? []).some((message) =>
              message.content?.includes(UI_REFUSED),
            ),
          ).length;
          const toolCalls = h.requests.flatMap((request) =>
            (request.messages ?? []).flatMap((message) => {
              const calls = (
                message as { tool_calls?: { function?: { name?: string } }[] }
              ).tool_calls;
              return Array.isArray(calls)
                ? calls.map((call) => call.function?.name)
                : [];
            }),
          );
          probe.observe("quality", { caseId: fixture.caseId, language });
          probe.observe("ui", {
            expected: fixture.expectsUi,
            present: !!program,
            repairs,
            text,
            program,
            programChars: program?.length ?? 0,
            components: [
              ...new Set(
                [...(program ?? "").matchAll(/\b([A-Z][A-Za-z]+)\(/g)].map(
                  (match) => match[1],
                ),
              ),
            ],
            modelRequests: h.requests.length,
            toolCalls: [...new Set(toolCalls)],
            serviceRequests: h.serviceRequests.map(({ method, url }) => ({
              method,
              url,
            })),
          });

          const failures: string[] = [];
          const score = async (
            id: string,
            description: string,
            assertion: () => void,
          ) => {
            try {
              await probe.check(id, description, assertion);
            } catch {
              failures.push(id);
            }
          };
          await score(
            "ui.turn.answered",
            "The turn is accepted with a correlated reply",
            () => {
              assert.equal(turn.status, "accepted");
              assert(reply, "Missing correlated reply");
            },
          );
          await score(
            fixture.expectsUi ? "ui.use.when-helpful" : "ui.use.not-needless",
            fixture.expectsUi
              ? "The answer carries generated UI where a visual helps"
              : "A simple answer stays text only",
            () =>
              assert.equal(
                !!program,
                fixture.expectsUi,
                fixture.expectsUi ? "No UI" : "Needless UI",
              ),
          );
          await score(
            "ui.admission.first-try",
            "The server admits the model's program without a repair round",
            () => assert.equal(repairs, 0, `${repairs} UI repair request(s)`),
          );
          await score(
            "ui.facts.grounded",
            "Text and UI carry the requested facts and only facts from the data",
            () =>
              fixture.grounded({ text, program, ui, all: `${text}\n${ui}` }),
          );
          if (program) {
            await score(
              "ui.text.brief",
              "With UI, the text is one or two sentences and leaves details to the UI",
              () => {
                assert(
                  text.length <= 500,
                  `Text has ${text.length} characters`,
                );
                assert(
                  sentences(text) <= 3,
                  `Text has ${sentences(text)} sentences`,
                );
              },
            );
            await score(
              "ui.language.matches",
              "UI text is in the person's language",
              () =>
                language === "cs"
                  ? assert(
                      !ENGLISH_LABELS.test(ui),
                      `English label in a Czech UI: ${ui.match(ENGLISH_LABELS)?.[0]}`,
                    )
                  : assert(!CZECH.test(ui), "Czech text in an English UI"),
            );
          }
          if (failures.length)
            throw new Error(`UI score failed: ${failures.join(", ")}`);
        },
      }),
    ),
);
