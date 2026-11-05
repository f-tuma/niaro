import assert from "node:assert/strict";
import { test } from "node:test";
import { AnswerReceiptPageSchema } from "../packages/protocol/answer-receipts";
import { ChatPresetsSchema } from "../packages/protocol/model-policy";
import type { StoredInvocation } from "../apps/server-identity/service-catalog";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";
import { storedTurn } from "./helpers/answer-receipts";

test(
  "the app reads its answers' receipts and the presets it may pick, only its own and only what it can open",
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const ok = (response: { status: number; data: unknown }) => {
        assert.equal(response.status, 200, JSON.stringify(response.data));
        return response.data;
      };
      const { organizationId, workspaceId } = h.target;
      const store = h.identity["catalog"].store;
      const member = await h.pair("member");
      const owner = await h.pair("owner");

      // Presets: off by default, then the ones the workspace offers by name.
      assert.equal((await h.mobile(undefined, "chat-presets")).status, 401);
      assert.equal((await h.mobile(member, "chat-presets?x=1")).status, 400);
      assert.deepEqual(
        ChatPresetsSchema.parse(ok(await h.mobile(member, "chat-presets")))
          .presets,
        [],
      );
      const policies = store.modelPolicies(organizationId, workspaceId);
      await h.catalog({
        type: "saveOrganizationModelPolicy",
        revision: policies.organization.revision,
        policy: {
          ...policies.organization.policy,
          tiers: [{ id: "fast", name: "TEST fast tier", models: [h.modelId] }],
        },
      });
      await h.catalog({
        type: "saveWorkspaceModelPolicy",
        revision: policies.workspace.revision,
        policy: {
          ...policies.workspace.policy,
          options: {
            ...policies.workspace.policy.options,
            presets: {
              enabled: true,
              items: [{ id: "quick", name: "Quick", tier: "fast" }],
            },
          },
        },
      });
      const offered = ChatPresetsSchema.parse(
        ok(await h.mobile(member, "chat-presets")),
      );
      assert.equal(offered.workspaceId, workspaceId);
      // Members see the preset's name, never its tier or models.
      assert.deepEqual(offered.presets, [{ id: "quick", name: "Quick" }]);

      // Receipts: the chat must be named, and an empty chat has none.
      const anonymous = await h.mobile(
        undefined,
        "receipts?conversationId=TEST-chat",
      );
      assert.equal(anonymous.status, 401, JSON.stringify(anonymous.data));
      assert.equal((await h.mobile(member, "receipts")).status, 400);
      assert.equal(
        (await h.mobile(member, "receipts?conversationId=TEST-chat&x=1"))
          .status,
        400,
      );
      assert.deepEqual(
        AnswerReceiptPageSchema.parse(
          ok(await h.mobile(member, "receipts?conversationId=TEST-chat")),
        ).receipts,
        [],
      );

      // A finished turn of the member's, as the server records it.
      const memberId = member.scope.userId;
      const invocation = (
        id: string,
        userId: string,
        extra: Partial<StoredInvocation> = {},
      ): StoredInvocation => ({
        id,
        organizationId,
        workspaceId,
        userId,
        serviceId: h.serviceId,
        actionId: h.actionId,
        serviceRevision: 1,
        actionRevision: 1,
        policyRevision: 1,
        input: {},
        status: "succeeded",
        title: "TEST read contacts",
        serviceName: "TEST CRM",
        effect: "read",
        ...extra,
      });
      store.saveInvocation(invocation("TEST-op-read", memberId));
      store.saveInvocation(
        invocation("TEST-op-waiting", memberId, {
          status: "awaiting_approval",
          effect: "write",
          title: "TEST waiting write",
        }),
      );
      const turn = storedTurn("TEST-command-1", "TEST-chat", {
        operations: ["TEST-op-read", "TEST-op-waiting"],
        replyBasis: { items: ["TEST-memory-that-does-not-exist"] },
        meetingReads: ["11111111-2222-4333-8444-555555555555"],
        answerModel: {
          modelId: h.modelId,
          role: "preset:quick",
          reason: "primary",
        },
        preset: { id: "quick", name: "Quick" },
      });
      store.saveTurn(turn.runId, workspaceId, memberId, turn);
      // The owner's turn in a chat with the same id is never the member's.
      const other = storedTurn("TEST-command-owner", "TEST-chat", {
        operations: [],
        answerModel: { modelId: h.modelId, role: "chat", reason: "primary" },
      });
      store.saveTurn(other.runId, workspaceId, owner.scope.userId, other);

      const page = AnswerReceiptPageSchema.parse(
        ok(await h.mobile(member, "receipts?conversationId=TEST-chat")),
      );
      assert.equal(page.conversationId, "TEST-chat");
      assert.deepEqual(
        page.receipts.map((receipt) => receipt.commandId),
        ["TEST-command-1"],
      );
      const [receipt] = page.receipts;
      assert.deepEqual(
        receipt?.read.map((item) => [item.title, item.detail]),
        [["TEST read contacts", "TEST CRM"]],
      );
      // A waiting approval is no change; unknown memories and meetings stay out.
      assert.deepEqual(receipt?.changed, []);
      assert.deepEqual(receipt?.memories, []);
      assert.deepEqual(receipt?.meetings, []);
      // The model by the administrator's name, with the picked preset.
      assert.deepEqual(receipt?.model, { name: "TEST tools model" });
      assert.deepEqual(receipt?.preset, { id: "quick", name: "Quick" });
      assert.doesNotMatch(JSON.stringify(page), /TEST-tools/);

      // Once the member may no longer use the action, its read is left out.
      const service = store.service(workspaceId, h.serviceId);
      const action = service.actions.find((item) => item.id === h.actionId)!;
      const {
        id: _id,
        revision: _revision,
        sourceKey: _key,
        ...settings
      } = action;
      await h.catalog({
        type: "saveAction",
        id: h.actionId,
        serviceId: h.serviceId,
        serviceRevision: service.revision,
        revision: action.revision,
        settings: {
          ...settings,
          policy: { roles: ["owner", "admin"], users: [] },
        },
      });
      const write = store
        .service(workspaceId, h.serviceId)
        .actions.find((item) => item.id === h.writeId)!;
      const {
        id: _wid,
        revision: _wrevision,
        sourceKey: _wkey,
        ...writeSettings
      } = write;
      await h.catalog({
        type: "saveAction",
        id: h.writeId,
        serviceId: h.serviceId,
        serviceRevision: store.service(workspaceId, h.serviceId).revision,
        revision: write.revision,
        settings: {
          ...writeSettings,
          policy: { roles: ["owner", "admin"], users: [] },
        },
      });
      const revoked = AnswerReceiptPageSchema.parse(
        ok(await h.mobile(member, "receipts?conversationId=TEST-chat")),
      );
      assert.deepEqual(revoked.receipts[0]?.read, []);
      assert.deepEqual(h.dispatches, []);
    } finally {
      await h.close();
    }
  },
);
