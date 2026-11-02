import assert from "node:assert/strict";
import { test } from "node:test";
import { emptyDesignBrief } from "../packages/protocol/process-design";
import type { ProcessLayout } from "../packages/protocol/service-processes";
import { IdentityError } from "../apps/server-identity/error";
import { processDigest } from "../apps/server-identity/process-validation";
import { sameProcessDefinition } from "../apps/server-admin/web/lib/service-process-overview";
import {
  designFixture,
  designTarget as target,
  designActor as actor,
} from "./helpers/process-design";

const code = (expected: string) => (error: unknown) =>
  error instanceof IdentityError && error.code === expected;
const brief = () => ({ ...emptyDesignBrief(), purpose: "TEST lookup" });
const moved: ProcessLayout = {
  positions: { lookup: { x: 240, y: 48 }, done: { x: 480, y: 48 } },
  notes: [{ id: "note1", x: 0, y: 192, text: "Ask TEST finance first" }],
};

/** A process with a frozen version 1 and an open edit session. */
function frozenProcess() {
  const h = designFixture();
  const first = h.store.start(actor, {
    ...target,
    requestId: "TEST-start-new",
    serviceId: h.serviceId,
  });
  h.store.update(actor, {
    ...target,
    sessionId: first.sessionId,
    requestId: "TEST-propose",
    revision: 1,
    brief: brief(),
    candidate: h.workflow(),
  });
  const proposed = h.store.get(actor, first.sessionId);
  const { processId } = h.store.accept(actor, {
    ...target,
    sessionId: first.sessionId,
    requestId: "TEST-accept-new",
    revision: proposed.revision,
    reviewDigest: proposed.reviewDigest,
  });
  const record = h.registry.getOwned(actor, processId!);
  const version = h.registry.freezeDraft(actor, processId!, record.revision);
  const edit = h.store.start(actor, {
    ...target,
    requestId: "TEST-start-edit",
    serviceId: h.serviceId,
    processId: processId!,
  });
  return { h, processId: processId!, version, sessionId: edit.sessionId };
}

test("moving steps and adding a note keeps every digest equal", () => {
  const { h, processId, version, sessionId } = frozenProcess();
  try {
    const before = h.store.get(actor, sessionId);
    const draftBefore = h.registry.getOwned(actor, processId);
    assert.equal(before.layout, null);
    assert.equal(before.layoutRevision, 0);

    const saved = h.store.layout(actor, {
      ...target,
      sessionId,
      layoutRevision: 0,
      layout: moved,
    });
    assert.deepEqual(saved, { sessionId, layoutRevision: 1, layout: moved });

    // Review digest, proposal revision and acknowledgments are untouched.
    const after = h.store.get(actor, sessionId);
    assert.equal(after.reviewDigest, before.reviewDigest);
    assert.equal(after.revision, before.revision);
    assert.equal(after.updatedAt, before.updatedAt);
    assert.deepEqual(after.candidate, before.candidate);
    assert.deepEqual(after.layout, moved);

    // Accepting only a new arrangement leaves the definition as it was.
    const accepted = h.store.accept(actor, {
      ...target,
      sessionId,
      requestId: "TEST-accept-layout",
      revision: after.revision,
      reviewDigest: after.reviewDigest,
    });
    assert.equal(accepted.processId, processId);
    const draft = h.registry.getOwned(actor, processId);
    assert.deepEqual(draft.layout, moved);
    assert.equal(processDigest(draft.draft), processDigest(draftBefore.draft));
    // "Changed since active" on the server and in the console.
    assert.equal(processDigest(draft.draft), processDigest(version.definition));
    assert.ok(sameProcessDefinition(draft.draft, version.definition));

    // Freezing again reuses version 1 with the same artifact digest: no
    // new version, so nothing needs a new test.
    const again = h.registry.freezeDraft(actor, processId, draft.revision);
    assert.equal(again.version, version.version);
    assert.equal(again.digest, version.digest);
    assert.equal(h.registry.getOwned(actor, processId).latestVersion, 1);
    assert.deepEqual(
      h.registry.validateOwner(
        actor,
        { type: "service", serviceId: h.serviceId },
        draft.draft,
      ).sources,
      version.sources,
    );
    // Version 1 keeps the arrangement it was frozen with (none).
    assert.equal(h.registry.versionLayout(actor, processId, 1), null);
  } finally {
    h.db.close();
  }
});

test("a lost layout response is answered again; a newer one conflicts", () => {
  const { h, sessionId } = frozenProcess();
  try {
    const input = { ...target, sessionId, layoutRevision: 0, layout: moved };
    h.store.layout(actor, input);
    // The same layout sent again with the old revision: the stored state.
    assert.deepEqual(h.store.layout(actor, input), {
      sessionId,
      layoutRevision: 1,
      layout: moved,
    });
    assert.throws(
      () =>
        h.store.layout(actor, {
          ...input,
          layout: { positions: {}, notes: [] },
        }),
      code("process_design_layout_conflict"),
    );
    // Notes go through the same credential guard as the proposal.
    assert.throws(
      () =>
        h.store.layout(actor, {
          ...input,
          layoutRevision: 1,
          layout: {
            positions: {},
            notes: [
              {
                id: "note1",
                x: 0,
                y: 0,
                text: "Bearer abcdefghijklmnopqrstuvwxyz",
              },
            ],
          },
        }),
      code("process_design_sensitive_content"),
    );
  } finally {
    h.db.close();
  }
});

test("a changed definition freezes a new version that keeps its arrangement", () => {
  const { h, processId, sessionId } = frozenProcess();
  try {
    const review = h.store.get(actor, sessionId);
    const changed = { ...h.workflow(), description: "TEST changed" };
    h.store.update(actor, {
      ...target,
      sessionId,
      requestId: "TEST-change",
      revision: review.revision,
      brief: brief(),
      candidate: changed,
    });
    // A position of a step the definition doesn't have is dropped on accept.
    h.store.layout(actor, {
      ...target,
      sessionId,
      layoutRevision: 0,
      layout: {
        ...moved,
        positions: { ...moved.positions, gone: { x: 1, y: 1 } },
      },
    });
    const ready = h.store.get(actor, sessionId);
    h.store.accept(actor, {
      ...target,
      sessionId,
      requestId: "TEST-accept-change",
      revision: ready.revision,
      reviewDigest: ready.reviewDigest,
    });
    const draft = h.registry.getOwned(actor, processId);
    assert.deepEqual(draft.layout, moved);
    const version = h.registry.freezeDraft(actor, processId, draft.revision);
    assert.equal(version.version, 2);
    assert.equal(
      version.digest,
      processDigest({
        definition: version.definition,
        sources: version.sources,
      }),
    );
    assert.deepEqual(h.registry.versionLayout(actor, processId, 2), moved);
    // A frozen version's arrangement is immutable.
    assert.throws(() =>
      h.db
        .prepare(
          "UPDATE agent_service_process_layout SET layout='{}' WHERE process_id=? AND version=2",
        )
        .run(processId),
    );
    // Accepted sessions take no more layout writes.
    assert.throws(
      () =>
        h.store.layout(actor, {
          ...target,
          sessionId,
          layoutRevision: 1,
          layout: moved,
        }),
      code("process_design_conflict"),
    );
  } finally {
    h.db.close();
  }
});
