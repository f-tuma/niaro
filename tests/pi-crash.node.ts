import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { crashAndResume } from "./helpers/pi-crash";

/**
 * Recovery policy A at Pi level, with a real SIGKILL and a fresh process on
 * the same files: an interrupted model call is retried and counted against
 * the budget once per attempt; an external write is never re-run blindly.
 */
const worker = fileURLToPath(
  new URL("./helpers/pi-crash-worker.ts", import.meta.url),
);
type Result = {
  status: string;
  ledgerBefore: string[];
  ledger: { run: string; status: string }[];
  requests: number;
  effectsBefore: { key: string; executions: number }[];
  effects: { key: string; executions: number }[];
  users: number;
  assistants: { stop: string; text: string }[];
  toolResults: { error: boolean; text: string }[];
};

test("killed during a streamed model call: the resumed process retries it once, each attempt counted against the same budget run", async () => {
  const { result } = await crashAndResume<Result>(worker, "model-stream", {
    killAt: "streaming",
    delayMs: 300,
  });
  assert.equal(result.status, "done");
  // Reopening the ledger turns the killed call's dispatched attempt into an
  // unknown one: its full reservation stays held.
  assert.deepEqual(result.ledgerBefore, ["unknown"]);
  assert.deepEqual(
    result.ledger.map((row) => row.status),
    ["unknown", "settled"],
  );
  assert.equal(result.ledger[0]!.run, result.ledger[1]!.run);
  assert.equal(result.requests, 1, "one new request after the restart");
  assert.equal(result.users, 1);
  const finals = result.assistants.filter((a) => a.stop === "stop");
  assert.equal(finals.length, 1);
  assert.match(finals[0]!.text, /^word0 word1 .* word79$/);
});

test("killed after a keyed write's side effect: Pi runs it again with the same key and the service keeps one effect", async () => {
  const { result } = await crashAndResume<Result>(worker, "write-keyed", {
    killAt: "side_effect_done",
    delayMs: 200,
  });
  assert.equal(result.status, "done");
  assert.equal(result.effectsBefore.length, 1);
  assert.deepEqual(result.effects, result.effectsBefore);
  assert.match(result.effects[0]!.key, /^niaro-pi-task:/);
  assert.deepEqual(result.toolResults, [
    { error: false, text: 'Saved "pay invoice 42".' },
  ]);
});

test("killed after an unkeyed write's side effect: it is not run again and the model is told it was interrupted", async () => {
  const { result } = await crashAndResume<Result>(worker, "write-unkeyed", {
    killAt: "side_effect_done",
    delayMs: 200,
  });
  assert.equal(result.status, "done");
  assert.deepEqual(result.effects, result.effectsBefore);
  assert.equal(result.effects.length, 1);
  assert.equal(result.toolResults.length, 1);
  assert.equal(result.toolResults[0]!.error, true);
  assert.match(result.toolResults[0]!.text, /interrupted/);
  assert.equal(result.assistants.at(-1)!.text, "Done.");
});
