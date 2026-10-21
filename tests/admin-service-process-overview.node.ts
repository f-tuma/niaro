import assert from "node:assert/strict";
import { test } from "node:test";
import { DESIGN_PROFILE } from "../packages/protocol/process-design";
import {
  PROCESS_PROFILE,
  ProcessRecordSchema,
  ProcessVersionSchema,
  type ProcessRecord,
} from "../packages/protocol/service-processes";
import { PROCESS_VERSION_PROFILE } from "../packages/protocol/process-versions";
import {
  loadWorkspaceProcesses,
  workspaceProcessesKey,
  loadProcessOverview,
  sameProcessDefinition,
} from "../apps/server-admin/web/lib/service-process-overview";
import { ApiError } from "../apps/server-admin/web/lib/api";
import {
  designUiTarget as target,
  designUiCandidate as definition,
  designUiCapabilities as capabilities,
} from "./admin-design-fixtures";

const process = ProcessRecordSchema.parse({
  id: "test_process",
  serviceId: "test_service",
  revision: 3,
  name: "TEST draft",
  kind: definition.kind,
  latestVersion: 2,
  activeVersion: 1,
  updatedAt: "2026-10-04T12:00:00.000Z",
  draft: { ...definition, name: "TEST draft", description: "TEST new purpose" },
});
const scope = {
  ...target,
  processId: process.id,
  serviceId: process.serviceId,
};
const version = (number: number, status: "passed" | "failed" | "untested") =>
  ProcessVersionSchema.parse({
    processId: process.id,
    version: number,
    definition: { ...definition, name: `TEST frozen v${number}` },
    sources: {
      resources: [],
      pluginsDigest: null,
      limitsDigest: "a".repeat(64),
    },
    digest: String(number).repeat(64),
    createdAt: "2026-10-04T11:00:00.000Z",
    createdBy: "test_user",
    testStatus: status,
  });
const active = version(1, "passed"),
  latest = version(2, "failed");
const summary = (id: string, serviceId = process.serviceId) => {
  const { draft: _draft, ...value } = process;
  return { ...value, id, serviceId };
};
const record = (value: ProcessRecord) =>
  Response.json({ ...target, profile: PROCESS_PROFILE, process: value });
const inventory = (
  processes: ReturnType<typeof summary>[],
  nextAfter: string | null = null,
  workspaceId = target.workspaceId,
) =>
  Response.json({
    ...target,
    workspaceId,
    profile: PROCESS_PROFILE,
    processes,
    nextAfter,
  });
const history = (versions = [latest, active]) =>
  Response.json({
    ...target,
    profile: PROCESS_VERSION_PROFILE,
    processId: process.id,
    versions,
    nextBefore: null,
  });

test("workspace inventory joins all service pages through one shared workspace key and GETs only", async (t) => {
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    assert.equal(init.body, undefined);
    const parsed = new URL(url, "http://local.test");
    calls.push(parsed);
    assert.equal(parsed.searchParams.has("serviceId"), false);
    return calls.length === 1
      ? inventory([summary("test_a")], "test_a")
      : inventory([summary("test_b", "test_other_service")]);
  });
  const loaded = await loadWorkspaceProcesses(
    target,
    new AbortController().signal,
  );
  assert.deepEqual(
    loaded.map((p) => p.id),
    ["test_a", "test_b"],
  );
  assert.equal(calls[1]!.searchParams.get("after"), "test_a");
  assert.equal(
    workspaceProcessesKey("human", target).includes(process.serviceId),
    false,
  );
  assert.notDeepEqual(
    workspaceProcessesKey("human", target),
    workspaceProcessesKey("other human", target),
  );
  assert.notDeepEqual(
    workspaceProcessesKey("human", target),
    workspaceProcessesKey("human", { ...target, workspaceId: "test_other" }),
  );
});

test("workspace inventory rejects foreign scope, duplicate/nonadvancing pages and malformed cursors", async (t) => {
  for (const failure of ["scope", "duplicate", "cursor"] as const) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      if (++calls === 1) return inventory([summary("test_a")], "test_a");
      if (failure === "scope")
        return inventory([summary("test_b")], null, "test_foreign");
      if (failure === "duplicate") return inventory([summary("test_a")]);
      return inventory([summary("test_b")], "test_unrelated");
    });
    await assert.rejects(
      loadWorkspaceProcesses(target, new AbortController().signal),
      SyntaxError,
    );
    mock.mock.restore();
  }
});

test("overview binds a newer draft, failed latest artifact and old passing active artifact without private history or commands", async (t) => {
  const calls: URL[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    assert.equal(init.body, undefined);
    const parsed = new URL(url, "http://local.test");
    calls.push(parsed);
    if (parsed.pathname.endsWith("/capabilities"))
      return Response.json({ profile: DESIGN_PROFILE, capabilities });
    if (parsed.pathname.endsWith("/versions")) return history([latest]);
    if (parsed.searchParams.has("version"))
      return Response.json({
        ...target,
        profile: PROCESS_PROFILE,
        version: active,
      });
    return record(process);
  });
  const loaded = await loadProcessOverview(scope, new AbortController().signal);
  assert.equal(loaded.process.draft.description, "TEST new purpose");
  assert.equal(loaded.activeVersion!.version, 1);
  assert.equal(loaded.activeVersion!.testStatus, "passed");
  assert.equal(loaded.history.versions[0]!.version, 2);
  assert.equal(loaded.history.versions[0]!.testStatus, "failed");
  assert.equal(
    calls.filter((u) => u.searchParams.get("version") === "1").length,
    1,
  );
  assert.equal(
    calls.some((u) => /tests|activation|freeze|turns|command/.test(u.pathname)),
    false,
  );
  assert.equal(
    sameProcessDefinition(
      loaded.process.draft,
      loaded.activeVersion!.definition,
    ),
    false,
  );
});

test("raced process snapshot retries once as GETs and never publishes the previous draft", async (t) => {
  let reads = 0;
  const current = {
    ...process,
    revision: 4,
    draft: { ...process.draft, description: "TEST current purpose" },
  };
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    assert.equal(init.method, undefined);
    const parsed = new URL(url, "http://local.test");
    if (parsed.pathname.endsWith("/capabilities"))
      return Response.json({ profile: DESIGN_PROFILE, capabilities });
    if (parsed.pathname.endsWith("/versions")) return history();
    return record(++reads === 1 ? process : current);
  });
  const loaded = await loadProcessOverview(scope, new AbortController().signal);
  assert.equal(reads, 4);
  assert.equal(loaded.process.revision, 4);
  assert.equal(loaded.process.draft.description, "TEST current purpose");
});

test("overview rejects repeated source races and foreign record/version/history bindings", async (t) => {
  for (const failure of ["race", "record", "history", "version"] as const) {
    let reads = 0;
    const mock = t.mock.method(globalThis, "fetch", async (url: string) => {
      const parsed = new URL(url, "http://local.test");
      if (parsed.pathname.endsWith("/capabilities"))
        return Response.json({ profile: DESIGN_PROFILE, capabilities });
      if (parsed.pathname.endsWith("/versions"))
        return failure === "history"
          ? history([{ ...latest, processId: "test_foreign" }])
          : history(failure === "version" ? [latest] : [latest, active]);
      if (parsed.searchParams.has("version"))
        return Response.json({
          ...target,
          profile: PROCESS_PROFILE,
          version: { ...active, version: 2 },
        });
      return record(
        failure === "record"
          ? { ...process, serviceId: "test_foreign" }
          : failure === "race"
            ? { ...process, revision: ++reads }
            : process,
      );
    });
    await assert.rejects(
      loadProcessOverview(scope, new AbortController().signal),
      failure === "race"
        ? (e: unknown) =>
            e instanceof ApiError && e.code === "process_snapshot_changed"
        : SyntaxError,
    );
    mock.mock.restore();
  }
});

test("aborted authority cannot publish an ignored-signal late inventory or overview response", async (t) => {
  for (const mode of ["inventory", "overview"] as const) {
    const controller = new AbortController();
    const mock = t.mock.method(globalThis, "fetch", async (url: string) => {
      const parsed = new URL(url, "http://local.test");
      if (parsed.pathname.endsWith("/capabilities"))
        return Response.json({ profile: DESIGN_PROFILE, capabilities });
      if (parsed.pathname.endsWith("/versions")) return history();
      controller.abort(new Error("TEST authority changed"));
      return mode === "inventory"
        ? inventory([summary("test_a")])
        : record(process);
    });
    await assert.rejects(
      mode === "inventory"
        ? loadWorkspaceProcesses(target, controller.signal)
        : loadProcessOverview(scope, controller.signal),
      /TEST authority changed/,
    );
    mock.mock.restore();
  }
});

test("draft comparison ignores object insertion order and detects definition changes", () => {
  const original = structuredClone(definition);
  original.inputSchema.properties.note = { type: "string" };
  const reordered = structuredClone(original);
  reordered.inputSchema = {
    ...reordered.inputSchema,
    properties: Object.fromEntries(
      Object.entries(reordered.inputSchema.properties).reverse(),
    ),
  };
  assert.notEqual(JSON.stringify(original), JSON.stringify(reordered));
  assert.equal(sameProcessDefinition(original, reordered), true);
  assert.equal(
    sameProcessDefinition(definition, {
      ...reordered,
      description: "TEST changed",
    }),
    false,
  );
});
