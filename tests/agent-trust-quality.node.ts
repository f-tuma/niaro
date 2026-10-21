import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustHarness, toolResults } from "./agent-trust/harness";
import {
  trustQualityScenarios,
  validateBalancedQualitySelection,
} from "./agent-trust/quality-scenarios";

test("live quality matrix has paired English and Czech cases", () => {
  const expected = [
    "ambiguous-contact",
    "inflected-contact-card",
    "memory-injection",
    "repeat-lookup",
    "stale-memory-conflict",
    "topic-detour",
  ];
  for (const language of ["en", "cs"]) {
    const selected = trustQualityScenarios.filter(
      (scenario) => scenario.quality.language === language,
    );
    assert.deepEqual(
      selected.map((scenario) => scenario.quality.caseId).sort(),
      expected,
    );
  }
  assert.equal(trustQualityScenarios.length, expected.length * 2);
});

test("live quality selection refuses an unbalanced language pair", () => {
  const english = trustQualityScenarios.find(
    (scenario) =>
      scenario.quality.caseId === "repeat-lookup" &&
      scenario.quality.language === "en",
  )!;
  const czech = trustQualityScenarios.find(
    (scenario) =>
      scenario.quality.caseId === "repeat-lookup" &&
      scenario.quality.language === "cs",
  )!;
  assert.throws(
    () => validateBalancedQualitySelection([english]),
    /both EN and CS/,
  );
  assert.doesNotThrow(() => validateBalancedQualitySelection([english, czech]));
});

test("synthetic live-quality contact fixture matches Czech inflection and ambiguity", async () => {
  const harness = createTrustHarness({
    contacts: [
      {
        id: "TEST-jana",
        name: "Jana Nováková",
        email: "jana.novakova@example.test",
      },
      { id: "TEST-alex-a", name: "Alex Novák", email: "alex.a@example.test" },
      { id: "TEST-alex-b", name: "Alex Novotný", email: "alex.b@example.test" },
    ],
  });
  try {
    let lookupAttempt = 0;
    harness.onChat((request) => {
      const contacts = toolResults(request).flatMap((result) =>
        Array.isArray(result.data?.contacts) ? result.data.contacts : [],
      );
      if (
        !request.tools?.some(
          (tool) => tool.function.name === harness.tool("Find contact"),
        )
      )
        return harness.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "find contact",
        });
      if (lookupAttempt < 2) {
        const name = lookupAttempt === 0 ? "Janu Novákovou" : "Novák";
        lookupAttempt += 1;
        return harness.call(harness.tool("Find contact"), {
          name,
        });
      }
      return { content: JSON.stringify(contacts) };
    });
    const result = await harness.send("Najdi Janu Novákovou.", {
      id: "TEST-czech-inflection-fixture",
      language: "cs",
    });
    assert.equal(result.status, "accepted");
    const lookups = harness.requests
      .flatMap(toolResults)
      .filter(
        (entry) =>
          entry.currentTurn === true && Array.isArray(entry.data?.contacts),
      );
    assert(
      lookups.length <= 3,
      "The bounded repair must not loop indefinitely",
    );
    assert.deepEqual(lookups[0]?.data.contacts, []);
    assert(
      lookups
        .slice(1)
        .some(
          (entry) =>
            entry.data.contacts.length === 2 &&
            entry.data.contacts.some(
              (contact: { id: string }) => contact.id === "TEST-jana",
            ),
        ),
      "A broadened surname query should find the contact while exposing ambiguity",
    );
    const lookup = lookups.at(-1);
    assert.deepEqual(
      lookup?.data.contacts.map((contact: { id: string }) => contact.id).sort(),
      ["TEST-alex-a", "TEST-jana"],
      JSON.stringify({ network: harness.network }),
    );
    assert.equal(harness.network.length, 2);
  } finally {
    await harness.close();
  }
});

test("synthetic CRM fixture refuses a one-letter contact search", async () => {
  const harness = createTrustHarness({
    contacts: [
      {
        id: "TEST-jana",
        name: "Jana Nováková",
        email: "jana.novakova@example.test",
      },
    ],
  });
  try {
    harness.onChat((request) => {
      const contacts = toolResults(request).filter(
        (result) =>
          result.currentTurn === true && Array.isArray(result.data?.contacts),
      );
      if (
        !request.tools?.some(
          (tool) => tool.function.name === harness.tool("Find contact"),
        )
      )
        return harness.call("find_actions", {
          service: "TEST Calendar and contacts",
          need: "find contact",
        });
      if (!contacts.length)
        return harness.call(harness.tool("Find contact"), { name: "J" });
      return { content: JSON.stringify(contacts.at(-1)?.data.contacts) };
    });
    const result = await harness.send("Find the contact beginning with J.", {
      id: "TEST-one-letter-contact-query",
    });
    assert.equal(result.status, "accepted");
    assert.equal(harness.network.length, 1);
    assert.match(harness.serviceRequests[0]?.url ?? "", /\/contacts\?name=J$/u);
    const receipts = harness.requests
      .flatMap(toolResults)
      .filter(
        (entry) =>
          entry.currentTurn === true && Array.isArray(entry.data?.contacts),
      );
    assert.deepEqual(receipts.at(-1)?.data.contacts, []);
  } finally {
    await harness.close();
  }
});
