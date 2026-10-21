import {
  ClientSession,
  commandTarget,
  type SessionCommand,
} from "../packages/client-core/session";
import {
  processStartCommand,
  type ProcessStartTarget,
} from "../packages/client-core/process-commands";
import { processCommandDigest } from "../packages/client-core/process-command-digest";
import {
  PROCESS_INVENTORY_PAGE_BYTES,
  PROCESS_INVENTORY_TOTAL_BYTES,
  PROCESS_INPUT_RESPONSE_BYTES,
  freezeProcessInputSelection,
  parseProcessInventoryPage,
  type ReadyProcessExecutionEntry,
} from "../packages/client-core/process-execution-reader";
import {
  PROCESS_EXECUTION_PROFILE,
  type ProcessExecutionEntry,
  type ProcessInputRequest,
  type ProcessInputCard,
} from "../packages/protocol/process-execution";
import type { ProcessData } from "../packages/protocol/service-processes";
import type { ProcessStartCommand } from "../packages/protocol/process-start";
import { ProcessRuntimeResponseSchema } from "../packages/protocol/process-coordinator";
import { FixtureEngine } from "../apps/fixture-server/engine";
import { credential, authInfo } from "./auth-fixtures";

const address = "https://fixture/v1/a";
const scope = credential().scope;
const response = (value: unknown, status = 200) =>
  rawResponse(JSON.stringify(value), status);
const rawResponse = (body: string, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }) as Response;
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const sessions = new Set<ClientSession>();
afterEach(() => {
  for (const session of sessions) session.stop();
  sessions.clear();
});
const object = (
  properties: Record<string, ProcessData> = {},
  required = Object.keys(properties),
): Extract<ProcessData, { type: "object" }> => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
function entry(
  id = "TEST-process",
  inputSchema = object({ name: { type: "string" } }),
): ReadyProcessExecutionEntry {
  return {
    processId: id,
    name: "TEST process",
    description: "TEST purpose",
    kind: "workflow",
    version: 1,
    artifactDigest: "a".repeat(64),
    availability: "ready",
    inputSchema,
  };
}
function inputRequest(selected = entry()): ProcessInputRequest {
  return {
    processId: selected.processId,
    version: selected.version,
    artifactDigest: selected.artifactDigest,
    language: "cs",
    origin: {
      type: "command",
      conversationId: "conversation-1",
      requestId: "TEST-original-menu",
    },
  };
}
function card(request = inputRequest(), selected = entry()): ProcessInputCard {
  const { availability: _availability, ...summary } = selected;
  const form = {
    profile: "agent-process-input/1" as const,
    scope,
    ...summary,
    language: request.language,
    origin: request.origin,
  };
  const formDigest = processCommandDigest(form);
  return {
    form,
    formDigest,
    intent: {
      intentId: "TEST-intent",
      processId: form.processId,
      version: form.version,
      artifactDigest: form.artifactDigest,
      formDigest,
      inputSchema: form.inputSchema,
      origin: form.origin,
      fields: {},
      createdAt: "2026-10-06T00:00:00.000Z",
    },
  };
}
const page = (
  processes: ProcessExecutionEntry[] = [],
  nextAfter: string | null = null,
  fingerprint = "f".repeat(64),
) => ({
  profile: PROCESS_EXECUTION_PROFILE,
  scope,
  fingerprint,
  processes,
  nextAfter,
});
const storage = () => {
  const map = new Map<string, string>();
  const hooks = { set: (_key: string, _value: string): void => {} };
  return {
    map,
    hooks,
    getItem: async (key: string) => map.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      hooks.set(key, value);
      map.set(key, value);
    },
  };
};
function fixture(options = { processQuestions: true }, saved = storage()) {
  const engine = new FixtureEngine();
  const reads: { url: URL; init?: RequestInit }[] = [];
  const handlers = {
    inventory: async (_url: URL): Promise<Response> =>
      response(page([entry()])),
    input: async (request: ProcessInputRequest): Promise<Response> =>
      response(card(request)),
    command: async (_command: ProcessStartCommand): Promise<Response> => {
      throw Error("TEST lost reply");
    },
  };
  const request: typeof fetch = async (rawUrl, init) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith("/auth/session")) return response(authInfo());
    if (url.pathname.endsWith("/snapshot")) return response(engine.snapshot());
    reads.push({ url, init });
    if (url.pathname.endsWith("/processes/input"))
      return handlers.input(JSON.parse(String(init?.body)));
    if (url.pathname.endsWith("/processes/commands"))
      return handlers.command(JSON.parse(String(init?.body)));
    if (url.pathname.endsWith("/processes")) return handlers.inventory(url);
    throw Error("TEST unexpected route");
  };
  const create = () => {
    const session = new ClientSession(
      address,
      saved,
      credential(),
      request,
      undefined,
      undefined,
      false,
      options,
    );
    sessions.add(session);
    return session;
  };
  return { session: create(), create, handlers, reads, saved };
}
async function startPair(f: ReturnType<typeof fixture>) {
  await f.session.start(false);
  const target = await f.session.prepareProcessInput(inputRequest(), entry());
  const command = processStartCommand(target, {
    commandId: "TEST-start",
    idempotencyKey: "TEST-start-key",
    language: "cs",
    input: { name: "  TEST original\n" },
  });
  return { target, command };
}
function runtime(
  command: ProcessStartCommand,
  target: ProcessStartTarget,
  rejected = false,
) {
  const admission = {
    profile: "agent-process-start/1" as const,
    receiptId: "TEST-admission",
    intentId: command.intentId,
    commandId: command.commandId,
    idempotencyKey: command.idempotencyKey,
    commandDigest: processCommandDigest(command),
    origin: target.card.form.origin,
    processId: target.entry.processId,
    version: target.entry.version,
    artifactDigest: target.entry.artifactDigest,
    formDigest: target.card.formDigest,
    createdAt: "2026-10-06T00:00:00.000Z",
  };
  return ProcessRuntimeResponseSchema.parse({
    profile: "agent-process-execution/2",
    scope,
    commandId: command.commandId,
    admission: rejected
      ? { ...admission, status: "rejected", reason: "process_input_invalid" }
      : {
          ...admission,
          status: "admitted",
          input: command.input,
          inputDigest: processCommandDigest(command.input),
          compilerVersion: "niaro-native-workflow/3",
          runId: "TEST-run",
          parentRunId: "TEST-parent",
        },
    ...(!rejected
      ? {
          process: {
            parentRunId: "TEST-parent",
            runId: "TEST-run",
            processId: target.entry.processId,
            version: target.entry.version,
            revision: 1,
            status: "running",
          },
        }
      : {}),
  });
}

test("Session reads one complete immutable inventory under one exact profile/scope/fingerprint", async () => {
  const f = fixture();
  const ready = entry("A-ready");
  const { inputSchema: _schema, ...summary } = entry("B-blocked");
  const blocked: ProcessExecutionEntry = {
    ...summary,
    availability: "blocked",
    reason: "budget_unavailable",
  };
  f.handlers.inventory = async (url) =>
    response(
      url.searchParams.has("after")
        ? page([entry("C-ready")])
        : page([ready, blocked], blocked.processId),
    );
  const result = await f.session.loadProcessInventory();
  expect(result.processes.map((value) => value.processId)).toEqual([
    "A-ready",
    "B-blocked",
    "C-ready",
  ]);
  expect(result.refreshed).toBe(false);
  expect(result.scope).toEqual(scope);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.processes)).toBe(true);
  const first = result.processes[0]!;
  expect(first.availability).toBe("ready");
  expect(
    Object.isFrozen(first.availability === "ready" && first.inputSchema),
  ).toBe(true);
  expect(f.reads.map(({ url }) => url.search)).toEqual([
    "?profile=agent-process-execution%2F1",
    "?profile=agent-process-execution%2F1&after=B-blocked&fingerprint=" +
      "f".repeat(64),
  ]);
  for (const { init } of f.reads) {
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer " + credential().accessToken,
    });
    expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit");
    expect(init?.method).toBeUndefined();
  }
  expect(f.session.getSnapshot().pending).toBeNull();
  expect(f.saved.map.size).toBe(0);
});

test("empty inventory is complete and no blocked schema or command is fabricated", async () => {
  const f = fixture();
  f.handlers.inventory = async () => response(page());
  expect((await f.session.loadProcessInventory()).processes).toEqual([]);
  expect(f.reads).toHaveLength(1);
  expect(f.session.getSnapshot().processPending).toBeNull();
});

test.each(["server conflict", "changed fingerprint"])(
  "%s discards all prior pages and retries once from a bare request",
  async (mode) => {
    const f = fixture();
    let call = 0;
    f.handlers.inventory = async () => {
      call++;
      if (call === 1) return response(page([entry("A-old")], "A-old"));
      if (call === 2)
        return mode === "server conflict"
          ? response({ error: "process_inventory_changed" }, 409)
          : response(page([entry("B-changed")], null, "b".repeat(64)));
      return response(page([entry("C-current")], null, "c".repeat(64)));
    };
    const result = await f.session.loadProcessInventory();
    expect(result.processes.map((value) => value.processId)).toEqual([
      "C-current",
    ]);
    expect(result.fingerprint).toBe("c".repeat(64));
    expect(result.refreshed).toBe(true);
    expect(f.reads).toHaveLength(3);
    expect(f.reads[2]!.url.searchParams.has("after")).toBe(false);
    expect(f.reads[2]!.url.searchParams.has("fingerprint")).toBe(false);
  },
);

test("a second inventory change fails visibly instead of looping or exposing partial entries", async () => {
  const f = fixture();
  f.handlers.inventory = async (url) =>
    url.searchParams.has("after")
      ? response({ error: "process_inventory_changed" }, 409)
      : response(page([entry("A-old")], "A-old"));
  await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
    code: "process_inventory_changed",
  });
  expect(f.reads).toHaveLength(4);
  expect(f.session.getSnapshot().pending).toBeNull();
});

test.each(["connectionId", "serverId", "userId", "workspaceId"] as const)(
  "inventory rejects foreign %s on every page",
  async (field) => {
    const f = fixture();
    f.handlers.inventory = async (url) =>
      response(
        url.searchParams.has("after")
          ? {
              ...page([entry("B")]),
              scope: { ...scope, [field]: "TEST-foreign" },
            }
          : page([entry("A")], "A"),
      );
    await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
      code: "process_inventory_invalid",
    });
    expect(f.reads).toHaveLength(2);
  },
);

test.each([
  ["duplicate", page([entry("A"), entry("A")])],
  ["unordered", page([entry("B"), entry("A")])],
  ["foreign cursor", page([entry("A")], "B")],
  ["empty next page", page([], "A")],
  ["wrong profile", { ...page(), profile: "agent-process-input/1" }],
  ["extra field", { ...page(), organizationId: "TEST-forged" }],
  ["bad digest", { ...page(), fingerprint: "bad" }],
] as const)("invalid inventory %s fails closed", async (_label, body) => {
  const f = fixture();
  f.handlers.inventory = async () => response(body);
  await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
    code: "process_inventory_invalid",
  });
  expect(f.reads).toHaveLength(1);
});

test("repeated cross-page IDs and cursors cannot advance a pagination loop", async () => {
  const f = fixture();
  f.handlers.inventory = async () => response(page([entry("A")], "A"));
  await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
    code: "process_inventory_invalid",
  });
  expect(f.reads).toHaveLength(2);
});

test.each([false, true])(
  "exact 1000-entry/10-page inventory boundary, further pages=%s",
  async (more) => {
    const f = fixture();
    let call = 0;
    f.handlers.inventory = async () => {
      const entries = Array.from({ length: 100 }, (_, index) =>
        entry("P" + String(call * 100 + index).padStart(4, "0")),
      );
      call++;
      return response(
        page(entries, call < 10 || more ? entries.at(-1)!.processId : null),
      );
    };
    if (more)
      await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
        code: "process_inventory_limit",
      });
    else
      expect((await f.session.loadProcessInventory()).processes).toHaveLength(
        1000,
      );
    expect(call).toBe(10);
  },
);

function largeSchema() {
  const fields = Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [
      `field${index}`,
      { type: "string" } as const,
    ]),
  );
  const groups = Object.fromEntries(
    Array.from({ length: 39 }, (_, index) => [`group${index}`, object(fields)]),
  );
  groups.last = object(Object.fromEntries(Object.entries(fields).slice(0, 17)));
  return object(groups);
}
test("registry boundary 1577-leaf input and repeated form schemas remain supported, including a large inventory page", async () => {
  const f = fixture();
  const selected = entry("TEST-process", largeSchema());
  f.handlers.inventory = async () =>
    response(
      page(
        Array.from({ length: 10 }, (_, index) =>
          entry("P" + index, selected.inputSchema),
        ),
      ),
    );
  expect((await f.session.loadProcessInventory()).processes).toHaveLength(10);
  f.handlers.input = async (request) => response(card(request, selected));
  const result = await f.session.prepareProcessInput(
    inputRequest(selected),
    selected,
  );
  expect(result.card.form.inputSchema).toEqual(selected.inputSchema);
  expect(Object.isFrozen(result.card.intent.inputSchema)).toBe(true);
});

test("registry-over-budget schemas and accessor payloads fail before recursive parsing", () => {
  const tooLarge = object(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, group) => [
        `group${group}`,
        object(
          Object.fromEntries(
            Array.from({ length: 40 }, (_, index) => [
              `field${index}`,
              { type: "string" } as const,
            ]),
          ),
        ),
      ]),
    ),
  );
  expect(() =>
    parseProcessInventoryPage(page([entry("P", tooLarge)]), scope),
  ).toThrow("process_inventory_invalid");
  const getter = jest.fn();
  const hostile = Object.defineProperty({}, "processes", {
    enumerable: true,
    get: getter,
  });
  expect(() => parseProcessInventoryPage(hostile, scope)).toThrow(
    "process_inventory_invalid",
  );
  const request = Object.defineProperty({}, "origin", {
    enumerable: true,
    get: getter,
  });
  expect(() =>
    freezeProcessInputSelection(request as ProcessInputRequest, entry()),
  ).toThrow("process_input_invalid");
  expect(getter).not.toHaveBeenCalled();
});

test.each(["characters", "UTF-8"])(
  "inventory page %s resource limit is checked before JSON/schema parsing",
  async (mode) => {
    const f = fixture();
    const body =
      mode === "characters"
        ? " ".repeat(PROCESS_INVENTORY_PAGE_BYTES) + JSON.stringify(page())
        : JSON.stringify({
            padding: "😀".repeat(PROCESS_INVENTORY_PAGE_BYTES / 3),
            ...page(),
          });
    f.handlers.inventory = async () => rawResponse(body);
    await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
      code: "process_inventory_limit",
    });
  },
);

test("aggregate byte budget counts wire bytes across pages and exposes no partial list", async () => {
  const f = fixture();
  let call = 0;
  const padding = " ".repeat(PROCESS_INVENTORY_TOTAL_BYTES / 5 + 100);
  f.handlers.inventory = async () => {
    const id = "P" + call++;
    return rawResponse(padding + JSON.stringify(page([entry(id)], id)));
  };
  await expect(f.session.loadProcessInventory()).rejects.toMatchObject({
    code: "process_inventory_limit",
  });
  expect(call).toBe(5);
});

test("explicit preparation authenticates once, freezes its original selection, and never creates a command", async () => {
  const f = fixture();
  const selected = entry(),
    request = inputRequest(selected),
    pending = gate<Response>(),
    started = gate<void>();
  const original = card(structuredClone(request), structuredClone(selected));
  f.handlers.input = async () => {
    started.resolve();
    return pending.promise;
  };
  const promise = f.session.prepareProcessInput(request, selected);
  await started.promise;
  request.language = "en";
  request.origin.conversationId = "conversation-B";
  selected.version = 2;
  selected.name = "TEST changed";
  pending.resolve(response(original));
  const target = await promise;
  expect(target.card.form.language).toBe("cs");
  expect(target.card.form.origin.conversationId).toBe("conversation-1");
  expect(target.entry.version).toBe(1);
  expect(target.entry.name).toBe("TEST process");
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.card.form.origin)).toBe(true);
  expect(f.reads[0]!.url.search).toBe("?profile=agent-process-execution%2F1");
  expect(f.reads[0]!.init?.headers).toMatchObject({
    "Content-Type": "application/json",
    Authorization: "Bearer " + credential().accessToken,
  });
  expect(f.reads[0]!.init?.method).toBe("POST");
  expect(JSON.parse(String(f.reads[0]!.init?.body))).toEqual(inputRequest());
  expect(f.session.getSnapshot().pending).toBeNull();
  expect(f.saved.map.size).toBe(0);
});

test("explicit same preparation retries identical original request bytes", async () => {
  const f = fixture();
  await f.session.prepareProcessInput(inputRequest(), entry());
  await f.session.prepareProcessInput(inputRequest(), entry());
  expect(f.reads).toHaveLength(2);
  expect(f.reads[0]!.init?.body).toBe(f.reads[1]!.init?.body);
});

test.each(["invalid request", "wrong entry", "blocked entry"])(
  "%s prevents any preparation POST",
  async (mode) => {
    const f = fixture();
    const request = inputRequest(),
      selected = entry();
    if (mode === "invalid request")
      Object.assign(request, { userId: "TEST-forged" });
    if (mode === "wrong entry") selected.artifactDigest = "b".repeat(64);
    if (mode === "blocked entry")
      Object.assign(selected, {
        availability: "blocked",
        reason: "budget_unavailable",
      });
    await expect(
      f.session.prepareProcessInput(request, selected),
    ).rejects.toMatchObject({
      code:
        mode === "invalid request"
          ? "process_input_invalid"
          : "process_input_changed",
    });
    expect(f.reads).toHaveLength(0);
  },
);

test.each([
  "scope",
  "language",
  "conversation",
  "request",
  "version",
  "artifact",
  "schema",
  "name",
  "digest",
  "intent",
])("form response cannot substitute %s", async (mode) => {
  const f = fixture();
  f.handlers.input = async (request) => {
    const body = card(request);
    if (mode === "scope")
      body.form.scope = { ...scope, userId: "TEST-foreign" };
    if (mode === "language") body.form.language = "en";
    if (mode === "conversation")
      body.form.origin.conversationId = "conversation-B";
    if (mode === "request")
      body.form.origin.type === "command" &&
        (body.form.origin.requestId = "TEST-other");
    if (mode === "version") body.form.version = body.intent.version = 2;
    if (mode === "artifact")
      body.form.artifactDigest = body.intent.artifactDigest = "b".repeat(64);
    if (mode === "schema")
      body.form.inputSchema = body.intent.inputSchema = object({
        other: { type: "boolean" },
      });
    if (mode === "name") body.form.name = "TEST other";
    body.formDigest = body.intent.formDigest = processCommandDigest(body.form);
    if (mode === "digest")
      body.formDigest = body.intent.formDigest = "b".repeat(64);
    if (mode === "intent") body.intent.processId = "TEST-other";
    return response(body);
  };
  await expect(
    f.session.prepareProcessInput(inputRequest(), entry()),
  ).rejects.toMatchObject({ code: "process_form_invalid" });
  expect(f.session.getSnapshot().pending).toBeNull();
});

test.each([
  "process_not_found",
  "process_active_version_changed",
  "process_execution_unavailable",
  "process_origin_changed",
  "process_inventory_limit",
])("reader retains server reason %s without a write replay", async (code) => {
  const f = fixture();
  f.handlers.input = async () => response({ error: code }, 409);
  await expect(
    f.session.prepareProcessInput(inputRequest(), entry()),
  ).rejects.toMatchObject({ code });
  expect(f.reads).toHaveLength(1);
});

test.each(["inventory", "input"])(
  "malformed %s JSON and untrusted error details expose stable local codes",
  async (kind) => {
    const f = fixture();
    const call = () =>
      kind === "inventory"
        ? f.session.loadProcessInventory()
        : f.session.prepareProcessInput(inputRequest(), entry());
    f.handlers.inventory = async () => rawResponse("{");
    f.handlers.input = async () => rawResponse("{");
    await expect(call()).rejects.toMatchObject({
      code:
        kind === "inventory"
          ? "process_inventory_invalid"
          : "process_form_invalid",
    });
    f.handlers.inventory = async () =>
      response({ error: "TEST secret server details" }, 500);
    f.handlers.input = async () =>
      response({ error: "TEST secret server details" }, 500);
    await expect(call()).rejects.toMatchObject({ code: "process_read_failed" });
  },
);

test("input response byte limit fails without exposing a form or command", async () => {
  const f = fixture();
  f.handlers.input = async () =>
    rawResponse(
      " ".repeat(PROCESS_INPUT_RESPONSE_BYTES) + JSON.stringify(card()),
    );
  await expect(
    f.session.prepareProcessInput(inputRequest(), entry()),
  ).rejects.toMatchObject({ code: "process_input_limit" });
  expect(f.session.getSnapshot().processPending).toBeNull();
});

test.each(["inventory", "input"])(
  "%s requires explicit profile opt-in and pre-aborted requests never read",
  async (kind) => {
    const f = fixture({ processQuestions: false });
    const call = (signal?: AbortSignal) =>
      kind === "inventory"
        ? f.session.loadProcessInventory(signal)
        : f.session.prepareProcessInput(inputRequest(), entry(), signal);
    await expect(call()).rejects.toMatchObject({
      code: "process_profile_unsupported",
    });
    const cancel = new AbortController();
    cancel.abort();
    await expect(call(cancel.signal)).rejects.toMatchObject({
      code: "process_read_cancelled",
    });
    expect(f.reads).toHaveLength(0);
  },
);

test.each(["inventory", "input"])(
  "delayed %s response cannot return after caller cancellation even when transport ignores abort",
  async (kind) => {
    const f = fixture(),
      pending = gate<Response>(),
      started = gate<void>(),
      cancel = new AbortController();
    f.handlers.inventory = async () => {
      started.resolve();
      return pending.promise;
    };
    f.handlers.input = async () => {
      started.resolve();
      return pending.promise;
    };
    const promise =
      kind === "inventory"
        ? f.session.loadProcessInventory(cancel.signal)
        : f.session.prepareProcessInput(inputRequest(), entry(), cancel.signal);
    await started.promise;
    cancel.abort();
    pending.resolve(response(kind === "inventory" ? page([entry()]) : card()));
    await expect(promise).rejects.toMatchObject({
      code: "process_read_cancelled",
    });
    expect(f.session.getSnapshot().pending).toBeNull();
  },
);

test("stopped Session rejects its delayed original inventory response", async () => {
  const f = fixture(),
    pending = gate<Response>(),
    started = gate<void>();
  f.handlers.inventory = async () => {
    started.resolve();
    return pending.promise;
  };
  const promise = f.session.loadProcessInventory();
  await started.promise;
  f.session.stop();
  pending.resolve(response(page([entry()])));
  await expect(promise).rejects.toMatchObject({
    code: "process_read_cancelled",
  });
});

test("metadata auth revocation clears private pending view and never returns metadata", async () => {
  const f = fixture(),
    pair = await startPair(f);
  await f.session.send(pair.command, false, pair.target);
  expect(f.session.getSnapshot().processPending).not.toBeNull();
  f.handlers.inventory = async () =>
    response({ error: "identity_forbidden" }, 403);
  await expect(f.session.loadProcessInventory()).rejects.toThrow(
    "auth_expired",
  );
  expect(f.session.getSnapshot().status).toBe("unauthorized");
  expect(f.session.getSnapshot().processPending).toBeNull();
  expect(f.session.getSnapshot().pending).toBeNull();
});

test("unknown start view owns frozen original review and restores atomically with pending without dispatch", async () => {
  const f = fixture(),
    pair = await startPair(f);
  const states: {
    pending: SessionCommand | null;
    view: ReturnType<ClientSession["getSnapshot"]>["processPending"];
  }[] = [];
  f.session.subscribe(() =>
    states.push({
      pending: f.session.getSnapshot().pending,
      view: f.session.getSnapshot().processPending,
    }),
  );
  await f.session.send(pair.command, false, pair.target);
  const view = f.session.getSnapshot().processPending!;
  expect(view).toEqual({
    command: pair.command,
    target: pair.target,
    outcome: "unknown",
    error: null,
  });
  expect(Object.isFrozen(view)).toBe(true);
  expect(
    Object.isFrozen(
      view.command.type === "process.start" && view.command.input,
    ),
  ).toBe(true);
  expect(Object.isFrozen(view.target)).toBe(true);
  expect(
    states
      .filter((state) => state.pending)
      .every(
        (state) => state.view?.command.commandId === state.pending!.commandId,
      ),
  ).toBe(true);
  await f.session.refresh();
  expect(f.session.getSnapshot().processPending).toBe(view);
  f.session.stop();
  const reopened = f.create();
  const restored: {
    pending: SessionCommand | null;
    view: ReturnType<ClientSession["getSnapshot"]>["processPending"];
  }[] = [];
  reopened.subscribe(() =>
    restored.push({
      pending: reopened.getSnapshot().pending,
      view: reopened.getSnapshot().processPending,
    }),
  );
  await reopened.start(false);
  expect(reopened.getSnapshot().processPending).toEqual(view);
  expect(
    restored
      .filter((state) => state.pending)
      .every(
        (state) => state.view?.command.commandId === state.pending!.commandId,
      ),
  ).toBe(true);
  expect(
    f.reads.filter(({ url }) => url.pathname.endsWith("/processes/commands")),
  ).toHaveLength(1);
});

test.each([false, true])(
  "known pending view rejected=%s restores its original outcome and Retry only saves",
  async (rejected) => {
    const f = fixture(),
      pair = await startPair(f);
    f.handlers.command = async (command) =>
      response(runtime(command, pair.target, rejected), rejected ? 422 : 202);
    let blocked = true;
    f.saved.hooks.set = (key, value) => {
      if (
        blocked &&
        key.startsWith("agent-client.command.v2:") &&
        value === "null"
      )
        throw Error("TEST cleanup failed");
    };
    await f.session.send(pair.command, false, pair.target);
    const view = f.session.getSnapshot().processPending!;
    expect(view.outcome).toBe(rejected ? "rejected" : "accepted");
    expect(view.error).toBe(rejected ? "process_input_invalid" : null);
    expect(
      f.session.getSnapshot().commandStates[commandTarget(pair.command)],
    ).toBe(view.outcome);
    f.session.stop();
    const reopened = f.create();
    await reopened.start(false);
    expect(reopened.getSnapshot().processPending).toEqual(view);
    blocked = false;
    await reopened.retry();
    expect(reopened.getSnapshot().processPending).toBeNull();
    expect(reopened.getSnapshot().pending).toBeNull();
    expect(
      f.reads.filter(({ url }) => url.pathname.endsWith("/processes/commands")),
    ).toHaveLength(1);
  },
);

test("legacy raw start remains visible but never acquires proof from current inventory", async () => {
  const f = fixture(),
    pair = await startPair(f);
  await f.session.send(pair.command, false, pair.target);
  const key = [...f.saved.map.keys()].find((value) =>
    value.startsWith("agent-client.command.v2:"),
  )!;
  f.saved.map.set(key, JSON.stringify(pair.command));
  f.session.stop();
  const reopened = f.create();
  await reopened.start(false);
  expect(reopened.getSnapshot().pending).toEqual(pair.command);
  expect(reopened.getSnapshot().processPending).toBeNull();
  await reopened.loadProcessInventory();
  expect(reopened.getSnapshot().processPending).toBeNull();
  await expect(reopened.retry()).rejects.toThrow("process_command_changed");
});

test("workspace design transport accepts a bounded long transcript and pins its mobile profile", async () => {
  const token = credential();
  let observed: { url: URL; init?: RequestInit } | undefined;
  const session = new ClientSession(
    address,
    storage(),
    token,
    async (rawUrl, init) => {
      observed = { url: new URL(String(rawUrl)), init };
      return rawResponse(JSON.stringify("x".repeat(200_000)));
    },
    undefined,
    undefined,
    false,
    { processExecution: true },
  );
  sessions.add(session);
  const result = await session.requestProcessDesign(
    "turns/list",
    { sessionId: "TEST-design-session" },
  );
  expect(typeof result).toBe("string");
  expect((result as string).length).toBe(200_000);
  expect(observed?.url.pathname).toBe("/v1/a/process-design/turns/list");
  expect(observed?.url.searchParams.get("profile")).toBe(
    "agent-process-design/2",
  );
  expect(observed?.url.searchParams.get("sessionId")).toBe(
    "TEST-design-session",
  );
  expect(observed?.init?.redirect).toBe("error");
  expect(new Headers(observed?.init?.headers).get("authorization")).toBe(
    `Bearer ${token.accessToken}`,
  );
});

test("workspace design conversation turn is an explicit POST of the reviewed command", async () => {
  const token = credential();
  let observed: { url: URL; init?: RequestInit } | undefined;
  const session = new ClientSession(
    address,
    storage(),
    token,
    async (rawUrl, init) => {
      observed = { url: new URL(String(rawUrl)), init };
      return response({ profile: "agent-process-design/2", turn: {} });
    },
    undefined,
    undefined,
    false,
    { processExecution: true },
  );
  sessions.add(session);
  const command = {
    sessionId: "TEST-design-session",
    requestId: "TEST-design-turn",
    revision: 3,
    modelId: "TEST-design-model",
    language: "cs",
    text: "Create a process that summarizes a meeting.",
  };
  await session.requestProcessDesign(
    "turn",
    { sessionId: command.sessionId },
    command,
  );
  expect(observed?.url.pathname).toBe("/v1/a/process-design/turns");
  expect(observed?.url.searchParams.get("profile")).toBe(
    "agent-process-design/2",
  );
  expect(observed?.init?.method).toBe("POST");
  expect(JSON.parse(String(observed?.init?.body))).toEqual(command);
});
