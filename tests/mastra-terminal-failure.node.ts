import assert from "node:assert/strict";
import { test } from "node:test";
import { createTrustHarness, toolResults } from "./agent-trust/harness";

test("live task polling cannot discard the final failure or its user message", async () => {
  const h = createTrustHarness();
  let polling = false;
  let progressSeen = false;
  const timer = setInterval(() => {
    if (polling) return;
    polling = true;
    void h.runtime().tasks!()
      .then((tasks) => {
        progressSeen ||= tasks.length > 0;
        h.workflow.syncNativeWork(h.scope, tasks);
      })
      .finally(() => {
        polling = false;
      });
  }, 1);
  try {
    h.onChat((body) =>
      toolResults(body).some((result) => result.data?.contacts)
        ? h.call("find_service", { need: "CRM" })
        : h.lookupScript(body),
    );
    const result = await h.send("TEST look up Jane Test and their tasks", {
      id: "TEST-polled-exhaustion",
      language: "cs",
    });
    assert.equal(result.status, "accepted");
    assert(
      progressSeen,
      "The test must observe actual native progress polling",
    );
    const messages = result.snapshot.conversations[0]!.messages;
    assert.equal(
      messages.filter((message) => message.role === "user").length,
      1,
    );
    assert.match(messages.at(-1)!.text, /limit kroků/);
    assert.equal(messages.at(-1)!.replyToCommandId, "TEST-polled-exhaustion");
    const requests = h.requests.length;
    const repeated = await h.send("TEST look up Jane Test and their tasks", {
      id: "TEST-polled-exhaustion",
      language: "cs",
    });
    assert.deepEqual(repeated.snapshot.conversations[0]!.messages, messages);
    assert.equal(h.requests.length, requests);
  } finally {
    clearInterval(timer);
    while (polling) await new Promise((resolve) => setTimeout(resolve, 1));
    await h.close();
  }
});

test("a bounded failure preserves a completed write and never repeats it on replay", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    h.onChat((body) =>
      toolResults(body).some((result) => result.data?.created)
        ? h.call("find_service", { need: "CRM" })
        : h.writeScript(body),
    );
    const result = await h.send("TEST create a meeting", {
      id: "TEST-partial-write",
    });
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(result.status, "accepted");
    assert.match(reply.text, /step limit/);
    assert.equal(reply.result?.type, "service.action");
    assert.equal(
      reply.result?.type === "service.action" && reply.result.status,
      "succeeded",
    );
    const network = h.network.length;
    const requests = h.requests.length;
    const repeated = await h.send("TEST create a meeting", {
      id: "TEST-partial-write",
    });
    assert.deepEqual(
      repeated.snapshot.conversations[0]!.messages,
      result.snapshot.conversations[0]!.messages,
    );
    assert.equal(h.network.length, network);
    assert.equal(h.requests.length, requests);
  } finally {
    await h.close();
  }
});

test("a bounded failure explains confirmed writes alongside an uncertain later write", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  let writes = 0;
  h.onWrite(() => {
    if (++writes === 2) h.writeResponse = "lost";
  });
  try {
    h.onChat((body) => {
      const results = toolResults(body).filter(
        (result) => result.currentTurn === true,
      );
      if (results.some((result) => result.status === "unknown"))
        return h.call("find_service", { need: "CRM" });
      if (results.some((result) => result.data?.created))
        return h.call(h.tool("Create meeting"), {
          body: {
            attendee: "jane@example.test",
            start: "2026-10-02T12:00:00Z",
            end: "2026-10-02T12:30:00Z",
          },
        });
      return h.writeScript(body);
    });
    const result = await h.send("TEST create two meetings", {
      id: "TEST-mixed-writes",
    });
    assert.equal(result.status, "accepted");
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.match(reply.text, /step limit/);
    assert.match(reply.text, /Confirmed completed actions:/);
    assert.match(reply.text, /Create meeting/);
    assert.equal(
      reply.result?.type === "service.action" && reply.result.status,
      "unknown",
    );
    assert.equal(writes, 2);
    const network = h.network.length,
      inference = h.requests.length;
    const replay = await h.send("TEST create two meetings", {
      id: "TEST-mixed-writes",
    });
    assert.deepEqual(
      replay.snapshot.conversations,
      result.snapshot.conversations,
    );
    assert.equal(h.network.length, network);
    assert.equal(h.requests.length, inference);
  } finally {
    await h.close();
  }
});

test("an exhausted native loop publishes a durable failure and replay performs no inference", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => h.call("find_service", { need: "CRM" }));
    const result = await h.send("TEST look up a contact and their tasks", {
      id: "TEST-exhausted",
      language: "cs",
    });
    assert.equal(result.status, "accepted");
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.match(reply.text, /limit kroků/);
    const before = h.requests.length;
    const repeated = await h.send("TEST look up a contact and their tasks", {
      id: "TEST-exhausted",
      language: "cs",
    });
    assert.equal(repeated.status, "accepted");
    assert.equal(
      repeated.snapshot.conversations[0]!.messages.at(-1)!.text,
      reply.text,
    );
    assert.equal(h.requests.length, before);
  } finally {
    await h.close();
  }
});

test("unavailable SDK tools reach the bounded public failure without leaking tool arguments", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() =>
      h.call("TEST_unavailable_tool", { private: "TEST-secret-argument" }),
    );
    const result = await h.send("TEST check CRM contact and tasks", {
      id: "TEST-invalid-tool",
      language: "cs",
    });
    const reply = result.snapshot.conversations[0]!.messages.at(-1)!;
    assert.equal(result.status, "accepted");
    assert.match(reply.text, /nástroj se nepodařilo použít/);
    assert.doesNotMatch(reply.text, /TEST-secret-argument/);
    assert.equal(h.network.length, 0);
    assert.equal(
      h.commandState("TEST-invalid-tool").toolProblems[0]?.reason,
      "unavailable",
    );
  } finally {
    await h.close();
  }
});
