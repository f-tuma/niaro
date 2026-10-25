import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityError } from "../apps/server-identity/error";
import {
  budgetedInferenceTransport,
  inferenceUsage,
} from "../apps/server-identity/inference-budget";
import {
  canStream,
  streamingTransport,
  type IntegrationTransport,
} from "../apps/server-integrations/transport";
import {
  budgetTarget as target,
  budgetSelection as selected,
  budgetSettings as settings,
  openBudget,
} from "./helpers/inference-budget";
import { createTrustHarness, toolResults } from "./agent-trust/harness";

const code = (value: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === value;
function fixture() {
  const f = openBudget();
  f.store.savePolicy(target.organizationId, target.workspaceId, 0, settings);
  return f;
}
const known = {
  inputTokens: 10,
  outputTokens: 5,
  costMicros: 20,
  costSource: "provider" as const,
};

test("usage retains provider costs, explicit free tariffs and missing/invalid usage", () => {
  assert.deepEqual(
    inferenceUsage(
      {
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          cost: "0.00002001",
        },
      },
      "model",
    ),
    { ...known, costMicros: 21 },
  );
  assert.deepEqual(
    inferenceUsage(
      { usage: { input_tokens: 10, output_tokens: 5, cost: 2e-5 } },
      "decision",
    ),
    known,
  );
  assert.equal(
    inferenceUsage({ usage: { inputTokens: 10, outputTokens: 5 } }, "decision")
      .inputTokens,
    null,
  );
  const free = {
    ...settings.prices[0]!,
    inputMicrosPerMillion: 0,
    outputMicrosPerMillion: 0,
  };
  assert.deepEqual(
    inferenceUsage(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      "model",
      free,
    ),
    { ...known, costMicros: 0, costSource: "tariff" },
  );
  assert.equal(
    inferenceUsage(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      "model",
    ).costMicros,
    null,
  );
  for (const cost of [-1, "bad", "1e100"])
    assert.equal(
      inferenceUsage(
        { usage: { prompt_tokens: 10, completion_tokens: 5, cost } },
        "model",
        free,
      ).costMicros,
      null,
    );
  assert.equal(
    inferenceUsage(
      { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 17 } },
      "model",
    ).inputTokens,
    null,
  );
  assert.equal(
    inferenceUsage(
      {
        usage: { prompt_tokens: Number.MAX_SAFE_INTEGER, completion_tokens: 1 },
      },
      "model",
    ).inputTokens,
    null,
  );
});

test("model and decision holds share a root, reconcile actual usage and deny concurrent oversubscription", () => {
  const { db, store } = fixture();
  try {
    store.savePolicy(target.organizationId, target.workspaceId, 1, {
      ...settings,
      maxTokens: 3000,
    });
    const first = store.reserve("TEST-root", target, selected, "model");
    assert.throws(
      () => store.reserve("TEST-root", target, selected, "decision"),
      code("catalog_budget_exhausted"),
    );
    store.dispatch(first.id);
    store.settle(first.id, known);
    const second = store.reserve("TEST-root", target, selected, "decision");
    store.dispatch(second.id);
    store.settle(second.id, known);
    assert.deepEqual(store.summary("TEST-root"), {
      calls: 2,
      accountedTokens: 30,
      accountedCostMicros: 40,
      unknownCalls: 0,
      overrun: false,
    });
  } finally {
    db.close();
  }
});

test("frozen process caps narrow the workspace policy and cannot change or reset at a child", () => {
  const { db, store } = fixture();
  try {
    const caps = { maxTokens: 3000, maxCostMicros: 3000, maxModelCalls: 2 };
    const first = store.reserve(
      "TEST-process",
      target,
      selected,
      "model",
      0,
      caps,
    );
    assert.equal(
      store.assertReady("TEST-process", target, 0, caps).settings.maxTokens,
      3000,
    );
    assert.throws(
      () =>
        store.reserve("TEST-process", target, selected, "decision", 0, caps),
      code("catalog_budget_exhausted"),
    );
    store.dispatch(first.id);
    store.settle(first.id, known);
    const second = store.reserve(
      "TEST-process",
      target,
      selected,
      "decision",
      1,
      caps,
    );
    store.dispatch(second.id);
    store.settle(second.id, known);
    assert.throws(
      () => store.reserve("TEST-process", target, selected, "model", 2, caps),
      code("catalog_budget_exhausted"),
    );
    assert.throws(
      () =>
        store.assertReady("TEST-process", target, 2, {
          ...caps,
          maxModelCalls: 3,
        }),
      code("catalog_budget_policy_changed"),
    );
    assert.throws(
      () => store.assertReady("TEST-process", target, 2),
      code("catalog_budget_policy_changed"),
    );
    assert.equal(store.summary("TEST-process").calls, 2);
    const broader = {
      maxTokens: 100000,
      maxCostMicros: 100000,
      maxModelCalls: 32,
    };
    const effective = store.assertReady(
      "TEST-broader",
      target,
      0,
      broader,
    ).settings;
    assert.equal(effective.maxTokens, settings.maxTokens);
    assert.equal(effective.maxCostMicros, settings.maxCostMicros);
  } finally {
    db.close();
  }
});

test("cost caps, model/provider revisions, history and scope cannot be bypassed", () => {
  const { db, store } = fixture();
  try {
    store.savePolicy(target.organizationId, target.workspaceId, 1, {
      ...settings,
      maxCostMicros: 100,
    });
    assert.throws(
      () => store.reserve("TEST-cost", target, selected, "model"),
      code("catalog_budget_exhausted"),
    );
    assert.throws(
      () =>
        store.reserve(
          "TEST-revision",
          target,
          { ...selected, model: { ...selected.model, revision: 2 } },
          "model",
        ),
      code("catalog_budget_price_required"),
    );
    assert.throws(
      () =>
        store.reserve(
          "TEST-provider",
          target,
          { ...selected, provider: { ...selected.provider, revision: 2 } },
          "model",
        ),
      code("catalog_budget_price_required"),
    );
    assert.throws(
      () => store.reserve("TEST-history", target, selected, "model", 2),
      code("catalog_budget_usage_unknown"),
    );
    store.open("TEST-scope", target);
    for (const changed of [
      { userId: "TEST-bob" },
      { workspaceId: "TEST-other-workspace" },
      { organizationId: "TEST-other" },
    ])
      assert.throws(
        () => store.open("TEST-scope", { ...target, ...changed }),
        code("identity_forbidden"),
      );
    assert.throws(
      () => store.savePolicy("TEST-other", target.workspaceId, 0, settings),
      code("identity_forbidden"),
    );
    store.savePolicy(target.organizationId, target.workspaceId, 2, settings);
    assert.throws(
      () => store.open("TEST-cost", target),
      code("catalog_budget_policy_changed"),
    );
    assert.throws(
      () =>
        store.savePolicy(
          target.organizationId,
          target.workspaceId,
          2,
          settings,
        ),
      code("catalog_conflict"),
    );
  } finally {
    db.close();
  }
});

test("observe mode records unknowns without treating absent pricing as free", () => {
  const { db, store } = openBudget();
  try {
    const r = store.reserve("TEST-root", target, selected, "model");
    assert.equal(r.price, undefined);
    store.dispatch(r.id);
    store.settle(r.id, inferenceUsage({}, "model"));
    assert.equal(store.summary("TEST-root").unknownCalls, 1);
    const row = db
      .prepare("SELECT * FROM agent_inference_attempt WHERE id=?")
      .get(r.id)!;
    assert.equal(row.cost_micros, null);
    assert.equal(row.reserved_cost, null);
    store.reserve("TEST-root", target, selected, "decision");
  } finally {
    db.close();
  }
});

test("unknown post-dispatch usage keeps its full hold while overruns block later calls without rewriting settled attempts", () => {
  const { db, store } = fixture();
  try {
    const r = store.reserve("TEST-unknown", target, selected, "model");
    store.dispatch(r.id);
    store.failed(r.id);
    // The unknown attempt is charged its whole reservation and the run continues.
    assert.deepEqual(store.summary("TEST-unknown"), {
      calls: 1,
      accountedTokens: 2148,
      accountedCostMicros: 2248,
      unknownCalls: 1,
      overrun: false,
    });
    store.reserve("TEST-unknown", target, selected, "decision");
    // Four more full holds would exceed the 10,000-token cap.
    store.reserve("TEST-unknown", target, selected, "decision");
    store.reserve("TEST-unknown", target, selected, "decision");
    assert.throws(
      () => store.reserve("TEST-unknown", target, selected, "decision"),
      code("catalog_budget_exhausted"),
    );
    const over = store.reserve("TEST-over", target, selected, "model");
    store.dispatch(over.id);
    store.settle(over.id, { ...known, costMicros: 3000 });
    store.failed(over.id);
    assert.throws(
      () => store.assertReady("TEST-over", target),
      code("catalog_budget_overrun"),
    );
    assert.equal(
      db
        .prepare("SELECT status FROM agent_inference_attempt WHERE id=?")
        .get(over.id)!.status,
      "settled",
    );
  } finally {
    db.close();
  }
});

test("transport cancels before dispatch, clamps output, and settles before downstream validation", async () => {
  const { db, store } = fixture();
  let pending = Promise.resolve<unknown>(undefined);
  const serial = <T>(run: () => Promise<T>) => {
    const p = pending.then(run);
    pending = p.catch(() => {});
    return p;
  };
  let sent = 0;
  const transport: IntegrationTransport = async (r) => {
    await r.beforeDispatch!(() => {
      sent++;
    });
    assert.equal((r.body as { max_tokens: number }).max_tokens, 100);
    // A malformed completion is still a billable, measured provider response.
    return {
      status: 200,
      headers: {},
      text: '{"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.00002}}',
    };
  };
  const wrapped = budgetedInferenceTransport(
    transport,
    store,
    "TEST-root",
    target,
    selected,
    "model",
    serial,
    async () => {},
    () => 0,
  );
  const request = {
    url: "https://provider.example.test/v1/chat/completions",
    body: { max_tokens: 10000 },
    beforeDispatch: async (start: () => void) => {
      await serial(async () => start());
    },
  };
  try {
    await assert.rejects(
      wrapped({ ...request, body: { input: "x".repeat(2048) } }),
      code("catalog_budget_request_too_large"),
    );
    await assert.rejects(
      wrapped({
        ...request,
        beforeDispatch: async () => {
          throw Error("TEST revoked");
        },
      }),
      /TEST revoked/,
    );
    assert.equal(sent, 0);
    assert.equal(store.summary("TEST-root").accountedTokens, 0);
    await wrapped(request);
    assert.equal(sent, 1);
    assert.equal(store.summary("TEST-root").accountedTokens, 15);
  } finally {
    db.close();
  }
});

test("a streamed completion settles the usage of its last event and keeps the transport streaming", async () => {
  const { db, store } = fixture();
  const serial = <T>(run: () => Promise<T>) => run();
  const streamed: IntegrationTransport = streamingTransport(async (r) => {
    await r.beforeDispatch!(() => {});
    return {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      text:
        'data: {"choices":[{"index":0,"delta":{"content":"TEST"}}]}\n\n' +
        'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.00002}}\n\n' +
        "data: [DONE]\n\n",
    };
  });
  const wrap = (transport: IntegrationTransport, runId: string) =>
    budgetedInferenceTransport(
      transport,
      store,
      runId,
      target,
      selected,
      "model",
      serial,
      async () => {},
      () => 0,
    );
  try {
    const wrapped = wrap(streamed, "TEST-streamed");
    assert.equal(canStream(wrapped), true);
    assert.equal(
      canStream(
        wrap(
          async () => ({ status: 200, headers: {}, text: "" }),
          "TEST-plain",
        ),
      ),
      false,
    );
    await wrapped({
      url: "https://provider.example.test/v1/chat/completions",
      body: { max_tokens: 100, stream: true },
      beforeDispatch: async (start) => start(),
    });
    assert.equal(store.summary("TEST-streamed").accountedTokens, 15);
  } finally {
    db.close();
  }
});

/** A large-context tariff: the whole window is its priced input ceiling. */
const wide = {
  ...settings.prices[0]!,
  maxInputTokens: 200_000,
  maxOutputTokens: 8_000,
  inputMicrosPerMillion: 1_000_000,
  outputMicrosPerMillion: 2_000_000,
};
const processCaps = {
  maxTokens: 100_000,
  maxCostMicros: 10_000_000,
  maxModelCalls: 32,
};
function wideFixture(change: Partial<typeof settings> = {}) {
  const f = openBudget();
  f.store.savePolicy(target.organizationId, target.workspaceId, 0, {
    ...settings,
    maxTokens: 1_000_000,
    maxCostMicros: 10_000_000,
    prices: [wide],
    ...change,
  });
  return f;
}
function serialQueue() {
  let pending = Promise.resolve<unknown>(undefined);
  return <T>(run: () => Promise<T>) => {
    const p = pending.then(run);
    pending = p.catch(() => {});
    return p;
  };
}
/** What the wrapper estimates for a body: UTF-8 JSON bytes plus 1,024. */
const estimate = (body: object) =>
  Buffer.byteLength(JSON.stringify(body), "utf8") + 1024;
const prompt = (bytes: number) => ({ input: "x".repeat(bytes) });

test("a call reserves its own estimated input within the price ceiling, so a large-context tariff fits a process run", () => {
  const { db, store } = wideFixture();
  try {
    // The priced maximum (208,000 tokens) no longer has to fit the 100,000 cap.
    assert.equal(
      store.canStartModel(
        target.organizationId,
        target.workspaceId,
        selected,
        processCaps,
      ),
      true,
    );
    const small = store.reserve(
      "TEST-wide",
      target,
      selected,
      "model",
      0,
      processCaps,
      5_000,
    );
    assert.equal(small.tokens, 13_000);
    assert.equal(small.cost, 5_000 + 16_000);
    // Below the floor, a call still reserves 2,048 input tokens.
    const tiny = store.reserve(
      "TEST-wide",
      target,
      selected,
      "decision",
      0,
      processCaps,
      300,
    );
    assert.equal(tiny.tokens, 2_048 + 8_000);
    // Without a body (a readiness check) the floor is what must fit.
    assert.equal(
      store.assertCanReserve("TEST-wide", target, selected, 0, processCaps)
        .tokens,
      10_048,
    );
    const rows = db
      .prepare(
        "SELECT reserved_tokens,reserved_cost FROM agent_inference_attempt WHERE run_id='TEST-wide' ORDER BY rowid",
      )
      .all()
      .map((r) => [Number(r.reserved_tokens), Number(r.reserved_cost)]);
    assert.deepEqual(rows, [
      [13_000, 21_000],
      [10_048, 18_048],
    ]);
    // Larger than the priced input ceiling: no budget admits it.
    assert.throws(
      () =>
        store.reserve(
          "TEST-wide",
          target,
          selected,
          "model",
          0,
          processCaps,
          200_001,
        ),
      code("catalog_budget_request_too_large"),
    );
    assert.throws(
      () =>
        store.reserve(
          "TEST-wide",
          target,
          selected,
          "model",
          0,
          processCaps,
          null,
        ),
      code("catalog_budget_request_too_large"),
    );
    // Within the price but beyond the run's remaining headroom (100,000 −
    // 23,048 held − 8,000 output).
    assert.throws(
      () =>
        store.reserve(
          "TEST-wide",
          target,
          selected,
          "model",
          0,
          processCaps,
          68_953,
        ),
      code("catalog_budget_exhausted"),
    );
    store.reserve(
      "TEST-wide",
      target,
      selected,
      "model",
      0,
      processCaps,
      68_952,
    );
    assert.throws(
      () =>
        store.assertCanReserve("TEST-wide", target, selected, 0, processCaps),
      code("catalog_budget_exhausted"),
    );
    // Refusals before a reservation do not consume the call cap.
    assert.equal(store.summary("TEST-wide").calls, 3);
    // A cap that cannot hold even the floor call is not ready.
    assert.equal(
      store.canStartModel(target.organizationId, target.workspaceId, selected, {
        ...processCaps,
        maxTokens: 10_047,
      }),
      false,
    );
  } finally {
    db.close();
  }
});

test("headroom shrinks with measured usage across calls, and the cost cap bounds the input allowance", () => {
  const { db, store } = wideFixture();
  try {
    const caps = { ...processCaps, maxTokens: 40_000 };
    for (let call = 0; call < 2; call++) {
      const r = store.reserve(
        "TEST-headroom",
        target,
        selected,
        "model",
        call,
        caps,
        20_000,
      );
      store.dispatch(r.id);
      store.settle(r.id, {
        inputTokens: 9_000,
        outputTokens: 1_000,
        costMicros: 11_000,
        costSource: "provider",
      });
    }
    // 20,000 accounted: 12,000 input + 8,000 output still fits, one more token does not.
    assert.throws(
      () =>
        store.reserve(
          "TEST-headroom",
          target,
          selected,
          "model",
          2,
          caps,
          12_001,
        ),
      code("catalog_budget_exhausted"),
    );
    const last = store.reserve(
      "TEST-headroom",
      target,
      selected,
      "model",
      2,
      caps,
      12_000,
    );
    assert.equal(last.tokens, 20_000);
  } finally {
    db.close();
  }
  const costly = wideFixture({ maxCostMicros: 30_000 });
  try {
    // Tokens are plentiful; the cost cap (30,000 micros) leaves 30,000 − 16,000
    // output cost = 14,000 input tokens at $1 per million.
    assert.throws(
      () =>
        costly.store.reserve(
          "TEST-cost-headroom",
          target,
          selected,
          "model",
          0,
          processCaps,
          14_001,
        ),
      code("catalog_budget_exhausted"),
    );
    const fits = costly.store.reserve(
      "TEST-cost-headroom",
      target,
      selected,
      "model",
      0,
      processCaps,
      14_000,
    );
    assert.equal(fits.cost, 30_000);
  } finally {
    costly.db.close();
  }
});

test("the transport refuses a prompt larger than its allowance before dispatch and an unknown result keeps exactly its reservation", async () => {
  const { db, store } = wideFixture();
  const serial = serialQueue();
  let sent = 0,
    status = 504;
  const bodies: Record<string, unknown>[] = [];
  const transport: IntegrationTransport = async (r) => {
    await r.beforeDispatch!(() => {
      sent++;
    });
    bodies.push(r.body as Record<string, unknown>);
    return {
      status,
      headers: {},
      text:
        status === 200
          ? '{"choices":[],"usage":{"prompt_tokens":3000,"completion_tokens":500}}'
          : '{"error":{"message":"TEST gateway timeout"}}',
    };
  };
  const wrapped = budgetedInferenceTransport(
    transport,
    store,
    "TEST-transport-wide",
    target,
    selected,
    "model",
    serial,
    async () => {},
    () => 0,
    processCaps,
  );
  const send = (body: object) =>
    wrapped({
      url: "https://provider.example.test/v1/chat/completions",
      body,
      beforeDispatch: async (start: () => void) => {
        await serial(async () => start());
      },
    });
  try {
    // Fits the 200,000 price ceiling but not the 100,000 run.
    await assert.rejects(
      send(prompt(95_000)),
      code("catalog_budget_exhausted"),
    );
    // Exceeds the price ceiling itself.
    await assert.rejects(
      send(prompt(200_000)),
      code("catalog_budget_request_too_large"),
    );
    assert.equal(sent, 0);
    assert.equal(store.summary("TEST-transport-wide").calls, 0);
    // A gateway timeout leaves usage unknown: the charge is the whole hold,
    // which is the request's own estimate plus the full output ceiling.
    const body = prompt(10_000);
    await send(body);
    assert.equal(bodies[0]!.max_tokens, 8_000);
    const held = estimate({ ...body }) + 8_000;
    assert.deepEqual(store.summary("TEST-transport-wide"), {
      calls: 1,
      accountedTokens: held,
      accountedCostMicros: estimate({ ...body }) + 16_000,
      unknownCalls: 1,
      overrun: false,
    });
    // The next measured call settles its actual usage within its own hold.
    status = 200;
    await send(prompt(3_000));
    assert.equal(
      store.summary("TEST-transport-wide").accountedTokens,
      held + 3_500,
    );
    assert.equal(store.summary("TEST-transport-wide").overrun, false);
    assert.equal(sent, 2);
  } finally {
    db.close();
  }
});

test("provider rejections settle as zero while gateway timeouts and missing usage keep their holds", async () => {
  const { db, store } = fixture();
  let pending = Promise.resolve<unknown>(undefined);
  const serial = <T>(run: () => Promise<T>) => {
    const p = pending.then(run);
    pending = p.catch(() => {});
    return p;
  };
  let status = 429;
  let text = '{"error":{"message":"TEST rate limited"}}';
  const transport: IntegrationTransport = async (r) => {
    await r.beforeDispatch!(() => {});
    return { status, headers: {}, text };
  };
  const wrapped = budgetedInferenceTransport(
    transport,
    store,
    "TEST-root",
    target,
    selected,
    "model",
    serial,
    async () => {},
    () => 0,
  );
  const request = {
    url: "https://provider.example.test/v1/chat/completions",
    body: { max_tokens: 10 },
    beforeDispatch: async (start: () => void) => {
      await serial(async () => start());
    },
  };
  try {
    for (const rejected of [400, 429, 500, 503]) {
      status = rejected;
      await wrapped(request);
    }
    assert.deepEqual(store.summary("TEST-root"), {
      calls: 4,
      accountedTokens: 0,
      accountedCostMicros: 0,
      unknownCalls: 0,
      overrun: false,
    });
    // A gateway timeout may hide a generated completion; a 2xx without usage
    // is billable but unmeasured. Both keep their full reservation.
    status = 504;
    await wrapped(request);
    status = 200;
    text = '{"choices":[]}';
    await wrapped(request);
    assert.deepEqual(store.summary("TEST-root"), {
      calls: 6,
      accountedTokens: 2 * 2148,
      accountedCostMicros: 2 * 2248,
      unknownCalls: 2,
      overrun: false,
    });
    store.assertReady("TEST-root", target);
  } finally {
    db.close();
  }
});

test("SIGKILL after provider response preserves an unknown hold across repeated restarts", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-budget-crash-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const outcome = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL(
            "./helpers/inference-budget-crash-worker.ts",
            import.meta.url,
          ),
        ),
        directory,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(Error("TEST worker timeout " + stderr));
    }, 20000);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stderr });
    });
  });
  assert.equal(outcome.signal, "SIGKILL", outcome.stderr);
  assert(existsSync(join(directory, "provider-response.json")));
  for (let restart = 0; restart < 2; restart++) {
    const { db, store } = openBudget(join(directory, "budget.sqlite"));
    try {
      assert.equal(store.summary("TEST-root").unknownCalls, 1);
      assert.equal(store.summary("TEST-root").accountedTokens, 2148);
      // The retained hold bounds the uncertain call; it no longer blocks the run.
      store.assertReady("TEST-root", target);
      assert.equal(store.summary("TEST-root").calls, 1);
    } finally {
      db.close();
    }
  }
});

test("overlapping transports cannot spend one reservation twice", async () => {
  const { db, store } = fixture();
  store.savePolicy(target.organizationId, target.workspaceId, 1, {
    ...settings,
    maxTokens: 3000,
  });
  let pending = Promise.resolve<unknown>(undefined),
    release!: () => void,
    entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const serial = <T>(run: () => Promise<T>) => {
    const p = pending.then(run);
    pending = p.catch(() => {});
    return p;
  };
  let calls = 0;
  const transport: IntegrationTransport = async (request) => {
    await request.beforeDispatch!(() => {
      calls++;
      entered();
    });
    await gate;
    return {
      status: 200,
      headers: {},
      text: '{"usage":{"prompt_tokens":10,"completion_tokens":5,"cost":0.00002}}',
    };
  };
  const wrapper = (kind: "model" | "decision") =>
    budgetedInferenceTransport(
      transport,
      store,
      "TEST-root",
      target,
      selected,
      kind,
      serial,
      async () => {},
      () => 0,
    );
  const request = {
    url: "https://provider.example.test/v1/chat/completions",
    body: {},
    beforeDispatch: async (start: () => void) => {
      await serial(async () => start());
    },
  };
  const first = wrapper("model")(request);
  try {
    await dispatched;
    await assert.rejects(
      wrapper("decision")(request),
      code("catalog_budget_exhausted"),
    );
    assert.equal(calls, 1);
    release();
    await first;
    assert.equal(store.summary("TEST-root").accountedTokens, 15);
  } finally {
    release();
    await first;
    db.close();
  }
});

test("restart releases only undispatched holds and preserves measured usage", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "niaro-budget-restart-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, "budget.sqlite");
  const original = openBudget(path);
  original.store.savePolicy(
    target.organizationId,
    target.workspaceId,
    0,
    settings,
  );
  const knownAttempt = original.store.reserve(
    "TEST-root",
    target,
    selected,
    "model",
  );
  original.store.dispatch(knownAttempt.id);
  original.store.settle(knownAttempt.id, known);
  original.store.reserve("TEST-root", target, selected, "decision");
  original.db.close();
  const resumed = openBudget(path);
  try {
    assert.deepEqual(resumed.store.summary("TEST-root"), {
      calls: 2,
      accountedTokens: 15,
      accountedCostMicros: 20,
      unknownCalls: 0,
      overrun: false,
    });
    assert.equal(
      resumed.db
        .prepare(
          "SELECT COUNT(*) AS count FROM agent_inference_attempt WHERE status='cancelled'",
        )
        .get()!.count,
      1,
    );
  } finally {
    resumed.db.close();
  }
});

function configureNativeBudget(
  h: ReturnType<typeof createTrustHarness>,
  maxTokens = 1000000,
) {
  const inventory = h.catalog.inventory(
    h.target.organizationId,
    h.target.workspaceId,
    { userId: h.scope.userId, role: "owner" },
  );
  h.catalog.inferenceBudget.savePolicy(
    h.target.organizationId,
    h.target.workspaceId,
    0,
    {
      ...settings,
      maxTokens,
      maxCostMicros: 1000000,
      prices: inventory.models.map((model) => ({
        ...settings.prices[0]!,
        modelId: model.id,
        modelRevision: model.revision,
        providerRevision: inventory.providers.find(
          (p) => p.id === model.providerId,
        )!.revision,
        maxInputTokens: 100000,
        maxOutputTokens: 1000,
      })),
    },
  );
}
function measuredNativeTransport(
  h: ReturnType<typeof createTrustHarness>,
  change?: (raw: Record<string, unknown>, decision: boolean) => void,
) {
  const original = h.controller.transport;
  Object.defineProperty(h.controller, "transport", {
    value: async (r: Parameters<IntegrationTransport>[0]) => {
      const response = await original(r);
      if (!r.url.includes("openrouter.ai")) return response;
      const raw = JSON.parse(response.text) as Record<string, unknown>;
      const decision = r.url.endsWith("/decisions");
      raw.usage = decision
        ? { input_tokens: 10, output_tokens: 5, cost: 0.00002 }
        : { prompt_tokens: 10, completion_tokens: 5, cost: 0.00002 };
      change?.(raw, decision);
      return { ...response, text: JSON.stringify(raw) };
    },
  });
}

test("native SDK chat and Jev share one measured root ledger across replay and restart", async () => {
  const h = createTrustHarness();
  try {
    configureNativeBudget(h);
    measuredNativeTransport(h);
    h.onChat(h.lookupScript);
    await h.send("Find Jane Test", { id: "TEST-budget-native" });
    const state = h.commandState();
    const rows = h.db
      .prepare("SELECT kind,run_id,status FROM agent_inference_attempt")
      .all();
    assert(rows.some((r) => r.kind === "model"));
    assert(rows.some((r) => r.kind === "decision"));
    assert(
      rows.every((r) => r.run_id === state.runId && r.status === "settled"),
    );
    const before = h.catalog.inferenceBudget.summary(state.runId);
    assert.equal(before.accountedTokens, rows.length * 15);
    assert.equal(before.accountedCostMicros, rows.length * 20);
    await h.restart();
    assert.deepEqual(h.catalog.inferenceBudget.summary(state.runId), before);
    const count = h.network.length;
    // Exact command replay returns its recorded answer without repeating provider/action work.
    await h.send("Find Jane Test", { id: "TEST-budget-native" });
    assert.equal(h.network.length, count);
    assert.deepEqual(h.catalog.inferenceBudget.summary(state.runId), before);
  } finally {
    await h.close();
  }
});

test("an authenticated answer alias continues the original budget after a restart", async () => {
  const h = createTrustHarness();
  try {
    configureNativeBudget(h);
    measuredNativeTransport(h);
    h.onChat((body) =>
      toolResults(body).some((r) => r.answered === true)
        ? { content: "TEST answer accepted" }
        : h.call("ask_user", { question: "Which name?" }),
    );
    await h.send("TEST ask a name", { id: "TEST-budget-question" });
    const original = h.commandState();
    assert.equal(original.pending?.kind, "question");
    const before = h.catalog.inferenceBudget.summary(original.runId);
    await h.restart();
    measuredNativeTransport(h);
    const reply = await h
      .runtime()
      .message(
        "TEST-budget-answer-alias",
        "Jane Test",
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        { conversationId: "conversation-1" },
      );
    assert.equal(reply?.reply, "TEST answer accepted");
    assert.equal(h.commandState().runId, original.runId);
    assert.equal(
      h.db.prepare("SELECT COUNT(*) AS count FROM agent_inference_run").get()!
        .count,
      1,
    );
    assert(
      h.catalog.inferenceBudget.summary(original.runId).accountedTokens >
        before.accountedTokens,
    );
  } finally {
    await h.close();
  }
});

test("unknown final inference usage keeps its hold, the completed write stands and replay never repeats it", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    configureNativeBudget(h);
    measuredNativeTransport(h, (raw) => {
      if (h.network.some((r) => r.path.endsWith("/meetings"))) delete raw.usage;
    });
    h.onChat(h.writeScript);
    const args: Parameters<ReturnType<typeof h.runtime>["message"]> = [
      "TEST-budget-known-write",
      "Create a meeting for Jane",
      "en",
      [],
      new AbortController().signal,
    ];
    const answer = await h.runtime().message(...args);
    assert.equal(answer!.reply, "The meeting was created.");
    const state = h.commandState();
    assert.equal(state.terminalCandidate, undefined);
    assert.equal(state.trace?.status, "succeeded");
    // Calls after the write report no usage and keep their full holds.
    assert(h.catalog.inferenceBudget.summary(state.runId).unknownCalls > 0);
    const receipt = h.catalog.invocation(
      state.operations[0]!,
      h.scope.workspaceId,
      h.scope.userId,
    )!;
    assert.equal(receipt.status, "succeeded");
    assert.equal(answer!.result?.operationId, receipt.id);
    assert.equal(answer!.result?.status, "succeeded");
    assert.equal(
      h.network.filter((r) => r.path.endsWith("/meetings")).length,
      1,
    );
    const requests = h.requests.length;
    const budget = h.catalog.inferenceBudget.summary(state.runId);
    await h.restart();
    args[4] = new AbortController().signal;
    assert.deepEqual(await h.runtime().message(...args), answer);
    assert.deepEqual(h.commandState(), state);
    assert.equal(h.requests.length, requests);
    assert.deepEqual(h.catalog.inferenceBudget.summary(state.runId), budget);
    assert.deepEqual(
      h.catalog.invocation(receipt.id, h.scope.workspaceId, h.scope.userId),
      receipt,
    );
    assert.equal(
      h.network.filter((r) => r.path.endsWith("/meetings")).length,
      1,
    );
  } finally {
    await h.close();
  }
});

test("a policy change after action preparation blocks the final dispatch guard", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    configureNativeBudget(h);
    measuredNativeTransport(h);
    h.onChat(h.writeScript);
    h.onBeforeActionDispatch(() => {
      const policy = h.catalog.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      );
      h.catalog.inferenceBudget.savePolicy(
        h.target.organizationId,
        h.target.workspaceId,
        policy.revision,
        policy.settings,
      );
    });
    const answer = await h
      .runtime()
      .message(
        "TEST-budget-action-change",
        "Create a meeting for Jane",
        "en",
        [],
        new AbortController().signal,
      );
    assert.match(answer!.reply, /inference budget changed/);
    assert.equal(h.network.length, 0);
    const state = h.commandState();
    assert.equal(state.terminalCandidate, "catalog_budget_policy_changed");
    assert.equal(state.trace?.status, "failed");
    assert.equal(state.taskTracked, true);
    const receipt = h.catalog.invocation(
      state.operations[0]!,
      h.scope.workspaceId,
      h.scope.userId,
    )!;
    assert.equal(receipt.status, "failed");
    assert.equal(receipt.failure?.code, "catalog_budget_policy_changed");
    assert.equal(answer!.result?.operationId, receipt.id);
    assert.equal(answer!.result?.status, "failed");
    const requests = h.requests.length;
    const budget = h.catalog.inferenceBudget.summary(state.runId);
    await h.restart();
    assert.deepEqual(
      await h
        .runtime()
        .message(
          "TEST-budget-action-change",
          "Create a meeting for Jane",
          "en",
          [],
          new AbortController().signal,
        ),
      answer,
    );
    assert.deepEqual(h.commandState(), state);
    assert.deepEqual(
      h.catalog.invocation(receipt.id, h.scope.workspaceId, h.scope.userId),
      receipt,
    );
    assert.deepEqual(h.catalog.inferenceBudget.summary(state.runId), budget);
    assert.equal(h.requests.length, requests);
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});

test("policy commands require a scoped manager, exact revisions and an atomic audit", async () => {
  const h = createTrustHarness();
  try {
    const url = new URL(
      "https://server.example.test/admin/api/identity/catalog/budget",
    );
    for (const [key, value] of Object.entries(h.target))
      url.searchParams.set(key, value);
    await assert.rejects(
      h.controller.handle(
        "GET",
        url,
        undefined,
        h.context,
        new AbortController().signal,
      ),
      code("identity_forbidden"),
    );
    const manager = {
      ...h.context,
      actor: async (t: typeof h.target) => {
        await h.context.actor(t);
        return { userId: h.scope.userId, role: "admin" as const };
      },
    };
    const current = (await h.controller.handle(
      "GET",
      url,
      undefined,
      manager,
      new AbortController().signal,
    )) as { revision: number };
    assert.equal(current.revision, 0);
    const payload = {
      ...h.target,
      revision: 0,
      settings: { ...settings, prices: [] },
    };
    await assert.rejects(
      h.controller.handle(
        "POST",
        url,
        payload,
        {
          ...manager,
          audit: () => {
            throw Error("TEST audit failure");
          },
        },
        new AbortController().signal,
      ),
      /TEST audit failure/,
    );
    assert.equal(
      h.catalog.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      ).revision,
      0,
    );
    await h.controller.handle(
      "POST",
      url,
      payload,
      manager,
      new AbortController().signal,
    );
    await assert.rejects(
      h.controller.handle(
        "POST",
        url,
        payload,
        manager,
        new AbortController().signal,
      ),
      code("catalog_conflict"),
    );
    await assert.rejects(
      h.controller.handle(
        "POST",
        url,
        {
          ...payload,
          revision: 1,
          settings: {
            ...settings,
            prices: [{ ...settings.prices[0]!, modelId: "TEST-missing" }],
          },
        },
        manager,
        new AbortController().signal,
      ),
      code("catalog_model_unavailable"),
    );
    await assert.rejects(
      h.controller.handle(
        "POST",
        url,
        { ...payload, revision: 1, extra: true },
        manager,
        new AbortController().signal,
      ),
    );
    await h.restart();
    assert.equal(
      h.catalog.inferenceBudget.policy(
        h.target.organizationId,
        h.target.workspaceId,
      ).revision,
      1,
    );
    assert.equal(h.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("missing native usage keeps full holds until the run cap prevents a new action, and a restarted alias cannot reset the root", async () => {
  const h = createTrustHarness({ writeApproval: "never" });
  try {
    // Each hold is the request's own estimate (about 23,000 tokens for this
    // chat request) plus 1,000 output: one unknown hold fits, a second does not.
    configureNativeBudget(h, 40_000);
    measuredNativeTransport(h, (raw) => {
      delete raw.usage;
    });
    // The write is offered directly; the script still searches first, so the
    // second model call is the one the run cap has to stop.
    h.onChat((body) =>
      toolResults(body).some((result) => Array.isArray(result.actions))
        ? h.writeScript(body)
        : h.call("find_actions", {
            service: "TEST Calendar and contacts",
            need: "create meeting",
          }),
    );
    const runtime = h.runtime();
    const args: Parameters<typeof runtime.message> = [
      "TEST-budget-missing",
      "Create a meeting for Jane",
      "en",
      [],
      new AbortController().signal,
    ];
    const answer = await runtime.message(...args);
    assert.match(answer!.reply, /reached the configured limit/);
    assert.equal(answer!.result, undefined);
    const state = h.commandState();
    assert.equal(state.terminalCandidate, "catalog_budget_exhausted");
    assert.equal(state.trace?.status, "failed");
    assert.equal(state.taskTracked, true);
    assert.equal(h.network.length, 0);
    assert.equal(
      h.catalog.inferenceBudget.summary(state.runId).unknownCalls,
      1,
    );
    const requests = h.requests.length;
    const budget = h.catalog.inferenceBudget.summary(state.runId);
    await h.restart();
    args[4] = new AbortController().signal;
    assert.deepEqual(await h.runtime().message(...args), answer);
    assert.deepEqual(h.commandState(), state);
    assert.equal(h.requests.length, requests);
    assert.deepEqual(h.catalog.inferenceBudget.summary(state.runId), budget);
    assert.equal(h.network.length, 0);
    assert.equal(h.catalog.inferenceBudget.summary(state.runId).calls, 1);
  } finally {
    await h.close();
  }
});
