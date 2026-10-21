import { CARD_PROFILE } from "../packages/protocol/card-document";
import { MESSAGE_TIME_PROFILE } from "../packages/protocol/message-delivery";
import { REPLY_CORRELATION_PROFILE } from "../packages/protocol/reply-correlation";
import { fork, type ChildProcess } from "node:child_process";
import { request } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FixtureAuth, issuePairingCode } from "../apps/fixture-server/auth";
import {
  FixtureStorage,
  type CommitStage,
} from "../apps/fixture-server/storage";
import {
  messageCommand,
  answerCommand,
  proposalDecision,
} from "../packages/client-core/commands";
import {
  CommandResultSchema,
  SnapshotSchema,
  type Scope,
} from "../packages/protocol";

const startTime = Date.UTC(2026, 8, 24, 9);
let directory: string;
const children: ChildProcess[] = [];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "agent-crash-"));
});
afterEach(async () => {
  for (const child of children.splice(0))
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>((resolve) =>
        child.once("exit", () => resolve()),
      );
      child.kill("SIGKILL");
      await exited;
    }
  rmSync(directory, { recursive: true, force: true });
});
async function start(now: number, stage?: CommitStage, change = "command") {
  const child = fork(join(__dirname, "helpers/crash-server.ts"), [], {
    execArgv: ["--import", "tsx"],
    silent: true,
    env: {
      ...process.env,
      TEST_DATA_DIR: directory,
      TEST_NOW: String(now),
      TEST_CRASH_STAGE: stage ?? "",
      TEST_CRASH_CHANGE: change,
    },
  });
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const exited = new Promise<NodeJS.Signals | number | null>((resolve) => {
    child.once("exit", (code, signal) => resolve(signal ?? code));
  });
  const port = await new Promise<number>((resolve, reject) => {
    child.once("message", (message: { port: number }) => resolve(message.port));
    child.once("error", reject);
    child.once("exit", () =>
      reject(new Error(`Fixture exited before listening: ${stderr}`)),
    );
  });
  return {
    port,
    exited,
    stop: async () => {
      child.kill("SIGTERM");
      await exited;
    },
  };
}
function json(port: number, token: string, route: string, body?: unknown) {
  return new Promise<{ status: number; value: unknown }>((resolve, reject) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/v1/a/${route}${route.includes("?") ? "&" : "?"}replies=${encodeURIComponent(REPLY_CORRELATION_PROFILE)}&cards=${encodeURIComponent(CARD_PROFILE)}&messages=${encodeURIComponent(MESSAGE_TIME_PROFILE)}`,
        method: body ? "POST" : "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      },
      (res) => {
        let text = "";
        res.on("data", (chunk) => {
          text += String(chunk);
        });
        res.on("end", () =>
          resolve({ status: res.statusCode!, value: JSON.parse(text) }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(5000, () => req.destroy(new Error("HTTP timeout")));
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}
function prepared() {
  let now = startTime;
  const auth = new FixtureAuth(directory, () => now);
  const credential = auth.pair(
    issuePairingCode(directory, "alice", "a", now),
    "a",
  );
  const scope = credential.scope;
  const store = new FixtureStorage(directory, auth.serverId, () => now);
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
  const before = store.snapshot(scope);
  const command = proposalDecision(
    before.actionProposals[0]!,
    "approve",
    "approve",
  );
  store.close();
  return { credential, scope, before, command, now };
}

test.each<CommitStage>([
  "state",
  "events",
  "receipts",
  "before_commit",
  "after_commit",
])(
  "SIGKILL at %s during approval: restart replays committed events and retry creates exactly one operation",
  async (stage) => {
    const { credential, scope, before, command, now } = prepared();
    const killed = await start(now, stage);
    await expect(
      json(killed.port, credential.accessToken, "commands", command),
    ).rejects.toThrow();
    expect(await killed.exited).toBe("SIGKILL");

    const restarted = await start(now);
    const recovered = SnapshotSchema.parse(
      (await json(restarted.port, credential.accessToken, "snapshot")).value,
    );
    if (stage === "after_commit") expect(recovered.operations).toHaveLength(1);
    else expect(recovered).toEqual(before);
    const replay = await json(
      restarted.port,
      credential.accessToken,
      `events?after=${before.cursor}`,
    );
    expect(replay.status).toBe(200);
    expect(replay.value).toMatchObject({ scope, cursor: recovered.cursor });
    expect((replay.value as { events: unknown[] }).events).toHaveLength(
      recovered.cursor - before.cursor,
    );
    expect(
      await json(
        restarted.port,
        credential.accessToken,
        `events?after=${before.cursor}`,
      ),
    ).toEqual(replay);

    const retried = await json(
      restarted.port,
      credential.accessToken,
      "commands",
      command,
    );
    expect(retried.status).toBe(202);
    const result = CommandResultSchema.parse(retried.value);
    expect(result.snapshot.operations).toHaveLength(1);
    expect(result.snapshot.operations[0]?.status).toBe("pending");
    if (stage === "after_commit") expect(result.snapshot).toEqual(recovered);
    expect(
      await json(restarted.port, credential.accessToken, "commands", command),
    ).toEqual(retried);
    const changed = CommandResultSchema.parse(
      (
        await json(restarted.port, credential.accessToken, "commands", {
          ...command,
          decision: "reject",
        })
      ).value,
    );
    expect(changed.code).toBe("idempotency_conflict");
    expect(changed.snapshot).toEqual(result.snapshot);
    await restarted.stop();
  },
  20_000,
);

async function waitForOperation(
  store: FixtureStorage,
  scope: Scope,
  status: string,
) {
  const deadline = Date.now() + 5000;
  while (store.snapshot(scope).operations[0]?.status !== status) {
    if (Date.now() > deadline)
      throw new Error(`Worker did not reach ${status}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}
test.each<CommitStage>(["before_commit", "after_commit"])(
  "worker SIGKILL at %s preserves its job and resumes without client requests",
  async (stage) => {
    const { credential, scope, command, now } = prepared();
    const observer = new FixtureStorage(directory, scope.serverId, () => now);
    try {
      observer.execute(scope, command);
      const killed = await start(now + 4000, stage, "tick");
      expect(await killed.exited).toBe("SIGKILL");
      expect(observer.snapshot(scope).operations[0]?.status).toBe(
        stage === "after_commit" ? "executing" : "pending",
      );
      const resumed = await start(now + 4000);
      await waitForOperation(observer, scope, "executing");
      await resumed.stop();
      const completed = await start(now + 8000);
      await waitForOperation(observer, scope, "succeeded");
      const snapshot = observer.snapshot(scope);
      expect(snapshot.operations).toHaveLength(1);
      expect(snapshot.operations[0]).toMatchObject({
        revision: 3,
        result: { kind: "simulated" },
      });
      expect(snapshot.workItems[0]?.status).toBe("succeeded");
      expect(
        CommandResultSchema.parse(
          (
            await json(
              completed.port,
              credential.accessToken,
              "commands",
              command,
            )
          ).value,
        ).snapshot,
      ).toEqual(snapshot);
      expect(observer.events(scope, 0)?.events.at(-1)?.sequence).toBe(
        snapshot.cursor,
      );
      await completed.stop();
    } finally {
      observer.close();
    }
  },
  20_000,
);
