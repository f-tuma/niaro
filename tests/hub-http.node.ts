import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HUB_PROFILE,
  HUB_PROFILE_V2,
  HUB_PROFILE_V3,
  HubDashboardSchema,
  HubViewSchema,
  hubConversationId,
  type HubView,
} from "../packages/protocol/hub";
import { ProcessDefinitionSchema } from "../packages/protocol/service-processes";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { ClientSession } from "../packages/client-core/session";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { processObject } from "./helpers/service-process";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test(
  "a member shapes their hub over the app API and a refresh runs the ordinary start in the item's chat",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const member = await h.pair("member");
      const admin = await h.pair("admin");
      const hub = (credential: typeof member | undefined, body?: unknown) =>
        h.mobile(credential, "hub?language=cs", body);
      const parse = (response: { status: number; data: unknown }) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return HubViewSchema.parse(response.data);
      };
      assert.equal((await hub(undefined)).status, 401);
      assert.equal(
        (await h.mobile(member, "hub?language=cs&extra=1")).status,
        400,
      );
      let view = parse(await hub(member));
      assert.deepEqual(view.scope, member.scope);
      assert.deepEqual(
        view.items.map((item) => [item.kind, item.title]),
        [["tasks", "Úkoly"]],
      );

      const base = h.workflow();
      const day = h.activate(
        ProcessDefinitionSchema.parse({
          ...base,
          name: "TEST Můj den",
          inputSchema: processObject({}),
          outputSchema: processObject({
            summary: { type: "string" },
            count: { type: "number" },
          }),
          entry: "done",
          steps: [
            {
              id: "done",
              type: "return",
              output: {
                summary: { source: "literal", value: "TEST tři schůzky" },
                count: { source: "literal", value: 3 },
              },
            },
          ],
        }),
      );
      const needsInput = h.activate(base);
      const refused = await hub(member, {
        profile: HUB_PROFILE,
        type: "add",
        kind: "process",
        processId: needsInput.processId,
      });
      assert.equal(refused.status, 409);
      assert.deepEqual(refused.data, { error: "hub_process_needs_input" });
      const unknown = await hub(member, {
        profile: HUB_PROFILE,
        type: "add",
        kind: "process",
        processId: "TEST-not-a-process",
      });
      assert.equal(unknown.status, 404);
      assert.equal(
        (await hub(member, { profile: HUB_PROFILE, type: "unknown" })).status,
        400,
      );

      view = parse(
        await hub(member, {
          profile: HUB_PROFILE,
          type: "add",
          kind: "process",
          processId: day.processId,
        }),
      );
      const item = view.items.find((value) => value.kind === "process")!;
      assert.equal(item.title, "TEST Můj den");
      assert.equal(item.result?.status, "running");
      const settled = async (): Promise<HubView> => {
        for (let i = 0; i < 200; i++) {
          const current = parse(await hub(member));
          const status = current.items.find((value) => value.id === item.id)
            ?.result?.status;
          if (status !== "running") return current;
          await sleep(100);
        }
        assert.fail("hub refresh did not settle");
      };
      view = await settled();
      const result = view.items.find((value) => value.id === item.id)!.result!;
      assert.equal(result.status, "succeeded", JSON.stringify(result));
      assert.equal(result.output?.text, "TEST tři schůzky");
      assert.deepEqual(result.output?.fields, [{ label: "Count", value: "3" }]);
      assert.equal(result.conversationId, hubConversationId(item.id));
      assert(result.producedAt);
      assert.equal(
        view.items.find((value) => value.id === item.id)!.stale,
        false,
      );

      // agent-hub/2: the same item as a widget, its view checked over HTTP.
      const dashboard = async (body?: unknown) => {
        const response = await h.mobile(
          member,
          `hub?language=cs&profile=${encodeURIComponent(HUB_PROFILE_V2)}`,
          body,
        );
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return HubDashboardSchema.parse(response.data);
      };
      assert.equal(
        (await h.mobile(member, "hub?language=cs&profile=agent-hub%2F9"))
          .status,
        400,
      );
      let widget = (await dashboard()).items.find(
        (value) => value.id === item.id,
      )!;
      assert.deepEqual(widget.view, { type: "summary" });
      assert.deepEqual(
        widget.fields?.map((field) => [field.key, field.type]),
        [
          ["summary", "string"],
          ["count", "number"],
        ],
      );
      widget = (
        await dashboard({
          profile: HUB_PROFILE_V2,
          type: "setView",
          itemId: item.id,
          view: { type: "number", field: "count", label: "TEST schůzky" },
        })
      ).items.find((value) => value.id === item.id)!;
      assert.deepEqual(widget.data, { type: "number", value: 3 });
      const invalid = await h.mobile(
        member,
        `hub?language=cs&profile=${encodeURIComponent(HUB_PROFILE_V2)}`,
        {
          profile: HUB_PROFILE_V2,
          type: "setView",
          itemId: item.id,
          view: { type: "number", field: "summary" },
        },
      );
      assert.equal(invalid.status, 409);
      assert.deepEqual(invalid.data, { error: "hub_view_invalid" });

      // The refresh is an ordinary run of that process, followed in the item's chat.
      const run = await h.mobile(
        member,
        `processes/runs${h.suffix}&parentRunId=${result.runId}`,
      );
      assert.equal(run.status, 200, JSON.stringify(run.data));
      const runtime = ProcessRuntimeResponseSchema.parse(run.data);
      assert.equal(runtime.admission.processId, day.processId);
      assert.equal(runtime.admission.origin.type, "command");
      assert.equal(
        runtime.admission.origin.conversationId,
        hubConversationId(item.id),
      );
      assert.equal(runtime.process?.status, "succeeded");

      // A second explicit refresh reuses the same chat.
      parse(
        await hub(member, {
          profile: HUB_PROFILE,
          type: "refresh",
          itemIds: [item.id],
        }),
      );
      view = await settled();
      const second = view.items.find((value) => value.id === item.id)!.result!;
      assert.equal(second.status, "succeeded");
      assert.notEqual(second.runId, result.runId);
      assert.equal(second.conversationId, result.conversationId);

      // Another person has their own hub and cannot touch this one.
      const theirs = parse(await hub(admin));
      assert.deepEqual(
        theirs.items.map((value) => value.kind),
        ["tasks"],
      );
      const foreign = await hub(admin, {
        profile: HUB_PROFILE,
        type: "refresh",
        itemIds: [item.id],
      });
      assert.equal(foreign.status, 404);
      parse(
        await hub(admin, {
          profile: HUB_PROFILE,
          type: "remove",
          itemId: item.id,
        }),
      );
      assert(
        parse(await hub(member)).items.some((value) => value.id === item.id),
      );

      // Refreshes never built the ordinary chat runtime.
      assert.equal(h.ordinaryRuntimeCalls(), 0);
      view = parse(
        await hub(member, {
          profile: HUB_PROFILE,
          type: "remove",
          itemId: item.id,
        }),
      );
      assert.deepEqual(
        view.items.map((value) => value.kind),
        ["tasks"],
      );
      // Nothing reached a business service.
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);

test(
  "a process the person can no longer run fails its refresh with a short reason; the app session reads the same hub",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
    try {
      const member = await h.pair("member");
      const hub = (body?: unknown) => h.mobile(member, "hub?language=en", body);
      const base = h.workflow();
      const day = h.activate(
        ProcessDefinitionSchema.parse({
          ...base,
          inputSchema: processObject({}),
          outputSchema: processObject({ summary: { type: "string" } }),
          entry: "done",
          steps: [
            {
              id: "done",
              type: "return",
              output: { summary: { source: "literal", value: "TEST" } },
            },
          ],
        }),
      );
      const added = HubViewSchema.parse(
        (
          await hub({
            profile: HUB_PROFILE,
            type: "add",
            kind: "process",
            processId: day.processId,
          })
        ).data,
      );
      const item = added.items.find((value) => value.kind === "process")!;
      for (let i = 0; i < 200; i++) {
        const current = HubViewSchema.parse((await hub()).data);
        if (
          current.items.find((value) => value.id === item.id)?.result
            ?.status !== "running"
        )
          break;
        await sleep(100);
      }
      // The process stops being available to the person (deactivated).
      const registry = h.identity["processes"];
      h.identity["db"]
        .prepare(
          "UPDATE agent_service_process SET active_version=NULL WHERE id=?",
        )
        .run(day.processId);
      assert.equal(
        registry
          .executionInventory(
            {
              organizationId: h.target.organizationId,
              workspaceId: h.target.workspaceId,
              userId: member.scope.userId,
              role: "member",
            },
            member.scope,
          )
          .processes.some((entry) => entry.processId === day.processId),
        false,
      );
      HubViewSchema.parse(
        (
          await hub({
            profile: HUB_PROFILE,
            type: "refresh",
            itemIds: [item.id],
          })
        ).data,
      );
      let result;
      for (let i = 0; i < 200; i++) {
        result = HubViewSchema.parse((await hub()).data).items.find(
          (value) => value.id === item.id,
        )!.result!;
        if (result.status !== "running") break;
        await sleep(100);
      }
      assert.equal(result?.status, "failed");
      assert.equal(result?.error, "hub_process_unavailable");
      // The last good output stays visible.
      assert.equal(result?.output?.text, "TEST");
      // The web app's ClientSession reads and changes the same hub.
      const session = new ClientSession(
        h.origin + "/v1/" + member.scope.workspaceId,
        { getItem: async () => null, setItem: async () => {} },
        member,
        (url, init) => fetch(url, init),
        undefined,
        undefined,
        false,
        { processOutputs: true },
      );
      try {
        await session.start(false);
        const read = await session.readHub("cs");
        assert.equal(read.items.length, 2);
        // The web app reads the dashboard profile.
        assert.equal(read.profile, HUB_PROFILE_V3);
        const changed = await session.sendHubCommand("cs", {
          profile: HUB_PROFILE_V3,
          type: "reorder",
          itemIds: [item.id, read.items[0]!.id],
        });
        assert.deepEqual(
          changed.items.map((value) => value.kind),
          ["process", "tasks"],
        );
        await assert.rejects(
          session.sendHubCommand("cs", {
            profile: HUB_PROFILE_V3,
            type: "reorder",
            itemIds: [item.id],
          }),
          /hub_changed/,
        );
      } finally {
        session.stop();
      }
    } finally {
      await h.close();
    }
  },
);
