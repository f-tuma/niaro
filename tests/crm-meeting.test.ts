import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import {
  emptyMeeting,
  MEMORY_TTL_MS,
} from "../apps/fixture-server/conversation-memory";
import type { Decision, ModelInput } from "../apps/fixture-server/decision";
import type { TestPerson } from "../apps/fixture-server/twenty";
import {
  calendarDocument,
  verifyCalendarDocument,
} from "../apps/fixture-server/calendar";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
  reviseProposal,
} from "../packages/client-core/commands";
import { scopeFor } from "../packages/test-fixtures";

const scope = scopeFor();
const initialNow = Date.parse("2026-09-25T10:00:00Z");
const jana: TestPerson = {
  id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
  name: { firstName: "TEST Jana", lastName: "Nováková" },
  email: "jana@example.test",
  phone: "+420 555 111 222",
  jobTitle: "Design",
};
const other: TestPerson = {
  ...jana,
  id: "bfdcd207-4745-4bf1-a732-be096058ab60",
  name: { firstName: "TEST Jana", lastName: "Malá" },
  email: "other@example.test",
};
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
const full = (name = "Jana Nováková") =>
  patch({
    mode: "new",
    contactName: name,
    localDate: "2026-09-26",
    localTime: "14:00",
    durationMinutes: 45,
  });
const listing: Decision = {
  kind: "crm_contacts",
  contactId: null,
  title: null,
  localStart: null,
  durationMinutes: null,
  reply: null,
};
let directory: string,
  now: number,
  store: FixtureStorage,
  service: ModelService,
  sequence: number;
let decide: jest.Mock<Promise<Decision>, [ModelInput, AbortSignal]>;
let list: jest.Mock<Promise<TestPerson[]>, [AbortSignal?]>;
function open() {
  store = new FixtureStorage(directory, scope.serverId, () => now);
  service = new ModelService(
    store,
    { timeZone: "Europe/Prague", decide },
    () => now,
    { list },
  );
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "crm-meeting-"));
  now = initialNow;
  sequence = 0;
  decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(async () =>
    full(),
  );
  list = jest.fn(async () => [jana]);
  open();
});
afterEach(() => {
  store.close();
  rmSync(directory, { recursive: true, force: true });
});
async function send(
  decision = full(),
  text = "synthetic request",
  id = `crm-${++sequence}`,
) {
  decide.mockResolvedValueOnce(decision);
  return service.execute(
    scope,
    messageCommand(text, "cs", id),
    () => {},
    new AbortController().signal,
  );
}

test("a unique CRM match fills the existing proposal card with canonical fields and survives restart/replay", async () => {
  const result = await send(full("Jana Novakova"), "Schůzka s Janou", "first");
  expect(result.status).toBe("accepted");
  expect(result.snapshot.inputRequests).toHaveLength(0);
  const proposal = result.snapshot.actionProposals[0]!;
  expect(proposal.parameters).toMatchObject({
    participant: {
      id: jana.id,
      label: "TEST Jana Nováková",
      email: jana.email,
    },
    startsAt: "2026-09-26T12:00:00.000Z",
    endsAt: "2026-09-26T12:45:00.000Z",
  });
  expect(result.snapshot.operations).toHaveLength(0);
  expect(JSON.stringify(result.snapshot)).not.toContain("meetingContacts");
  store.close();
  open();
  const replay = await service.execute(
    scope,
    messageCommand("Schůzka s Janou", "cs", "first"),
    () => {},
    new AbortController().signal,
  );
  expect(replay.snapshot).toEqual(result.snapshot);
  expect(list).toHaveBeenCalledTimes(1);
  const changed = await send(patch({ localTime: "15:00" }));
  expect(changed.snapshot.actionProposals[0]!.id).toBe(proposal.id);
  expect(changed.snapshot.actionProposals[0]!.parameters.participant).toEqual(
    proposal.parameters.participant,
  );
  expect(
    store.execute(scope, proposalDecision(proposal, "approve", "stale")).code,
  ).toBe("revision_conflict");
  expect(list).toHaveBeenCalledTimes(1);
  const current = changed.snapshot.actionProposals[0]!;
  expect(
    store.execute(
      scope,
      reviseProposal(
        current,
        jana.id,
        "2026-09-26T14:00:00.000Z",
        "card-revise",
      ),
    ).status,
  ).toBe("accepted");
});
test("partial CRM facts persist until time is supplied; lookup runs only when the draft is complete", async () => {
  await send(patch({ mode: "new", contactName: "Jana Nováková" }));
  expect(list).not.toHaveBeenCalled();
  store.close();
  open();
  const result = await send(
    patch({ localDate: "2026-09-26", localTime: "14:00" }),
  );
  expect(result.snapshot.actionProposals[0]!.parameters.participant.email).toBe(
    jana.email,
  );
  expect(list).toHaveBeenCalledTimes(1);
});
test.each(["card", "chat"])(
  "ambiguous TEST contacts use input.choice, %s selection and persisted trusted email",
  async (mode) => {
    list.mockResolvedValue([jana, other]);
    const result = await send(full("Jana"));
    expect(result.snapshot.actionProposals).toHaveLength(0);
    const input = result.snapshot.inputRequests[0]!;
    expect(input.options.map((o) => o.id)).toEqual([jana.id, other.id]);
    expect(input.options[1]!.detail).toContain(other.email);
    store.close();
    open();
    if (mode === "card")
      store.execute(scope, answerCommand(input, other.id, "choose"));
    else {
      decide.mockResolvedValueOnce({
        ...listing,
        kind: "contact",
        contactId: other.id,
      });
      await service.execute(
        scope,
        messageCommand("tu druhou", "cs", "choose", input),
        () => {},
        new AbortController().signal,
      );
    }
    now += 5000;
    store.tick();
    expect(
      store.snapshot(scope).actionProposals[0]!.parameters.participant,
    ).toEqual({ id: other.id, label: "TEST Jana Malá", email: other.email });
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.snapshot(scope).operations).toHaveLength(0);
  },
);
test("a spoken clarification without explicit question context can select only that draft's candidates", async () => {
  list.mockResolvedValue([jana, other]);
  await send(full("Jana"));
  const result = await send(
    patch({ contactId: other.id, contactName: "TEST Jana Malá" }),
  );
  expect(result.snapshot.actionProposals[0]!.parameters.participant.email).toBe(
    other.email,
  );
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(list).toHaveBeenCalledTimes(1);
});
test.each(["missing", "missing-email", "truncated", "non-test"])(
  "%s directory cannot invent a participant or silently choose one",
  async (kind) => {
    list.mockResolvedValue(
      kind === "missing"
        ? []
        : kind === "missing-email"
          ? [{ ...jana, email: undefined }]
          : kind === "non-test"
            ? [{ ...jana, name: { firstName: "Jana", lastName: "Nováková" } }]
            : Array.from({ length: 20 }, (_, index) => ({
                ...jana,
                id: `bfdcd207-4745-4bf1-a732-${String(index).padStart(12, "0")}`,
                name: {
                  firstName: "TEST Jana",
                  lastName: index === 0 ? "Nováková" : `Other${index}`,
                },
              })),
    );
    const result = await send();
    expect(result.snapshot.workItems).toHaveLength(0);
    expect(result.snapshot.actionProposals).toHaveLength(0);
    expect(result.snapshot.operations).toHaveLength(0);
    expect(result.snapshot.conversations[0]!.messages.at(-1)!.text).toMatch(
      /CRM|neúplný/,
    );
  },
);
test("recent CRM cards supply only IDs/names, expire, stay scoped and are revalidated for a new meeting", async () => {
  await send(listing);
  store.close();
  open();
  await send(
    patch({
      mode: "new",
      contactId: jana.id,
      contactName: "Jana",
      localDate: "2026-09-26",
      localTime: "14:00",
    }),
    "Připrav schůzku s tím kontaktem zítra ve dvě",
  );
  const modelInput = decide.mock.calls.at(-1)![0];
  expect(modelInput.recentContacts).toEqual([
    { id: jana.id, label: "TEST Jana Nováková" },
  ]);
  expect(JSON.stringify(modelInput)).not.toContain(jana.email);
  expect(JSON.stringify(modelInput)).not.toContain(jana.phone);
  expect(list).toHaveBeenCalledTimes(2);
  expect(
    store.modelState({ ...scope, userId: "other-user" }, "Europe/Prague")
      .recentContacts,
  ).toEqual([]);
  now += MEMORY_TTL_MS + 1;
  expect(store.modelState(scope, "Europe/Prague").recentContacts).toEqual([]);
});
test("a contact removed since its CRM card was shown is not reused", async () => {
  await send(listing);
  list.mockResolvedValue([]);
  const result = await send(patch({ ...full().patch!, contactId: jana.id }));
  expect(result.snapshot.actionProposals).toHaveLength(0);
});
test("an invented UUID, a foreign selection or a forged email cannot change workflow", async () => {
  await expect(
    send(patch({ ...full().patch!, contactId: jana.id })),
  ).rejects.toThrow("model_invalid_response");
  await expect(
    send({ ...full(), email: "forged@example.test" } as Decision),
  ).rejects.toThrow();
  list.mockResolvedValue([jana, other]);
  const result = await send(full("Jana"));
  expect(
    store.execute(
      scope,
      answerCommand(
        result.snapshot.inputRequests[0]!,
        "peter-novak",
        "foreign",
      ),
    ).code,
  ).toBe("invalid_answer");
  expect(store.snapshot(scope).actionProposals).toHaveLength(0);
});
test("CRM participant corrections increment the same proposal revision and keep canonical data", async () => {
  await send();
  list.mockResolvedValue([jana, other]);
  const result = await send(
    patch({ contactName: "Jana Malá", localTime: "15:00" }),
  );
  expect(result.snapshot.workItems).toHaveLength(1);
  expect(result.snapshot.actionProposals).toHaveLength(1);
  expect(result.snapshot.actionProposals[0]).toMatchObject({
    revision: 2,
    parameters: { participant: { id: other.id, email: other.email } },
  });
  const unchanged = await send(patch({ contactName: "Jana" }));
  expect(unchanged.snapshot.actionProposals).toEqual(
    result.snapshot.actionProposals,
  );
  store.close();
  open();
  expect(
    store
      .modelState(scope, "Europe/Prague")
      .activeMeeting?.options.map((c) => c.id),
  ).toEqual([jana.id, other.id]);
  const clarified = await send(
    patch({ contactId: jana.id, contactName: "TEST Jana Nováková" }),
  );
  expect(
    clarified.snapshot.actionProposals[0]!.parameters.participant.email,
  ).toBe(jana.email);
  expect(clarified.snapshot.actionProposals[0]!.revision).toBe(3);
});

test("only explicit approval creates an operation, with verified CRM fields and no invitation in ICS", async () => {
  const result = await send();
  const proposal = result.snapshot.actionProposals[0]!;
  expect(result.snapshot.operations).toHaveLength(0);
  const approved = store.execute(
    scope,
    proposalDecision(proposal, "approve", "approve"),
  );
  const operation = approved.snapshot.operations[0]!;
  const document = calendarDocument(scope, operation);
  expect(document).toContain("Test contact: TEST Jana");
  expect(document).toContain(jana.email);
  expect(document).not.toMatch(/ATTENDEE|ORGANIZER|METHOD/);
  expect(verifyCalendarDocument(document, scope, operation)).toBe(true);
  expect(
    verifyCalendarDocument(
      document.replace(jana.email!, "forged@example.test"),
      scope,
      operation,
    ),
  ).toBe(false);
  const unchanged = await send(patch({ localTime: "15:00" }));
  expect(unchanged.snapshot.actionProposals).toEqual(
    approved.snapshot.actionProposals,
  );
  expect(unchanged.snapshot.operations).toEqual(approved.snapshot.operations);
});
test.each(["abort", "revoked", "cursor", "provider"])(
  "%s during CRM lookup cannot commit a late draft",
  async (kind) => {
    const abort = new AbortController();
    let revoked = false;
    list.mockImplementation(async () => {
      if (kind === "abort") abort.abort();
      if (kind === "revoked") revoked = true;
      if (kind === "cursor")
        store.execute(
          scope,
          messageCommand("Choose Peter", "en", "concurrent"),
        );
      if (kind === "provider") throw Error("secret");
      return [jana];
    });
    const command = messageCommand("Jana zítra", "cs", "late");
    const request = service.execute(
      scope,
      command,
      () => {
        if (revoked) throw Error("revoked");
      },
      abort.signal,
    );
    if (kind === "cursor")
      expect((await request).code).toBe("revision_conflict");
    else await expect(request).rejects.toThrow();
    expect(store.snapshot(scope).actionProposals).toHaveLength(0);
    if (kind !== "cursor") expect(store.replay(scope, command)).toBeUndefined();
  },
);
