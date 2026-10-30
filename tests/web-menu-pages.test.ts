import {
  ProcessLauncher,
  groupProcesses,
  pendingStart,
  recentRuns,
} from "../apps/server-admin/web/app/process-launch";
import {
  handOffComposerPicker,
  takeComposerHandoff,
  handOffHumanTask,
  takeHumanTask,
} from "../apps/server-admin/web/app/task-handoff";
import { menuCopy } from "../apps/server-admin/web/app/menu-copy";
import { personalProcessRows } from "../apps/server-admin/web/app/personal-processes";
import type { ProcessOfferResult } from "../packages/protocol/process-offer";
import type { ProcessExecutionEntry } from "../packages/protocol/process-execution";
import { processLaunchFixture } from "./helpers/process-launch-client";

const flush = async () => {
  for (let i = 0; i < 80; i++) await Promise.resolve();
};
const ids = () => {
  let id = 0;
  return () => `TEST-web-${++id}`;
};
const offer = (
  patch: Partial<ProcessOfferResult> = {},
): ProcessOfferResult => ({
  type: "process.offer",
  version: 1,
  processId: "TEST-process-B",
  processVersion: 1,
  artifactDigest: "a".repeat(64),
  name: "TEST process B",
  description: "TEST purpose B",
  kind: "workflow",
  reason: "TEST fits",
  input: { name: "TEST prefilled", undeclared: "TEST dropped" },
  ...patch,
});

test("a chat offer opens its exact version once, prefilled, and starts in the launcher's chat", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  const launcher = new ProcessLauncher(
    session,
    "en",
    // An existing chat: the launcher creates a missing one before starting.
    "conversation-1",
    offer(),
    ids(),
  );
  await launcher.load();
  await flush();
  let model = launcher.getSnapshot();
  expect(model.phase).toBe("editing");
  expect(model.offered).toBe(true);
  expect(model.selected?.processId).toBe("TEST-process-B");
  // Only values that fit a declared input survive.
  expect(model.reviewedInput).toEqual({ name: "TEST prefilled" });
  expect(h.commands).toHaveLength(0);

  launcher.review({ name: "TEST reviewed" });
  expect(launcher.getSnapshot().phase).toBe("review");
  launcher.edit();
  expect(launcher.getSnapshot().phase).toBe("editing");
  // Editing keeps the reviewed draft to start from.
  expect(launcher.getSnapshot().reviewedInput).toEqual({
    name: "TEST reviewed",
  });
  launcher.review({ name: "TEST reviewed" });
  await Promise.all([launcher.start(), launcher.start()]);
  await flush();
  model = launcher.getSnapshot();
  expect(h.commands).toHaveLength(1);
  const sent = JSON.parse(h.commands[0]!);
  expect(sent.input).toEqual({ name: "TEST reviewed" });
  expect(sent.conversationId).toBe("conversation-1");
  expect(model.phase).toBe("accepted");
  expect(pendingStart(session.getSnapshot())).toBeNull();

  // The offer was used; a reload is an ordinary choice.
  launcher.close();
  await launcher.load();
  await flush();
  expect(launcher.getSnapshot().phase).toBe("selection");
  expect(launcher.getSnapshot().selected).toBeNull();
  expect(launcher.getSnapshot().inventory?.processes).toHaveLength(3);
  launcher.dispose();
  session.stop();
});

test("a changed offer asks for a new choice, and blocked processes never open", async () => {
  const h = processLaunchFixture(),
    session = h.open();
  await session.start(false);
  const launcher = new ProcessLauncher(
    session,
    "cs",
    "conversation-1",
    offer({ processVersion: 2 }),
    ids(),
  );
  await launcher.load();
  await flush();
  expect(launcher.getSnapshot().error).toBe("processOfferUnavailable");
  expect(launcher.getSnapshot().selected).toBeNull();
  expect(h.inputRequests).toHaveLength(0);
  const blocked = launcher
    .getSnapshot()
    .inventory!.processes.find((entry) => entry.availability === "blocked")!;
  await launcher.open(blocked);
  expect(launcher.getSnapshot().selected).toBeNull();
  expect(h.inputRequests).toHaveLength(0);
  // An entry that is not from the current inventory is refused, too.
  await launcher.open({ ...h.entries[0]! });
  expect(h.inputRequests).toHaveLength(0);
  await launcher.open(launcher.getSnapshot().inventory!.processes[0]!);
  await flush();
  expect(launcher.getSnapshot().phase).toBe("editing");
  expect(launcher.getSnapshot().offered).toBe(false);
  expect(launcher.getSnapshot().reviewedInput).toBeNull();
  expect(h.inputRequests[0]!.language).toBe("cs");
  expect(recentRuns(session.getSnapshot())).toEqual([]);
  launcher.dispose();
  session.stop();
});

test("personal processes are grouped apart from the workspace's", () => {
  const entry = (id: string, personal?: true): ProcessExecutionEntry => ({
    availability: "blocked",
    reason: "model_unavailable",
    processId: id,
    name: id,
    description: "",
    kind: "workflow",
    version: 1,
    artifactDigest: "a".repeat(64),
    ...(personal ? { personal } : {}),
  });
  const groups = groupProcesses([
    entry("TEST-a"),
    entry("TEST-b", true),
    entry("TEST-c"),
  ]);
  expect(groups.mine.map((e) => e.processId)).toEqual(["TEST-b"]);
  expect(groups.company.map((e) => e.processId)).toEqual(["TEST-a", "TEST-c"]);
});

test("a task handed to chat is taken exactly once", () => {
  expect(takeHumanTask("TEST-actor")).toBeNull();
  handOffHumanTask({ id: "TEST-task", title: "TEST resolve me" }, "TEST-actor");
  expect(takeHumanTask("TEST-actor")).toEqual({
    id: "TEST-task",
    title: "TEST resolve me",
  });
  expect(takeHumanTask("TEST-actor")).toBeNull();
});

test("menu copy has the same keys in both languages", () => {
  expect(Object.keys(menuCopy.cs).sort()).toEqual(
    Object.keys(menuCopy.en).sort(),
  );
  for (const value of Object.values(menuCopy.cs)) expect(value).toBeTruthy();
});

test("my processes show drafts, tested, active and blocked states with a start only when ready", () => {
  const summary = (
    id: string,
    latestVersion: number,
    activeVersion: number | null,
    updatedAt: string,
  ) => ({
    id,
    revision: 1,
    name: id,
    kind: "workflow" as const,
    latestVersion,
    activeVersion,
    updatedAt,
    owner: { type: "user" as const, userId: "TEST-user" },
  });
  const base = {
    name: "TEST",
    description: "",
    kind: "workflow" as const,
    version: 1,
    artifactDigest: "a".repeat(64),
    personal: true as const,
  };
  const ready: ProcessExecutionEntry = {
    ...base,
    processId: "TEST-active",
    availability: "ready",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
  const blocked: ProcessExecutionEntry = {
    ...base,
    processId: "TEST-blocked",
    availability: "blocked",
    reason: "connection_required",
  };
  const rows = personalProcessRows(
    {
      processes: [
        summary("TEST-draft", 0, null, "2026-10-01T00:00:00.000Z"),
        summary("TEST-tested", 2, null, "2026-10-04T00:00:00.000Z"),
        summary("TEST-untested", 1, null, "2026-10-02T00:00:00.000Z"),
        summary("TEST-active", 3, 3, "2026-10-03T00:00:00.000Z"),
        summary("TEST-blocked", 1, 1, "2026-10-05T00:00:00.000Z"),
      ],
      latestTest: { "TEST-tested": "passed", "TEST-untested": "untested" },
    },
    [ready, blocked],
  );
  // Newest first, each with its own state.
  expect(rows.map((r) => [r.id, r.state])).toEqual([
    ["TEST-blocked", "blocked"],
    ["TEST-tested", "tested"],
    ["TEST-active", "active"],
    ["TEST-untested", "draft"],
    ["TEST-draft", "draft"],
  ]);
  expect(rows.find((r) => r.id === "TEST-active")?.start).toBe(ready);
  expect(rows.find((r) => r.id === "TEST-blocked")).toMatchObject({
    start: null,
    reason: "connection_required",
  });
  expect(rows.filter((r) => r.start)).toHaveLength(1);
});

test("picker handoff is identity-owned, consumed once and never replays to a foreign account", () => {
  handOffComposerPicker("TEST-A");
  expect(takeComposerHandoff("TEST-B")).toBeNull();
  expect(takeComposerHandoff("TEST-A")).toBeNull();
  handOffComposerPicker("TEST-A");
  expect(takeComposerHandoff("TEST-A")).toEqual({
    identityKey: "TEST-A",
    picker: true,
  });
  expect(takeComposerHandoff("TEST-A")).toBeNull();
  handOffHumanTask({ id: "TEST-task", title: "context" }, "TEST-A");
  expect(takeHumanTask("TEST-B")).toBeNull();
  expect(takeHumanTask("TEST-A")).toBeNull();
});
