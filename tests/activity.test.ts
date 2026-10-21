import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import { ModelError, type Decision } from "../apps/fixture-server/decision";
import { messageCommand } from "../packages/client-core/commands";
import type { CatalogRuntime } from "../apps/server-identity/catalog-runtime";
import {
  RequestActivitySchema,
  ActivityResponseSchema,
  legacyActivity,
  toolActivity,
  ACTIVITY_PROFILE,
  TOOL_ACTIVITY_PROFILE,
  LEGACY_ACTIVITY_PROFILE,
} from "../packages/protocol/activity";
import {
  scopeFor,
  requestActivity,
  pluginActivity,
  workflowActivity,
} from "../packages/test-fixtures";

const decision: Decision = {
  kind: "crm_contacts",
  reply: null,
  title: null,
  contactId: null,
  localStart: null,
  durationMinutes: null,
};
const gate = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
test.each(["accepted", "aborted", "policy", "missing-router", "inference"])(
  "catalog handoff keeps completed plugin work when fallback is %s",
  async (outcome) => {
    const dir = mkdtempSync(join(tmpdir(), "activity-handoff-"));
    const scope = scopeFor(),
      store = new FixtureStorage(dir, scope.serverId);
    const controller = new AbortController();
    let report: Parameters<CatalogRuntime["message"]>[5];
    const integrations: CatalogRuntime = {
      enabled: true,
      hasTurn: async () => false,
      resolve: async () => {
        throw Error("unused");
      },
      message: async (_id, _text, _lang, _history, _signal, update) => {
        report = update;
        update?.({ id: "datetime", calls: 1, status: "running" });
        update?.({ id: "datetime", calls: 1, status: "succeeded" });
        return null;
      },
    };
    const model = new ModelService(
      store,
      outcome === "missing-router"
        ? undefined
        : {
            timeZone: "Europe/Prague",
            decide: async () => {
              if (outcome === "inference")
                throw new ModelError("model_timeout");
              return {
                ...decision,
                kind: "reply",
                reply: "TEST date calculated",
              };
            },
          },
    );
    const access = {
      tools: {
        has: () => false,
        invoke: async () => {
          throw Error("unused");
        },
      },
      run: async <T>(fn: () => T) => fn(),
      runModel: async <T>(fn: () => T) => {
        if (outcome === "aborted") controller.abort();
        if (outcome === "policy") throw new ModelError("model_unavailable");
        return fn();
      },
      integrations,
    };
    const command = messageCommand("TEST date", "en", "handoff");
    try {
      const before = store.snapshot(scope);
      const pending = model.execute(
        scope,
        command,
        () => {},
        controller.signal,
        access,
      );
      if (outcome === "accepted")
        expect((await pending).status).toBe("accepted");
      else if (outcome === "missing-router")
        // No model at all is a settled refusal the app can move on from.
        expect((await pending).status).toBe("rejected");
      else {
        await expect(pending).rejects.toThrow();
        expect(store.snapshot(scope)).toEqual(before);
      }
      const final = RequestActivitySchema.parse(
        model.activity(scope, command.commandId),
      );
      expect(final.status).toBe(
        outcome === "accepted" ? "succeeded" : "failed",
      );
      expect(final.tools).toEqual([
        { id: "datetime", calls: 1, status: "succeeded" },
      ]);
      // A callback retained by an old executor cannot reopen completed progress.
      report?.({ id: "datetime", calls: 2, status: "running" });
      expect(model.activity(scope, command.commandId)).toEqual(final);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("interrupted catalog calculation cannot be marked successful", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-tool-error-"));
  const scope = scopeFor(),
    store = new FixtureStorage(dir, scope.serverId);
  const model = new ModelService(store, undefined);
  const command = messageCommand("TEST date", "en", "failed-tool");
  try {
    await expect(
      model.execute(scope, command, () => {}, new AbortController().signal, {
        tools: {
          has: () => false,
          invoke: async () => {
            throw Error("unused");
          },
        },
        run: async <T>(fn: () => T) => fn(),
        integrations: {
          enabled: true,
          hasTurn: async () => false,
          resolve: async () => {
            throw Error("unused");
          },
          message: async (_id, _text, _lang, _history, _signal, report) => {
            report?.({ id: "datetime", calls: 1, status: "running" });
            throw new ModelError("model_timeout");
          },
        },
      }),
    ).rejects.toThrow("model_timeout");
    const final = RequestActivitySchema.parse(
      model.activity(scope, command.commandId),
    );
    expect(final.status).toBe("failed");
    expect(final.tools).toEqual([
      { id: "datetime", calls: 1, status: "failed" },
    ]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("catalog handoff joins an identical request and guards other commands while fallback preparation awaits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-overlap-"));
  const scope = scopeFor(),
    store = new FixtureStorage(dir, scope.serverId);
  const entered = gate<void>(),
    release = gate<void>();
  const decide = jest.fn(async () => ({
    ...decision,
    kind: "reply" as const,
    reply: "TEST ready",
  }));
  const model = new ModelService(store, {
    timeZone: "UTC",
    decide,
  });
  const integrations: CatalogRuntime = {
    enabled: true,
    hasTurn: async () => false,
    resolve: async () => {
      throw Error("unused");
    },
    message: jest.fn(async (_id, _text, _lang, _history, _signal, report) => {
      report?.({ id: "datetime", calls: 1, status: "succeeded" });
      return null;
    }),
  };
  const access = {
    tools: {
      has: () => false,
      invoke: async () => {
        throw Error("unused");
      },
    },
    run: async <T>(fn: () => T) => fn(),
    runModel: async <T>(fn: () => T) => {
      entered.resolve();
      await release.promise;
      return fn();
    },
    integrations,
  };
  const command = messageCommand("TEST date", "en", "overlap");
  const first = model.execute(
    scope,
    command,
    () => {},
    new AbortController().signal,
    access,
  );
  let duplicate: ReturnType<ModelService["execute"]> | undefined;
  try {
    await entered.promise;
    duplicate = model.execute(
      scope,
      command,
      () => {},
      new AbortController().signal,
      access,
    );
    await expect(
      model.execute(
        scope,
        messageCommand("Another date", "en", "different-command"),
        () => {},
        new AbortController().signal,
        access,
      ),
    ).rejects.toThrow("model_busy");
    expect(integrations.message).toHaveBeenCalledTimes(1);
    expect(decide).not.toHaveBeenCalled();
    expect(model.activity(scope, command.commandId)?.status).toBe("running");
    release.resolve();
    const [accepted, joined] = await Promise.all([first, duplicate]);
    expect(accepted.status).toBe("accepted");
    expect(joined).toEqual(accepted);
    expect(integrations.message).toHaveBeenCalledTimes(1);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(
      RequestActivitySchema.parse(model.activity(scope, command.commandId))
        .status,
    ).toBe("succeeded");
  } finally {
    release.resolve();
    await Promise.allSettled([first, ...(duplicate ? [duplicate] : [])]);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("progress follows actual inference and CRM completion, isolates scope, expires, and replay does not run again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "activity-"));
  const scope = scopeFor();
  const store = new FixtureStorage(dir, scope.serverId);
  const inference = gate<Decision>(),
    startedInference = gate<void>(),
    crm = gate<[]>(),
    startedCrm = gate<void>();
  const decide = jest.fn(() => {
    startedInference.resolve();
    return inference.promise;
  });
  const list = jest.fn(() => {
    startedCrm.resolve();
    return crm.promise;
  });
  let now = Date.now();
  const model = new ModelService(
    store,
    { timeZone: "Europe/Prague", decide },
    () => now,
    { list },
  );
  const command = messageCommand("TEST contacts", "en", "activity");
  try {
    const before = store.snapshot(scope);
    const result = model.execute(
      scope,
      command,
      () => {},
      new AbortController().signal,
    );
    await startedInference.promise;
    expect(model.activity(scope, command.commandId)?.steps).toEqual([
      { id: "understanding", status: "running" },
      { id: "preparing", status: "pending" },
    ]);
    expect(list).not.toHaveBeenCalled();
    expect(
      model.activity({ ...scope, userId: "other" }, command.commandId),
    ).toBeNull();
    inference.resolve(decision);
    await startedCrm.promise;
    expect(
      RequestActivitySchema.parse(model.activity(scope, command.commandId))
        .steps,
    ).toEqual(requestActivity().steps);
    expect(store.snapshot(scope)).toEqual(before);
    crm.resolve([]);
    expect((await result).status).toBe("accepted");
    const complete = RequestActivitySchema.parse(
      model.activity(scope, command.commandId),
    );
    expect(complete.status).toBe("succeeded");
    expect(complete.steps.every((step) => step.status === "succeeded")).toBe(
      true,
    );
    await model.execute(scope, command, () => {}, new AbortController().signal);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledTimes(1);
    expect(store.snapshot(scope).operations).toEqual([]);
    now += 300_001;
    expect(model.activity(scope, command.commandId)).toBeNull();
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["inference", "crm", "revoked", "aborted"])(
  "%s failure leaves no false completion or workflow mutation",
  async (failure) => {
    const dir = mkdtempSync(join(tmpdir(), "activity-error-"));
    const scope = scopeFor(),
      store = new FixtureStorage(dir, scope.serverId);
    const controller = new AbortController();
    let revoked = false;
    const model = new ModelService(
      store,
      {
        timeZone: "Europe/Prague",
        decide: async () => {
          revoked = failure === "revoked";
          if (failure === "inference") throw new ModelError("model_timeout");
          if (failure === "aborted") controller.abort();
          return decision;
        },
      },
      undefined,
      {
        list: async () => {
          throw new Error("private upstream detail");
        },
      },
    );
    const command = messageCommand("test", "en", "failed");
    try {
      const before = store.snapshot(scope);
      await expect(
        model.execute(
          scope,
          command,
          () => {
            if (revoked) throw new Error("auth_expired");
          },
          controller.signal,
        ),
      ).rejects.toThrow();
      const activity = RequestActivitySchema.parse(
        model.activity(scope, command.commandId),
      );
      expect(activity.status).toBe("failed");
      expect(
        activity.steps.filter((step) => step.status === "failed"),
      ).toHaveLength(1);
      expect(activity.steps.some((step) => step.status === "running")).toBe(
        false,
      );
      expect(JSON.stringify(activity)).not.toContain("private");
      expect(store.snapshot(scope)).toEqual(before);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test("activity schema rejects invented stages, authority, duplicate steps and impossible completion", () => {
  const activity = requestActivity();
  for (const value of [
    { ...activity, style: "remote" },
    { ...activity, status: "succeeded" },
    { ...activity, steps: [...activity.steps, activity.steps[0]] },
    {
      ...activity,
      steps: [
        { id: "calendar_approved", status: "running" },
        activity.steps[2],
      ],
    },
    {
      ...activity,
      steps: activity.steps.map((step) => ({ ...step, status: "running" })),
    },
  ])
    expect(RequestActivitySchema.safeParse(value).success).toBe(false);
});
test("versioned plugin activity is bounded and never leaks into the legacy wire shape", () => {
  const activity = pluginActivity("succeeded");
  const envelope = { scope: scopeFor(), commandId: activity.commandId };
  expect(
    ActivityResponseSchema.parse({
      ...envelope,
      profile: ACTIVITY_PROFILE,
      activity,
    }).activity,
  ).toEqual(activity);
  expect(
    ActivityResponseSchema.parse({
      ...envelope,
      profile: LEGACY_ACTIVITY_PROFILE,
      activity: legacyActivity(activity),
    }).activity,
  ).not.toHaveProperty("tools");
  expect(
    ActivityResponseSchema.safeParse({
      ...envelope,
      profile: LEGACY_ACTIVITY_PROFILE,
      activity,
    }).success,
  ).toBe(false);
  for (const tools of [
    [{ id: "unknown", status: "running", calls: 1 }],
    [{ id: "datetime", status: "running", calls: 5 }],
    [{ id: "datetime", status: "succeeded", calls: 1, input: "private" }],
    [...activity.tools!, ...activity.tools!],
  ])
    expect(
      RequestActivitySchema.safeParse({ ...activity, tools }).success,
    ).toBe(false);
  expect(
    RequestActivitySchema.safeParse({
      ...pluginActivity(),
      status: "succeeded",
      steps: activity.steps.map((s) => ({ ...s, status: "succeeded" })),
    }).success,
  ).toBe(false);
});
test("workflow activity is bounded and older profiles preserve only their supported fields", () => {
  const activity = {
    ...workflowActivity({ step: 5, stage: "execute" }),
    tools: pluginActivity("succeeded").tools,
  };
  const envelope = { scope: scopeFor(), commandId: activity.commandId };
  expect(
    ActivityResponseSchema.parse({
      ...envelope,
      profile: ACTIVITY_PROFILE,
      activity,
    }).activity,
  ).toEqual(activity);
  expect(
    ActivityResponseSchema.parse({
      ...envelope,
      profile: TOOL_ACTIVITY_PROFILE,
      activity: toolActivity(activity),
    }).activity,
  ).toEqual({ ...legacyActivity(activity), tools: activity.tools });
  expect(
    ActivityResponseSchema.parse({
      ...envelope,
      profile: LEGACY_ACTIVITY_PROFILE,
      activity: legacyActivity(activity),
    }).activity,
  ).toEqual(legacyActivity(activity));
  for (const profile of [TOOL_ACTIVITY_PROFILE, LEGACY_ACTIVITY_PROFILE])
    expect(
      ActivityResponseSchema.safeParse({ ...envelope, profile, activity })
        .success,
    ).toBe(false);
  for (const workflow of [
    { step: 0, stage: "service" },
    { step: 6, stage: "execute" },
    { step: 1.5, stage: "action" },
    { step: 1, stage: "approved" },
    { step: 1, stage: "inputs", label: "private model text" },
    { step: 1 },
    null,
  ])
    expect(
      RequestActivitySchema.safeParse({ ...activity, workflow }).success,
    ).toBe(false);
  for (const stage of ["service", "action", "inputs", "execute"])
    expect(
      RequestActivitySchema.safeParse({
        ...activity,
        workflow: { step: 1, stage },
      }).success,
    ).toBe(true);
  expect(toolActivity(null)).toBeNull();
  expect(legacyActivity(null)).toBeNull();
});
