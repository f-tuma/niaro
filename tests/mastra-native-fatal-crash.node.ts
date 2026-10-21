import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DurableStepIds } from "@mastra/core/agent/durable";
import { CommandSchema, type Command } from "../packages/protocol";
import { NativeRunUnsettledError } from "../apps/server-identity/mastra-runtime";
import { createTrustHarness } from "./agent-trust/harness";

const worker = fileURLToPath(
  new URL("./helpers/mastra-fatal-crash-worker.ts", import.meta.url),
);
async function cut(directory: string, mode: "answer" | "held") {
  return new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    stderr: string;
  }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", worker, directory, mode],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const deadline = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        Error("TEST fatal crash worker timed out: " + mode + "\n" + stderr),
      );
    }, 20000);
    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stderr });
    });
  });
}
const original = (mode: string): Extract<Command, { type: "message.send" }> => {
  const parsed = CommandSchema.parse({
    type: "message.send",
    commandId: "TEST-fatal-crash-outer-" + mode,
    idempotencyKey: "TEST-fatal-crash-idempotency-" + mode,
    conversationId: "conversation-1",
    text: "TEST complete this request",
    language: "cs",
    timeZone: "UTC",
  });
  assert.equal(parsed.type, "message.send");
  return parsed;
};
function checkNativeData(directory: string) {
  const db = new DatabaseSync(
    join(directory, "identity.sqlite.mastra.sqlite"),
    { readOnly: true },
  );
  try {
    const snapshots = db
      .prepare("SELECT workflow_name,snapshot FROM mastra_workflow_snapshot")
      .all();
    const messages = db.prepare("SELECT * FROM mastra_messages").all();
    for (const row of [...snapshots, ...messages])
      for (const value of Object.values(row)) {
        if (typeof value === "string" || value instanceof Uint8Array)
          assert(
            !Buffer.from(value).includes(
              Buffer.from("TEST_PRIVATE_FATAL_CRASH_CREDENTIAL"),
            ),
          );
      }
    return snapshots.filter((row) =>
      [DurableStepIds.AGENTIC_LOOP, DurableStepIds.AGENTIC_EXECUTION].includes(
        String(row.workflow_name) as typeof DurableStepIds.AGENTIC_LOOP,
      ),
    ).length;
  } finally {
    db.close();
  }
}

for (const mode of ["answer", "held"] as const) {
  test(`SIGKILL after native fatal ${mode} preserves exact passive recovery without inference`, async (t) => {
    const directory = mkdtempSync(
      join(tmpdir(), "niaro-fatal-cut-" + mode + "-"),
    );
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const killed = await cut(directory, mode);
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert(
      existsSync(join(directory, "fatal-cut.json")),
      "The fixture must reach the intended cut, not time out",
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(directory, "fatal-cut.json"), "utf8")),
      {
        mode,
        site:
          mode === "answer"
            ? "workflow-before-commit"
            : "candidate-with-live-native-checkpoint",
      },
    );
    assert.equal(checkNativeData(directory), mode === "answer" ? 0 : 2);
    const h = createTrustHarness({
      directory,
      reuseConfiguration: true,
      cleanupDirectory: false,
    });
    h.onChat(() => {
      h.db.prepare("INSERT INTO TEST_fatal_crash_call VALUES('model')").run();
      throw Error("TEST passive recovery must not call a provider");
    });
    h.onBeforeActionDispatch(() => {
      h.db.prepare("INSERT INTO TEST_fatal_crash_call VALUES('action')").run();
      throw Error("TEST passive recovery must not dispatch an action");
    });
    try {
      const cmd = original(mode);
      assert.equal(h.workflow.replay(h.scope, cmd), undefined);
      assert.equal(
        h.workflow.snapshot(h.scope).conversations[0]!.messages.length,
        0,
      );
      assert.equal(
        h.commandState().terminalCandidate,
        mode === "answer" ? "protocol" : "execution",
      );
      if (mode === "answer") {
        assert.match(h.commandState().answer!.reply, /neplatnou odpověď/);
        const answer = await h.execute(cmd);
        assert.equal(answer.status, "accepted");
        assert.equal(answer.snapshot.conversations[0]!.messages.length, 2);
        assert.equal(
          answer.snapshot.conversations[0]!.messages.at(-1)!.replyToCommandId,
          cmd.commandId,
        );
        assert.match(
          answer.snapshot.conversations[0]!.messages.at(-1)!.text,
          /neplatnou odpověď/,
        );
        await h.restart();
        assert.deepEqual(
          (await h.execute(cmd)).snapshot.conversations,
          answer.snapshot.conversations,
        );
      } else {
        assert.equal(h.commandState().answer, undefined);
        assert.equal(h.commandState().trace?.status, "running");
        const before = h.workflow.snapshot(h.scope);
        const tasks = await h.runtime().tasks!();
        assert.equal(tasks[0]?.status, "waiting_system");
        assert.equal(tasks[0]?.native?.question, undefined);
        await assert.rejects(h.execute(cmd), NativeRunUnsettledError);
        const next = CommandSchema.parse({
          ...cmd,
          commandId: "TEST-fatal-crash-next",
          idempotencyKey: "TEST-fatal-crash-next",
          session: "new",
        });
        await assert.rejects(h.execute(next), /model_busy/);
        assert.deepEqual(h.workflow.snapshot(h.scope), before);
        await h.restart();
        const retryAttempt = CommandSchema.parse({
          ...cmd,
          commandId: "TEST-fatal-crash-retry-public-" + mode,
          idempotencyKey: "TEST-fatal-crash-retry-internal-" + mode,
          logicalMessageId: cmd.logicalMessageId ?? cmd.commandId,
          retryOf: cmd.commandId,
        });
        const beforeRetry = h.workflow.snapshot(h.scope);
        await assert.rejects(h.execute(retryAttempt), /model_busy/);
        assert.equal(h.workflow.replay(h.scope, retryAttempt), undefined);
        assert.deepEqual(h.workflow.snapshot(h.scope), beforeRetry);
        assert.equal(checkNativeData(directory), 2);
        await assert.rejects(h.execute(cmd), NativeRunUnsettledError);
        assert.deepEqual(h.workflow.snapshot(h.scope), beforeRetry);
        assert.equal(checkNativeData(directory), 2);
      }
      assert.equal(h.requests.length, 0);
      assert.equal(h.network.length, 0);
      assert.deepEqual(
        h.db
          .prepare(
            "SELECT kind,count(*) AS count FROM TEST_fatal_crash_call GROUP BY kind",
          )
          .all()
          .map((row) => ({ ...row })),
        [{ kind: "model", count: 1 }],
      );
      assert.equal(
        h.db
          .prepare("SELECT count(*) AS count FROM agent_service_invocation")
          .get()?.count,
        0,
      );
    } finally {
      await h.close();
    }
  });
}
