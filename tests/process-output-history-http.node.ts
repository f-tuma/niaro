import assert from "node:assert/strict";
import { test } from "node:test";
import { SnapshotSchema, EventsResponseSchema } from "../packages/protocol";
import { PROCESS_OUTPUT_WORK_PROFILE } from "../packages/protocol/process-output";
import {
  PROCESS_WORK_PROFILE,
  PROCESS_QUESTION_WORK_PROFILE,
  PROCESS_APPROVAL_WORK_PROFILE,
} from "../packages/protocol/process-work";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { CONTACT_CONTEXT_TTL } from "../apps/server-identity/contact-context";
import { CARD_PROFILE } from "../packages/protocol/card-document";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

test(
  "fresh historical event delivery hides revoked output across all profiles without rewriting events or recorded actions",
  { timeout: 90000 },
  async () => {
    const h = await coordinatorHttpFixture({ allowOrdinaryRuntime: true });
    try {
      const credential = await h.pair();
      const command = await h.prepare(credential, h.activate());
      const started = await h.mobile(
        credential,
        "processes/commands" + h.suffix,
        command,
      );
      assert.equal(started.status, 202);
      const process = ProcessRuntimeResponseSchema.parse(started.data).process!;
      const query =
        "?tasks=" +
        encodeURIComponent(PROCESS_OUTPUT_WORK_PROFILE) +
        "&cards=" +
        encodeURIComponent(CARD_PROFILE);
      const before = SnapshotSchema.parse(
        (await h.mobile(credential, "snapshot" + query)).data,
      ).workItems.find((w) => w.id === process.parentRunId)!;
      assert(JSON.stringify(before.card).includes("TEST-mobile-result"));
      const originalEvents = EventsResponseSchema.parse(
        (await h.mobile(credential, "events" + query + "&after=0")).data,
      ).events;
      const catalog = h.identity["catalog"].store;
      const receipt = catalog.invocation(
        before.native!.process!.receipts[0]!.operationId,
        credential.scope.workspaceId,
        credential.scope.userId,
      )!;
      catalog.saveInvocation({
        ...receipt,
        completedAt: Date.now() - CONTACT_CONTEXT_TTL - 1,
      });
      const models = h.modelCount(),
        dispatches = [...h.dispatches];
      for (const profile of [
        PROCESS_OUTPUT_WORK_PROFILE,
        PROCESS_APPROVAL_WORK_PROFILE,
        PROCESS_QUESTION_WORK_PROFILE,
        PROCESS_WORK_PROFILE,
        undefined,
      ]) {
        const q =
          "?cards=" +
          encodeURIComponent(CARD_PROFILE) +
          (profile ? "&tasks=" + encodeURIComponent(profile) : "");
        const response = await h.mobile(credential, "events" + q + "&after=0");
        assert.equal(response.status, 200);
        const events = EventsResponseSchema.parse(response.data).events;
        assert(!JSON.stringify(events).includes("TEST-mobile-result"));
        for (const old of originalEvents) {
          const delivered = events.find((e) => e.eventId === old.eventId)!;
          assert(delivered);
          assert.equal(delivered.sequence, old.sequence);
          if (
            old.type === "work_item.upserted" &&
            delivered.type === "work_item.upserted"
          ) {
            assert.equal(delivered.entity.revision, old.entity.revision);
            assert.equal(delivered.entity.status, old.entity.status);
            assert.deepEqual(
              delivered.entity.native?.process?.receipts.map((r) => r.status),
              profile
                ? old.entity.native?.process?.receipts.map((r) => r.status)
                : undefined,
            );
          }
        }
      }
      assert.equal(h.modelCount(), models);
      assert.deepEqual(h.dispatches, dispatches);
      assert.equal(
        catalog.invocation(
          receipt.id,
          credential.scope.workspaceId,
          credential.scope.userId,
        )!.status,
        "succeeded",
      );
    } finally {
      await h.close();
    }
  },
);
