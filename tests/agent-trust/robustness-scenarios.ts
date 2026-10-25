import assert from "node:assert/strict";
import {
  createTrustHarness,
  ServiceStatus,
  type TrustHarness,
} from "./harness";
import {
  parseProgram,
  programText,
} from "../../packages/openui-library/program";
import type { TrustQualityScenario } from "./quality-scenarios";
import { amountClaims, supportedAmount } from "./ui-scenarios";

/**
 * Live robustness matrix: requests that need several reads and that a CRM
 * like Twenty makes hard on purpose — date filters its schema calls
 * date-time but that accept only YYYY-MM-DD. The turn must end in an answer
 * grounded in the records, never in a failure the agent could have avoided.
 */
type Language = "en" | "cs";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const day = (base: Date, months: number, date: number) =>
  new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + months, date))
    .toISOString()
    .slice(0, 10);

function loanBook(now: number) {
  const today = new Date(now);
  const loans = [
    {
      name: "Investor A 2401",
      castka: 500_000,
      urok: 8,
      stav: "AKTIVNI",
      frekvenceVyplatyUroku: "MESICNE",
      datumKonceZapujcky: day(today, 10, 15),
    },
    {
      name: "Investor B 2402",
      castka: 1_000_000,
      urok: 9,
      stav: "AKTIVNI",
      frekvenceVyplatyUroku: "CTVRTLETNE",
      datumKonceZapujcky: day(today, 2, 28),
    },
    {
      name: "Investor C 2403",
      castka: 200_000,
      urok: 7,
      stav: "PO_TERMINU",
      frekvenceVyplatyUroku: "NA_KONCI",
      datumKonceZapujcky: day(today, -1, 10),
    },
    {
      name: "Investor D 2404",
      castka: 300_000,
      urok: 7,
      stav: "AKTIVNI",
      frekvenceVyplatyUroku: "MESICNE",
      datumKonceZapujcky: day(today, 1, 20),
    },
    {
      name: "Investor E 2405",
      castka: 400_000,
      urok: 6,
      stav: "SPLACENO",
      frekvenceVyplatyUroku: "MESICNE",
      datumKonceZapujcky: day(today, -3, 5),
    },
    {
      name: "Investor F 2406",
      castka: 750_000,
      urok: 10,
      stav: "AKTIVNI",
      frekvenceVyplatyUroku: "NA_KONCI",
      datumKonceZapujcky: day(today, 14, 1),
    },
  ].map((loan, index) => ({
    id: `TEST-loan-${index + 1}`,
    mena: "CZK",
    ...loan,
  }));
  const payouts = [
    ...[1, 2, 3].map((month) => ({
      zapujcka: "Investor A 2401",
      datum: day(today, month, 15),
      castka: 3_333,
      stav: "PLANOVANO",
    })),
    {
      zapujcka: "Investor B 2402",
      datum: day(today, 2, 1),
      castka: 22_500,
      stav: "PLANOVANO",
    },
    {
      zapujcka: "Investor D 2404",
      datum: day(today, 1, 20),
      castka: 1_750,
      stav: "PLANOVANO",
    },
    {
      zapujcka: "Investor A 2401",
      datum: day(today, -1, 15),
      castka: 3_333,
      stav: "VYPLACENO",
    },
  ].map((payout, index) => ({
    id: `TEST-payout-${index + 1}`,
    mena: "CZK",
    ...payout,
  }));
  // Ground truth: what leaves the company in the next three months.
  const horizon = [day(today, 0, 1), day(today, 4, 1)];
  const due = [
    ...payouts
      .filter(
        (p) =>
          p.stav === "PLANOVANO" &&
          p.datum >= horizon[0]! &&
          p.datum < horizon[1]!,
      )
      .map((p) => ({
        month: p.datum.slice(0, 7),
        amount: p.castka,
        kind: "payout",
      })),
    ...loans
      .filter(
        (l) =>
          l.stav === "AKTIVNI" &&
          l.datumKonceZapujcky >= horizon[0]! &&
          l.datumKonceZapujcky < horizon[1]!,
      )
      .map((l) => ({
        month: l.datumKonceZapujcky.slice(0, 7),
        amount: l.castka,
        kind: "principal",
      })),
  ];
  const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
  const months = [...new Set(due.map((d) => d.month))];
  const byMonth = months.map((m) =>
    sum(due.filter((d) => d.month === m).map((d) => d.amount)),
  );
  const kinds = ["payout", "principal"].map((k) =>
    sum(due.filter((d) => d.kind === k).map((d) => d.amount)),
  );
  const perKindMonth = months.flatMap((m) =>
    ["payout", "principal"].map((k) =>
      sum(
        due.filter((d) => d.month === m && d.kind === k).map((d) => d.amount),
      ),
    ),
  );
  const allowed = [
    ...loans.map((l) => l.castka),
    ...payouts.map((p) => p.castka),
    ...byMonth,
    ...kinds,
    ...perKindMonth,
    sum(byMonth),
    sum(loans.filter((l) => l.stav === "AKTIVNI").map((l) => l.castka)),
    sum(loans.filter((l) => l.stav !== "SPLACENO").map((l) => l.castka)),
  ].filter((v) => v > 0);
  return { loans, payouts, allowed, due };
}

export function configureLoans(h: TrustHarness) {
  const book = loanBook(h.now());
  const date = (description: string) => ({
    type: "string",
    format: "date-time",
    description: `${description} (ISO datetime)`,
  });
  const serviceId = h.command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST CRM",
      description:
        "Company CRM: loans from investors (zápůjčky) and their interest payouts (výplaty úroků), amounts in CZK",
      url: "https://services.example.test/crm",
      protocol: "openapi",
      icon: "database",
      auth: { type: "bearer" },
      enabled: true,
    },
    apiKey: "TEST-service-key",
  });
  const actions = [
    {
      name: "Search loans",
      description:
        "Find loan (zápůjčka) records. Fields: name, castka, urok, stav (AKTIVNI, PO_TERMINU, SPLACENO), frekvenceVyplatyUroku, datumKonceZapujcky, mena.",
      path: "/loans",
      properties: {
        stav: { type: "string", description: "Exact state" },
        konecOd: date("datumKonceZapujcky >="),
        konecDo: date("datumKonceZapujcky <="),
      },
    },
    {
      name: "Search interest payouts",
      description:
        "Find interest payout (výplata úroku) records. Fields: zapujcka, datum, castka, stav (PLANOVANO, VYPLACENO), mena.",
      path: "/payouts",
      properties: {
        stav: { type: "string", description: "Exact state" },
        datumOd: date("datum >="),
        datumDo: date("datum <="),
      },
    },
  ];
  for (const action of actions) {
    const properties = {
      ...action.properties,
      limit: {
        type: "integer",
        description: "Max records (default 10, max 100)",
      },
    };
    h.command({
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
          properties,
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: "GET",
          path: action.path,
          parameters: Object.keys(properties).map((name) => ({
            name,
            in: "query",
            required: false,
          })),
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["member"], users: [] },
      },
    });
  }
  const rejected: string[] = [];
  const range: Record<string, [string, "gte" | "lte"]> = {
    konecOd: ["datumKonceZapujcky", "gte"],
    konecDo: ["datumKonceZapujcky", "lte"],
    datumOd: ["datum", "gte"],
    datumDo: ["datum", "lte"],
  };
  h.onService(({ path, search }) => {
    const records = path.endsWith("/loans")
      ? book.loans
      : path.endsWith("/payouts")
        ? book.payouts
        : undefined;
    if (!records) return undefined;
    let rows: Record<string, unknown>[] = records;
    for (const [name, value] of search) {
      if (name === "limit") continue;
      if (name === "stav") {
        rows = rows.filter((row) => row.stav === value);
        continue;
      }
      const [field, op] = range[name] ?? [];
      if (!field) continue;
      if (!DATE.test(value)) {
        rejected.push(name);
        // As Twenty answers a datetime given to a DATE field.
        return new ServiceStatus(400, {
          success: false,
          error: `Invalid value '${value}' for date field "${field}". Expected format: 'YYYY-MM-DD'`,
        });
      }
      rows = rows.filter((row) =>
        op === "gte"
          ? (row[field] as string) >= value
          : (row[field] as string) <= value,
      );
    }
    const limit = Math.min(Number(search.get("limit") ?? 10) || 10, 100);
    return {
      records: rows.slice(0, limit),
      count: rows.length,
      hasNextPage: rows.length > limit,
    };
  });
  return { book, rejected };
}

const prompts: Record<Language, string> = {
  en: "Hi, please look at the state of our loans and show me a clear projected cashflow for the next 3 months.",
  cs: "Ahoj, koukni se prosím na stav zápujček a ukaž mi prosím zřetelný stav předpokládaného cashflow na další 3 měsíce.",
};
const FAILED =
  /could not be completed|nepodařilo dokončit|step limit|limit kroků|invalid response|neplatnou odpověď/i;

export const trustRobustnessScenarios: TrustQualityScenario[] = (
  Object.entries(prompts) as [Language, string][]
).map(([language, prompt]) => ({
  id: `robust.loan-cashflow.${language}`,
  title: `A multi-read cashflow over loans and payouts ends in a grounded answer (${language.toUpperCase()})`,
  quality: { caseId: "loan-cashflow", language },
  async run(probe) {
    const h = createTrustHarness({ signal: probe.signal });
    probe.defer(() => h.close());
    const { book, rejected } = configureLoans(h);
    h.onDecision((body) => {
      const criteria = body.questions?.route.criteria ?? {};
      if (!("fallback" in criteria)) return undefined;
      const services = Object.entries(criteria).filter(([key]) =>
        key.startsWith("service_"),
      );
      if (!services.length) return undefined;
      return (
        services.find(([, value]) => value.startsWith("TEST CRM"))?.[0] ??
        "fallback"
      );
    });
    const turn = await h.send(prompt, {
      id: `TEST-robust-${language}`,
      language: "en",
    });
    const message = turn.snapshot.conversations
      .flatMap((c) => c.messages)
      .find(
        (m) => m.role === "assistant" && m.replyToCommandId === turn.commandId,
      );
    const text = message?.text ?? "";
    const root = message?.ui?.program
      ? parseProgram(message.ui.program).root
      : null;
    const ui = root ? programText(root) : "";
    const reads = h.serviceRequests.map(({ url, body }) => ({ url, body }));
    probe.observe("quality", { caseId: "loan-cashflow", language });
    probe.observe("robust", {
      text,
      program: message?.ui?.program,
      reads,
      rejected,
      modelRequests: h.requests.length,
      due: book.due,
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
      "robust.turn.answered",
      "The turn ends in an answer, not a failure",
      () => {
        assert.equal(turn.status, "accepted");
        assert(message, "Missing reply");
        assert.doesNotMatch(text, FAILED);
      },
    );
    await score(
      "robust.reads.recovered",
      "A rejected date filter is corrected and both sources are read",
      () => {
        assert(
          reads.some((r) => r.url.startsWith("/crm/loans")),
          "No loan read",
        );
        assert(
          reads.some((r) => r.url.startsWith("/crm/payouts")),
          "No payout read",
        );
        assert(
          rejected.length <= 2,
          `${rejected.length} rejected date filters`,
        );
      },
    );
    await score(
      "robust.facts.grounded",
      "Every amount in the answer comes from the records or sums of them",
      () => {
        // Loan names carry numbers ("Investor A 2401") that are not amounts.
        const answer = book.loans.reduce(
          (all, loan) => all.replaceAll(loan.name, ""),
          `${text}\n${ui}`,
        );
        const unsupported = amountClaims(answer).filter(
          (claim) => !supportedAmount(claim, book.allowed),
        );
        assert.deepEqual(
          unsupported.map((c) => c.source),
          [],
          "Amounts not derivable from the records",
        );
        for (const loan of ["Investor B 2402", "Investor D 2404"])
          assert(
            `${text}\n${ui}`.includes(loan),
            `Missing repayment of ${loan}`,
          );
      },
    );
    await score(
      "robust.language.matches",
      "The answer is in the language of the message",
      () => {
        if (language === "cs") assert.match(text, /[áčďéěíňóřšťúůýž]/i);
        else assert.doesNotMatch(text, /[čďěňřšťůž]/i);
      },
    );
    if (failures.length)
      throw new Error(`Robustness score failed: ${failures.join(", ")}`);
  },
}));
