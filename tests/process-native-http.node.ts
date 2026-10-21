import assert from "node:assert/strict";
import { test, after } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { CatalogController } from "../apps/server-identity/catalog-controller";
import {
  ActionSettings,
  ProviderSettings,
} from "../packages/protocol/service-catalog";
import { OrganizationDetailSchema } from "../packages/protocol/identity";
import { NativeTestListSchema } from "../packages/protocol/process-native-testing";
import {
  nativeHttpFixture,
  nativeHttpPath as base,
} from "./helpers/process-native-http";

type Fixture = Awaited<ReturnType<typeof nativeHttpFixture>>;
let fixtureReady: Promise<Fixture> | undefined;
async function fixture(run: (h: Fixture) => Promise<void>) {
  // BetterAuth's real per-IP limiter remains enabled. One account fixture avoids
  // repeatedly provisioning/signing in the same loopback client in one minute.
  fixtureReady ??= nativeHttpFixture();
  await run(await fixtureReady);
}
after(async () => {
  if (fixtureReady) await (await fixtureReady).close();
});
async function gate(
  h: Fixture,
  run: (control: {
    entered: Promise<void>;
    release: () => void;
  }) => Promise<void>,
) {
  let release!: () => void,
    entered!: () => void,
    held = false;
  const pause = new Promise<void>((r) => {
    release = r;
  });
  const ready = new Promise<void>((r) => {
    entered = r;
  });
  const original = CatalogController.prototype.invoke;
  // Only this test file's detached synthetic controller is delayed. The actual
  // native runner, HTTP identity queue, request/session and SQLite remain real.
  CatalogController.prototype.invoke = async function (...args) {
    if (this !== h.identity["catalog"] && !held) {
      held = true;
      entered();
      await pause;
    }
    return original.apply(this, args);
  };
  try {
    await run({
      entered: Promise.race([
        ready,
        delay(5000).then(() => {
          throw Error("TEST native boundary not reached");
        }),
      ]),
      release,
    });
  } finally {
    release();
    CatalogController.prototype.invoke = original;
  }
}
async function stored(h: Fixture, testId: string) {
  const result = await h.request("owner", base + "?" + h.query({ testId }));
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return h.job(result.data);
}
async function list(h: Fixture, processId: string) {
  const result = await h.request(
    "owner",
    base + "/list?" + h.query({ processId }),
  );
  assert.equal(result.status, 200, JSON.stringify(result.data));
  return NativeTestListSchema.parse(result.data);
}

test("native HTTP runs both actual scripted strategies and retains private immutable results across two reopens", () =>
  fixture(async (h) => {
    const input = await h.fresh(),
      before = h.production();
    const source = h.identity["catalog"].store;
    const oldModel = source.model,
      oldProvider = source.provider;
    source.model = () => {
      throw Error("TEST production model getter called");
    };
    source.provider = () => {
      throw Error("TEST production credential getter called");
    };
    let result;
    try {
      const response = await h.request("owner", base, input);
      assert.equal(response.status, 200, JSON.stringify(response.data));
      result = h.job(response.data);
    } finally {
      source.model = oldModel;
      source.provider = oldProvider;
    }
    assert.equal(result.status, "completed");
    assert.equal(result.report?.qualification, "native_scripted");
    assert.equal(result.report.activationEligible, false);
    assert.equal(result.qualification?.status, "failed");
    assert.equal(result.qualification?.scope, "native_scripted_runtime");
    assert.equal(result.qualification?.liveAcceptance, false);
    assert(result.qualification?.reasons.includes("missing_scenario"));
    assert.deepEqual(result.report.comparison, {
      cases: 1,
      configuredPassed: 1,
      genericPassed: 1,
      configuredModelCalls: 2,
      genericModelCalls: 3,
    });
    assert.equal(
      result.report.observations.reduce((n, v) => n + v.businessDispatches, 0),
      2,
    );
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
    assert.deepEqual(h.production(), before);
    const journal = h.identity["processTests"];
    h.identity.attachWorkflow(h.identity["workflowServerId"]!);
    assert.equal(h.identity["processTests"], journal);
    const events = () =>
      h.identity["db"]
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_audit WHERE json_extract(details,'$.processEvent') IN ('native_test_started','native_test_completed','native_test_interrupted')",
        )
        .get()!.n;
    assert.equal(events(), 2);
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await stored(h, result.testId), result);
      assert.deepEqual(
        h.job((await h.request("owner", base, input)).data),
        result,
      );
      const history = await list(h, input.processId);
      assert.equal(history.summaries.length, 1);
      assert.equal(history.nextAfter, null);
      assert.equal(history.summaries[0]?.reportStatus, "passed");
      assert.equal(history.summaries[0]?.qualification?.status, "failed");
      assert.equal(
        history.summaries[0]?.qualification?.qualificationDigest,
        result.qualification?.qualificationDigest,
      );
      const safe = JSON.stringify(history);
      for (const field of [
        '"observations":',
        '"suite":',
        '"environment":',
        '"environmentDigest":',
        '"creatorUserId":',
        '"reportDigest":',
        "TEST-HTTP-provider-key",
        "https://models.example.test",
      ])
        assert(!safe.includes(field));
      assert.deepEqual(h.production(), before);
      assert.equal(events(), 2);
      if (i < 2) await h.restart();
    }
    const current = await h.request(
      "owner",
      "api/identity/catalog/processes?" +
        h.query({ id: input.processId }).replace(/&profile=[^&]+/, ""),
    );
    assert.equal(current.status, 200);
    assert.equal(h.record(h.record(current.data).process).activeVersion, null);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("native HTTP rejects forged authority, scopes, profile, duplicate query and unbounded declarative input", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    assert.equal((await h.loginOperator()).status, 200);
    const response = await h.request("owner", base, input);
    assert.equal(response.status, 200);
    const result = h.job(response.data),
      get = base + "?" + h.query({ testId: result.testId });
    // Creator-private: members can own personal tests, so not theirs is 404.
    for (const [role, status] of [
      ["admin", 404],
      ["member", 404],
      ["operator", 403],
      ["anonymous", 401],
    ] as const)
      assert.equal((await h.request(role, get)).status, status, role);
    for (const [role, status] of [
      ["member", 403],
      ["operator", 403],
      ["anonymous", 401],
    ] as const)
      assert.equal(
        (
          await h.request(role, base, {
            ...input,
            requestId: "TEST-other-" + role,
          })
        ).status,
        status,
      );
    const adminHistory = await h.request(
      "admin",
      base + "/list?" + h.query({ processId: input.processId }),
    );
    assert.equal(adminHistory.status, 200);
    assert.equal(
      NativeTestListSchema.parse(adminHistory.data).summaries.length,
      0,
    );
    for (const patch of [
      { organizationId: "TEST-foreign-org" },
      { workspaceId: "TEST-foreign-workspace" },
    ])
      assert(
        [403, 404].includes(
          (await h.request("owner", base, { ...input, ...patch })).status,
        ),
      );
    for (const headers of [
      { Origin: "https://hostile.example.test" },
      { Host: "hostile.example.test" },
      { "Sec-Fetch-Site": "cross-site" },
    ] as Record<string, string>[])
      assert.equal(
        (await h.request("owner", get, undefined, { headers })).status,
        403,
      );
    for (const patch of [
      { actor: { role: "owner" } },
      { catalog: {} },
      { report: {} },
      { qualification: result.qualification },
      { profile: "agent-process-contract-tests/1" },
      {
        suite: { ...input.suite, cases: Array(17).fill(input.suite.cases[0]) },
      },
    ])
      assert.equal(
        (await h.request("owner", base, { ...input, ...patch })).status,
        400,
      );
    assert.equal(
      (await h.request("owner", base, undefined, { raw: "{invalid" })).status,
      400,
    );
    assert.equal(
      (await h.request("owner", base, undefined, { raw: " ".repeat(131073) }))
        .status,
      413,
    );
    assert.equal(
      (await h.request("owner", base + "?unexpected=1", input)).status,
      400,
    );
    assert.equal(
      (await h.request("owner", get + "&testId=TEST-ambiguous")).status,
      400,
    );
    for (const extra of ["__proto__=x", "__proto__=x&__proto__=y"]) {
      assert.equal((await h.request("owner", get + "&" + extra)).status, 400);
      assert.equal(
        (await h.request("owner", base + "?" + extra, input)).status,
        400,
      );
    }
    for (const extra of ["&limit=21", "&limit=0", "&version=0", "&extra=1"])
      assert.equal(
        (
          await h.request(
            "owner",
            base + "/list?" + h.query({ processId: input.processId }) + extra,
          )
        ).status,
        400,
      );
    assert.equal(
      (
        await h.request(
          "owner",
          base +
            "/list?" +
            h.query({
              processId: input.processId,
              after: "TEST-foreign-cursor",
            }),
        )
      ).status,
      404,
    );
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("native HTTP concurrent exact replay stays running while a different command is busy and changes conflict", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    await gate(h, async (control) => {
      const pending = h.request("owner", base, input);
      try {
        await control.entered;
        const first = h.job((await h.request("owner", base, input)).data);
        assert.equal(first.status, "running");
        assert.equal(first.report, null);
        h.identity.attachWorkflow(h.identity["workflowServerId"]!);
        assert.equal((await stored(h, first.testId)).status, "running");
        const busy = await h.request("owner", base, {
          ...input,
          requestId: "TEST-concurrent-other",
        });
        assert.equal(busy.status, 429);
        assert.equal(h.record(busy.data).error, "process_test_busy");
        const changed = structuredClone(input);
        changed.suite.cases[0]!.input = { name: "TEST-changed" };
        const conflict = await h.request("owner", base, changed);
        assert.equal(conflict.status, 409);
        assert.equal(h.record(conflict.data).error, "process_test_conflict");
        assert.equal((await list(h, input.processId)).summaries.length, 1);
        control.release();
        const result = await pending;
        assert.equal(result.status, 200);
        assert.equal(h.job(result.data).testId, first.testId);
      } finally {
        control.release();
        await pending;
      }
    });
  }));

for (const change of [
  "cookie",
  "origin",
  "session",
  "source",
  "provider",
  "budget",
  "epoch",
] as const)
  test(`native HTTP withholds publication when ${change} changes during the actual runner`, () =>
    fixture(async (h) => {
      const input = await h.fresh();
      await gate(h, async (control) => {
        const pending = h.request("owner", base, input);
        let id!: string;
        try {
          await control.entered;
          id = (await list(h, input.processId)).summaries[0]!.testId;
          if (change === "cookie")
            h.mutateNativeHeader("cookie", "TEST-replaced-session");
          if (change === "origin")
            h.mutateNativeHeader("origin", "https://hostile.example.test");
          if (change === "session") {
            assert.equal(
              (await h.request("owner", "auth/sign-out", {})).status,
              200,
            );
            assert.equal(
              (
                await h.request("owner", "auth/sign-in/email", {
                  email: "owner@example.test",
                  password: "TEST-design-HTTP-password-only-2026",
                })
              ).status,
              200,
            );
          }
          if (change === "source") {
            const service = h.identity["catalog"].store.service(
              h.target.workspaceId,
              h.serviceId,
            );
            const action = service.actions.find((a) => a.id === h.actionId)!;
            const {
              id: _id,
              revision: _revision,
              sourceKey: _key,
              ...settings
            } = action;
            await h.catalog({
              type: "saveAction",
              id: action.id,
              serviceId: h.serviceId,
              serviceRevision: service.revision,
              revision: action.revision,
              settings: ActionSettings.parse({
                ...settings,
                description: "TEST source drift",
              }),
            });
          }
          if (change === "provider") {
            const provider = h.identity["catalog"].store
              .inventory(h.target.organizationId, h.target.workspaceId, {
                userId: "TEST-projection",
                role: "owner",
              })
              .providers.find((p) => p.id === h.providerId)!;
            await h.catalog({
              type: "saveProvider",
              id: provider.id,
              revision: provider.revision,
              settings: ProviderSettings.parse({
                name: "TEST changed provider",
                url: provider.url,
                enabled: provider.enabled,
                dailyRequestLimit: provider.dailyRequestLimit,
              }),
            });
          }
          if (change === "budget") {
            const policyRevision = h.identity[
              "catalog"
            ].store.inferenceBudget.policy(
              h.target.organizationId,
              h.target.workspaceId,
            ).revision;
            for (const [revision, maxTokens] of [
              [policyRevision, h.budgetSettings.maxTokens - 1],
              [policyRevision + 1, h.budgetSettings.maxTokens],
            ] as const) {
              const saved = await h.request(
                "owner",
                "api/identity/catalog/budget",
                {
                  ...h.target,
                  revision,
                  settings: { ...h.budgetSettings, maxTokens },
                },
              );
              assert.equal(saved.status, 200, JSON.stringify(saved.data));
            }
          }
          if (change === "epoch")
            h.identity["connections"].changePolicy(h.target.organizationId);
          control.release();
          const response = await pending;
          assert(
            [401, 403, 409].includes(response.status),
            JSON.stringify(response),
          );
          const stopped = await stored(h, id);
          assert.equal(stopped.status, "interrupted");
          assert.equal(stopped.report, null);
          assert.equal(
            stopped.failure,
            ["source", "provider", "budget", "epoch"].includes(change)
              ? "test_source_changed"
              : "test_authority_changed",
          );
          assert.deepEqual(
            h.job((await h.request("owner", base, input)).data),
            stopped,
          );
          assert.equal(h.modelCount(), 0);
          assert.equal(h.businessCount(), 0);
        } finally {
          control.release();
          await pending;
        }
      });
    }));

test("native HTTP disconnect during body admission creates no reservation", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    h.disconnectNextNativeAtBodyEnd();
    await assert.rejects(h.request("owner", base, input));
    await delay(20);
    assert.equal((await list(h, input.processId)).summaries.length, 0);
    assert.equal(h.modelCount(), 0);
    assert.equal(h.businessCount(), 0);
  }));

test("native HTTP cancellation retires the real isolated runner without a staged report", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    await gate(h, async (control) => {
      const abort = new AbortController();
      const pending = h
        .request("owner", base, input, { signal: abort.signal })
        .catch(() => undefined);
      try {
        await control.entered;
        const id = (await list(h, input.processId)).summaries[0]!.testId;
        abort.abort();
        await pending;
        await delay(30);
        control.release();
        let result = await stored(h, id);
        for (let i = 0; i < 100 && result.status === "running"; i++) {
          await delay(20);
          result = await stored(h, id);
        }
        assert.equal(result.status, "interrupted");
        assert.equal(result.failure, "test_aborted");
        assert.equal(result.report, null);
        assert.deepEqual(
          h.job((await h.request("owner", base, input)).data),
          result,
        );
      } finally {
        control.release();
        await pending;
      }
    });
  }));

test("native HTTP shutdown rejects admission and drains native cleanup before identity owner release", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    await gate(h, async (control) => {
      const pending = h.request("owner", base, input);
      let restarting: Promise<void> | undefined;
      try {
        await control.entered;
        const id = (await list(h, input.processId)).summaries[0]!.testId;
        let drained = false;
        restarting = h.restart().then(() => {
          drained = true;
        });
        await delay(30);
        assert.equal(drained, false);
        assert.equal(
          (
            await h.request(
              "owner",
              base + "/list?" + h.query({ processId: input.processId }),
            )
          ).status,
          503,
        );
        control.release();
        await pending;
        await restarting;
        const result = await stored(h, id);
        assert.equal(result.status, "interrupted");
        assert.equal(result.failure, "test_aborted");
        assert.equal(result.report, null);
        assert.deepEqual(
          h.job((await h.request("owner", base, input)).data),
          result,
        );
        assert.equal(h.modelCount(), 0);
        assert.equal(h.businessCount(), 0);
      } finally {
        control.release();
        await pending;
        await restarting;
      }
    });
  }));

test("native HTTP current management role is revalidated and a restored admin reads only their interrupted result", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    const detail = OrganizationDetailSchema.parse(
      (
        await h.request(
          "owner",
          "api/identity/organization?id=" + h.target.organizationId,
        )
      ).data,
    );
    const memberId = detail.members.find((m) => m.role === "admin")!.id;
    await gate(h, async (control) => {
      const pending = h.request("admin", base, input);
      try {
        await control.entered;
        const historyResponse = await h.request(
          "admin",
          base + "/list?" + h.query({ processId: input.processId }),
        );
        assert.equal(historyResponse.status, 200);
        const id = NativeTestListSchema.parse(historyResponse.data)
          .summaries[0]!.testId;
        const revoke = await h.request("owner", "api/identity/command", {
          type: "changeRole",
          organizationId: h.target.organizationId,
          memberId,
          role: "member",
        });
        assert.equal(revoke.status, 200, JSON.stringify(revoke.data));
        control.release();
        const result = await pending;
        assert.equal(result.status, 403);
        const restore = await h.request("owner", "api/identity/command", {
          type: "changeRole",
          organizationId: h.target.organizationId,
          memberId,
          role: "admin",
        });
        assert.equal(restore.status, 200, JSON.stringify(restore.data));
        const read = await h.request(
          "admin",
          base + "?" + h.query({ testId: id }),
        );
        assert.equal(read.status, 200);
        const stopped = h.job(read.data);
        assert.equal(stopped.status, "interrupted");
        assert.equal(stopped.failure, "test_authority_changed");
        assert.equal(stopped.report, null);
        assert.equal(
          (await h.request("owner", base + "?" + h.query({ testId: id })))
            .status,
          404,
        );
      } finally {
        control.release();
        await pending;
      }
    });
  }));

test("native HTTP total deadline returns an explicit timeout after tracked native retirement", () =>
  fixture(async (h) => {
    const input = await h.fresh();
    const timeout = AbortSignal.timeout;
    const deadline = new AbortController();
    let deadlineCalls = 0;
    AbortSignal.timeout = function (ms) {
      if (ms === 120000) {
        deadlineCalls++;
        if (deadlineCalls === 1) return deadline.signal;
      }
      return timeout(ms);
    };
    try {
      await gate(h, async (control) => {
        const pending = h.request("owner", base, input);
        try {
          await control.entered;
          const id = (await list(h, input.processId)).summaries[0]!.testId;
          assert(deadlineCalls > 0);
          deadline.abort(
            new DOMException("TEST native HTTP deadline", "TimeoutError"),
          );
          control.release();
          const result = await pending;
          assert.equal(result.status, 504);
          assert.equal(h.record(result.data).error, "process_test_timeout");
          const retired = await stored(h, id);
          assert.equal(retired.status, "interrupted");
          assert.equal(retired.failure, "test_aborted");
          assert.equal(retired.report, null);
        } finally {
          control.release();
          await pending;
        }
      });
    } finally {
      AbortSignal.timeout = timeout;
    }
  }));
