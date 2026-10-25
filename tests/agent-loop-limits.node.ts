import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustHarness, toolResults } from "./agent-trust/harness";
import { messageLanguage } from "../apps/server-identity/mastra-domain";

const reply = (
  result: Awaited<ReturnType<ReturnType<typeof createTrustHarness>["send"]>>,
) => {
  const message = result.snapshot.conversations
    .flatMap((conversation) => conversation.messages)
    .find(
      (entry) =>
        entry.role === "assistant" &&
        entry.replyToCommandId === result.commandId,
    );
  assert(message, "Every turn has a correlated reply");
  return message.text;
};

test("a run that keeps calling tools answers from what it has in its last steps", async () => {
  const h = createTrustHarness();
  try {
    let reads = 0;
    const answer =
      "Jane Test's email is jane@example.test. I could not finish checking every other contact in the steps available.";
    h.onChat((body) => {
      // The last steps offer no tools: the model has to answer.
      if (!body.tools?.length) return { content: answer };
      if (
        !body.tools.some(
          (tool) => tool.function.name === h.tool("Find contact"),
        )
      )
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "find contact",
        });
      return h.call(h.tool("Find contact"), {
        name: ++reads % 2 ? "Jane Test" : "Jane",
      });
    });
    const result = await h.send("Find Jane Test and every other Jane.", {
      id: "TEST-final-steps",
    });
    assert.equal(result.status, "accepted");
    assert.equal(reply(result), answer);
    const modelRequests = h.requests.filter((request) => request.messages);
    // The first of the two answering steps (the 23rd) already answers; the
    // second is left for a checker repair.
    assert.equal(modelRequests.length, 23);
    assert(!modelRequests.at(-1)!.tools?.length);
    assert(modelRequests.at(-2)!.tools?.length);
    assert(
      modelRequests
        .at(-1)!
        .messages!.some(
          (message) =>
            message.role === "system" &&
            message.content?.includes("no more tools can be called"),
        ),
      "The model is told why it must answer now",
    );
  } finally {
    await h.close();
  }
});

test("a read too large to keep tells the model to ask for less, and it can", async () => {
  const h = createTrustHarness();
  try {
    h.onService(({ path, search }) =>
      path.endsWith("/contacts") && search.get("name") === "Jane"
        ? {
            contacts: Array.from({ length: 900 }, (_, index) => ({
              id: `TEST-${index}`,
              name: `Jane ${index}`,
              email: `jane.${index}@example.test`,
              notes: "x".repeat(40),
            })),
          }
        : undefined,
    );
    let failure: Record<string, unknown> | undefined;
    h.onChat((body) => {
      if (
        !body.tools?.some(
          (tool) => tool.function.name === h.tool("Find contact"),
        )
      )
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "find contact",
        });
      const results = toolResults(body).filter((r) => r.currentTurn === true);
      failure ??= results.find((r) => r.status === "failed")?.failure;
      if (!results.length)
        return h.call(h.tool("Find contact"), { name: "Jane" });
      if (!results.some((r) => r.status === "succeeded"))
        return h.call(h.tool("Find contact"), { name: "Jane Test" });
      return { content: "Jane Test's email is jane@example.test." };
    });
    const result = await h.send("Find Jane Test's email.", {
      id: "TEST-too-large",
    });
    assert.equal(result.status, "accepted");
    assert.equal(reply(result), "Jane Test's email is jane@example.test.");
    assert(failure, "The model saw the refused read");
    assert.equal(failure.code, "integration_response_too_large");
    assert.equal(failure.retry, "correct_input");
    assert.match(String(failure.message), /too large .*fewer records/);
  } finally {
    await h.close();
  }
});

test("a message's language is recognised when it is clear", () => {
  assert.equal(
    messageLanguage(
      "Ahoj, koukni se prosím na stav zápujček a ukaž mi prosím zřetelný stav předpokládaného cashflow na další 3 měsíce.",
    ),
    "cs",
  );
  assert.equal(
    messageLanguage("Ukaž moje otevřené obchody nad 100 000 Kč."),
    "cs",
  );
  assert.equal(messageLanguage("What is on my calendar today?"), "en");
  // A name or a quoted word with diacritics does not make a message Czech.
  assert.equal(messageLanguage("TEST submitted request žluťoučký"), undefined);
  assert.equal(messageLanguage("ok"), undefined);
});

test("a decision model that sees no fitting service or action still shows the model what exists", async () => {
  const h = createTrustHarness();
  try {
    h.onDecision((body) => {
      const criteria = body.questions?.route.criteria ?? {};
      return "fallback" in criteria ? "fallback" : undefined;
    });
    const seen: Record<string, unknown>[] = [];
    h.onChat((body) => {
      const results = (body.messages ?? [])
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(message.content ?? "{}"));
      seen.push(...results);
      if (!results.some((result) => Array.isArray(result.services)))
        return h.call("find_service", { need: "loans and their payouts" });
      if (!results.some((result) => Array.isArray(result.actions)))
        return h.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "loans and their payouts",
        });
      return { content: "No connected service holds loans." };
    });
    const result = await h.send("Show me our loans.", { id: "TEST-no-fit" });
    assert.equal(result.status, "accepted");
    const services = seen.find((r) => Array.isArray(r.services));
    assert(services, "find_service answered");
    assert.deepEqual(
      (services.services as { service: string }[]).map((s) => s.service),
      ["TEST Calendar and contacts"],
      "Every connected service is listed when none clearly fits",
    );
    assert.match(String(services.note), /all the connected services/);
    const actions = seen.find((r) => Array.isArray(r.actions));
    assert(actions, "find_actions answered");
    assert.equal(
      actions.error,
      undefined,
      "No action_unavailable for a service that has actions",
    );
  } finally {
    await h.close();
  }
});

test("the model sees the connected services in its instructions and small services' tools from the first step", async () => {
  const h = createTrustHarness();
  try {
    const seen: { tools: string[]; system: string }[] = [];
    h.onChat((body) => {
      seen.push({
        tools: body.tools?.map((t) => t.function.name) ?? [],
        system: (body.messages ?? [])
          .filter((m) => m.role === "system")
          .map((m) => m.content ?? "")
          .join("\n"),
      });
      const results = toolResults(body).filter((r) => r.currentTurn === true);
      if (!results.some((r) => r.data?.contacts))
        return h.call(h.tool("Find contact"), { name: "Jane Test" });
      return { content: "Jane Test's email is jane@example.test." };
    });
    const result = await h.send("Find Jane Test's email.", {
      id: "TEST-direct",
    });
    assert.equal(result.status, "accepted");
    assert.equal(reply(result), "Jane Test's email is jane@example.test.");
    // The two allowed actions are tools from the first request: no
    // find_service or find_actions needed.
    assert.equal(seen.length, 2);
    assert(seen[0]!.tools.includes(h.tool("Find contact")));
    assert(seen[0]!.tools.includes(h.tool("Create meeting")));
    assert.match(
      seen[0]!.system,
      /Connected services:\n- TEST Calendar and contacts: Find contacts and create meetings\n {2}• TEST /,
    );
    assert.match(seen[0]!.system, /• TEST Find contact \(read\): Find contact/);
    assert.match(
      seen[0]!.system,
      /• TEST Create meeting \(write\): Create meeting/,
    );
    assert.equal(h.network.length, 1);
  } finally {
    await h.close();
  }
});

const crmService = (
  h: ReturnType<typeof createTrustHarness>,
  names: string[],
) => {
  const serviceId = h.command({
    type: "saveService",
    revision: 0,
    settings: {
      name: "TEST CRM",
      description: "Company CRM with many record types",
      url: "https://services.example.test/crm",
      protocol: "openapi",
      icon: "database",
      auth: { type: "bearer" },
      enabled: true,
    },
    apiKey: "TEST-service-key",
  });
  for (const name of names)
    h.command({
      type: "saveAction",
      serviceId,
      serviceRevision: h.catalog.service(h.target.workspaceId, serviceId)
        .revision,
      revision: 0,
      settings: {
        name: `TEST Search ${name}`,
        description: `Find ${name} records`,
        inputSchema: {
          type: "object",
          properties: { q: { type: "string" } },
          additionalProperties: false,
        },
        binding: {
          type: "http",
          method: "GET",
          path: `/${name}`,
          parameters: [{ name: "q", in: "query", required: false }],
          body: false,
        },
        effect: "read",
        approval: "never",
        enabled: true,
        policy: { roles: ["member"], users: [] },
      },
    });
};
const NINE = [
  "loans",
  "payouts",
  "invoices",
  "deals",
  "companies",
  "people",
  "notes",
  "tasks",
  "amendments",
];
const crmTools = (h: ReturnType<typeof createTrustHarness>, tools: string[]) =>
  tools.filter(
    (name) =>
      name.startsWith("action_") &&
      name !== h.tool("Find contact") &&
      name !== h.tool("Create meeting"),
  );

test("a large service is listed by name and loaded with use_actions; wrong names get the closest ones", async () => {
  const h = createTrustHarness();
  try {
    crmService(h, NINE);
    h.onService(({ path }) =>
      path.endsWith("/loans")
        ? { records: [{ id: "L1", stav: "PO_TERMINU" }] }
        : undefined,
    );
    const seen: {
      tools: string[];
      system: string;
      results: Record<string, unknown>[];
    }[] = [];
    h.onChat((body) => {
      const results = toolResults(body);
      seen.push({
        tools: body.tools?.map((t) => t.function.name) ?? [],
        system: (body.messages ?? [])
          .filter((m) => m.role === "system")
          .map((m) => m.content ?? "")
          .join("\n"),
        results,
      });
      const loaded = results.find((r) => Array.isArray(r.actions));
      if (!loaded)
        return h.call("use_actions", {
          actions: [
            "TEST Search loans",
            "Search payouts",
            "TEST Search nonsense",
          ],
        });
      if (!results.some((r) => r.currentTurn === true && r.data?.records))
        return h.call(String((loaded.actions as { tool: string }[])[0]!.tool), {
          q: "overdue",
        });
      return { content: "One loan is overdue." };
    });
    const result = await h.send("Which loans are overdue?", {
      id: "TEST-use-actions",
    });
    assert.equal(result.status, "accepted");
    assert.equal(reply(result), "One loan is overdue.");
    assert.equal(seen.length, 3);
    // Listed, but not a tool yet: a 9-action service is not offered directly.
    assert.deepEqual(crmTools(h, seen[0]!.tools), []);
    assert.match(
      seen[0]!.system,
      /- TEST CRM: Company CRM with many record types\n {2}• TEST Search [a-z]+ \(read\)/,
    );
    assert.match(
      seen[0]!.system,
      /• TEST Search loans \(read\): Find loans records/,
    );
    const loaded = seen[1]!.results.find((r) => Array.isArray(r.actions))!;
    assert.deepEqual(
      (loaded.actions as { action: string; effect: string }[]).map((a) => [
        a.action,
        a.effect,
      ]),
      [
        ["TEST Search loans", "read"],
        ["TEST Search payouts", "read"],
      ],
    );
    assert.deepEqual(loaded.unknown, [
      { requested: "TEST Search nonsense", closest: [] },
    ]);
    assert.match(String(loaded.note), /closest action names/);
    // Exactly the loaded actions became tools.
    assert.equal(crmTools(h, seen[1]!.tools).length, 2);
    assert.equal(h.serviceRequests.length, 1);
  } finally {
    await h.close();
  }
});

test("the next turn of a chat starts with the actions the previous turn loaded", async () => {
  const h = createTrustHarness();
  try {
    crmService(h, ["a", "b", "c", "d", "e", "f", "g", "h", "loans"]);
    h.onService(({ path }) =>
      path.endsWith("/loans") ? { records: [] } : undefined,
    );
    let loansTool = "";
    const steps: string[][] = [];
    h.onChat((body) => {
      const tools = body.tools?.map((t) => t.function.name) ?? [];
      steps.push(tools);
      const results = toolResults(body);
      const loaded = results.find((r) => Array.isArray(r.actions));
      if (loaded)
        loansTool = String((loaded.actions as { tool: string }[])[0]!.tool);
      if (!loansTool && !crmTools(h, tools).length)
        return h.call("use_actions", { actions: ["TEST Search loans"] });
      loansTool ||= crmTools(h, tools)[0]!;
      if (!results.some((r) => r.currentTurn === true && r.data?.records))
        return h.call(loansTool, {});
      return { content: "No loans." };
    });
    await h.send("Any loans?", { id: "TEST-turn-1" });
    assert.equal(steps.length, 3);
    await h.send("And overdue ones?", { id: "TEST-turn-2" });
    // The follow-up calls the loan tool in its first step: no use_actions.
    assert.equal(steps.length, 5);
    assert(
      steps[3]!.includes(loansTool),
      "The previous turn's action is a tool from the first step",
    );
  } finally {
    await h.close();
  }
});
