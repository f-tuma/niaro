import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { HubStore } from "../apps/server-identity/hub-store";
import { createHub } from "../apps/server-identity/hub";
import {
  HUB_SCHEDULE_DEFAULTS,
  HubScheduler,
  hubScheduleDue,
  type HubScheduleSettings,
} from "../apps/server-identity/hub-scheduler";
import {
  HUB_PROFILE_V3,
  HubDashboardV3Schema,
  type HubDashboardV3,
  type HubRefresh,
} from "../packages/protocol/hub";
import { coordinatorHttpFixture } from "./helpers/process-coordinator-http";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const org = "TEST-org";
const ws1 = "11111111-1111-4111-8111-111111111111";
const ws2 = "22222222-2222-4222-8222-222222222222";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Person = { userId: string; workspaceId: string };
const anna = { userId: "TEST-anna", workspaceId: ws1 };
const bob = { userId: "TEST-bob", workspaceId: ws1 };
const carol = { userId: "TEST-carol", workspaceId: ws2 };
const actorOf = (person: Person) => ({
  organizationId: org,
  workspaceId: person.workspaceId,
  userId: person.userId,
  role: "member" as const,
});
const scopeOf = (person: Person) => ({
  connectionId: `account-${person.workspaceId}`,
  serverId: "TEST-server",
  workspaceId: person.workspaceId,
  userId: person.userId,
});

function fixture(settings: Partial<HubScheduleSettings> = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE organization(id TEXT PRIMARY KEY);
    CREATE TABLE user(id TEXT PRIMARY KEY);
    CREATE TABLE member(id TEXT PRIMARY KEY, "organizationId" TEXT REFERENCES organization(id) ON DELETE CASCADE, "userId" TEXT REFERENCES user(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace(id TEXT PRIMARY KEY, organization_id TEXT REFERENCES organization(id) ON DELETE CASCADE);
    CREATE TABLE agent_workspace_member(workspace_id TEXT NOT NULL REFERENCES agent_workspace(id) ON DELETE CASCADE, member_id TEXT NOT NULL REFERENCES member(id) ON DELETE CASCADE, PRIMARY KEY(workspace_id, member_id)) STRICT;
    INSERT INTO organization VALUES ('${org}');
    INSERT INTO user VALUES ('TEST-anna'), ('TEST-bob'), ('TEST-carol');
    INSERT INTO member VALUES ('TEST-m-anna','${org}','TEST-anna'), ('TEST-m-bob','${org}','TEST-bob'), ('TEST-m-carol','${org}','TEST-carol');
    INSERT INTO agent_workspace VALUES ('${ws1}','${org}'), ('${ws2}','${org}');
    INSERT INTO agent_workspace_member VALUES ('${ws1}','TEST-m-anna'), ('${ws1}','TEST-m-bob'), ('${ws2}','TEST-m-carol');`);
  let now = Date.parse("2026-10-16T08:00:00.000Z");
  const store = new HubStore(db, () => now);
  const hub = createHub({
    store,
    processes: {
      unattendedEffect: () => "read",
      activeOutputSchema: () => undefined,
      executionInventory: (_actor, scope) => ({
        profile: "agent-process-execution/1",
        scope,
        fingerprint: "f".repeat(64),
        processes: [],
        nextAfter: null,
      }),
    },
    starts: () => undefined,
    journal: () => undefined,
    humanTasks: { open: () => [], openCount: () => 0 },
    timeZone: () => "Europe/Prague",
    services: () => [],
    now: () => now,
  });
  const launched: string[] = [];
  const logs: Record<string, unknown>[] = [];
  let launchFails = false;
  const scheduler = new HubScheduler(
    {
      scheduled: () => hub.scheduled(),
      // The identity service's part: re-check the owner, mark the item, run.
      launch: (entry) => {
        if (launchFails) throw Error("TEST launch failed");
        launched.push(entry.item.id);
        const person = {
          userId: entry.owner.userId,
          workspaceId: entry.owner.workspaceId,
        };
        return hub.schedule(actorOf(person), scopeOf(person), entry.item.id);
      },
      log: (fields) => logs.push(fields),
      now: () => now,
    },
    { ...HUB_SCHEDULE_DEFAULTS, intervalSeconds: 0, ...settings },
  );
  const v3 = (person: Person, command: Record<string, unknown>) =>
    hub.command(actorOf(person), scopeOf(person), "cs", {
      profile: HUB_PROFILE_V3,
      ...command,
    }) as { view: HubDashboardV3; refresh: string[] };
  /** Adds an AI widget (its first fill starts) and completes that fill. */
  const add = (person: Person, refresh: HubRefresh, type = "briefing") => {
    const before = new Set(
      hub
        .cards(actorOf(person), scopeOf(person), "cs")
        .items.map((item) => item.id),
    );
    const { view } = v3(person, {
      type: "add",
      kind: "widget",
      widget: { type },
      refresh,
    });
    return view.items.find((item) => !before.has(item.id))!.id;
  };
  const succeed = (person: Person, id: string) => {
    const request = hub.fillRequest(actorOf(person), id);
    hub.fillDone(actorOf(person), id, request, {
      data: { summary: "TEST", highlights: [] },
      recipe: null,
    });
    hub.release(scopeOf(person), id);
  };
  const fail = (person: Person, id: string, error = "hub_fill_failed") => {
    hub.record(actorOf(person), scopeOf(person), id, { type: "failed", error });
    hub.release(scopeOf(person), id);
  };
  const card = (person: Person, id: string) =>
    hub
      .cards(actorOf(person), scopeOf(person), "cs")
      .items.find((item) => item.id === id)!;
  return {
    db,
    store,
    hub,
    scheduler,
    launched,
    logs,
    v3,
    add,
    succeed,
    fail,
    card,
    open: (person: Person) => hub.opened(actorOf(person), "cs"),
    advance: (ms: number) => {
      now += ms;
    },
    now: () => now,
    breakLaunch: () => {
      launchFails = true;
    },
  };
}

test("the scheduler fills hourly widgets after an hour and daily after a day; on_open, manual and built-ins never", async () => {
  const f = fixture();
  f.open(anna);
  const hourly = f.add(anna, "hourly");
  const daily = f.add(anna, "daily");
  const onOpen = f.add(anna, "on_open");
  const manual = f.add(anna, "manual");
  const meetings = f.add(anna, "on_open", "meetings");
  f.v3(anna, { type: "setRefresh", itemId: meetings, refresh: "hourly" });
  for (const id of [hourly, daily, onOpen, manual]) f.succeed(anna, id);
  assert.equal(f.card(anna, hourly).result?.source, "manual");
  // Fresh: nothing is due.
  assert.deepEqual(await f.scheduler.tick(), {
    due: 0,
    started: 0,
    skipped: 0,
    reasons: {},
  });
  f.advance(59 * MINUTE);
  assert.equal((await f.scheduler.tick()).due, 0);
  f.advance(MINUTE);
  assert.deepEqual(await f.scheduler.tick(), {
    due: 1,
    started: 1,
    skipped: 0,
    reasons: {},
  });
  assert.deepEqual(f.launched, [hourly]);
  const running = f.card(anna, hourly).result;
  assert.equal(running?.status, "running");
  assert.equal(running?.source, "schedule");
  assert.equal(running?.producedAt, "2026-10-16T08:00:00.000Z");
  f.succeed(anna, hourly);
  const done = f.card(anna, hourly).result;
  assert.equal(done?.status, "succeeded");
  assert.equal(done?.source, "schedule");
  assert.equal(done?.producedAt, new Date(f.now()).toISOString());
  // A day later both are due; the daily one holds the older data and goes
  // first, one fill per person per tick.
  f.advance(23 * HOUR);
  assert.deepEqual(await f.scheduler.tick(), {
    due: 2,
    started: 1,
    skipped: 1,
    reasons: { person_busy: 1 },
  });
  assert.deepEqual(f.launched, [hourly, daily]);
  // While it runs, the other waits.
  assert.deepEqual((await f.scheduler.tick()).reasons, { running: 1 });
  f.succeed(anna, daily);
  assert.equal((await f.scheduler.tick()).started, 1);
  f.succeed(anna, hourly);
  f.advance(10 * DAY);
  await f.scheduler.tick();
  assert(!f.launched.includes(onOpen));
  assert(!f.launched.includes(manual));
  assert(!f.launched.includes(meetings));
  // The item's own setting decides, read fresh on every tick.
  f.v3(anna, { type: "setRefresh", itemId: manual, refresh: "hourly" });
  f.succeed(anna, daily);
  f.succeed(anna, hourly);
  assert.equal((await f.scheduler.tick()).started, 1);
  assert.equal(f.launched.at(-1), manual);
  // One log line per tick with work in it.
  assert.deepEqual(f.logs.at(-1), { due: 1, started: 1, skipped: 0 });
  assert.equal(
    hubScheduleDue(
      { kind: "widget", refresh: "hourly", result: null, widget: null },
      f.now(),
    ),
    false,
  );
  assert.equal(
    hubScheduleDue(
      {
        kind: "widget",
        refresh: "hourly",
        result: null,
        widget: {
          type: "briefing",
          version: 1,
          brief: "x",
          config: {},
          sources: [],
          data: null,
          recipe: null,
          requested: false,
        },
      },
      f.now(),
    ),
    true,
  );
});

test("a failed scheduled fill waits an hour, six after two in a row, until any success", async () => {
  const f = fixture();
  f.open(anna);
  f.open(bob);
  f.open(carol);
  const a = f.add(anna, "hourly");
  const b = f.add(bob, "hourly");
  const c = f.add(carol, "hourly");
  for (const [person, id] of [
    [anna, a],
    [bob, b],
    [carol, c],
  ] as const)
    f.succeed(person, id);
  f.advance(HOUR);
  assert.equal((await f.scheduler.tick()).started, 3);
  f.fail(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  const failed = f.card(anna, a).result;
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.source, "schedule");
  // Backoff: an hour from the failed start.
  assert.deepEqual((await f.scheduler.tick()).reasons, { backoff: 1 });
  f.advance(59 * MINUTE);
  assert.deepEqual((await f.scheduler.tick()).reasons, { backoff: 1 });
  f.advance(MINUTE);
  const second = await f.scheduler.tick();
  assert.equal(second.started, 3);
  f.fail(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  // Twice in a row: six hours.
  f.advance(2 * HOUR);
  assert.deepEqual((await f.scheduler.tick()).reasons, { backoff: 1 });
  assert.equal(f.launched.filter((id) => id === a).length, 2);
  f.advance(4 * HOUR);
  assert.equal(f.launched.filter((id) => id === a).length, 2);
  await f.scheduler.tick();
  assert.equal(f.launched.filter((id) => id === a).length, 3);
  f.succeed(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  // A success resets the count: the next failure waits an hour again.
  f.advance(HOUR);
  await f.scheduler.tick();
  f.fail(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  f.advance(HOUR + MINUTE);
  await f.scheduler.tick();
  assert.equal(f.launched.filter((id) => id === a).length, 5);
  // A streak of scheduled failures is not broken by the person's own failed
  // refresh, only by a success (theirs or the scheduler's).
  f.fail(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  assert.deepEqual((await f.scheduler.tick()).reasons, { backoff: 1 });
  f.v3(anna, { type: "refresh", itemIds: [a] });
  assert.equal(f.card(anna, a).result?.source, "manual");
  f.fail(anna, a);
  f.advance(HOUR);
  assert.deepEqual((await f.scheduler.tick()).reasons, { backoff: 1 });
  f.succeed(bob, b);
  f.succeed(carol, c);
  f.v3(anna, { type: "refresh", itemIds: [a] });
  f.succeed(anna, a);
  f.advance(HOUR);
  assert.equal((await f.scheduler.tick()).started, 3);
  f.fail(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  f.advance(HOUR);
  assert.equal((await f.scheduler.tick()).started, 3);
});

test("a budget refusal pauses the workspace's scheduled fills for an hour; other workspaces go on", async () => {
  const f = fixture({ maxPerTick: 1 });
  for (const person of [anna, bob, carol]) f.open(person);
  const a = f.add(anna, "hourly");
  const b = f.add(bob, "hourly");
  const c = f.add(carol, "hourly");
  f.succeed(anna, a);
  f.succeed(bob, b);
  f.succeed(carol, c);
  f.advance(HOUR);
  const first = await f.scheduler.tick();
  assert.equal(first.started, 1);
  assert.deepEqual(f.launched, [a]);
  f.fail(anna, a, "catalog_budget_exhausted");
  // Anna's workspace waits (Bob too); Carol's is another workspace.
  const paused = await f.scheduler.tick();
  assert.deepEqual(paused.reasons, { budget: 2 });
  assert.equal(paused.started, 1);
  assert.deepEqual(f.launched, [a, c]);
  f.succeed(carol, c);
  f.advance(59 * MINUTE);
  assert.deepEqual((await f.scheduler.tick()).reasons, { budget: 2 });
  f.advance(2 * MINUTE);
  const resumed = await f.scheduler.tick();
  assert.equal(resumed.started, 1);
  assert.deepEqual(resumed.reasons, { limit: 2 });
});

test("people who have not opened their hub in idleDays are left alone", async () => {
  const f = fixture({ idleDays: 14 });
  const a = f.add(anna, "hourly");
  const b = f.add(bob, "hourly");
  f.succeed(anna, a);
  f.succeed(bob, b);
  f.open(anna);
  f.advance(HOUR);
  // Bob never opened his hub (no read_at); Anna did.
  assert.deepEqual(await f.scheduler.tick(), {
    due: 2,
    started: 1,
    skipped: 1,
    reasons: { idle: 1 },
  });
  assert.deepEqual(f.launched, [a]);
  f.succeed(anna, a);
  f.advance(14 * DAY);
  assert.deepEqual((await f.scheduler.tick()).reasons, { idle: 2 });
  f.open(bob);
  assert.equal((await f.scheduler.tick()).started, 1);
  assert.equal(f.launched.at(-1), b);
  f.succeed(bob, b);
  // Anna has been away for a fortnight meanwhile.
  f.advance(HOUR);
  assert.deepEqual((await f.scheduler.tick()).reasons, { idle: 1 });
  f.open(anna);
  assert.equal((await f.scheduler.tick()).started, 1);
  const row = f.db
    .prepare("SELECT read_at FROM agent_hub WHERE user_id = 'TEST-anna'")
    .get();
  assert.equal(row?.read_at, new Date(f.now()).toISOString());
});

test("at most maxPerTick fills per tick and one per person; a launch that fails starts nothing", async () => {
  const f = fixture({ maxPerTick: 2 });
  for (const person of [anna, bob, carol]) f.open(person);
  const a1 = f.add(anna, "hourly");
  const a2 = f.add(anna, "daily");
  const b = f.add(bob, "hourly");
  const c = f.add(carol, "hourly");
  f.succeed(anna, a1);
  f.succeed(anna, a2);
  f.succeed(bob, b);
  f.succeed(carol, c);
  f.advance(DAY);
  const first = await f.scheduler.tick();
  assert.equal(first.due, 4);
  assert.equal(first.started, 2);
  assert.deepEqual(first.reasons, { person_busy: 1, limit: 1 });
  assert.equal(f.launched.length, 2);
  assert.equal(new Set(f.launched).size, 2);
  // The person with a fill running waits; the rest take the next tick.
  const second = await f.scheduler.tick();
  assert.equal(second.started, 1);
  assert.equal(f.launched.length, 3);
  assert.deepEqual(new Set(f.launched), new Set([a1, b, c]));
  for (const [person, id] of [
    [anna, a1],
    [bob, b],
    [carol, c],
  ] as const)
    f.succeed(person, id);
  assert.equal((await f.scheduler.tick()).started, 1);
  assert.equal(f.launched.at(-1), a2);
  f.succeed(anna, a2);
  f.breakLaunch();
  f.advance(HOUR);
  const broken = await f.scheduler.tick();
  assert.equal(broken.started, 0);
  assert.equal(broken.due, 3);
  assert.equal(f.card(anna, a1).result?.status, "succeeded");
});

test("a refresh the person starts while a scheduled fill runs is coalesced, and vice versa", async () => {
  const f = fixture();
  f.open(anna);
  const id = f.add(anna, "hourly");
  f.succeed(anna, id);
  f.advance(HOUR);
  assert.equal((await f.scheduler.tick()).started, 1);
  const running = f.card(anna, id).result;
  assert.equal(running?.status, "running");
  assert.equal(running?.source, "schedule");
  // The person's refresh (button and open) starts nothing new.
  assert.deepEqual(f.v3(anna, { type: "refresh", itemIds: [id] }).refresh, []);
  assert.deepEqual(f.v3(anna, { type: "refresh", stale: true }).refresh, []);
  assert.deepEqual(f.card(anna, id).result, running);
  assert.equal(f.launched.length, 1);
  f.succeed(anna, id);
  assert.equal(f.card(anna, id).result?.source, "schedule");
  // The other way round: the person's fill runs, the scheduler leaves it.
  f.advance(HOUR);
  assert.deepEqual(f.v3(anna, { type: "refresh", stale: true }).refresh, [id]);
  assert.equal(f.card(anna, id).result?.source, "open");
  assert.deepEqual(await f.scheduler.tick(), {
    due: 0,
    started: 0,
    skipped: 0,
    reasons: {},
  });
  assert.equal(f.launched.length, 1);
  f.succeed(anna, id);
  assert.equal(f.card(anna, id).result?.source, "open");
  // The schedule start itself refuses an item that is running or removed.
  f.advance(HOUR);
  f.v3(anna, { type: "refresh", itemIds: [id] });
  assert.equal(f.hub.schedule(actorOf(anna), scopeOf(anna), id), false);
  f.succeed(anna, id);
  f.v3(anna, { type: "remove", itemId: id });
  assert.equal(f.hub.schedule(actorOf(anna), scopeOf(anna), id), false);
});

test("every tick sweeps first; a failed sweep stops nothing", async () => {
  let sweeps = 0;
  const scheduler = new HubScheduler(
    {
      scheduled: () => [],
      launch: () => false,
      sweep: () => {
        if (++sweeps === 1) throw Error("TEST sweep failed");
      },
    },
    { ...HUB_SCHEDULE_DEFAULTS, intervalSeconds: 0 },
  );
  assert.equal((await scheduler.tick()).due, 0);
  await scheduler.tick();
  assert.equal(sweeps, 2);
  await scheduler.stop();
  await scheduler.tick();
  assert.equal(sweeps, 2);
});

test("interval 0 disables the scheduler; a started one ticks until it is stopped", async () => {
  const off = fixture({ intervalSeconds: 0 });
  assert.equal(off.scheduler.start(), false);
  assert.equal(off.scheduler.active, false);
  await off.scheduler.stop();

  const f = fixture({ intervalSeconds: 0.02 });
  f.open(anna);
  const id = f.add(anna, "hourly");
  f.succeed(anna, id);
  f.advance(HOUR);
  assert.equal(f.scheduler.start(), true);
  assert.equal(f.scheduler.start(), false);
  assert.equal(f.scheduler.active, true);
  for (let i = 0; i < 50 && !f.launched.length; i++) await sleep(20);
  assert.deepEqual(f.launched, [id]);
  await f.scheduler.stop();
  assert.equal(f.scheduler.active, false);
  f.succeed(anna, id);
  f.advance(HOUR);
  const logged = f.logs.length;
  await sleep(100);
  assert.equal(f.launched.length, 1);
  assert.equal(f.logs.length, logged);
  // Stopped for good: neither the timer nor a pass starts again.
  assert.equal(f.scheduler.start(), false);
  assert.equal((await f.scheduler.tick()).due, 0);
});

test(
  'over the app API a scheduled fill runs under the person\'s own authority, shows source "schedule", and opening the hub does not fill it again within the hour',
  { timeout: 120000 },
  async () => {
    const h = await coordinatorHttpFixture();
    try {
      const member = await h.pair("member");
      const hub = (body?: unknown) =>
        h.mobile(
          member,
          `hub?language=cs&profile=${encodeURIComponent(HUB_PROFILE_V3)}`,
          body,
        );
      let fills = 0;
      h.onModel((request) => {
        const tools = (request as { tools?: unknown[] }).tools;
        const outputs = (request.messages ?? [])
          .filter((message) => message.role === "tool")
          .map((message) =>
            JSON.parse(String((message as { content: unknown }).content)),
          );
        if (!tools?.length) {
          fills++;
          return {
            content: JSON.stringify({
              items: [{ title: `TEST-fill-${fills}`, meta: "TEST" }],
            }),
          };
        }
        const call = (name: string, args: unknown) => ({
          content: null,
          tool_calls: [
            {
              id: `TEST-call-${outputs.length}`,
              type: "function",
              function: { name, arguments: JSON.stringify(args) },
            },
          ],
        });
        if (!outputs.length)
          return call("find_actions", {
            service: "TEST design service",
            need: "lookup",
          });
        if (outputs.length === 1)
          return call("read", {
            action: outputs[0].actions[0].action,
            input: { name: "TEST" },
          });
        return { content: "TEST done" };
      });
      await h.catalog({
        type: "saveRouting",
        routing: { revision: 0, modelId: h.modelId, services: [] },
      });
      const added = await hub({
        profile: HUB_PROFILE_V3,
        type: "add",
        kind: "widget",
        widget: { type: "list", brief: "TEST výsledky vyhledávání" },
        refresh: "hourly",
      });
      assert.equal(added.status, 200, JSON.stringify(added.data));
      const id = HubDashboardV3Schema.parse(added.data).items.find(
        (item) => item.kind === "widget",
      )!.id;
      const read = async () => {
        const response = await hub();
        assert.equal(response.status, 200);
        return HubDashboardV3Schema.parse(response.data).items.find(
          (item) => item.id === id,
        )!;
      };
      const settled = async () => {
        let card = await read();
        for (let i = 0; i < 200 && card.result?.status === "running"; i++) {
          await sleep(100);
          card = await read();
        }
        return card;
      };
      const first = await settled();
      assert.equal(first.result?.status, "succeeded", JSON.stringify(first));
      assert.equal(first.result?.source, "manual");
      assert.deepEqual(h.dispatches, ["GET"]);
      // Nothing is due yet: a tick starts nothing.
      const idle = await h.identity.hubScheduleTick();
      assert.equal(idle.due, 0);
      // The data ages past the hour (the clock is the server's own).
      const db = h.identity["db"] as DatabaseSync;
      const aged = new Date(Date.now() - 2 * HOUR).toISOString();
      db.prepare(
        "UPDATE agent_hub_item SET result = json_set(result, '$.producedAt', ?, '$.startedAt', ?) WHERE id = ?",
      ).run(aged, aged, id);
      assert.equal((await read()).stale, true);
      const tick = await h.identity.hubScheduleTick();
      assert.equal(tick.started, 1, JSON.stringify(tick));
      const scheduled = await settled();
      assert.equal(
        scheduled.result?.status,
        "succeeded",
        JSON.stringify(scheduled),
      );
      assert.equal(scheduled.result?.source, "schedule");
      assert.notEqual(scheduled.result?.producedAt, aged);
      assert.deepEqual(scheduled.widget?.data, {
        items: [{ title: "TEST-fill-2", meta: "TEST" }],
      });
      // One more read under the member's own authority, nothing else.
      assert.deepEqual(h.dispatches, ["GET", "GET"]);
      // Fresh again: opening the hub refreshes nothing, and nor does a tick.
      assert.equal(scheduled.stale, false);
      const opened = await hub({
        profile: HUB_PROFILE_V3,
        type: "refresh",
        stale: true,
      });
      assert.equal(opened.status, 200);
      const after = HubDashboardV3Schema.parse(opened.data).items.find(
        (item) => item.id === id,
      )!;
      assert.equal(after.result?.status, "succeeded");
      assert.equal(after.result?.producedAt, scheduled.result?.producedAt);
      assert.equal(after.result?.source, "schedule");
      assert.equal((await h.identity.hubScheduleTick()).due, 0);
      await sleep(200);
      assert.deepEqual(h.dispatches, ["GET", "GET"]);
      // Opened items past their day in the index go with the next tick.
      const detail = db.prepare(
        "INSERT INTO agent_hub_item_detail (workspace_id, member_id, item_id, ref, detail, fetched_at, recipe_revision) SELECT workspace_id, member_id, id, ?, '{}', ?, 0 FROM agent_hub_item WHERE id = ?",
      );
      detail.run("TEST-old", new Date(Date.now() - 2 * DAY).toISOString(), id);
      detail.run("TEST-new", new Date().toISOString(), id);
      await h.identity.hubScheduleTick();
      assert.deepEqual(
        db
          .prepare("SELECT ref FROM agent_hub_item_detail WHERE item_id = ?")
          .all(id)
          .map((row) => row.ref),
        ["TEST-new"],
      );
      // Signed out everywhere: due again, but nothing runs as the person
      // until they sign in again.
      db.prepare(
        "UPDATE agent_hub_item SET result = json_set(result, '$.producedAt', ?, '$.startedAt', ?) WHERE id = ?",
      ).run(aged, aged, id);
      const owner = String(
        db
          .prepare(
            "SELECT h.user_id FROM agent_hub h JOIN agent_hub_item i ON i.workspace_id = h.workspace_id AND i.member_id = h.member_id WHERE i.id = ?",
          )
          .get(id)!.user_id,
      );
      h.identity["accountSecurity"].revokeEverything(owner);
      const revoked = await h.identity.hubScheduleTick();
      assert.equal(revoked.due, 1);
      assert.equal(revoked.started, 0, JSON.stringify(revoked));
      await sleep(200);
      assert.deepEqual(h.dispatches, ["GET", "GET"]);
    } finally {
      await h.close();
    }
  },
);
