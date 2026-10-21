import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { createDrainCatalogRuntime } from "../apps/server-identity/catalog-runtime-legacy";
import { createTrustHarness } from "./agent-trust/harness";

// Produce authentic pre-Mastra journal bytes with the retained historical
// runtime, then route every continuation/replay through the current catalog
// entry point. This is a catalog-router regression, not paired HTTP acceptance.
for (const outcome of ["succeeded", "rejected", "unknown"] as const) {
  test(`current catalog router drains an authentic historical approval to ${outcome} without migrating or repeating its effect`, async () => {
    const h = createTrustHarness();
    const commandId = "TEST-historical-" + outcome;
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          h.scope.serverId,
          h.scope.workspaceId,
          h.scope.userId,
          commandId,
        ]),
      )
      .digest("hex");
    try {
      h.onChat(h.writeScript);
      const historical = createDrainCatalogRuntime(
        h.controller,
        h.controller.transport,
        h.context,
        h.scope,
        h.target.organizationId,
        true,
      );
      const pending = await historical.message(
        commandId,
        "Create a TEST meeting",
        "en",
        [],
        new AbortController().signal,
      );
      assert.equal(pending?.result?.status, "awaiting_approval");
      const operationId = pending!.result!.operationId;
      const before = h.catalog.turn(
        key,
        h.scope.workspaceId,
        h.scope.userId,
      ) as { kind: string };
      assert.equal(before.kind, "agent-1");
      assert.equal(h.network.length, 0);
      if (outcome === "unknown") h.writeResponse = "lost";
      const answer = await h
        .runtime()
        .resolve(
          operationId,
          outcome !== "rejected",
          "en",
          new AbortController().signal,
        );
      if (outcome === "rejected") {
        assert.equal(
          answer.result,
          undefined,
          "Historical rejected turns used a plain reply, not a native result envelope",
        );
        assert.match(answer.reply, /cancelled/i);
      } else assert.equal(answer.result?.status, outcome);
      const receipt = structuredClone(
        h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId),
      );
      assert.equal(receipt?.status, outcome);
      assert.equal(
        (
          h.catalog.turn(key, h.scope.workspaceId, h.scope.userId) as {
            kind: string;
          }
        ).kind,
        "agent-1",
      );
      assert.equal(h.network.length, outcome === "rejected" ? 0 : 1);
      const models = h.requests.length;
      const replay = await h
        .runtime()
        .message(
          commandId,
          "Create a TEST meeting",
          "en",
          [],
          new AbortController().signal,
        );
      if (outcome === "rejected") assert.equal(replay?.reply, answer.reply);
      else {
        assert.equal(replay?.result?.operationId, operationId);
        assert.equal(replay?.result?.status, outcome);
      }
      assert.deepEqual(
        h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId),
        receipt,
      );
      assert.equal(h.requests.length, models);
      assert.equal(h.network.length, outcome === "rejected" ? 0 : 1);
      h.onChat(() => ({ content: "TEST new native command" }));
      const newId = "TEST-new-after-" + outcome;
      const accepted = await h.send("TEST new native command", {
        id: newId,
        session: "new",
      });
      assert.equal(accepted.status, "accepted");
      const newKey = createHash("sha256")
        .update(
          JSON.stringify([
            h.scope.serverId,
            h.scope.workspaceId,
            h.scope.userId,
            newId,
          ]),
        )
        .digest("hex");
      assert.equal(
        (
          h.catalog.turn(newKey, h.scope.workspaceId, h.scope.userId) as {
            kind: string;
          }
        ).kind,
        "mastra-1",
      );
      assert.equal(
        (
          h.catalog.turn(key, h.scope.workspaceId, h.scope.userId) as {
            kind: string;
          }
        ).kind,
        "agent-1",
      );
      assert.deepEqual(
        h.catalog.invocation(operationId, h.scope.workspaceId, h.scope.userId),
        receipt,
      );
    } finally {
      await h.close();
    }
  });
}

test("current catalog router refuses an operation without a saved chat turn instead of draining it", async () => {
  const h = createTrustHarness();
  try {
    const actionId = h.tool("Create meeting").slice(7).replaceAll("_", "-");
    const service = h.catalog
      .inventory(h.target.organizationId, h.target.workspaceId, {
        userId: h.scope.userId,
        role: "owner",
      })
      .services.find((s) => s.actions.some((a) => a.id === actionId))!;
    const action = service.actions.find((a) => a.id === actionId)!;
    // A console invocation awaiting approval is never linked to a chat turn.
    const pending = (await h.controller.invoke(
      {
        ...h.target,
        serviceId: service.id,
        serviceRevision: service.revision,
        actionId,
        revision: action.revision,
        input: {
          body: {
            attendee: "Jane Test",
            start: "2026-10-20T09:00:00Z",
            end: "2026-10-20T09:30:00Z",
          },
        },
        requestId: "11111111-2222-4333-8444-555555555555",
        approve: false,
      },
      h.context,
      new AbortController().signal,
    )) as { id: string; status: string };
    assert.equal(pending.status, "awaiting_approval");
    await assert.rejects(
      h.runtime().resolve(pending.id, true, "en", new AbortController().signal),
      /catalog_not_found/,
    );
    assert.equal(
      h.catalog.invocation(pending.id, h.scope.workspaceId, h.scope.userId)
        ?.status,
      "awaiting_approval",
    );
    assert.equal(h.network.length, 0);
  } finally {
    await h.close();
  }
});
