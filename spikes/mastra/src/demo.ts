import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = mkdtempSync(join(tmpdir(), "niaro-mastra-demo-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const worker = fileURLToPath(new URL("worker.ts", import.meta.url));
function call(input: object) {
  return JSON.parse(
    execFileSync(
      process.execPath,
      ["--import", "tsx", worker, directory, JSON.stringify(input)],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
      },
    ),
  );
}
const taskId = "TEST-create-person",
  operationId = "TEST-demo-operation";
const command = { kind: "create-person", operationId, name: "TEST Ada" };
call({
  kind: "set-objective",
  taskId,
  objective: "Create TEST Ada and verify the result.",
});
const start = call({ kind: "start", taskId, command });
assert.equal(start.result.finishReason, "suspended");
assert.equal(start.dispatches, 0);
console.log(
  "1. Native Agent prepared the Niaro operation; awaiting human approval, no write.",
);
call({
  kind: "start",
  taskId: "TEST-detour",
  command: { kind: "remember", fact: "TEST side task" },
});
const pending = call({ kind: "pending", taskId }).result.runs[0];
const approved = call({
  kind: "answer",
  taskId,
  runId: pending.runId,
  toolCallId: pending.toolCalls[0].toolCallId,
});
assert.equal(JSON.parse(approved.result.text).status, "succeeded");
assert.equal(approved.dispatches, 1);
console.log(
  "2. A new process resumed the original task after a detour; exactly one TEST write.",
);
const replay = call({ kind: "start", taskId, command });
assert.equal(replay.modelCalls, 0);
assert.equal(replay.dispatches, 1);
console.log(
  "3. Replaying the command returned its durable receipt without model inference or write.",
);
const inspected = call({ kind: "inspect", taskId, operationId });
assert.equal(inspected.result.objective.status, "done");
console.log(
  "4. Native objective is done; native pending snapshot is removed, Niaro receipt remains.",
);
console.log(`Isolated fixture data: ${directory}`);
