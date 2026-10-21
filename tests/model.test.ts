import { CrmContactResultSchema } from "../packages/protocol";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DecisionSchema,
  localToUtc,
  ModelError,
  type Decision,
  type ModelInput,
} from "../apps/fixture-server/decision";
import {
  OpenRouterModel,
  reserveModelRequest,
  type OpenRouterConfig,
} from "../apps/fixture-server/openrouter";
import { ModelService } from "../apps/fixture-server/model-service";
import { FixtureStorage } from "../apps/fixture-server/storage";
import type { TestPerson } from "../apps/fixture-server/twenty";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
} from "../packages/client-core/commands";
import { scopeFor } from "../packages/test-fixtures";

const now = Date.parse("2026-09-24T12:00:00Z");
const config: OpenRouterConfig = {
  apiKey: "fake-key-for-tests-only",
  model: "openai/gpt-4.1-mini",
  expiresAt: "2026-09-24T22:00:00.000Z",
  maxRequests: 2,
  timeZone: "Europe/Prague",
};
const meeting: Decision = {
  kind: "meeting",
  contactId: "peter-novak",
  title: "TEST meeting",
  localStart: "2026-09-25T14:00",
  durationMinutes: 45,
  reply: null,
};
const reply: Decision = {
  kind: "reply",
  contactId: null,
  title: null,
  localStart: null,
  durationMinutes: null,
  reply: "V kolik hodin?",
};
const input: ModelInput = {
  text: "Zítra ve dvě s Novákem",
  language: "cs",
  now: new Date(now).toISOString(),
  timeZone: "Europe/Prague",
  history: [],
};
const response = (content: unknown, overrides: object = {}) => {
  let read = false;
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: async () =>
          read
            ? { done: true }
            : ((read = true),
              {
                done: false,
                value: Buffer.from(
                  JSON.stringify({
                    model: config.model,
                    choices: [
                      {
                        finish_reason: "stop",
                        message: { content: JSON.stringify(content) },
                      },
                    ],
                    ...overrides,
                  }),
                ),
              }),
        cancel: async () => {},
      }),
    },
  } as Response;
};
test("OpenRouter uses a fixed HTTPS endpoint, bounded structured output, privacy routing and no tools", async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => response(meeting),
  );
  const reserve = jest.fn();
  const model = new OpenRouterModel(config, reserve, transport, () => now);
  expect(await model.decide(input, new AbortController().signal)).toEqual(
    meeting,
  );
  expect(reserve).toHaveBeenCalledTimes(1);
  const [url, request] = transport.mock.calls[0]!;
  expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
  expect(request!.redirect).toBe("error");
  const payload = JSON.parse(request!.body as string);
  expect(payload.response_format.json_schema.strict).toBe(true);
  expect(
    payload.response_format.json_schema.schema.properties.kind.enum,
  ).toEqual(["meeting", "reply"]);
  expect(JSON.parse(payload.messages[1].content)).toMatchObject({
    mode: "new_request",
    question: null,
  });
  expect(payload.provider).toMatchObject({
    require_parameters: true,
    data_collection: "deny",
    zdr: true,
  });
  expect(payload.max_tokens).toBe(768);
  expect(payload.tools).toBeUndefined();
  expect(request!.body).not.toContain(config.apiKey);
});
test.each([
  { ...meeting, kind: "approve" },
  { ...meeting, contactId: "attacker" },
  { ...meeting, durationMinutes: 0 },
  { ...meeting, calendarUrl: "https://attacker.invalid" },
  { ...reply, contactId: "peter-novak" },
  { ...meeting, title: null },
  { ...meeting, localStart: "2026-09-25T14:00:01" },
  { ...reply, kind: "contact", reply: null, contactId: "peter-novak" },
  { ...reply, kind: "crm_contacts", reply: null },
])(
  "rejects an untrusted interpretation without accepting extra authority: %j",
  async (value) => {
    const model = new OpenRouterModel(
      config,
      () => {},
      async () => response(value),
      () => now,
    );
    await expect(
      model.decide(input, new AbortController().signal),
    ).rejects.toThrow("model_invalid_response");
  },
);
test("normalizes zero seconds without changing the requested wall time", async () => {
  const model = new OpenRouterModel(
    config,
    () => {},
    async () => response({ ...meeting, localStart: "2026-09-25T14:00:00" }),
    () => now,
  );
  expect(await model.decide(input, new AbortController().signal)).toEqual(
    meeting,
  );
});
test("an explicit contact question cannot start a new meeting or CRM read", async () => {
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => response(meeting),
  );
  const model = new OpenRouterModel(
    config,
    () => {},
    transport,
    () => now,
  );
  await expect(
    model.decide(
      {
        ...input,
        testCrmRead: true,
        question: {
          text: "Which Peter?",
          options: [
            { id: "peter-novak", label: "Peter Novák", detail: "Acme" },
          ],
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("model_invalid_response");
  const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(body.response_format.json_schema.schema.properties.kind.enum).toEqual([
    "contact",
    "reply",
  ]);
});
test("rejects tool calls, truncated output and secret-bearing transport errors", async () => {
  for (const overrides of [
    {
      choices: [
        {
          finish_reason: "length",
          message: { content: JSON.stringify(meeting) },
        },
      ],
    },
    {
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: JSON.stringify(meeting),
            tool_calls: [{ name: "approve" }],
          },
        },
      ],
    },
  ]) {
    const m = new OpenRouterModel(
      config,
      () => {},
      async () => response(meeting, overrides),
      () => now,
    );
    await expect(m.decide(input, new AbortController().signal)).rejects.toThrow(
      "model_invalid_response",
    );
  }
  const m = new OpenRouterModel(
    config,
    () => {},
    async () => {
      throw Error(config.apiKey);
    },
    () => now,
  );
  await expect(m.decide(input, new AbortController().signal)).rejects.toThrow(
    "model_unavailable",
  );
});
test("expired access and cancelled calls never reserve budget or contact the provider", async () => {
  const transport = jest.fn(),
    reserve = jest.fn();
  const expired = new OpenRouterModel(config, reserve, transport, () =>
    Date.parse(config.expiresAt),
  );
  await expect(
    expired.decide(input, new AbortController().signal),
  ).rejects.toThrow("model_expired");
  const abort = new AbortController();
  abort.abort();
  const model = new OpenRouterModel(config, reserve, transport, () => now);
  await expect(model.decide(input, abort.signal)).rejects.toThrow();
  expect(reserve).not.toHaveBeenCalled();
  expect(transport).not.toHaveBeenCalled();
});
test("provider timeout aborts the request and returns only a safe code", async () => {
  jest.useFakeTimers();
  try {
    const transport: typeof fetch = async (_url, options) =>
      new Promise((_resolve, reject) =>
        options!.signal!.addEventListener("abort", () =>
          reject(Error("provider details")),
        ),
      );
    const m = new OpenRouterModel(
      config,
      () => {},
      transport,
      () => now,
    );
    const result = expect(
      m.decide(input, new AbortController().signal),
    ).rejects.toThrow("model_timeout");
    await jest.advanceTimersByTimeAsync(20001);
    await result;
  } finally {
    jest.useRealTimers();
  }
});
test("wall times convert in Prague with DST ambiguity, nonexistent times and invalid dates rejected", () => {
  expect(localToUtc("2026-09-25T14:00", "Europe/Prague")).toBe(
    "2026-09-25T12:00:00.000Z",
  );
  expect(localToUtc("2026-12-25T14:00", "Europe/Prague")).toBe(
    "2026-12-25T13:00:00.000Z",
  );
  for (const local of [
    "2026-10-25T02:30",
    "2026-03-29T02:30",
    "2026-02-30T10:00",
  ])
    expect(localToUtc(local, "Europe/Prague")).toBeUndefined();
});

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-model-"));
});
afterEach(() => {
  rmSync(directory, { recursive: true, force: true });
});
test("request cap persists independently of model instances and rejects before another call", () => {
  const file = join(directory, "budget.sqlite");
  reserveModelRequest(file, config);
  reserveModelRequest(file, config);
  expect(() => reserveModelRequest(file, config)).toThrow("model_limit");
});
const scope = scopeFor();
function setup(
  decide = jest.fn(
    async (_input: ModelInput, _signal: AbortSignal): Promise<Decision> =>
      meeting,
  ),
) {
  const store = new FixtureStorage(directory, scope.serverId, () => now);
  const service = new ModelService(
    store,
    { timeZone: "Europe/Prague", decide },
    () => now,
  );
  return {
    store,
    service,
    decide,
    send: (id = "start", text = input.text) =>
      service.execute(
        scope,
        messageCommand(text, "cs", id),
        () => {},
        new AbortController().signal,
      ),
  };
}
test("model creates a reviewable proposal, not an operation; receipt survives restart without another model call", async () => {
  const { store, send, decide } = setup();
  const first = await send();
  expect(first.status).toBe("accepted");
  expect(first.snapshot.operations).toHaveLength(0);
  expect(first.snapshot.actionProposals[0]).toMatchObject({
    status: "awaiting_approval",
    parameters: {
      startsAt: "2026-09-25T12:00:00.000Z",
      endsAt: "2026-09-25T12:45:00.000Z",
    },
  });
  await send();
  expect(decide).toHaveBeenCalledTimes(1);
  store.close();
  const reopened = setup(decide);
  try {
    expect((await reopened.send()).snapshot).toEqual(first.snapshot);
    expect((await reopened.send("start", "changed")).code).toBe(
      "idempotency_conflict",
    );
    expect(decide).toHaveBeenCalledTimes(1);
    const proposal = first.snapshot.actionProposals[0]!;
    reopened.store.execute(
      scope,
      proposalDecision(proposal, "approve", "approve"),
    );
    expect(reopened.store.snapshot(scope).operations).toHaveLength(1);
  } finally {
    reopened.store.close();
  }
});
test("ambiguous contact retains requested time/duration across restart and card answer", async () => {
  const { store, send } = setup(
    jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(async () => ({
      ...meeting,
      contactId: null,
    })),
  );
  const first = await send();
  expect(first.snapshot.actionProposals).toHaveLength(0);
  store.close();
  let clock = now;
  const reopened = new FixtureStorage(directory, scope.serverId, () => clock);
  try {
    reopened.execute(
      scope,
      answerCommand(
        first.snapshot.inputRequests[0]!,
        "peter-svoboda",
        "answer",
      ),
    );
    clock += 4001;
    reopened.tick();
    expect(
      reopened.snapshot(scope).actionProposals[0]!.parameters,
    ).toMatchObject({
      participant: { id: "peter-svoboda" },
      startsAt: "2026-09-25T12:00:00.000Z",
      endsAt: "2026-09-25T12:45:00.000Z",
    });
  } finally {
    reopened.close();
  }
});
test("clarification history is scoped and stops at completed proposal messages", async () => {
  const decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(
    async () => reply,
  );
  const { store, send } = setup(decide);
  try {
    await send("clarify");
    expect(store.snapshot(scope).workItems).toHaveLength(0);
    decide.mockResolvedValue(meeting);
    await send("complete", "zítra ve 14:00");
    expect(decide.mock.calls[1]![0].history).toHaveLength(2);
    await send("next", "něco dalšího");
    expect(decide.mock.calls[2]![0].history).toEqual([]);
    expect(
      (
        await new ModelService(
          store,
          { timeZone: "Europe/Prague", decide },
          () => now,
        ).execute(
          { ...scope, userId: "bob" },
          messageCommand("hello", "en", "other"),
          () => {},
          new AbortController().signal,
        )
      ).snapshot.scope.userId,
    ).toBe("bob");
    expect(decide.mock.calls[3]![0].history).toEqual([]);
  } finally {
    store.close();
  }
});
test("identical concurrent requests join one inference while other commands are gated and cursor changes invalidate the shared result", async () => {
  let finish!: (value: Decision) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const { store, service, send, decide } = setup(
    jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(
      () =>
        new Promise<Decision>((r) => {
          finish = r;
          started();
        }),
    ),
  );
  const pending = send();
  let duplicate: ReturnType<typeof send> | undefined;
  try {
    await entered;
    duplicate = send();
    await expect(
      send("different-command", "Choose another contact"),
    ).rejects.toThrow("model_busy");
    await expect(send("start", "Changed duplicate payload")).rejects.toThrow(
      "idempotency_conflict",
    );
    expect(decide).toHaveBeenCalledTimes(1);
    store.execute(scope, messageCommand("Choose Peter", "en", "other-command"));
    finish(meeting);
    const [first, joined] = await Promise.all([pending, duplicate]);
    expect(first.code).toBe("revision_conflict");
    expect(joined).toEqual(first);
    expect((await send()).code).toBe("revision_conflict");
    expect(store.snapshot(scope).actionProposals).toHaveLength(0);
    const invalid = messageCommand("yes", "en", "invalid", {
      ...store.snapshot(scope).inputRequests[0]!,
      id: "foreign",
    });
    expect(
      (
        await service.execute(
          scope,
          invalid,
          () => {},
          new AbortController().signal,
        )
      ).code,
    ).toBe("unknown_context");
    expect(decide).toHaveBeenCalledTimes(1);
  } finally {
    finish?.(reply);
    await Promise.allSettled([pending, ...(duplicate ? [duplicate] : [])]);
    store.close();
  }
});
test("revocation and abort during inference leave no receipts or workflow changes", async () => {
  const { store, service } = setup();
  try {
    const command = messageCommand(input.text, "cs", "start");
    await expect(
      service.execute(
        scope,
        command,
        () => {
          throw Error("revoked");
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow("revoked");
    expect(store.snapshot(scope).cursor).toBe(0);
    expect(store.replay(scope, command)).toBeUndefined();
    const abort = new AbortController();
    abort.abort();
    await expect(
      service.execute(scope, command, () => {}, abort.signal),
    ).rejects.toThrow();
    expect(store.snapshot(scope).cursor).toBe(0);
  } finally {
    store.close();
  }
});
test("invalid schema or provider failure cannot produce events", async () => {
  const { store, send, decide } = setup();
  try {
    decide.mockResolvedValue({ ...meeting, approve: true } as Decision);
    await expect(send()).rejects.toThrow();
    decide.mockRejectedValue(new ModelError("model_unavailable"));
    await expect(send()).rejects.toThrow("model_unavailable");
    expect(store.snapshot(scope).cursor).toBe(0);
    expect(
      DecisionSchema.safeParse({ ...meeting, durationMinutes: null }).success,
    ).toBe(false);
  } finally {
    store.close();
  }
});
test("CRM intent persists structured server-owned fields, replays once and keeps contact details out of model history", async () => {
  const decide = jest.fn<Promise<Decision>, [ModelInput, AbortSignal]>(
    async () => ({
      kind: "crm_contacts",
      contactId: null,
      title: null,
      localStart: null,
      durationMinutes: null,
      reply: null,
    }),
  );
  const { store } = setup(decide);
  const crm = {
    list: jest.fn(
      async (): Promise<TestPerson[]> => [
        {
          id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
          name: { firstName: "TEST Agent", lastName: "Client" },
          email: "test.agent@example.test",
          phone: "+1 202 555 0147",
        },
      ],
    ),
  };
  const service = new ModelService(
    store,
    { timeZone: "Europe/Prague", decide },
    () => now,
    crm,
  );
  try {
    const command = messageCommand("Ukaž testovací kontakty", "cs", "crm");
    const result = await service.execute(
      scope,
      command,
      () => {},
      new AbortController().signal,
    );
    expect(decide.mock.calls[0]![0].testCrmRead).toBe(true);
    expect(JSON.stringify(decide.mock.calls[0]![0])).not.toContain(
      "TEST Agent",
    );
    const message = result.snapshot.conversations[0]!.messages[1]!;
    expect(message.text).not.toContain("TEST Agent Client");
    expect(message.result).toMatchObject({
      type: "crm.contacts",
      version: 1,
      source: "twenty",
      hasMore: false,
      contacts: [
        {
          id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
          name: "TEST Agent Client",
          email: "test.agent@example.test",
          phone: "+1 202 555 0147",
        },
      ],
    });
    const reopened = new FixtureStorage(directory, scope.serverId, () => now);
    try {
      expect(reopened.snapshot(scope).conversations[0]!.messages[1]).toEqual(
        message,
      );
    } finally {
      reopened.close();
    }
    expect(result.snapshot.operations).toHaveLength(0);
    expect(result.snapshot.workItems).toHaveLength(0);
    await service.execute(
      scope,
      command,
      () => {},
      new AbortController().signal,
    );
    expect(crm.list).toHaveBeenCalledTimes(1);
    crm.list.mockResolvedValueOnce([]);
    const empty = await service.execute(
      scope,
      messageCommand("Kontakty ještě jednou", "cs", "crm-empty"),
      () => {},
      new AbortController().signal,
    );
    expect(
      CrmContactResultSchema.parse(
        empty.snapshot.conversations[0]!.messages.at(-1)!.result,
      ).contacts,
    ).toEqual([]);
    const history = JSON.stringify(decide.mock.calls[1]![0]);
    expect(history).not.toContain("test.agent@example.test");
    expect(history).not.toContain("202 555");
    // Only bounded IDs/names are shared for a following meeting reference, never email or phone.
    expect(decide.mock.calls[1]![0].recentContacts).toEqual([
      {
        id: "bfdcd207-4745-4bf1-a732-be096058ab6f",
        label: "TEST Agent Client",
      },
    ]);
    crm.list.mockResolvedValueOnce(
      Array.from({ length: 7 }, (_, i) => ({
        id: `bfdcd207-4745-4bf1-a732-be096058ab6${i}`,
        name: { firstName: "TEST", lastName: String(i) },
      })),
    );
    const many = await service.execute(
      scope,
      messageCommand("again", "en", "crm-many"),
      () => {},
      new AbortController().signal,
    );
    expect(
      many.snapshot.conversations[0]!.messages.at(-1)!.result,
    ).toMatchObject({ hasMore: true });
    expect(
      CrmContactResultSchema.parse(
        many.snapshot.conversations[0]!.messages.at(-1)!.result,
      ).contacts,
    ).toHaveLength(5);
    const failing = new ModelService(
      store,
      { timeZone: "Europe/Prague", decide },
      () => now,
      {
        list: async () => {
          throw Error("private CRM details");
        },
      },
    );
    await expect(
      failing.execute(
        scope,
        messageCommand("again", "en", "crm-failure"),
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("model_unavailable");
    expect(store.snapshot(scope)).toEqual(many.snapshot);
  } finally {
    store.close();
  }
});

test("structured context negotiates a bounded patch schema separate from explicit contact answers", async () => {
  const draft: Decision = {
    kind: "meeting_patch",
    contactId: null,
    title: null,
    localStart: null,
    durationMinutes: null,
    reply: null,
    patch: {
      mode: "continue",
      contactId: null,
      contactName: null,
      localDate: null,
      localTime: "15:00",
      durationMinutes: null,
      title: null,
    },
  };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () =>
      response({ kind: draft.kind, patch: draft.patch, reply: draft.reply }),
  );
  const model = new OpenRouterModel(
    config,
    () => {},
    transport,
    () => now,
  );
  const activeMeeting: NonNullable<ModelInput["activeMeeting"]> = {
    phase: "waiting_approval",
    slots: {
      contactId: "peter-novak",
      contactName: "Peter Novák",
      localDate: "2026-09-25",
      localTime: "14:00",
      durationMinutes: 45,
      title: null,
    },
    displayTitle: "Meeting",
    options: [],
  };
  expect(
    await model.decide(
      { ...input, activeMeeting },
      new AbortController().signal,
    ),
  ).toEqual(draft);
  const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(JSON.parse(body.messages[1].content)).toMatchObject({
    mode: "contextual_request",
    activeMeeting,
  });
  expect(body.response_format.json_schema.schema.required).toContain("patch");
  expect(body.response_format.json_schema.schema.properties.kind.enum).toEqual([
    "meeting_patch",
    "reply",
    "new_topic",
  ]);
  expect(body.messages[0].content).toContain("mode=new");
  expect(body.tools).toBeUndefined();
  await expect(
    model.decide(
      {
        ...input,
        activeMeeting,
        question: {
          text: "Which Peter?",
          options: [
            { id: "peter-novak", label: "Peter Novák", detail: "Acme" },
          ],
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("model_invalid_response");
});

test("model output allows CRM IDs only from the current server-provided question or recent context", async () => {
  const id = "bfdcd207-4745-4bf1-a732-be096058ab6f";
  const contact = { ...reply, kind: "contact", reply: null, contactId: id };
  const transport = jest.fn<ReturnType<typeof fetch>, Parameters<typeof fetch>>(
    async () => response(contact),
  );
  const model = new OpenRouterModel(
    config,
    () => {},
    transport,
    () => now,
  );
  const question = {
    text: "Which person?",
    options: [{ id, label: "TEST Jana", detail: "jana@example.test" }],
  };
  expect(
    await model.decide({ ...input, question }, new AbortController().signal),
  ).toEqual(contact);
  const body = JSON.parse(transport.mock.calls[0]![1]!.body as string);
  expect(
    body.response_format.json_schema.schema.properties.contactId.enum,
  ).toEqual([id, null]);
  await expect(
    model.decide(
      {
        ...input,
        question: {
          ...question,
          options: [{ id: "peter-novak", label: "Peter", detail: "Demo" }],
        },
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("model_invalid_response");
  const patch = {
    mode: "new",
    contactId: id,
    contactName: "TEST Jana",
    localDate: "2026-09-25",
    localTime: "14:00",
    durationMinutes: 30,
    title: null,
  };
  transport.mockImplementation(async () =>
    response({ kind: "meeting_patch", reply: null, patch }),
  );
  expect(
    (
      await model.decide(
        {
          ...input,
          activeMeeting: null,
          testCrmRead: true,
          recentContacts: [{ id, label: "TEST Jana" }],
        },
        new AbortController().signal,
      )
    ).patch?.contactId,
  ).toBe(id);
  expect(
    (
      await model.decide(
        {
          ...input,
          activeMeeting: null,
          testCrmRead: false,
          testCrmSearch: true,
          recentContacts: [{ id, label: "TEST Jana" }],
        },
        new AbortController().signal,
      )
    ).patch?.contactId,
  ).toBe(id);
  const searchOnlyBody = JSON.parse(
    transport.mock.calls.at(-1)![1]!.body as string,
  );
  expect(
    searchOnlyBody.response_format.json_schema.schema.properties.kind.enum,
  ).not.toContain("crm_contacts");
  await expect(
    model.decide(
      {
        ...input,
        activeMeeting: null,
        testCrmRead: true,
        testCrmSearch: false,
        recentContacts: [{ id, label: "TEST Jana" }],
      },
      new AbortController().signal,
    ),
  ).rejects.toThrow("model_invalid_response");
  await expect(
    model.decide(
      { ...input, activeMeeting: null, testCrmRead: true },
      new AbortController().signal,
    ),
  ).rejects.toThrow("model_invalid_response");
});
