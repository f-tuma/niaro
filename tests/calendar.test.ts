import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CalDavCalendar,
  CalendarWorker,
  CalendarConfigSchema,
  calendarDocument,
  verifyCalendarDocument,
  type CalendarConfig,
} from "../apps/fixture-server/calendar";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { FixtureEngine } from "../apps/fixture-server/engine";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
  reviseProposal,
  reconcileOperation,
} from "../packages/client-core/commands";
import { commandTarget } from "../packages/client-core/session";
import { scopeFor } from "../packages/test-fixtures";
import { PROFILE, type Operation } from "../packages/protocol";

const scope = scopeFor();
const config: CalendarConfig = {
  scope,
  username: "tester",
  password: "synthetic-test-password",
  target: {
    provider: "caldav",
    integrationId: "local",
    label: "Test calendar",
    collectionUrl: "http://127.0.0.1:5232/test/calendar/",
    invitations: "none",
  },
};
let now: number;
let dir: string;
beforeEach(() => {
  now = Date.UTC(2026, 8, 24, 9);
  dir = mkdtempSync(join(tmpdir(), "agent-calendar-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function prepare(store: FixtureStorage) {
  store.execute(scope, messageCommand("Choose Peter", "en", "start"));
  store.execute(
    scope,
    answerCommand(
      store.snapshot(scope).inputRequests[0]!,
      "peter-novak",
      "answer",
    ),
  );
  now += 4000;
  store.tick();
  return store.snapshot(scope).actionProposals[0]!;
}
const open = () =>
  new FixtureStorage(
    dir,
    scope.serverId,
    () => now,
    undefined,
    (s) => (s.userId === scope.userId ? config.target : undefined),
  );
const approve = (store: FixtureStorage) => {
  const p = prepare(store);
  store.execute(scope, proposalDecision(p, "approve", "approve"));
  now += 4000;
  store.tick();
  return store.snapshot(scope).operations[0]!;
};
// A small HTTP response double, independent of the native Jest fetch polyfill.
const response = (status: number, body = "", etag = '"verified-etag"') =>
  ({
    status,
    headers: { get: (key: string) => (key === "etag" ? etag : null) },
    body: {
      cancel: async () => {},
      getReader: () => {
        let read = false;
        return {
          read: async () => {
            if (read) return { done: true };
            read = true;
            return { value: Buffer.from(body), done: false };
          },
          cancel: async () => {},
        };
      },
    },
  }) as unknown as Response;
function remote(op: Operation, status = 201) {
  let written = false;
  const calls: { url: string; options: RequestInit }[] = [];
  const transport: typeof fetch = async (url, options) => {
    calls.push({ url: String(url), options: options! });
    if (options?.method === "PUT") {
      written = true;
      return response(status);
    }
    return written ? response(200, calendarDocument(scope, op)) : response(404);
  };
  return { calendar: new CalDavCalendar(config, transport), calls };
}

test("only explicit approval creates a calendar job; GET verifies a conditional PUT before success", async () => {
  const store = open();
  try {
    const proposal = prepare(store);
    expect(proposal.parameters.calendar).toEqual(config.target);
    expect(store.calendarJobs()).toEqual([]);
    store.execute(scope, proposalDecision(proposal, "approve", "approve"));
    now += 4000;
    store.tick();
    const op = store.snapshot(scope).operations[0]!;
    const { calendar, calls } = remote(op);
    await new CalendarWorker(store, calendar).tick();
    expect(calls.map((c) => c.options.method)).toEqual(["GET", "PUT", "GET"]);
    expect(calls[1]?.options).toMatchObject({
      redirect: "error",
      headers: { "If-None-Match": "*" },
    });
    expect(calls[1]?.options.body).not.toMatch(
      /(?:ATTENDEE|ORGANIZER|METHOD):/,
    );
    expect(store.snapshot(scope).operations[0]).toMatchObject({
      status: "succeeded",
      result: { kind: "calendar" },
    });
    expect(store.snapshot(scope).workItems[0]?.status).toBe("succeeded");
  } finally {
    store.close();
  }
});

test("lost write reply reconciles the same remote event after restart without another PUT", async () => {
  let store = open();
  const op = approve(store);
  let written = false,
    puts = 0;
  const calendar = new CalDavCalendar(config, async (_url, options) => {
    if (options?.method === "PUT") {
      puts++;
      written = true;
      throw new Error("response lost");
    }
    return response(
      written ? 200 : 404,
      written ? calendarDocument(scope, op) : "",
    );
  });
  await new CalendarWorker(store, calendar).tick();
  expect(store.snapshot(scope).operations[0]?.status).toBe("result_unknown");
  store.close();
  now += 3000;
  store = open();
  try {
    await new CalendarWorker(store, calendar).tick();
    expect(store.snapshot(scope).operations).toHaveLength(1);
    expect(store.snapshot(scope).operations[0]?.result?.kind).toBe("calendar");
    expect(puts).toBe(1);
  } finally {
    store.close();
  }
});

test.each([412, 409])(
  "HTTP %i does not overwrite and succeeds only after a matching readback",
  async (status) => {
    const store = open();
    try {
      const op = approve(store);
      const { calendar, calls } = remote(op, status);
      expect((await calendar.execute(scope, op)).status).toBe("succeeded");
      expect(calls.filter((c) => c.options.method === "PUT")).toHaveLength(1);
    } finally {
      store.close();
    }
  },
);

test.each([401, 403, 500])(
  "HTTP %i remains unknown, never a false success or a new event identity",
  async (status) => {
    const store = open();
    try {
      const op = approve(store);
      const calls: string[] = [];
      const calendar = new CalDavCalendar(config, async (_url, init) => {
        calls.push(init!.method!);
        return response(status);
      });
      await new CalendarWorker(store, calendar).tick();
      expect(store.snapshot(scope).operations[0]?.status).toBe(
        "result_unknown",
      );
      expect(calls).toEqual(["GET"]);
      expect(op.id).toBe(store.snapshot(scope).operations[0]?.id);
    } finally {
      store.close();
    }
  },
);

test("different remote parameters or malformed data cannot count as success or be overwritten", async () => {
  const store = open();
  try {
    const op = approve(store);
    for (const content of [
      "bad ical",
      calendarDocument(scope, {
        ...op,
        parameters: { ...op.parameters, title: "Different title" },
      }),
    ]) {
      const calls: string[] = [];
      const calendar = new CalDavCalendar(config, async (_url, init) => {
        calls.push(init!.method!);
        return response(200, content);
      });
      expect(await calendar.execute(scope, op)).toMatchObject({
        status: "result_unknown",
        error: "remote_conflict",
        retry: false,
      });
      expect(calls).toEqual(["GET"]);
    }
    expect(
      verifyCalendarDocument(
        calendarDocument(scope, op).replace(
          "END:VEVENT",
          "ATTENDEE:mailto:someone@example.test\r\nEND:VEVENT",
        ),
        scope,
        op,
      ),
    ).toBe(false);
  } finally {
    store.close();
  }
});

test("scope or target changes cannot reuse credentials or old consent", async () => {
  const store = open();
  try {
    const op = approve(store);
    const transport = jest.fn();
    const calendar = new CalDavCalendar(config, transport);
    expect(
      (await calendar.execute({ ...scope, userId: "other" }, op)).status,
    ).toBe("result_unknown");
    expect(
      (
        await calendar.execute(scope, {
          ...op,
          parameters: {
            ...op.parameters,
            calendar: {
              ...config.target,
              collectionUrl: "https://other.test/",
            },
          },
        })
      ).status,
    ).toBe("result_unknown");
    expect(transport).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test("claim persistence failure prevents network I/O", async () => {
  const seed = open();
  approve(seed);
  seed.close();
  const store = new FixtureStorage(
    dir,
    scope.serverId,
    () => now,
    (stage, change) => {
      if (stage === "before_commit" && change === "calendar")
        throw Error("disk failure");
    },
    () => config.target,
  );
  const transport = jest.fn();
  try {
    await expect(
      new CalendarWorker(store, new CalDavCalendar(config, transport)).tick(),
    ).rejects.toThrow("disk failure");
    expect(transport).not.toHaveBeenCalled();
  } finally {
    store.close();
  }
});

test("bounded retries stay unknown; manual reconcile keeps the same approved operation", async () => {
  const store = open();
  try {
    approve(store);
    const worker = new CalendarWorker(
      store,
      new CalDavCalendar(config, async () => {
        throw Error("offline");
      }),
    );
    for (let i = 0; i < 8; i++) {
      await worker.tick();
      now += 60_000;
    }
    const op = store.snapshot(scope).operations[0]!;
    expect(op).toMatchObject({
      status: "result_unknown",
      error: "retry_exhausted",
    });
    expect(store.calendarJobs()).toHaveLength(0);
    const command = reconcileOperation(op, "check-again");
    expect(commandTarget(command)).toBe(op.id);
    expect(store.execute(scope, command).status).toBe("accepted");
    const { calendar } = remote(op);
    await new CalendarWorker(store, calendar).tick();
    expect(store.snapshot(scope).operations).toHaveLength(1);
    expect(store.snapshot(scope).operations[0]?.status).toBe("succeeded");
    expect(store.execute(scope, command).snapshot).toEqual(
      store.snapshot(scope),
    );
    expect(
      store.execute(scope, reconcileOperation(op, "stale-check")).status,
    ).toBe("conflict");
  } finally {
    store.close();
  }
});

test("old simulated proposals remain simulated after enabling integration, even when edited", () => {
  const engine = new FixtureEngine("a", undefined, undefined, () => now, scope);
  engine.execute(messageCommand("Choose Peter", "en", "start"));
  engine.execute(
    answerCommand(engine.snapshot().inputRequests[0]!, "peter-novak", "answer"),
  );
  now += 4000;
  engine.tick();
  const data = structuredClone(engine.data);
  Object.assign(data.snapshot, { profile: "agent-client/0.2-fixture" });
  const restored = new FixtureEngine(
    "a",
    data,
    undefined,
    () => now,
    scope,
    config.target,
  );
  expect(restored.snapshot().profile).toBe(PROFILE);
  const proposal = restored.snapshot().actionProposals[0]!;
  restored.execute(
    reviseProposal(
      proposal,
      "peter-svoboda",
      proposal.parameters.startsAt,
      "edit",
    ),
  );
  expect(
    restored.snapshot().actionProposals[0]?.parameters.calendar,
  ).toBeUndefined();
  restored.execute(
    proposalDecision(
      restored.snapshot().actionProposals[0]!,
      "approve",
      "approve",
    ),
  );
  now += 4000;
  restored.tick();
  now += 4000;
  restored.tick();
  expect(restored.snapshot().operations[0]?.result?.kind).toBe("simulated");
});

test("calendar binding is reviewed content and cannot change silently before approval", () => {
  const store = open();
  const p = prepare(store);
  store.close();
  const changed = new FixtureStorage(
    dir,
    scope.serverId,
    () => now,
    undefined,
    () => ({ ...config.target, label: "Another calendar" }),
  );
  try {
    expect(
      changed.execute(scope, proposalDecision(p, "approve", "approve")).code,
    ).toBe("integration_unavailable");
    expect(changed.snapshot(scope).operations).toHaveLength(0);
  } finally {
    changed.close();
  }
});

test.each([
  "http://remote.example/calendar/",
  "https://user:pass@remote.example/calendar/",
  "https://remote.example/calendar/?token=x",
  "https://remote.example/calendar",
])("rejects unsafe calendar URL %s", (collectionUrl) => {
  expect(
    CalendarConfigSchema.safeParse({
      ...config,
      target: { ...config.target, collectionUrl },
    }).success,
  ).toBe(false);
});
