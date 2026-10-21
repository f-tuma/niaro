// Opt-in integration against the locally installed Radicale, separate from npm test.
import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ICAL from "ical.js";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import {
  CalDavCalendar,
  CalendarWorker,
  loadCalendarConfig,
  calendarIdentity,
  verifyCalendarDocument,
  type CalendarConfig,
} from "../apps/fixture-server/calendar";
import { FixtureStorage } from "../apps/fixture-server/storage";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
} from "../packages/client-core/commands";
import { SnapshotSchema, CommandResultSchema } from "../packages/protocol";

async function main() {
  const base = loadCalendarConfig(resolve(".radicale/client.json"));
  const directory = mkdtempSync(join(tmpdir(), "agent-radicale-live-"));
  const collection = new URL(
    `qa-${Date.now()}/`,
    new URL("../", base.target.collectionUrl),
  ).href;
  assert(collection.startsWith("http://127.0.0.1:5232/agent-test/qa-"));
  const authorization = `Basic ${Buffer.from(`${base.username}:${base.password}`).toString("base64")}`;
  const remote = (url: string, method = "GET", body?: string) =>
    fetch(url, {
      method,
      body,
      redirect: "error",
      signal: AbortSignal.timeout(8000),
      headers: {
        Authorization: authorization,
        ...(body ? { "Content-Type": "application/xml; charset=utf-8" } : {}),
      },
    });
  let now = Date.now();
  const auth = new FixtureAuth(directory, () => now);
  const credential = auth.pair(
    issuePairingCode(directory, "calendar-user", "a", now),
    "a",
  );
  const config: CalendarConfig = {
    ...base,
    scope: credential.scope,
    target: { ...base.target, collectionUrl: collection },
  };
  const path = join(directory, "calendar.json");
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const calendar = new CalDavCalendar(config);
  const scope = config.scope;
  const open = () =>
    new FixtureStorage(
      directory,
      scope.serverId,
      () => now,
      undefined,
      (s) => calendar.targetFor(s),
    );
  const children: ChildProcess[] = [];
  let store: FixtureStorage | undefined;
  let created = false;
  async function child(crash: boolean) {
    const process = fork(resolve("tests/helpers/crash-server.ts"), [], {
      execArgv: ["--import", "tsx"],
      silent: true,
      env: {
        ...global.process.env,
        TEST_DATA_DIR: directory,
        TEST_NOW: String(now),
        TEST_CALENDAR_CONFIG: path,
        TEST_CRASH_AFTER_PUT: crash ? "1" : "0",
      },
    });
    children.push(process);
    let stderr = "";
    process.stderr?.on("data", (c) => {
      stderr += String(c);
    });
    const exited = new Promise<string | number | null>((resolve) =>
      process.once("exit", (code, signal) => resolve(signal ?? code)),
    );
    const port = await new Promise<number>((resolve, reject) => {
      process.once("message", (m: { port: number }) => resolve(m.port));
      process.once("error", reject);
      process.once("exit", () =>
        reject(new Error(`Server stopped before listen: ${stderr}`)),
      );
    });
    return {
      port,
      exited,
      stop: async () => {
        process.kill("SIGTERM");
        await exited;
      },
    };
  }
  const prepare = (id: string) => {
    const first = store!.execute(
      scope,
      messageCommand("Choose Peter", "en", `${id}-start`),
    );
    store!.execute(
      scope,
      answerCommand(
        first.snapshot.inputRequests.at(-1)!,
        "peter-novak",
        `${id}-answer`,
      ),
    );
    now += 4000;
    store!.tick();
    const proposal = store!.snapshot(scope).actionProposals.at(-1)!;
    const approve = proposalDecision(proposal, "approve", `${id}-approve`);
    assert.equal(store!.execute(scope, approve).status, "accepted");
    now += 4000;
    store!.tick();
    return { op: store!.snapshot(scope).operations.at(-1)!, approve };
  };
  const deadline = setTimeout(() => {
    for (const p of children)
      if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL");
    throw new Error("Radicale integration deadline exceeded");
  }, 45_000);
  try {
    const init = await remote(
      collection,
      "MKCALENDAR",
      '<C:mkcalendar xmlns:C="urn:ietf:params:xml:ns:caldav"/>',
    );
    assert.equal(init.status, 201);
    await init.body?.cancel();
    created = true;
    store = open();
    const lost = prepare("lost-reply");
    let puts = 0;
    const lossy = new CalDavCalendar(config, async (url, options) => {
      const res = await fetch(url, options);
      if (options?.method === "PUT") {
        puts++;
        assert.equal(res.status, 201);
        await res.body?.cancel();
        throw new Error("lost PUT response");
      }
      return res;
    });
    await new CalendarWorker(store, lossy).tick();
    assert.equal(store.snapshot(scope).operations[0]?.status, "result_unknown");
    store.close();
    now += 3000;
    store = open();
    await new CalendarWorker(store, lossy).tick();
    assert.equal(store.snapshot(scope).operations[0]?.status, "succeeded");
    assert.equal(puts, 1);
    assert(
      verifyCalendarDocument(
        await (
          await remote(`${collection}${calendarIdentity(scope, lost.op)}.ics`)
        ).text(),
        scope,
        lost.op,
      ),
    );

    const crash = prepare("crash-after-put");
    store.close();
    store = undefined;
    const killed = await child(true);
    assert.equal(await killed.exited, "SIGKILL");
    const saved = await remote(
      `${collection}${calendarIdentity(scope, crash.op)}.ics`,
    );
    assert.equal(saved.status, 200);
    assert(verifyCalendarDocument(await saved.text(), scope, crash.op));
    now += 30_001;
    const resumed = await child(false);
    const api = async (route: string, body?: unknown) => {
      const res = await fetch(
        `http://127.0.0.1:${resumed.port}/v1/a/${route}`,
        {
          method: body ? "POST" : "GET",
          headers: {
            Authorization: `Bearer ${credential.accessToken}`,
            "Content-Type": "application/json",
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(5000),
        },
      );
      assert.equal(res.status, body ? 202 : 200);
      return res.json();
    };
    const end = Date.now() + 7000;
    while (
      SnapshotSchema.parse(await api("snapshot")).operations.at(-1)?.status !==
      "succeeded"
    ) {
      assert(Date.now() < end, "restarted worker did not verify the event");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const retried = CommandResultSchema.parse(
      await api("commands", crash.approve),
    );
    assert.equal(retried.snapshot.operations.length, 2);
    assert.equal(retried.snapshot.operations.at(-1)?.result?.kind, "calendar");
    const exported = await remote(collection);
    assert.equal(exported.status, 200);
    const events = ICAL.Component.fromString(
      await exported.text(),
    ).getAllSubcomponents("vevent");
    assert.equal(
      events.length,
      2,
      "each approved operation must have exactly one remote VEVENT",
    );
    await resumed.stop();
    console.log(
      "Radicale live PASS: conditional creation, readback, lost PUT reply + restart, SIGKILL after remote commit + restart, exact-command retry, exactly 2 events for 2 approved operations.",
    );
  } finally {
    clearTimeout(deadline);
    store?.close();
    for (const p of children)
      if (p.exitCode === null && p.signalCode === null) {
        const exit = new Promise<void>((resolve) =>
          p.once("exit", () => resolve()),
        );
        p.kill("SIGKILL");
        await exit;
      }
    if (created) {
      const deleted = await remote(collection, "DELETE");
      assert.equal(deleted.status, 200);
      await deleted.body?.cancel();
    }
    rmSync(directory, { recursive: true, force: true });
  }
}
main().catch(() => {
  console.error(
    "Radicale live integration failed; inspect the local test setup and server logs. Credentials are not logged.",
  );
  process.exitCode = 1;
});
