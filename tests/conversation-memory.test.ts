import { mkdtempSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import {
  DecisionSchema,
  type Decision,
  type ModelInput,
} from "../apps/fixture-server/decision";
import {
  emptyMeeting,
  MEMORY_TTL_MS,
} from "../apps/fixture-server/conversation-memory";
import {
  messageCommand,
  proposalDecision,
  reviseProposal,
  answerCommand,
} from "../packages/client-core/commands";
import { scopeFor } from "../packages/test-fixtures";
const scope = scopeFor();
const initialTime = Date.parse("2026-09-25T10:00:00Z");
const patch = (
  fields: Partial<NonNullable<Decision["patch"]>> = {},
): Decision => ({
  kind: "meeting_patch",
  contactId: null,
  title: null,
  localStart: null,
  durationMinutes: null,
  reply: null,
  patch: { ...emptyMeeting(), mode: "continue", ...fields },
});
const full = () =>
  patch({
    mode: "new",
    contactId: "peter-novak",
    contactName: "Peter Novák",
    localDate: "2026-09-26",
    localTime: "14:00",
    durationMinutes: 45,
  });
let directory: string;
let store: FixtureStorage;
let clock: number;
let decide: jest.Mock<Promise<Decision>, [ModelInput, AbortSignal]>;
let service: ModelService;
let sequence: number;
function open() {
  store = new FixtureStorage(directory, scope.serverId, () => clock);
  service = new ModelService(
    store,
    { timeZone: "Europe/Prague", decide },
    () => clock,
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "memory-test-"));
  clock = initialTime;
  sequence = 0;
  decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(async () =>
    full(),
  );
  open();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
async function send(
  decision: Decision,
  text = "synthetic request",
  id = `request-${++sequence}`,
) {
  decide.mockResolvedValueOnce(decision);
  return service.execute(
    scope,
    messageCommand(text, "cs", id),
    () => {},
    new AbortController().signal,
  );
}
const memory = () => store.modelState(scope, "Europe/Prague").activeMeeting;

test("partial facts survive turns, server restart and a bounded history without asking for known fields", async () => {
  const first = await send(
    patch({
      mode: "new",
      contactId: "peter-svoboda",
      contactName: "Peter Svoboda",
    }),
    "Připrav schůzku s Peterem Svobodou",
  );
  expect(first.snapshot.workItems).toHaveLength(0);
  expect(first.snapshot.conversations[0]!.messages.at(-1)!.text).toBe(
    "Kdy má schůzka začít?",
  );
  await send(patch({ localDate: "2026-09-26" }), "Zítra");
  store.close();
  open();
  expect(memory()?.slots).toMatchObject({
    contactId: "peter-svoboda",
    localDate: "2026-09-26",
    localTime: null,
  });
  const result = await send(
    patch({ localTime: "11:30", durationMinutes: 45 }),
    "V jedenáct třicet na 45 minut",
  );
  expect(decide.mock.calls.at(-1)![0].activeMeeting?.slots.contactId).toBe(
    "peter-svoboda",
  );
  expect(result.snapshot.actionProposals[0]!.parameters).toMatchObject({
    participant: { id: "peter-svoboda" },
    startsAt: "2026-09-26T09:30:00.000Z",
    endsAt: "2026-09-26T10:15:00.000Z",
  });
  expect(result.snapshot.operations).toHaveLength(0);
});
test("follow-up changes same proposal and invalidates old approval without touching the other fields", async () => {
  const first = await send(full());
  const before = first.snapshot.actionProposals[0]!;
  const revised = await send(patch({ localTime: "15:00" }), "O hodinu později");
  const proposal = revised.snapshot.actionProposals[0]!;
  expect(revised.snapshot.workItems).toHaveLength(1);
  expect(revised.snapshot.actionProposals).toHaveLength(1);
  expect(proposal.id).toBe(before.id);
  expect(proposal.revision).toBe(before.revision + 1);
  expect(proposal.parameters).toMatchObject({
    participant: { id: "peter-novak" },
    startsAt: "2026-09-26T13:00:00.000Z",
    endsAt: "2026-09-26T13:45:00.000Z",
  });
  expect(
    store.execute(scope, proposalDecision(before, "approve", "stale-approval"))
      .code,
  ).toBe("revision_conflict");
  const again = await send(patch({ durationMinutes: 60 }), "Radši hodinu");
  expect(again.snapshot.actionProposals[0]!.parameters.endsAt).toBe(
    "2026-09-26T14:00:00.000Z",
  );
  expect(again.snapshot.operations).toHaveLength(0);
});
test("implicit ordered contact answer completes the focused question without a duplicate task", async () => {
  await send(
    patch({
      mode: "new",
      contactName: "Peter",
      localDate: "2026-09-26",
      localTime: "14:00",
      durationMinutes: 45,
    }),
  );
  expect(memory()?.phase).toBe("waiting_input");
  expect(memory()?.options.map((o) => o.id)).toEqual([
    "peter-novak",
    "peter-svoboda",
  ]);
  const result = await send(
    patch({ contactId: "peter-svoboda", contactName: "Peter Svoboda" }),
    "S tím druhým",
  );
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(result.snapshot.inputRequests[0]!.status).toBe("resolved");
  expect(result.snapshot.actionProposals[0]!.parameters.participant.id).toBe(
    "peter-svoboda",
  );
  expect(result.snapshot.actionProposals[0]!.parameters.endsAt).toBe(
    "2026-09-26T12:45:00.000Z",
  );
});
test("a new meeting never inherits the prior date, time or duration", async () => {
  await send(full());
  const next = await send(
    patch({
      mode: "new",
      contactId: "peter-svoboda",
      contactName: "Peter Svoboda",
    }),
    "Nová schůzka s Peterem Svobodou",
  );
  expect(next.snapshot.workItems).toHaveLength(1);
  expect(memory()?.slots).toEqual({
    ...emptyMeeting(),
    contactId: "peter-svoboda",
    contactName: "Peter Svoboda",
  });
  await send(patch({ localDate: "2026-09-27", localTime: "10:00" }));
  expect(store.snapshot(scope).actionProposals).toHaveLength(2);
  expect(memory()?.slots.durationMinutes).toBe(30);
});
test("topic reset clears conversational focus without cancelling stored work", async () => {
  await send(full());
  await send(
    {
      kind: "new_topic",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: "Dobře, nové téma.",
      patch: null,
    },
    "To nechme, nové téma",
  );
  expect(memory()).toBeNull();
  const result = await send(patch({ localTime: "15:00" }), "O hodinu později");
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(result.snapshot.actionProposals[0]!.revision).toBe(1);
  expect(result.snapshot.conversations[0]!.messages.at(-1)!.text).toContain(
    "Kterou schůzku",
  );
  expect(
    decide.mock.calls
      .at(-1)![0]
      .history.map((m) => m.text)
      .join(" "),
  ).not.toContain("Peter");
});
test("unknown contact is retained without substituting a supported person", async () => {
  const result = await send(
    patch({
      mode: "new",
      contactName: "Jana Horáková",
      localDate: "2026-09-26",
      localTime: "14:00",
    }),
  );
  expect(result.snapshot.actionProposals).toHaveLength(0);
  expect(memory()?.slots.contactName).toBe("Jana Horáková");
  expect(result.snapshot.conversations[0]!.messages.at(-1)!.text).toContain(
    "nemám v testovacím adresáři",
  );
});
test("ambiguous participant correction retains its requested time but cannot silently alter the current proposal", async () => {
  await send(full());
  const uncertain = await send(
    patch({ contactName: "Peter", localTime: "18:00" }),
  );
  expect(uncertain.snapshot.actionProposals[0]!.parameters.startsAt).toBe(
    "2026-09-26T12:00:00.000Z",
  );
  expect(memory()).toMatchObject({
    pendingChanges: true,
    slots: { contactId: null, localTime: "18:00", durationMinutes: 45 },
  });
  store.close();
  open();
  const resolved = await send(
    patch({ contactName: "Peter Svoboda", contactId: "peter-svoboda" }),
    "S tím druhým",
  );
  expect(resolved.snapshot.actionProposals[0]!.parameters).toMatchObject({
    participant: { id: "peter-svoboda" },
    startsAt: "2026-09-26T16:00:00.000Z",
    endsAt: "2026-09-26T16:45:00.000Z",
  });
  expect(memory()?.pendingChanges).toBeUndefined();
});
test("expiry and time-zone change do not revive an old context from raw history", async () => {
  await send(
    patch({
      mode: "new",
      contactName: "Peter Svoboda",
      contactId: "peter-svoboda",
    }),
  );
  expect(store.modelState(scope, "America/New_York").activeMeeting).toBeNull();
  clock += MEMORY_TTL_MS + 1;
  const result = await send(
    patch({ localDate: "2026-09-27", localTime: "14:00" }),
  );
  expect(decide.mock.calls.at(-1)![0].history).toEqual([]);
  expect(decide.mock.calls.at(-1)![0].activeMeeting).toBeNull();
  expect(result.snapshot.workItems).toHaveLength(0);
});
test("memory is isolated by account and workspace and never enters public snapshots", async () => {
  await send(full());
  for (const other of [{ ...scope, userId: "bob" }, scopeFor("b")])
    expect(store.modelState(other, "Europe/Prague").activeMeeting).toBeNull();
  expect(store.snapshot(scope)).not.toHaveProperty("conversationMemory");
});
test("current card revisions are projected instead of stale remembered facts", async () => {
  const first = await send(full());
  const proposal = first.snapshot.actionProposals[0]!;
  store.execute(
    scope,
    reviseProposal(
      proposal,
      "peter-svoboda",
      "2026-09-27T08:00:00.000Z",
      "card-edit",
    ),
  );
  expect(memory()?.slots).toMatchObject({
    contactId: "peter-svoboda",
    localDate: "2026-09-27",
    localTime: "10:00",
    durationMinutes: 45,
  });
  const second = await send(patch({ durationMinutes: 60 }));
  expect(second.snapshot.actionProposals[0]!.parameters.endsAt).toBe(
    "2026-09-27T09:00:00.000Z",
  );
});
test("card contact selection and worker completion keep the same memory target", async () => {
  const first = await send(
    patch({
      mode: "new",
      contactName: "Peter",
      localDate: "2026-09-26",
      localTime: "14:00",
    }),
  );
  store.execute(
    scope,
    answerCommand(first.snapshot.inputRequests[0]!, "peter-svoboda", "card"),
  );
  clock += 4001;
  store.tick();
  expect(memory()).toMatchObject({
    phase: "waiting_approval",
    slots: { contactId: "peter-svoboda", localTime: "14:00" },
  });
});
test("approved or completed work is locked; follow-up cannot schedule a duplicate", async () => {
  const first = await send(full());
  store.execute(
    scope,
    proposalDecision(first.snapshot.actionProposals[0]!, "approve", "approve"),
  );
  expect(memory()?.phase).toBe("locked");
  const result = await send(patch({ localTime: "15:00" }));
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(result.snapshot.operations).toHaveLength(1);
  expect(result.snapshot.actionProposals[0]!.parameters.startsAt).toBe(
    "2026-09-26T12:00:00.000Z",
  );
});
test("replay does not reapply a relative correction or consume inference", async () => {
  await send(full());
  const decision = patch({ localTime: "15:00" });
  await send(decision, "O hodinu později", "relative");
  const calls = decide.mock.calls.length;
  await service.execute(
    scope,
    messageCommand("O hodinu později", "cs", "relative"),
    () => {},
    new AbortController().signal,
  );
  expect(decide).toHaveBeenCalledTimes(calls);
  expect(store.snapshot(scope).actionProposals[0]!.revision).toBe(2);
});
test("concurrent approval invalidates the captured interpretation and leaves memory/workflow unchanged", async () => {
  const first = await send(full());
  let finish!: (value: Decision) => void;
  let started!: () => void;
  const inferenceStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  decide.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      }),
  );
  const pending = service.execute(
    scope,
    messageCommand("Později", "cs", "race"),
    () => {},
    new AbortController().signal,
  );
  await inferenceStarted;
  store.execute(
    scope,
    proposalDecision(first.snapshot.actionProposals[0]!, "approve", "approve"),
  );
  finish(patch({ localTime: "15:00" }));
  expect((await pending).code).toBe("revision_conflict");
  expect(memory()?.slots.localTime).toBe("14:00");
  expect(memory()?.phase).toBe("locked");
});
test("revocation during inference leaves partial memory and receipts unchanged", async () => {
  await send(
    patch({ mode: "new", contactName: "Peter", localDate: "2026-09-26" }),
  );
  const before = store.modelState(scope, "Europe/Prague");
  decide.mockResolvedValueOnce(patch({ localTime: "14:00" }));
  await expect(
    service.execute(
      scope,
      messageCommand("Ve dvě", "cs", "revoked"),
      () => {
        throw Error("revoked");
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("revoked");
  expect(store.modelState(scope, "Europe/Prague")).toEqual(before);
});
test.each([
  { localDate: "2026-02-30" },
  { localTime: "24:00" },
  { durationMinutes: 0 },
  { targetWorkItemId: "other" },
  { approve: true },
])(
  "invalid patch cannot acquire arbitrary scope or action authority: %j",
  (fields) => {
    expect(DecisionSchema.safeParse(patch(fields)).success).toBe(false);
  },
);

test("explicit new meeting hides previous contact and history before inference", async () => {
  await send(full());
  await send(
    patch({
      mode: "new",
      contactName: "Peter",
      localDate: "2026-09-27",
      localTime: "10:00",
    }),
    "Nová schůzka s Peterem pozítří v deset.",
  );
  expect(decide.mock.calls.at(-1)![0].activeMeeting).toBeNull();
  expect(decide.mock.calls.at(-1)![0].history).toEqual([]);
  expect(memory()?.slots.contactId).toBeNull();
});
test("explicit new request cannot be redirected to old work by a continue flag", async () => {
  await send(full());
  const result = await send(
    patch({ contactName: "Peter Svoboda", contactId: "peter-svoboda" }),
    "Prepare a new meeting with Peter Svoboda.",
  );
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(memory()?.slots.localDate).toBeNull();
  expect(result.snapshot.actionProposals[0]!.parameters.participant.id).toBe(
    "peter-novak",
  );
});
test("an unrelated card edit supersedes a pending conversational correction", async () => {
  const first = await send(full());
  await send(patch({ contactName: "Peter", localTime: "18:00" }));
  store.execute(
    scope,
    reviseProposal(
      first.snapshot.actionProposals[0]!,
      "peter-novak",
      "2026-09-27T08:00:00.000Z",
      "card-later",
    ),
  );
  expect(memory()?.pendingChanges).toBeUndefined();
  expect(memory()?.slots).toMatchObject({
    contactId: "peter-novak",
    localDate: "2026-09-27",
    localTime: "10:00",
  });
});
test("structured facts outlive the six-message raw history window", async () => {
  await send(
    patch({
      mode: "new",
      contactName: "Peter Svoboda",
      contactId: "peter-svoboda",
      durationMinutes: 45,
    }),
  );
  for (let i = 0; i < 5; i++)
    await send(
      {
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "Rozumím.",
      },
      `Detail ${i}`,
    );
  await send(patch({ localDate: "2026-09-27", localTime: "09:00" }));
  const input = decide.mock.calls.at(-1)![0];
  expect(input.history).toHaveLength(6);
  expect(input.activeMeeting?.slots).toMatchObject({
    contactId: "peter-svoboda",
    durationMinutes: 45,
  });
  expect(
    store.snapshot(scope).actionProposals[0]!.parameters.participant.id,
  ).toBe("peter-svoboda");
});

test("a fresh bare Peter request cannot inherit or invent a surname even if the model supplies one", async () => {
  await send(full());
  const result = await send(
    patch({
      mode: "new",
      contactId: "peter-novak",
      contactName: "Peter Novák",
      localDate: "2026-09-27",
      localTime: "10:00",
    }),
    "Nová schůzka s Peterem pozítří v deset.",
  );
  expect(memory()?.slots.contactId).toBeNull();
  expect(memory()?.slots.contactName).toBe("Peter");
  expect(memory()?.phase).toBe("waiting_input");
  expect(result.snapshot.actionProposals).toHaveLength(1);
});

test("the immediately preceding unfinished legacy card can be continued, but older or completed cards are not resurrected", async () => {
  const first = await send(full());
  store.close();
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  db.exec(
    "UPDATE workflows SET state=json_remove(state, '$.conversationMemory', '$.conversationMemories', '$.conversationContacts')",
  );
  db.close();
  open();
  expect(memory()).toMatchObject({
    phase: "waiting_approval",
    slots: {
      contactId: "peter-novak",
      localTime: "14:00",
      durationMinutes: 45,
    },
  });
  const changed = await send(patch({ localTime: "15:00" }));
  expect(changed.snapshot.actionProposals).toHaveLength(1);
  expect(changed.snapshot.actionProposals[0]!.id).toBe(
    first.snapshot.actionProposals[0]!.id,
  );
  store.close();
  open();
  expect(memory()?.slots.localTime).toBe("15:00");
});

test.each(["approved", "later_reply"])(
  "legacy focus does not scan past %s",
  async (state) => {
    const first = await send(full());
    if (state === "approved")
      store.execute(
        scope,
        proposalDecision(
          first.snapshot.actionProposals[0]!,
          "approve",
          "legacy-approve",
        ),
      );
    else
      await send({
        kind: "reply",
        contactId: null,
        title: null,
        localStart: null,
        durationMinutes: null,
        reply: "Jiné vysvětlení.",
      });
    store.close();
    const db = new DatabaseSync(join(directory, "workflow.sqlite"));
    db.exec(
      "UPDATE workflows SET state=json_remove(state, '$.conversationMemory', '$.conversationMemories', '$.conversationContacts')",
    );
    db.close();
    open();
    expect(memory()).toBeNull();
  },
);

test("an explicit last meeting reference recovers a legacy draft after clarification and retains focus", async () => {
  const first = await send(full());
  const reply: Decision = {
    kind: "reply",
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
    reply: "Kterou schůzku máš na mysli?",
  };
  await send(reply, "Tu schůzku jsem říkal na čtrnáct hodin.");
  store.close();
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  db.exec(
    "UPDATE workflows SET state=json_remove(state, '$.conversationMemory', '$.conversationMemories', '$.conversationContacts')",
  );
  db.close();
  open();
  expect(memory()).toBeNull();
  await send(
    { ...reply, reply: "Mám poslední návrh. Co mám změnit?" },
    "Tu poslední schůzku.",
  );
  expect(decide.mock.calls.at(-1)![0].activeMeeting?.slots.localTime).toBe(
    "14:00",
  );
  store.close();
  open();
  expect(memory()?.slots.contactId).toBe("peter-novak");
  const changed = await send(
    patch({ localTime: "15:00" }),
    "O hodinu později.",
  );
  expect(changed.snapshot.actionProposals).toHaveLength(1);
  expect(changed.snapshot.actionProposals[0]!.id).toBe(
    first.snapshot.actionProposals[0]!.id,
  );
  expect(memory()?.slots.localTime).toBe("15:00");
});

test("explicit latest reference after a topic reset selects the newest scoped task, including a locked one", async () => {
  await send(full());
  const latest = await send(
    patch({
      ...full().patch!,
      contactId: "peter-svoboda",
      contactName: "Peter Svoboda",
      localTime: "16:00",
    }),
  );
  const proposal = latest.snapshot.actionProposals.at(-1)!;
  store.execute(scope, proposalDecision(proposal, "approve", "approve-latest"));
  await send({
    kind: "new_topic",
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
    reply: "Dobře.",
  });
  expect(memory()).toBeNull();
  const changed = await send(
    patch({ localTime: "17:00" }),
    "Move the latest meeting one hour later.",
  );
  expect(decide.mock.calls.at(-1)![0].activeMeeting).toMatchObject({
    phase: "locked",
    slots: { contactId: "peter-svoboda", localTime: "16:00" },
  });
  expect(changed.snapshot.actionProposals).toHaveLength(2);
  expect(changed.snapshot.actionProposals.at(-1)!.parameters).toEqual(
    proposal.parameters,
  );
  expect(changed.snapshot.operations).toHaveLength(1);
  expect(memory()?.phase).toBe("locked");
  const other = { ...scope, userId: "other-user" };
  expect(
    store.modelState(other, "Europe/Prague", "tu poslední schůzku")
      .activeMeeting,
  ).toBeNull();
});

test("explicit last draft can be recalled after expiry without reviving unrelated raw history", async () => {
  await send(full());
  clock += MEMORY_TTL_MS + 1;
  expect(memory()).toBeNull();
  const changed = await send(
    patch({ localTime: "15:00" }),
    "Tu poslední schůzku posuň na patnáctou.",
  );
  expect(changed.snapshot.actionProposals).toHaveLength(1);
  expect(memory()?.slots.localTime).toBe("15:00");
  expect(decide.mock.calls.at(-1)![0].activeMeeting?.slots.localTime).toBe(
    "14:00",
  );
});

test("per-chat focus remains authoritative without its legacy scalar mirror, survives reopen and never follows B into A", async () => {
  const a = await send(full());
  store.execute(scope, {
    type: "conversation.create",
    conversationId: "TEST-memory-B",
    commandId: "TEST-memory-create-B",
    idempotencyKey: "TEST-memory-create-B",
  });
  decide.mockResolvedValueOnce(
    patch({
      mode: "new",
      contactId: "peter-svoboda",
      contactName: "Peter Svoboda",
      localDate: "2026-09-27",
      localTime: "10:00",
      durationMinutes: 30,
    }),
  );
  await service.execute(
    scope,
    {
      ...messageCommand(
        "TEST independent B request",
        "cs",
        "TEST-memory-B-first",
      ),
      conversationId: "TEST-memory-B",
    },
    () => {},
    new AbortController().signal,
  );
  expect(decide.mock.calls.at(-1)![0].activeMeeting).toBeNull();
  expect(
    store.modelState(scope, "Europe/Prague", undefined, "TEST-memory-B")
      .activeMeeting?.slots.localTime,
  ).toBe("10:00");
  store.close();
  const db = new DatabaseSync(join(directory, "workflow.sqlite"));
  db.exec(
    "UPDATE workflows SET state=json_remove(state, '$.conversationMemory')",
  );
  db.close();
  open();
  expect(memory()?.slots.localTime).toBe("14:00");
  expect(memory()?.slots.contactId).toBe("peter-novak");
  expect(
    store.modelState(scope, "Europe/Prague", undefined, "TEST-memory-B")
      .activeMeeting?.slots.contactId,
  ).toBe("peter-svoboda");
  const changed = await send(
    patch({ localTime: "15:00" }),
    "TEST change only A",
  );
  expect(
    changed.snapshot.actionProposals.find(
      (p) => p.id === a.snapshot.actionProposals[0]!.id,
    )?.parameters.startsAt,
  ).toBe("2026-09-26T13:00:00.000Z");
  expect(
    store.modelState(scope, "Europe/Prague", undefined, "TEST-memory-B")
      .activeMeeting?.slots.localTime,
  ).toBe("10:00");
  store.close();
  open();
  expect(memory()?.slots.localTime).toBe("15:00");
  expect(
    store.modelState(scope, "Europe/Prague", undefined, "TEST-memory-B")
      .activeMeeting?.slots.localTime,
  ).toBe("10:00");
});
