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
