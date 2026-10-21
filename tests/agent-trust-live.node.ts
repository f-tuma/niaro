import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTrustHarness } from "./agent-trust/harness";
import { createLiveTrustBudget } from "./agent-trust/live-budget";
import {
  buildLiveTrustReport,
  parseLiveTrustArguments,
  runLiveTrustEvaluation,
  scrubLiveTrustSecrets,
} from "./agent-trust/live-cli";
import { evaluateTrust } from "./agent-trust/runner";

const inflectedPair = [
  "quality.inflected-contact-card.en",
  "quality.inflected-contact-card.cs",
];
const liveArgs = (json: string, scenarios = inflectedPair) => [
  "--confirm-live",
  "--model",
  "TEST-exact-model",
  ...scenarios.flatMap((id) => ["--scenario", id]),
  "--max-requests",
  "32",
  "--max-input-tokens",
  "1000000",
  "--max-output-tokens",
  "32768",
  "--max-output-tokens-per-request",
  "4096",
  "--max-cost-usd",
  "10",
  "--input-usd-per-million",
  "10",
  "--output-usd-per-million",
  "10",
  "--json",
  json,
];

test("live trust harness admits one bounded model request and keeps services synthetic", async () => {
  const events: string[] = [];
  const outbound: { url: string; body: unknown }[] = [];
  const harness = createTrustHarness({
    liveModel: {
      providerUrl: "https://openrouter.ai/api/v1",
      modelId: "TEST-exact-model",
      apiKey: "TEST-private-key",
      maxOutputTokensPerRequest: 32,
      reserve: async (request) => {
        events.push("reserved");
        assert.equal(request.model, "TEST-exact-model");
        assert(request.max_tokens === undefined || request.max_tokens <= 32);
      },
      transport: async (request) => {
        events.push("transport");
        outbound.push({ url: request.url, body: request.body });
        assert.equal(request.beforeDispatch, undefined);
        assert.equal(request.headers?.Authorization, "Bearer TEST-private-key");
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          text: JSON.stringify({
            model: "TEST-exact-model",
            choices: [{ message: { content: "TEST live model answer" } }],
            usage: { prompt_tokens: 12, completion_tokens: 5, cost: 0.0001 },
          }),
        };
      },
      observe: (_request, response, elapsedMs) => {
        events.push("observed");
        assert(response.text.includes('"prompt_tokens":12'));
        assert(elapsedMs >= 0);
      },
    },
  });
  try {
    await harness.send("Explain a triangle.", { id: "TEST-live-model" });
    assert.deepEqual(events, ["reserved", "transport", "observed"]);
    assert.equal(outbound.length, 1);
    assert.equal(
      outbound[0]!.url,
      "https://openrouter.ai/api/v1/chat/completions",
    );
    assert.deepEqual(harness.network, []);
  } finally {
    await harness.close();
  }
});

test("live trust mode is scoped through the regular scenario runner", async () => {
  let calls = 0;
  const liveModel = {
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-exact-model",
    apiKey: "TEST-private-key",
    maxOutputTokensPerRequest: 24,
    reserve: async () => {},
    transport: async () => {
      calls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          model: "TEST-exact-model",
          choices: [{ message: { content: "TEST live scenario answer" } }],
          usage: { prompt_tokens: 8, completion_tokens: 4, cost: 0.00001 },
        }),
      };
    },
  };
  const report = await evaluateTrust(
    [
      {
        id: "live-context",
        title: "The runner passes the selected model to scenario harnesses",
        run: async (probe) => {
          const harness = createTrustHarness({ signal: probe.signal });
          probe.defer(() => harness.close());
          harness.onChat(() => ({ content: "TEST scripted answer" }));
          const result = await harness.send("TEST prompt", {
            id: "TEST-live-context",
          });
          await probe.check(
            "live-model-routed",
            "Live-mode runner uses its model response instead of the scripted fixture",
            () => {
              assert.equal(result.status, "accepted");
              assert.equal(calls, 1);
              assert.equal(
                result.snapshot.conversations[0]?.messages.at(-1)?.text,
                "TEST live scenario answer",
              );
            },
          );
        },
      },
    ],
    undefined,
    { liveModel },
  );
  assert.equal(report.mode, "live-model");
  assert.equal(report.verdict, "passed");
});

test("live trust budget admits before transport and reconciles actual usage", async () => {
  const events: string[] = [];
  const budget = createLiveTrustBudget({
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-exact-model",
    apiKey: "TEST-private-key",
    caps: {
      maxRequests: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 32,
      maxCostUsd: 0.1,
      maxOutputTokensPerRequest: 32,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    },
    transport: async () => {
      events.push("transport");
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          model: "TEST-exact-model",
          choices: [{ message: { content: "TEST answer" } }],
          usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.000013 },
        }),
      };
    },
  });
  const request = {
    model: "TEST-exact-model",
    max_tokens: 32,
    messages: [{ role: "user" as const, content: "TEST prompt" }],
  };
  await budget.reserve(request);
  events.push("reserved");
  const response = await budget.model.transport({
    url: "https://openrouter.ai/api/v1/chat/completions",
    body: request,
  });
  await budget.observe(request, response);
  events.push("observed");
  assert.deepEqual(events, ["reserved", "transport", "observed"]);
  assert.equal(budget.snapshot().requests, 1);
  assert.equal(budget.snapshot().actualInputTokens, 10);
  assert.equal(budget.snapshot().actualOutputTokens, 3);
  assert.equal(budget.snapshot().providerReportedCostUsd, 0.000013);
  assert.equal(budget.snapshot().rateEstimatedCostUsd, 0);
  assert.deepEqual(budget.snapshot().actualModelIds, ["TEST-exact-model"]);
  assert.equal(budget.snapshot().reservedCostUsd, 0);
  assert.equal(budget.snapshot().uncertain, false);
  await assert.rejects(
    budget.reserve(request),
    /request cap reached before dispatch/,
  );
});

test("live trust budget fails closed when provider usage is missing", async () => {
  const budget = createLiveTrustBudget({
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-exact-model",
    apiKey: "TEST-private-key",
    caps: {
      maxRequests: 2,
      maxInputTokens: 10_000,
      maxOutputTokens: 64,
      maxCostUsd: 0.1,
      maxOutputTokensPerRequest: 32,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    },
    transport: async () => {
      throw new Error("This test must not send a request");
    },
  });
  const request = {
    model: "TEST-exact-model",
    max_tokens: 32,
    messages: [{ role: "user" as const, content: "TEST prompt" }],
  };
  await budget.reserve(request);
  await assert.rejects(
    budget.observe(request, {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        model: "TEST-exact-model",
        choices: [{ message: { content: "TEST" } }],
      }),
    }),
    /usage; budget is uncertain/,
  );
  assert.equal(budget.snapshot().uncertain, true);
  await assert.rejects(
    budget.reserve({ ...request }),
    /stopped because usage is uncertain/,
  );
});

test("live trust budget reserves full request and rejects token and cost overruns before dispatch", async () => {
  const caps = {
    maxRequests: 2,
    maxInputTokens: 10_000,
    maxOutputTokens: 64,
    maxCostUsd: 0.1,
    maxOutputTokensPerRequest: 32,
    inputUsdPerMillionTokens: 1,
    outputUsdPerMillionTokens: 1,
  };
  const request = {
    model: "TEST-exact-model",
    max_tokens: 32,
    messages: [{ role: "user" as const, content: "TEST prompt" }],
    tools: [
      {
        type: "function" as const,
        function: {
          name: "TEST tool",
          parameters: { description: "TEST".repeat(1024) },
        },
      },
    ],
  };
  const create = (overrides: Partial<typeof caps>) =>
    createLiveTrustBudget({
      providerUrl: "https://openrouter.ai/api/v1",
      modelId: "TEST-exact-model",
      apiKey: "TEST-private-key",
      caps: { ...caps, ...overrides },
      transport: async () => {
        throw new Error("A rejected reservation must not dispatch");
      },
    });
  await assert.rejects(
    create({ maxInputTokens: 128 }).reserve(request),
    /input token cap reached before dispatch/,
  );
  await assert.rejects(
    create({ maxOutputTokens: 31 }).reserve(request),
    /output token cap reached before dispatch/,
  );
  await assert.rejects(
    create({ maxCostUsd: 0.000001 }).reserve(request),
    /cost cap reached before dispatch/,
  );
  await assert.rejects(
    create({ maxOutputTokensPerRequest: 16 }).reserve(request),
    /output token cap is invalid/,
  );
  assert.throws(
    () => create({ inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 }),
    /At least one live eval token price/,
  );
});

test("live trust budget stops after transport failure or actual overrun", async () => {
  const makeBudget = (transport: () => Promise<never>) =>
    createLiveTrustBudget({
      providerUrl: "https://openrouter.ai/api/v1",
      modelId: "TEST-exact-model",
      apiKey: "TEST-private-key",
      caps: {
        maxRequests: 3,
        maxInputTokens: 10_000,
        maxOutputTokens: 100,
        maxCostUsd: 0.1,
        maxOutputTokensPerRequest: 32,
        inputUsdPerMillionTokens: 1,
        outputUsdPerMillionTokens: 1,
      },
      transport,
    });
  const request = {
    model: "TEST-exact-model",
    max_tokens: 32,
    messages: [{ role: "user" as const, content: "TEST prompt" }],
  };
  const transportFailure = makeBudget(async () => {
    throw new Error("TEST timeout");
  });
  await transportFailure.reserve(request);
  await assert.rejects(
    transportFailure.model.transport({
      url: "https://openrouter.ai/api/v1/chat/completions",
      body: request,
    }),
    /TEST timeout/,
  );
  transportFailure.fail(request, new Error("TEST timeout"));
  assert.equal(transportFailure.snapshot().uncertain, true);
  await assert.rejects(
    transportFailure.reserve({ ...request }),
    /stopped because usage is uncertain/,
  );

  const overrun = makeBudget(async () => {
    throw new Error("not used");
  });
  await overrun.reserve(request);
  await assert.rejects(
    overrun.observe(request, {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        model: "TEST-exact-model",
        usage: { prompt_tokens: 10, completion_tokens: 33, cost: 0.000043 },
      }),
    }),
    /exceeded its reserved budget/,
  );
  assert.equal(overrun.snapshot().uncertain, true);
  assert.equal(overrun.snapshot().actualOutputTokens, 33);
  assert.equal(overrun.snapshot().providerReportedCostUsd, 0.000043);
  assert.equal(overrun.snapshot().lastObservedAnomaly?.costUsd, 0.000043);
});

test("live CLI rejects unsafe selections and incomplete or duplicate caps before transport setup", () => {
  const output = join(tmpdir(), "TEST-trust-report.json");
  const valid = liveArgs(output);
  const env = { NIARO_TRUST_MODEL_API_KEY: "TEST-private-key" };
  assert.throws(
    () =>
      parseLiveTrustArguments(
        valid.filter((arg) => arg !== "--confirm-live"),
        env,
      ),
    /--confirm-live/,
  );
  assert.throws(
    () => parseLiveTrustArguments(liveArgs(output, [inflectedPair[0]!]), env),
    /both EN and CS/i,
  );
  assert.throws(
    () =>
      parseLiveTrustArguments(
        valid.filter(
          (arg, index) =>
            !(
              arg === "--max-cost-usd" || valid[index - 1] === "--max-cost-usd"
            ),
        ),
        env,
      ),
    /--max-cost-usd must be specified exactly once/,
  );
  assert.throws(
    () => parseLiveTrustArguments([...valid, "--max-requests", "1"], env),
    /--max-requests must be specified exactly once/,
  );
  assert.throws(
    () => parseLiveTrustArguments([...valid, "--unknown", "value"], env),
    /Unknown argument/,
  );
  assert.throws(
    () =>
      parseLiveTrustArguments(
        liveArgs(output, [inflectedPair[0]!, inflectedPair[0]!]),
        env,
      ),
    /selected only once/,
  );
  assert.throws(
    () => parseLiveTrustArguments(valid, {}),
    /NIARO_TRUST_MODEL_API_KEY/,
  );
});

test("live report secret scrubber recursively redacts values and object keys", () => {
  assert.deepEqual(
    scrubLiveTrustSecrets(
      { "TEST-private-key": [{ nested: "prefix-TEST-private-key-suffix" }] },
      ["TEST-private-key"],
    ),
    { "[REDACTED]": [{ nested: "prefix-[REDACTED]-suffix" }] },
  );
});

test("live report target is reserved before any provider transport", async () => {
  const directory = mkdtempSync(
    join(tmpdir(), "niaro-trust-output-preflight-"),
  );
  const output = join(directory, "missing", "report.json");
  let calls = 0;
  try {
    const options = parseLiveTrustArguments(liveArgs(output), {
      NIARO_TRUST_MODEL_API_KEY: "TEST-private-key",
    });
    assert.notEqual(options, "help");
    if (options === "help") throw new Error("Expected parsed options");
    await assert.rejects(
      runLiveTrustEvaluation(options, async () => {
        calls += 1;
        throw new Error("Provider transport must not run");
      }),
      /ENOENT|no such file/i,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("mocked EN/CS live run records selection, repetition, latency, costs and a private redacted report", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-trust-live-"));
  const output = join(directory, "report.json");
  const secret = "TEST-private-key";
  let calls = 0;
  try {
    const options = parseLiveTrustArguments(
      [...liveArgs(output), "--repeat", "2"],
      { NIARO_TRUST_MODEL_API_KEY: secret },
    );
    assert.notEqual(options, "help");
    if (options === "help") throw new Error("Expected parsed options");
    const result = await runLiveTrustEvaluation(options, async (request) => {
      calls += 1;
      const body = request.body as { model?: string };
      assert.equal(body.model, "TEST-exact-model");
      const usage = {
        prompt_tokens: 1,
        completion_tokens: 1,
        ...(calls % 2 ? { cost: 0.000001 } : {}),
      };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          model: "TEST-exact-model",
          choices: [{ message: { content: secret } }],
          usage,
        }),
      };
    });
    assert.equal(calls, 8);
    assert.equal(result.report.mode, "live-model");
    assert.equal(result.report.live.selection.repetitionCount, 2);
    assert.deepEqual(result.report.live.selection.languages, ["cs", "en"]);
    assert.deepEqual(result.report.live.selection.qualityCases, [
      "inflected-contact-card",
    ]);
    assert.equal(result.report.live.selection.scenarioRuns.length, 4);
    assert.equal(result.report.live.usage.providerReportedCostUsd, 0.000004);
    assert(result.report.live.usage.rateEstimatedCostUsd > 0);
    assert.equal(result.report.live.usage.totalLatencyMs >= 0, true);
    const earlyFailure = buildLiveTrustReport(
      {
        profile: "agent-trust/1",
        mode: "live-model",
        runtimeProfile: "mastra-1",
        verdict: "incomplete",
        generatedAt: "2026-10-12T00:00:00.000Z",
        summary: { scenarios: 1, passed: 0, failed: 0, gaps: 1, checks: 0 },
        limitations: [],
        scenarios: [
          {
            id: "quality.inflected-contact-card.en",
            title: "Early failure before quality observations",
            status: "gap",
            durationMs: 1,
            checks: [],
            observations: {},
          },
        ],
      },
      options,
      result.usage,
    );
    assert.equal(earlyFailure.live.qualityScore?.runs, 1);
    assert.equal(earlyFailure.live.qualityScore?.byLanguage.en?.incomplete, 1);
    assert.deepEqual(
      earlyFailure.live.qualityScore?.incompleteWithoutDimension,
      [
        {
          scenarioId: "quality.inflected-contact-card.en",
          caseId: "inflected-contact-card",
          language: "en",
          status: "gap",
        },
      ],
    );
    const saved = readFileSync(output, "utf8");
    assert(!saved.includes(secret));
    assert(!saved.includes("[REDACTED]"));
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("provider model substitution fails closed after the first mocked response", async () => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-trust-substitution-"));
  const output = join(directory, "report.json");
  let calls = 0;
  try {
    const options = parseLiveTrustArguments(liveArgs(output), {
      NIARO_TRUST_MODEL_API_KEY: "TEST-private-key",
    });
    assert.notEqual(options, "help");
    if (options === "help") throw new Error("Expected parsed options");
    const result = await runLiveTrustEvaluation(options, async () => {
      calls += 1;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        text: JSON.stringify({
          model: "TEST-substituted-model",
          choices: [{ message: { content: "TEST answer" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0.000001 },
        }),
      };
    });
    assert.equal(calls, 1);
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.verdict, "failed");
    assert.equal(result.usage.uncertain, true);
    assert.deepEqual(result.usage.actualModelIds, ["TEST-substituted-model"]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("live trust budget rejects provider model substitution", async () => {
  const budget = createLiveTrustBudget({
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-requested-model",
    apiKey: "TEST-private-key",
    caps: {
      maxRequests: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 32,
      maxCostUsd: 0.1,
      maxOutputTokensPerRequest: 32,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    },
    transport: async () => {
      throw new Error("Not used");
    },
  });
  const request = {
    model: "TEST-requested-model",
    max_tokens: 32,
    messages: [{ role: "user" as const, content: "TEST prompt" }],
  };
  await budget.reserve(request);
  await assert.rejects(
    budget.observe(request, {
      status: 200,
      headers: { "content-type": "application/json" },
      text: JSON.stringify({
        model: "TEST-routed-model",
        usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.000013 },
      }),
    }),
    /different model than requested/,
  );
  assert.equal(budget.snapshot().uncertain, true);
});

test("live harness marks a failed dispatched request uncertain before retry", async () => {
  let transportCalls = 0;
  const budget = createLiveTrustBudget({
    providerUrl: "https://openrouter.ai/api/v1",
    modelId: "TEST-exact-model",
    apiKey: "TEST-private-key",
    caps: {
      maxRequests: 3,
      maxInputTokens: 200_000,
      maxOutputTokens: 96,
      maxCostUsd: 1,
      maxOutputTokensPerRequest: 32,
      inputUsdPerMillionTokens: 1,
      outputUsdPerMillionTokens: 1,
    },
    transport: async () => {
      transportCalls += 1;
      throw new Error("TEST network timeout");
    },
  });
  const harness = createTrustHarness({ liveModel: budget.model });
  try {
    const result = await harness.send("TEST request", {
      id: "TEST-transport-failure",
    });
    assert.equal(
      transportCalls,
      1,
      JSON.stringify({
        status: result.status,
        requests: harness.requests.map((request) => request.model),
        usage: budget.snapshot(),
      }),
    );
    assert.equal(budget.snapshot().uncertain, true);
    await assert.rejects(
      budget.reserve({
        model: "TEST-exact-model",
        max_tokens: 32,
        messages: [{ role: "user", content: "TEST retry" }],
      }),
      /stopped because usage is uncertain/,
    );
    assert.equal(transportCalls, 1);
  } finally {
    await harness.close();
  }
});
