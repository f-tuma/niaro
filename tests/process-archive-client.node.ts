import assert from "node:assert/strict";
import { test } from "node:test";
import { archivePersonalProcess } from "../apps/server-admin/web/lib/process-archive";
import { ApiError } from "../apps/server-admin/web/lib/api";
import { WORKSPACE_PROCESS_PROFILE } from "../packages/protocol/service-processes";

const target = { organizationId: "TEST-org", workspaceId: "TEST-workspace" };

test("deleting a personal process sends the seen revision and checks the answer", async (t) => {
  const calls: { url: string; body: unknown }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) });
    return Response.json({
      profile: WORKSPACE_PROCESS_PROFILE,
      id: "TEST-process",
      archivedAt: "2026-10-16T10:00:00.000Z",
    });
  });
  const result = await archivePersonalProcess(target, {
    id: "TEST-process",
    revision: 4,
  });
  assert.equal(result.id, "TEST-process");
  assert.deepEqual(calls, [
    {
      url: "/admin/api/identity/catalog/processes/archive",
      body: {
        profile: WORKSPACE_PROCESS_PROFILE,
        type: "archive",
        ...target,
        id: "TEST-process",
        revision: 4,
      },
    },
  ]);
});

test("a refused or mismatched delete is an error, never a silent success", async (t) => {
  const responses = [
    Response.json({ error: "process_conflict" }, { status: 409 }),
    Response.json({
      profile: WORKSPACE_PROCESS_PROFILE,
      id: "TEST-other",
      archivedAt: "2026-10-16T10:00:00.000Z",
    }),
  ];
  t.mock.method(globalThis, "fetch", async () => responses.shift()!);
  await assert.rejects(
    archivePersonalProcess(target, { id: "TEST-process", revision: 1 }),
    (error) => error instanceof ApiError && error.code === "process_conflict",
  );
  await assert.rejects(
    archivePersonalProcess(target, { id: "TEST-process", revision: 1 }),
    SyntaxError,
  );
});
