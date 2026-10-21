import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
  reviseProposal,
} from "../packages/client-core/commands";
import {
  fromSnapshot,
  selectTasks,
  selectConversationWork,
} from "../packages/client-core/store";
import { ActionProposalSchema, SnapshotSchema } from "../packages/protocol";

function prepared() {
  let now = Date.UTC(2026, 8, 24, 9);
  const engine = new FixtureEngine("a", undefined, undefined, () => now);
  const advance = (ms = 4000) => {
    now += ms;
    engine.tick();
  };
  engine.execute(messageCommand("Choose Peter", "en", "start"));
  engine.execute(
    answerCommand(engine.snapshot().inputRequests[0]!, "peter-novak", "answer"),
  );
  advance();
  return {
    engine,
    advance,
    proposal: () => engine.snapshot().actionProposals[0]!,
  };
}
test("input resolution only proposes; exact approval produces one pending operation and separate completion", () => {
  const { engine: e, advance, proposal } = prepared();
  const s = e.snapshot();
  expect(s.operations).toHaveLength(0);
  expect(s.workItems[0]?.status).toBe("waiting_approval");
  const store = fromSnapshot("a", s.scope, s);
  expect(selectTasks(store, "needsInput")[0]).toBe(
    selectConversationWork(store, "conversation-1")[0],
  );
  const p = proposal();
  const command = proposalDecision(p, "approve", "approve-1");
  const accepted = e.execute(command);
  expect(accepted.snapshot.operations[0]).toMatchObject({
    status: "pending",
    acceptedProposalRevision: p.revision,
    parameters: p.parameters,
  });
  const cursor = e.snapshot().cursor;
  expect(e.execute(command).status).toBe("accepted");
  expect(e.snapshot().cursor).toBe(cursor);
  expect(e.execute(proposalDecision(p, "approve", "second-click")).status).toBe(
    "conflict",
  );
  expect(
    e.execute(proposalDecision(proposal(), "approve", "new-current-click"))
      .status,
  ).toBe("conflict");
  expect(e.snapshot().operations).toHaveLength(1);
  advance();
  expect(e.snapshot().operations[0]?.status).toBe("executing");
  expect(e.snapshot().workItems[0]?.status).toBe("running");
  advance();
  expect(e.snapshot().operations[0]?.result?.kind).toBe("simulated");
  expect(e.snapshot().workItems[0]?.status).toBe("succeeded");
});
test("changed participant and time invalidate an old confirmation, including after server restart", () => {
  const { engine: e, proposal } = prepared();
  const before = proposal();
  e.execute(
    reviseProposal(before, "peter-svoboda", "2026-10-01T15:00:00.000Z", "edit"),
  );
  const restored = new FixtureEngine("a", structuredClone(e.data));
  expect(
    restored.execute(proposalDecision(before, "approve", "stale")),
  ).toMatchObject({ status: "conflict", code: "revision_conflict" });
  expect(restored.snapshot().operations).toHaveLength(0);
  const current = restored.snapshot().actionProposals[0]!;
  expect(current.parameters.participant.id).toBe("peter-svoboda");
  expect(current.parameters.startsAt).toBe("2026-10-01T15:00:00.000Z");
});
test("editing an approved pending proposal cancels its attempt; fresh approval alone can run the new details", () => {
  const { engine: e, advance, proposal } = prepared();
  e.execute(proposalDecision(proposal(), "approve", "approve"));
  const old = e.snapshot().operations[0]!;
  e.execute(
    reviseProposal(
      proposal(),
      "peter-svoboda",
      "2026-10-02T10:00:00.000Z",
      "edit",
    ),
  );
  expect(e.snapshot().operations[0]).toMatchObject({
    status: "cancelled",
    parameters: old.parameters,
  });
  expect(proposal().approval).toBeUndefined();
  advance(10_000);
  expect(e.snapshot().workItems[0]?.status).toBe("waiting_approval");
  e.execute(proposalDecision(proposal(), "approve", "new-approval"));
  advance();
  advance();
  expect(e.snapshot().operations.map((o) => o.status)).toEqual([
    "cancelled",
    "succeeded",
  ]);
  expect(e.snapshot().operations[1]?.parameters.participant.id).toBe(
    "peter-svoboda",
  );
});
test("already executing effects cannot be silently edited or revoked", () => {
  const { engine: e, advance, proposal } = prepared();
  e.execute(proposalDecision(proposal(), "approve", "approve"));
  advance();
  const before = e.snapshot();
  expect(
    e.execute(
      reviseProposal(
        proposal(),
        "peter-svoboda",
        "2026-10-03T10:00:00.000Z",
        "late-edit",
      ),
    ).code,
  ).toBe("operation_in_progress");
  expect(
    e.execute(proposalDecision(proposal(), "reject", "late-reject")).code,
  ).toBe("operation_in_progress");
  expect(e.snapshot().actionProposals).toEqual(before.actionProposals);
  expect(e.snapshot().operations).toEqual(before.operations);
});
test("reject, ambiguous yes, foreign context and invalid changes create no operation", () => {
  const { engine: e, proposal } = prepared();
  expect(e.execute(messageCommand("yes", "en", "yes")).status).toBe("rejected");
  expect(
    e.execute(
      proposalDecision(
        { ...proposal(), workItemId: "foreign" },
        "approve",
        "foreign",
      ),
    ).code,
  ).toBe("unknown_context");
  expect(
    e.execute(
      reviseProposal(
        proposal(),
        "unknown",
        "2026-10-03T10:00:00.000Z",
        "unknown-contact",
      ),
    ).code,
  ).toBe("invalid_proposal");
  expect(
    e.execute(
      reviseProposal(
        proposal(),
        "peter-novak",
        "2000-01-01T00:00:00.000Z",
        "past",
      ),
    ).code,
  ).toBe("invalid_proposal");
  e.execute(proposalDecision(proposal(), "reject", "reject"));
  expect(e.snapshot().workItems[0]?.status).toBe("cancelled");
  expect(e.snapshot().operations).toHaveLength(0);
});
test("approval persistence failure rolls back operation, consent and receipt together", () => {
  const { engine: e, proposal } = prepared();
  const broken = new FixtureEngine("a", structuredClone(e.data), () => {
    throw Error("disk full");
  });
  const before = broken.snapshot();
  expect(() =>
    broken.execute(proposalDecision(proposal(), "approve", "approve")),
  ).toThrow("disk full");
  expect(broken.snapshot()).toEqual(before);
  expect(
    broken.data.receipts.some((r) => r.command.commandId === "approve"),
  ).toBe(false);
});
test("operation persists across worker restart and runs once", () => {
  const { engine: e, proposal } = prepared();
  const approve = proposalDecision(proposal(), "approve", "approve");
  e.execute(approve);
  const restored = new FixtureEngine(
    "a",
    structuredClone(e.data),
    undefined,
    () => Date.UTC(2026, 8, 25),
  );
  restored.tick();
  const executing = structuredClone(restored.data);
  const completed = new FixtureEngine("a", executing, undefined, () =>
    Date.UTC(2026, 8, 26),
  );
  completed.tick();
  expect(completed.execute(approve).status).toBe("accepted");
  completed.tick();
  expect(completed.snapshot().operations).toHaveLength(1);
  expect(completed.snapshot().operations[0]?.status).toBe("succeeded");
});
test("strict action catalog and snapshot reject injected approval and mismatched operation parameters", () => {
  const { engine: e, proposal } = prepared();
  expect(
    ActionProposalSchema.safeParse({ ...proposal(), style: { color: "red" } })
      .success,
  ).toBe(false);
  expect(
    ActionProposalSchema.safeParse({ ...proposal(), status: "approved" })
      .success,
  ).toBe(false);
  e.execute(proposalDecision(proposal(), "approve", "approve"));
  const snapshot = e.snapshot();
  snapshot.operations[0]!.parameters.participant.label = "Someone else";
  expect(SnapshotSchema.safeParse(snapshot).success).toBe(false);
});
test("version 1 data preserves contacts, receipts and pending work while upgrading to proposal flow", () => {
  let clock = Date.UTC(2026, 8, 24);
  const e = new FixtureEngine("a", undefined, undefined, () => clock);
  e.execute(messageCommand("Choose Peter", "en", "old-start"));
  const answer = answerCommand(
    e.snapshot().inputRequests[0]!,
    "peter-novak",
    "old-answer",
  );
  e.execute(answer);
  const strip = (w: object) => {
    const copy = { ...w } as Record<string, unknown>;
    delete copy.actionProposalIds;
    delete copy.operationIds;
    return copy;
  };
  const data = e.data;
  const legacy = {
    // A historical v1 envelope cannot contain current v2 context dictionaries.
    eventFloor: 0,
    receipts: data.receipts,
    nextWork: data.nextWork,
    version: 1,
    snapshot: {
      profile: "agent-client/0.1-fixture",
      scope: data.snapshot.scope,
      cursor: data.snapshot.cursor,
      conversations: data.snapshot.conversations,
      workItems: data.snapshot.workItems.map(strip),
      inputRequests: data.snapshot.inputRequests,
    },
    events: data.events.map((event) =>
      event.type === "work_item.upserted"
        ? { ...event, entity: strip(event.entity) }
        : event,
    ),
    pending: data.pending.map((p) => ({
      workItemId: p.workItemId,
      dueAt: p.dueAt,
    })),
  };
  clock += 5000;
  const restored = new FixtureEngine("a", legacy, undefined, () => clock);
  expect(restored.execute(answer).status).toBe("accepted");
  restored.tick();
  expect(restored.data.version).toBe(2);
  expect(
    restored.snapshot().inputRequests[0]?.resolution?.selectedContactId,
  ).toBe("peter-novak");
  expect(restored.snapshot().actionProposals).toHaveLength(1);
  expect(restored.snapshot().operations).toHaveLength(0);
});

test("a worker tick never discards another job that becomes due during processing", () => {
  const base = Date.UTC(2026, 8, 24);
  let now = base;
  const e = new FixtureEngine("a", undefined, undefined, () => now);
  for (const n of [1, 2]) {
    e.execute(messageCommand("Choose Peter", "en", `start-${n}`));
    e.execute(
      answerCommand(
        e.snapshot().inputRequests[n - 1]!,
        "peter-novak",
        `answer-${n}`,
      ),
    );
    now++;
  }
  let calls = 0;
  const restored = new FixtureEngine(
    "a",
    structuredClone(e.data),
    undefined,
    () => base + 4000 + calls++,
  );
  restored.tick();
  expect(restored.snapshot().actionProposals).toHaveLength(1);
  expect(restored.data.pending).toHaveLength(1);
  restored.tick();
  expect(restored.snapshot().actionProposals).toHaveLength(2);
});

test("a snapshot cannot attach an active operation to an unapproved proposal", () => {
  const { engine: e, proposal } = prepared();
  e.execute(proposalDecision(proposal(), "approve", "approve"));
  const snapshot = e.snapshot();
  snapshot.actionProposals[0]!.status = "awaiting_approval";
  delete snapshot.actionProposals[0]!.approval;
  expect(SnapshotSchema.safeParse(snapshot).success).toBe(false);
});
