import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  ProcessConsoleClient,
  processConsoleStorageKey,
  type ProcessConsoleTransport,
} from "../apps/server-admin/web/lib/process-console-client";
import { suiteToDraft } from "../apps/server-admin/web/lib/process-test-suite";
import { ApiError, api } from "../apps/server-admin/web/lib/api";
import { DesignCapabilitiesSchema } from "../packages/protocol/process-design";
import { IdentityStateSchema } from "../packages/protocol/identity";
import { activationHttpFixture } from "./helpers/process-activation-http";
import {
  PROCESS_NATIVE_TEST_PROFILE,
  PROCESS_NATIVE_TEST_DETAIL_PROFILE,
  NativeTestJobSchema,
  NativeTestDetailV2Schema,
} from "../packages/protocol/process-native-testing";

type Fixture = Awaited<ReturnType<typeof activationHttpFixture>>;
let ready: Promise<Fixture> | undefined;
after(async () => {
  if (ready) await (await ready).close();
});
async function fixture() {
  const h = await (ready ??= activationHttpFixture()),
    input = await h.fresh();
  const userId = IdentityStateSchema.parse(
    (await h.request("owner", "api/identity")).data,
  ).user!.id;
  const scope = {
    ...h.target,
    userId,
    authority: "TEST-console-authority",
    serviceId: h.serviceId,
    processId: input.processId,
  };
  const memory = new Map<string, string>();
  let failStorage = false;
  const storage = {
    getItem: (k: string) => memory.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failStorage) throw Error("TEST quota");
      memory.set(k, v);
    },
    removeItem: (k: string) => {
      memory.delete(k);
    },
  };
  const calls: { path: string; body: unknown }[] = [];
  const actual: ProcessConsoleTransport["request"] = async (
    path,
    body,
    signal,
  ) => {
    const response = await h.request("owner", "api/" + path, body, { signal });
    if (response.status !== 200)
      throw new ApiError(
        response.status,
        h.record(response.data).error as string,
      );
    return response.data;
  };
  let hook: ProcessConsoleTransport["request"] = actual;
  const transport: ProcessConsoleTransport = {
    request: async (path, body, signal) => {
      calls.push({ path, body: structuredClone(body) });
      if (body !== undefined)
        assert.equal(
          JSON.parse(memory.get(processConsoleStorageKey(scope))!).pending.body
            .requestId,
          (body as { requestId: string }).requestId,
          "persist before POST",
        );
      return hook(path, body, signal);
    },
    capabilities: async (target, signal) => {
      const response = await actual(
        "identity/catalog/processes/design/capabilities?" +
          new URLSearchParams(target),
        undefined,
        signal,
      );
      const caps = DesignCapabilitiesSchema.parse(
        h.record(response).capabilities,
      );
      assert.equal(caps.nextAfter, null);
      return caps;
    },
  };
  const client = () => new ProcessConsoleClient(scope, storage, transport);
  return {
    h,
    input,
    userId,
    scope,
    memory,
    storage,
    calls,
    actual,
    client,
    setHook: (fn: typeof hook) => {
      hook = fn;
    },
    failStorage: () => {
      failStorage = true;
    },
    posts: () => calls.filter((c) => c.body !== undefined),
  };
}

async function interruptedFixture() {
  const f = await fixture();
  const input = structuredClone(f.input);
  const rejection = input.suite.cases.find((c) => c.scenario === "rejection")!;
  rejection.actions[0]!.decision = "none";
  input.suite.cases = [rejection];
  const response = await f.h.request(
    "owner",
    "api/identity/catalog/processes/tests/native",
    input,
  );
  assert.equal(response.status, 502);
  assert.equal(f.h.record(response.data).error, "integration_unavailable");
  const read = await f.h.request(
    "owner",
    "api/identity/catalog/processes/tests/native/detail?" +
      new URLSearchParams({
        ...f.h.target,
        profile: PROCESS_NATIVE_TEST_DETAIL_PROFILE,
        requestId: input.requestId,
      }),
  );
  assert.equal(read.status, 200);
  const job = NativeTestJobSchema.parse(f.h.record(read.data).job);
  assert.equal(job.status, "interrupted");
  return { ...f, input, job };
}

test("console freeze recovery is GET-only and accepts a durable original receipt after source revision changes", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  assert(c.getSnapshot().fresh);
  assert.equal(f.posts().length, 0);
  const original = await f.h.process(f.input.processId);
  f.setHook(async (p, b, s) => {
    const result = await f.actual(p, b, s);
    if (b !== undefined) throw Error("TEST lost response");
    return result;
  });
  await c.freeze(original.revision);
  assert.equal(c.getSnapshot().pending?.kind, "freeze");
  const sent = structuredClone(f.posts()[0]);
  c.dispose();
  await f.h.fresh(f.input.processId);
  const recovered = f.client();
  await recovered.retry();
  assert.equal(f.posts().length, 1);
  await recovered.refresh();
  assert.equal(recovered.getSnapshot().pending, null);
  assert.equal(
    recovered.getSnapshot().freezeReceipt?.requestId,
    (sent!.body as { requestId: string }).requestId,
  );
  assert.equal(f.posts().length, 1);
  assert(recovered.getSnapshot().fresh);
  recovered.dispose();
});

test("unknown native admission is explicitly replayed exactly, its original suite is recovered, and lost human activation is never auto-reposted", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  c.setSuite(suiteToDraft(f.input.suite));
  await c.refresh();
  const prepared = c.prepareTest(false);
  assert(prepared);
  f.setHook(async (p, b, s) => {
    if (b !== undefined) throw Error("TEST before admission");
    return f.actual(p, b, s);
  });
  await c.test(prepared);
  assert.equal(c.getSnapshot().pending?.kind, "test");
  const sent = structuredClone(f.posts()[0]);
  c.dispose();
  const recovered = f.client();
  await recovered.refresh();
  assert.equal(f.posts().length, 1);
  assert.equal(
    recovered.getSnapshot().pending?.body.requestId,
    prepared.requestId,
  );
  f.setHook(f.actual);
  await recovered.retry();
  assert.deepEqual(f.posts()[1], sent);
  assert.equal(recovered.getSnapshot().pending, null);
  assert.deepEqual(recovered.getSnapshot().original, prepared);
  assert.equal(prepared.profile, PROCESS_NATIVE_TEST_PROFILE);
  assert.equal(
    (f.posts()[1]!.body as { profile: string }).profile,
    PROCESS_NATIVE_TEST_PROFILE,
  );
  assert.equal(recovered.getSnapshot().job?.report?.observations.length, 12);
  const review = recovered.getSnapshot().review;
  assert(review?.canActivate);
  f.setHook(async (p, b, s) => {
    const result = await f.actual(p, b, s);
    if (b !== undefined) throw Error("TEST lost activation response");
    return result;
  });
  await recovered.decide(review, "activate");
  assert.equal(recovered.getSnapshot().pending?.kind, "decision");
  recovered.dispose();
  const active = f.client();
  await active.refresh();
  assert.equal(f.posts().length, 3);
  assert.equal(active.getSnapshot().pending, null);
  assert.equal(active.getSnapshot().process?.activeVersion, prepared.version);
  assert.equal(
    active.getSnapshot().decisionReceipt?.activeVersion,
    prepared.version,
  );
  assert.equal(active.prepareTest(false), null, "active retest is explicit");
  const v2 = await f.h.fresh(f.input.processId),
    job2 = await f.h.runNative(v2);
  const activated = await f.h.request(
    "owner",
    "api/identity/catalog/processes/activation",
    { ...f.h.command(v2, job2), expectedActiveVersion: prepared.version },
  );
  assert.equal(activated.status, 200);
  await active.refresh();
  assert.equal(active.getSnapshot().process?.activeVersion, v2.version);
  assert.equal(
    active.getSnapshot().decisionReceipt?.activeVersion,
    prepared.version,
    "old receipt never rewrites current pointer",
  );
  assert.equal(f.posts().length, 3);
  for (const call of f.calls) {
    const url = new URL(call.path, "http://TEST.local/");
    if (url.pathname.endsWith("/tests/native/detail"))
      assert.equal(
        url.searchParams.get("profile"),
        PROCESS_NATIVE_TEST_DETAIL_PROFILE,
      );
    if (
      url.pathname.endsWith("/tests/native/list") ||
      url.pathname.endsWith("/tests/native/tools")
    )
      assert.equal(
        url.searchParams.get("profile"),
        PROCESS_NATIVE_TEST_PROFILE,
      );
  }
  assert(
    f
      .posts()
      .every((call) =>
        (call.body as { profile: string }).profile.endsWith("/1"),
      ),
  );
  active.dispose();
});

test("negotiated diagnostic detail is private transient evidence and passive reads never post", async () => {
  const f = await interruptedFixture(),
    c = f.client();
  await c.refresh();
  await c.selectTest(f.job.testId);
  const state = c.getSnapshot();
  assert.equal(state.diagnostic?.code, "native_test_approval_unexpected");
  assert.equal(state.diagnostic?.evidence?.checkpoint?.pending, "approval");
  assert.equal(state.diagnostic?.evidence?.businessDispatches, 0);
  assert.equal(
    state.diagnostic?.evidence?.receipts?.[0]?.status,
    "awaiting_approval",
  );
  assert.equal(state.diagnostic?.evidence?.receipts?.[0]?.dispatches, 0);
  assert.deepEqual(state.original, f.input);
  assert.equal(state.review, null);
  assert.equal(state.job?.qualification, undefined);
  assert.equal(state.job?.report, null);
  assert.equal(f.posts().length, 0);
  const saved = f.memory.get(processConsoleStorageKey(f.scope))!;
  assert.equal(saved.includes("diagnostic"), false);
  assert.equal(saved.includes("native_test_approval_unexpected"), false);
  await c.refresh();
  assert.equal(c.getSnapshot().diagnostic?.code, state.diagnostic?.code);
  assert.equal(f.posts().length, 0);
  c.dispose();
  assert.equal(c.getSnapshot().diagnostic, null);
  assert.equal(c.getSnapshot().job, null);
  const restored = f.client();
  assert.equal(restored.getSnapshot().diagnostic, null);
  await restored.refresh();
  assert.equal(restored.getSnapshot().diagnostic?.code, state.diagnostic?.code);
  assert.equal(f.posts().length, 0);
  restored.dispose();
  const anotherScope = new ProcessConsoleClient(
    { ...f.scope, workspaceId: "TEST-another-workspace" },
    f.storage,
  );
  assert.equal(anotherScope.getSnapshot().diagnostic, null);
  assert.equal(anotherScope.getSnapshot().job, null);
  assert.equal(anotherScope.getSnapshot().original, null);
  anotherScope.dispose();
});

test("an interrupted native POST recovers its original diagnostic by GET without replaying a model or command", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  const suite = structuredClone(f.input.suite);
  const rejection = suite.cases.find(
    (entry) => entry.scenario === "rejection",
  )!;
  rejection.actions[0]!.decision = "none";
  suite.cases = [rejection];
  c.setSuite(suiteToDraft(suite));
  await c.refresh();
  const command = c.prepareTest(false);
  assert(command);
  await c.test(command);
  assert.equal(c.getSnapshot().error, "integration_unavailable");
  assert.deepEqual(c.getSnapshot().pending, { kind: "test", body: command });
  assert.equal(f.posts().length, 1);
  await c.refresh();
  assert.equal(c.getSnapshot().pending, null);
  assert.deepEqual(c.getSnapshot().original, command);
  assert.equal(c.getSnapshot().job?.status, "interrupted");
  assert.equal(
    c.getSnapshot().diagnostic?.code,
    "native_test_approval_unexpected",
  );
  assert.equal(c.getSnapshot().review, null);
  await c.refresh();
  assert.equal(f.posts().length, 1);
  assert.equal(
    (f.posts()[0]!.body as { profile: string }).profile,
    PROCESS_NATIVE_TEST_PROFILE,
  );
  c.dispose();
});

test("negotiated detail refuses old envelopes and internally valid foreign bindings without retaining a diagnostic", async () => {
  const f = await interruptedFixture(),
    c = f.client();
  await c.refresh();
  await c.selectTest(f.job.testId);
  const path = "identity/catalog/processes/tests/native/detail";
  for (const kind of [
    "old_profile",
    "scope",
    "process",
    "version",
    "request",
    "identifier",
    "artifact",
    "extra_text",
    "case",
    "source_changed",
    "aborted",
  ] as const) {
    f.setHook(async (p, b, s) => {
      const value = await f.actual(p, b, s);
      if (!p.startsWith(path)) return value;
      const v = NativeTestDetailV2Schema.parse(structuredClone(value));
      if (kind === "old_profile") return { job: v.job, request: v.request };
      if (kind === "scope")
        v.job.workspaceId = v.request.workspaceId = "TEST-foreign-workspace";
      if (kind === "process")
        v.job.processId = v.request.processId = "TEST-foreign-process";
      if (kind === "version")
        v.job.version = v.request.version = v.job.version + 1;
      if (kind === "request")
        v.job.requestId = v.request.requestId = "TEST-foreign-request";
      if (kind === "identifier") v.job.testId = "TEST-foreign-test";
      if (kind === "artifact")
        v.job.stamp.artifactDigest = v.request.artifactDigest = "e".repeat(64);
      if (kind === "case") v.diagnostic!.evidence!.caseId = "TEST_foreign_case";
      if (kind === "source_changed") v.job.failure = "test_source_changed";
      if (kind === "aborted") v.job.failure = "test_aborted";
      if (kind === "extra_text")
        return {
          ...v,
          diagnostic: { ...v.diagnostic, error: "TEST excluded error text" },
        };
      if (!["case", "source_changed", "aborted"].includes(kind))
        assert(NativeTestDetailV2Schema.safeParse(v).success, kind);
      return v;
    });
    await c.refresh();
    assert.equal(c.getSnapshot().diagnostic, null, kind);
    assert.equal(c.getSnapshot().review, null, kind);
    assert.equal(c.getSnapshot().error, "response_invalid", kind);
    assert.equal(c.getSnapshot().fresh, false, kind);
  }
  assert.equal(f.posts().length, 0);
  c.dispose();
});

test("selection, version, stale reads and authority denial discard diagnostic evidence with its private selection", async () => {
  const f = await interruptedFixture(),
    c = f.client();
  await c.refresh();
  await c.selectTest(f.job.testId);
  assert(c.getSnapshot().diagnostic);
  const unsubscribe = c.subscribe(() => {
    const state = c.getSnapshot();
    if (state.diagnostic) {
      assert.equal(state.job?.testId, state.selectedTestId);
      assert.equal(state.job?.version, state.selectedVersion);
      assert.equal(state.original?.requestId, state.job?.requestId);
    }
  });
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.setHook(async (p, b, s) => {
    const value = await f.actual(p, b, s);
    if (p.includes("/tests/native/detail?")) {
      entered();
      await hold;
    }
    return value;
  });
  const stale = c.refresh();
  assert.equal(c.getSnapshot().diagnostic, null);
  await started;
  f.setHook(f.actual);
  const selected = c.selectTest("TEST-no-such-test");
  assert.equal(c.getSnapshot().job, null);
  assert.equal(c.getSnapshot().original, null);
  assert.equal(c.getSnapshot().diagnostic, null);
  await selected;
  release();
  await stale;
  assert.equal(c.getSnapshot().job, null);
  assert.equal(c.getSnapshot().diagnostic, null);
  await c.selectTest(f.job.testId);
  assert(c.getSnapshot().diagnostic);
  const version = c.selectVersion(f.input.version);
  assert.equal(c.getSnapshot().job, null);
  assert.equal(c.getSnapshot().original, null);
  assert.equal(c.getSnapshot().diagnostic, null);
  await version;
  await c.selectTest(f.job.testId);
  assert(c.getSnapshot().diagnostic);
  f.setHook(async () => {
    throw new ApiError(403, "identity_forbidden");
  });
  await c.refresh();
  assert(c.getSnapshot().denied);
  assert.equal(c.getSnapshot().diagnostic, null);
  assert.equal(c.getSnapshot().job, null);
  assert.equal(c.getSnapshot().original, null);
  assert.equal(f.memory.size, 0);
  assert.equal(f.posts().length, 0);
  unsubscribe();
  c.dispose();
});

test("corrupt or foreign recovery data stays untouched, and storage failure prevents dispatch", async () => {
  const f = await fixture(),
    key = processConsoleStorageKey(f.scope);
  f.memory.set(key, "{invalid TEST");
  let c = f.client();
  await c.refresh();
  await c.freeze(f.input.revision);
  assert.equal(c.getSnapshot().error, "recovery_storage_invalid");
  assert.equal(f.memory.get(key), "{invalid TEST");
  assert.equal(f.calls.length, 0);
  c.dispose();
  f.memory.clear();
  c = f.client();
  await c.refresh();
  f.setHook(async () => {
    throw Error("TEST network");
  });
  await c.freeze(f.input.revision);
  const saved = JSON.parse(f.memory.get(key)!);
  c.dispose();
  saved.pending.body.workspaceId = "TEST-other";
  f.memory.set(key, JSON.stringify(saved));
  c = f.client();
  await c.refresh();
  assert.equal(c.getSnapshot().error, "recovery_storage_invalid");
  assert.equal(c.getSnapshot().pending, null);
  assert.equal(f.memory.get(key), JSON.stringify(saved));
  c.dispose();
  f.memory.clear();
  f.setHook(f.actual);
  c = f.client();
  await c.refresh();
  const before = f.posts().length;
  f.failStorage();
  await c.freeze(f.input.revision);
  assert.equal(f.posts().length, before);
  assert.equal(c.getSnapshot().error, "recovery_storage_unavailable");
  c.dispose();
});

test("private detail must match the exact selected identifier and artifact, while ineligible current review preserves historical evidence", async () => {
  const f = await fixture(),
    job = await f.h.runNative(f.input),
    c = f.client();
  await c.refresh();
  await c.selectTest(job.testId);
  assert.equal(c.getSnapshot().job?.testId, job.testId);
  const path = "identity/catalog/processes/tests/native/detail";
  for (const kind of ["identifier", "artifact"]) {
    f.setHook(async (p, b, s) => {
      const value = await f.actual(p, b, s);
      if (p.startsWith(path)) {
        const v = structuredClone(value) as {
          job: typeof job;
          request: typeof f.input;
        };
        if (kind === "identifier") {
          v.job.testId = "TEST-wrong";
          if (v.job.qualification) v.job.qualification.testId = "TEST-wrong";
        } else {
          v.job.stamp.artifactDigest = "e".repeat(64);
          v.request.artifactDigest = "e".repeat(64);
          if (v.job.report) v.job.report.stamp.artifactDigest = "e".repeat(64);
          if (v.job.qualification)
            v.job.qualification.stamp.artifactDigest = "e".repeat(64);
        }
        return v;
      }
      return value;
    });
    await c.refresh();
    assert.equal(c.getSnapshot().error, "response_invalid");
    assert.equal(c.getSnapshot().fresh, false);
    assert.equal(c.getSnapshot().review, null);
  }
  f.setHook(async (p, b, s) => {
    if (p.includes("/activation/review?"))
      throw new ApiError(409, "process_test_superseded");
    return f.actual(p, b, s);
  });
  await c.refresh();
  assert.equal(c.getSnapshot().reviewError, "process_test_superseded");
  assert.equal(c.getSnapshot().job?.testId, job.testId);
  assert.equal(c.getSnapshot().original?.requestId, f.input.requestId);
  assert(c.getSnapshot().fresh);
  c.dispose();
});

test("disposed reads and baseline changes cannot republish stale private state or tool inventory", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  c.setSuite(suiteToDraft(f.input.suite));
  await c.refresh();
  assert(c.getSnapshot().tools);
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>((r) => {
    entered = r;
  });
  const hold = new Promise<void>((r) => {
    release = r;
  });
  f.setHook(async (p, b, s) => {
    const value = await f.actual(p, b, s);
    if (p.includes("/tools?")) {
      entered();
      await hold;
    }
    return value;
  });
  const read = c.refresh();
  await started;
  const draft = JSON.parse(c.getSnapshot().suite);
  draft.genericModelId = "TEST-another-model";
  c.setSuite(JSON.stringify(draft));
  release();
  await read;
  assert.equal(c.getSnapshot().tools, null);
  assert.equal(c.getSnapshot().fresh, false);
  f.setHook(f.actual);
  c.setSuite(suiteToDraft(f.input.suite));
  await c.refresh();
  let resume!: () => void;
  const delayed = new Promise<void>((r) => {
    resume = r;
  });
  f.setHook(async (p, b, s) => {
    const value = await f.actual(p, b, s);
    await delayed;
    return value;
  });
  const stale = c.refresh();
  c.dispose();
  c.attach();
  f.setHook(f.actual);
  await c.refresh();
  const snapshot = c.getSnapshot();
  resume();
  await stale;
  assert.equal(c.getSnapshot(), snapshot);
  assert.equal(f.posts().length, 0);
  c.dispose();
});

test("authority denial clears private recovery and blocks later publication and commands", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  c.setSuite(suiteToDraft(f.input.suite));
  await c.refresh();
  assert(c.getSnapshot().tools);
  f.setHook(async () => {
    throw new ApiError(403, "identity_forbidden");
  });
  await c.refresh();
  assert(c.getSnapshot().denied);
  assert.equal(c.getSnapshot().process, null);
  assert.equal(c.getSnapshot().suite, "");
  assert.equal(c.getSnapshot().tools, null);
  assert.equal(f.memory.size, 0);
  f.setHook(f.actual);
  await c.refresh();
  await c.freeze(f.input.revision);
  assert.equal(f.posts().length, 0);
  assert(c.getSnapshot().denied);
  c.dispose();
});

test("native POST timeout permits the server's bounded 120-second runner, while passive reads remain shorter", async (t) => {
  const times: number[] = [];
  const timeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (ms: number) => {
    times.push(ms);
    return timeout(ms);
  });
  t.mock.method(globalThis, "fetch", async () => Response.json({}));
  await api("identity/catalog/processes/tests/native", {});
  await api(
    "identity/catalog/processes/design/turns?profile=agent-process-design%2F2",
    {},
  );
  await api("identity/catalog/processes/tests/native/detail?testId=TEST-id");
  assert.deepEqual(times, [125000, 305000, 50000]);
});

test("legacy console metadata rejects a mismatched workspace response profile", async () => {
  const f = await fixture(),
    client = f.client();
  f.setHook(async (path, body, signal) => {
    const result = await f.actual(path, body, signal);
    return path.startsWith("identity/catalog/processes?")
      ? { ...(result as object), profile: "agent-service-processes/2" }
      : result;
  });
  await client.refresh();
  assert.equal(client.getSnapshot().fresh, false);
  assert.equal(client.getSnapshot().error, "response_invalid");
  assert.equal(client.getSnapshot().process, null);
  assert.equal(f.posts().length, 0);
  client.dispose();
});

test("a positively rejected busy admission preserves editable scenarios without a phantom pending request", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  const original = suiteToDraft(f.input.suite);
  c.setSuite(original);
  await c.refresh();
  const cmd = c.prepareTest(false);
  assert(cmd);
  f.setHook(async (p, b, s) => {
    if (b !== undefined) throw new ApiError(429, "process_test_busy");
    return f.actual(p, b, s);
  });
  await c.test(cmd);
  assert.equal(c.getSnapshot().pending, null);
  assert.equal(c.getSnapshot().rejected?.code, "process_test_busy");
  assert.equal(c.getSnapshot().suite, original);
  assert.equal(c.getSnapshot().fresh, true);
  c.setSuite(original + " ");
  assert.equal(c.getSnapshot().suite, original + " ");
  assert.equal(f.posts().length, 1);
  c.dispose();
});

test("one run-test action freezes a changed draft and tests only the version it produced", async () => {
  const f = await fixture(),
    c = f.client();
  await c.refresh();
  c.setSuite(suiteToDraft(f.input.suite));
  await c.refresh();
  const current = await f.h.process(f.input.processId);
  const saved = await f.h.request(
    "owner",
    "api/identity/catalog/processes/command",
    {
      ...f.h.target,
      type: "saveDraft",
      id: current.id,
      serviceId: f.h.serviceId,
      revision: current.revision,
      definition: { ...current.draft, name: current.draft.name + " v2" },
    },
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  await c.refresh();
  const changed = c.getSnapshot().process!;
  assert.equal(changed.latestVersion, f.input.version);
  // A stale revision freezes nothing and never falls back to the old version.
  assert.equal(await c.freezeAndTest(current.revision), true);
  assert.equal(f.posts().length, 0);
  assert.equal(await c.freezeAndTest(changed.revision), true);
  const paths = f.posts().map((call) => call.path);
  assert.equal(paths.length, 2, JSON.stringify(paths));
  assert.match(paths[0]!, /versions\/freeze$/);
  assert.match(paths[1]!, /tests\/native$/);
  const snapshot = c.getSnapshot();
  assert.equal(snapshot.pending, null);
  assert.equal(snapshot.selectedVersion, f.input.version + 1);
  assert.equal(snapshot.original?.version, f.input.version + 1);
  assert.equal(snapshot.job?.version, f.input.version + 1);
  c.dispose();
});

test("paginated history cannot publish evidence for another immutable artifact", async () => {
  const f = await fixture(),
    job = await f.h.runNative(f.input),
    c = f.client();
  let first: any;
  f.setHook(async (p, b, s) => {
    const value = await f.actual(p, b, s);
    if (p.includes("/tests/native/list?")) {
      const v = structuredClone(value) as {
        summaries: Record<string, unknown>[];
        nextAfter: string | null;
      };
      if (p.includes("after=")) {
        const wrong = structuredClone(first);
        wrong.testId = "zzTEST-wrong";
        wrong.stamp.artifactDigest = "e".repeat(64);
        return { ...v, summaries: [wrong], nextAfter: null };
      }
      first = v.summaries[0];
      v.nextAfter = job.testId;
      return v;
    }
    return value;
  });
  await c.refresh();
  assert.equal(c.getSnapshot().nextAfter, job.testId);
  await c.more("history");
  assert.equal(c.getSnapshot().error, "response_invalid");
  assert.equal(c.getSnapshot().fresh, false);
  assert(!c.getSnapshot().history.some((j) => j.testId === "zzTEST-wrong"));
  c.dispose();
});
