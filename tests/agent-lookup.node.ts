import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainCommandSchema } from "../apps/server-identity/mastra-domain";
import {
  createTrustHarness,
  toolResults,
  type ModelRequest,
  type TrustHarness,
} from "./agent-trust/harness";
import type { CommandResult } from "../packages/protocol";

const reply = (result: CommandResult) =>
  result.snapshot.conversations
    .flatMap((conversation) => conversation.messages)
    .find((message) => message.replyToCommandId === result.commandId)!.text;
const latest = (h: TrustHarness) =>
  DomainCommandSchema.parse(
    h.catalog.latestTurn(h.scope.workspaceId, h.scope.userId)!.value,
  );
function freshLookup(h: TrustHarness, body: ModelRequest, name: string) {
  if (
    !body.tools?.some((tool) => tool.function.name === h.tool("Find contact"))
  )
    return h.call("find_actions", {
      service: "TEST Calendar and contacts",
      need: "find contact",
    });
  if (
    !toolResults(body).some(
      (result) => result.currentTurn === true && result.effect === "read",
    )
  )
    return h.call(h.tool("Find contact"), { name });
  return { content: "The query returned a contact result." };
}

for (const text of [
  "Ne, koukni se ještě jednou do toho 20 CRM na Petra Sláma.",
  "Ne, i de mě, se mám v kontaktech osobu Jana Nováka teďka.",
  "Mrkni na Petra v CRM.",
  "Najdi Petra Slámu",
  "Find Jane Test",
  "Please search CRM contacts for Jane Test again.",
  "Find Jane Test in CRM and explain her role.",
])
  test(`explicit lookup cannot claim a fresh negative without a service receipt: ${text}`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(() => ({
        content: "Podle opakované kontroly osoba v CRM není.",
      }));
      const result = await h.send(text, { language: "cs" });
      assert.match(reply(result), /neověřil/);
      assert.equal(h.network.length, 0);
      assert.equal(latest(h).modelCalls, 2);
      assert.equal(latest(h).lookupRepair, true);
      assert(
        h.requests.some((request) =>
          request.messages?.some((message) =>
            message.content?.includes(
              "This explicit lookup has no current matching read receipt",
            ),
          ),
        ),
      );
    } finally {
      await h.close();
    }
  });

test("a no-read answer repairs into a real lookup, with query-bound current evidence", async () => {
  const h = createTrustHarness();
  try {
    let attempted = false;
    h.onChat((body) => {
      if (!attempted) {
        attempted = true;
        return { content: "I checked again and Jane does not exist." };
      }
      return freshLookup(h, body, "Jane Test");
    });
    const result = await h.send("Find Jane Test in CRM");
    assert.equal(reply(result), "The query returned a contact result.");
    assert.equal(h.network.length, 1);
    const checker = h.requests.find(
      (request) => request.questions?.route.criteria.complete,
    );
    assert(checker);
    const reads = checker.state?.currentReads as {
      input: unknown;
      service: string;
      action: string;
    }[];
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0]!.input, { name: "Jane Test" });
    assert.equal(checker.state?.lookupRequired, true);
    assert.match(
      checker.questions!.route.instructions!,
      /zero-result filtered query/,
    );
  } finally {
    await h.close();
  }
});

test("Czech declined input accepts a corrected nominative wildcard query as possible evidence", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) => freshLookup(h, body, "%Petr% %Sláma%"));
    const result = await h.send("Vyhledej v CRM osobu Petra Slámy", {
      language: "cs",
    });
    assert.equal(reply(result), "The query returned a contact result.");
    assert.equal(h.network.length, 1);
    assert.equal(latest(h).lookupRepair, false);
    const prompt = h.requests
      .find((request) => request.messages)
      ?.messages?.find((message) => message.role === "system")?.content;
    assert.match(prompt!, /Czech inflections/);
    assert.match(prompt!, /surname stem with wildcards/);
  } finally {
    await h.close();
  }
});

test("a current contact read for another person cannot cover the requested person", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) => freshLookup(h, body, "Other Person"));
    const result = await h.send("Find Jane Test in CRM");
    assert.match(reply(result), /not verified this person/);
    assert.equal(h.network.length, 1);
    assert.equal(latest(h).lookupRepair, true);
  } finally {
    await h.close();
  }
});

test("a historical successful lookup cannot cover an explicit retry or a new person", async () => {
  const h = createTrustHarness();
  try {
    h.onChat((body) => freshLookup(h, body, "Jane Test"));
    await h.send("Find Jane Test in CRM");
    h.onChat(() => ({ content: "I checked again and no person exists." }));
    const retry = await h.send("Zkus to ještě jednou", { language: "cs" });
    assert.match(reply(retry), /neověřil/);
    const changed = await h.send("Najdi v kontaktech osobu Jana Nováka", {
      language: "cs",
    });
    assert.match(reply(changed), /neověřil/);
    assert.equal(h.network.length, 1);
    const historical = h.requests
      .flatMap(toolResults)
      .filter((result) => result.currentTurn === false);
    assert(historical.length > 0);
    assert.deepEqual(historical[0]!.input, { name: "Jane Test" });
  } finally {
    await h.close();
  }
});

test("the second rejected final lookup answer cannot bypass the checker", async () => {
  const h = createTrustHarness();
  try {
    let checks = 0;
    h.onDecision((body) => {
      if ("complete" in body.questions!.route.criteria) {
        checks++;
        return "incomplete";
      }
      return undefined;
    });
    h.onChat((body) => freshLookup(h, body, "Jane Test"));
    const result = await h.send("Find Jane Test in CRM");
    assert.match(reply(result), /does not reliably support/);
    assert.equal(checks, 2);
    assert.equal(h.network.length, 1);
    assert.equal(latest(h).checked, true);
  } finally {
    await h.close();
  }
});

test("a missing identifier can still pause via ask_user", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => h.call("ask_user", { question: "Which Jane do you mean?" }));
    const result = await h.send("Find Jane in CRM");
    assert.equal(reply(result), "Which Jane do you mean?");
    assert.equal(latest(h).pending?.kind, "question");
    assert.equal(latest(h).lookupRepair, false);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("a bare retry after a topic change does not borrow an older CRM request", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "Prague." }));
    const answer = await h.runtime().message(
      "TEST-topic-retry",
      "Zkus to ještě jednou",
      "cs",
      [
        { role: "user", text: "Find Jane Test in CRM" },
        { role: "assistant", text: "Jane Test was found." },
        { role: "user", text: "What is the capital of Czechia?" },
        { role: "assistant", text: "Prague." },
      ],
      new AbortController().signal,
    );
    assert.equal(answer?.reply, "Prague.");
    assert.equal(latest(h).lookupRepair, false);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

for (const text of [
  "Jak znovu v CRM vyhledat kontakt?",
  'Prosím oprav paměť: "Najdi kontakt v CRM znovu" na "Find contact by email"',
  "Nevyhledávej kontakty v CRM znovu, vysvětli postup.",
])
  test(`prior lookup does not reinterpret a described/declined retry: ${text}`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat((body) => freshLookup(h, body, "Jane Test"));
      await h.send("Find Jane Test in CRM");
      h.onChat(() => ({ content: "Acknowledged." }));
      const answer = await h.runtime().message(
        "TEST-meta-followup",
        text,
        "en",
        [
          { role: "user", text: "Find Jane Test in CRM" },
          { role: "assistant", text: "The query returned a contact result." },
        ],
        new AbortController().signal,
      );
      assert.equal(answer?.reply, "Acknowledged.");
      assert.equal(h.network.length, 1);
      assert.equal(latest(h).lookupRepair, false);
    } finally {
      await h.close();
    }
  });

for (const text of [
  "Hello",
  "Prepare a contact lookup form.",
  "Jak v CRM vyhledat kontakt?",
  "Nevyhledávej kontakty v CRM, pouze vysvětli jak je hledat",
  "Nechci nyní najít osobu v CRM. Pouze napiš stručný postup.",
  "Find documentation about CRM contact search",
  'Příklad příkazu je "Najdi kontakt"',
  "Zapamatuj si: najdi osobu v CRM podle emailu",
  'Prosím oprav paměť: "Najdi kontakt v CRM" na "Find contact by email"',
  'Please revise memory: "Find contact" to "Find contact by email"',
])
  test(`non-lookup intent keeps ordinary replies: ${text}`, async () => {
    const h = createTrustHarness();
    try {
      h.onChat(() => ({ content: "Acknowledged." }));
      const answer = await h
        .runtime()
        .message(
          "TEST-plain-request",
          text,
          "en",
          [],
          new AbortController().signal,
        );
      assert.equal(answer?.reply, "Acknowledged.");
      assert.equal(h.network.length, 0);
      assert.equal(h.requests.filter((request) => request.messages).length, 1);
    } finally {
      await h.close();
    }
  });
