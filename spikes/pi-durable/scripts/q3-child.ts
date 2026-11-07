/**
 * One process of a Q3 crash scenario. Usage: q3-child.ts <scenario> <start|resume> <dataDir>
 * `start` prints "MARK <name> <json>" lines; the parent SIGKILLs it at a marker.
 * `resume` opens the same SQLite storage in a fresh process and finishes the work.
 */
import { LiveDoc, type Conversation, type Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { readFileSync, writeFileSync } from "node:fs";
import { check, ctx, printTranscript } from "../src/kit.ts";
import { Approvals, NiaroDb, type ApprovalRequest } from "../src/policy.ts";
import { LONG_ANSWER, openNiaro, type OpenOptions } from "../src/setup.ts";

const [scenario, step, dir] = process.argv.slice(2) as [string, "start" | "resume", string];
const mark = (name: string, data: unknown = {}) => console.log(`MARK ${name} ${JSON.stringify(data)}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const state = (k: string, v?: unknown) => {
  const f = `${dir}/${k}.json`;
  if (v !== undefined) writeFileSync(f, JSON.stringify(v));
  else return JSON.parse(readFileSync(f, "utf8"));
};

const niaro = new NiaroDb(`${dir}/niaro.sqlite`);
niaro.grant("user-ada", "notes.read");
niaro.grant("user-ada", "notes.write");
const storage = await openNodeSqliteStorage(`${dir}/pi.sqlite`);

let opened: Awaited<ReturnType<typeof openNiaro>> | undefined;
const approvalsSeen: ApprovalRequest[] = [];
/** Member approves every write as soon as it waits (b scenarios); c approves by hand. */
const autoApprove = (_c: string, req: ApprovalRequest) => {
  approvalsSeen.push(req);
  void (async () => {
    while (!opened) await sleep(10);
    await opened.root.commit(async (tx) => {
      (await tx.doc(Approvals, opened!.root.id)).decisions[req.callId] = { approved: true, by: "user-ada" };
    }, ctx);
  })();
};

async function open(o: Partial<OpenOptions>) {
  opened = await openNiaro({ storage, niaro, ...o });
  return opened;
}

const assistantStops = (items: { kind: string; model?: readonly unknown[] }[]) =>
  items.filter((e) => e.kind === "pi.assistant").map((e) => (e.model?.[0] as any)?.stopReason as string);

async function finish(h: Harness, root: Conversation, subId: string) {
  const sub = (await h.submission(subId as never, ctx))!;
  const settled = await sub.wait(ctx);
  console.log(`  submission ${subId}: ${settled.status}${settled.status === "unanswered" ? " reason=" + (settled as any).reason : ""}`);
  const items = await printTranscript(root);
  return { settled, items };
}

// ------------------------------------------------------------------ a) killed during a model request
if (scenario === "a" && step === "start") {
  const { harness, root } = await open({ script: { tokensPerSecond: 12 } });
  const sub = await root.submit({ type: "input", content: "tell a long story", requestId: "a-1" }, ctx);
  state("sub", sub.id);
  mark("submitted", { id: sub.id });
  for (;;) {
    const live = await harness.snapshot(LiveDoc, root.id, ctx);
    const text = JSON.stringify(live?.generation?.message ?? "");
    if (text.includes("word5")) break;
    await sleep(30);
  }
  mark("streaming");
  await sub.wait(ctx); // never reached: killed
}
if (scenario === "a" && step === "resume") {
  const { harness, root } = await open({});
  console.log(`  ledger before resume: ${JSON.stringify(niaro.attempts())}`);
  harness.resume();
  const { settled, items } = await finish(harness, root, state("sub"));
  const stops = assistantStops(items);
  const finals = items.filter((e) => e.kind === "pi.assistant" && (e.model?.[0] as any)?.stopReason === "stop");
  console.log(`  ledger after: ${JSON.stringify(niaro.attempts())}`);
  check("a: resumed run completes", settled.status === "done");
  check("a: exactly one final reply", finals.length === 1 && JSON.stringify(finals[0]!.model).includes(LONG_ANSWER), `assistant stops=${stops.join(",")}`);
  check("a: partial answer kept as an aborted entry (the UI must hide or mark it)", stops.filter((s) => s === "aborted").length <= 1, `aborted=${stops.filter((s) => s === "aborted").length}`);
  check("a: one user entry", items.filter((e) => e.kind === "pi.user").length === 1);
  const rows = niaro.attempts() as any[];
  check("a: the killed request's reservation stays as a hold (status dispatched), the retry settles", rows[0]?.status === "dispatched" && rows.at(-1)?.status === "settled");
}

// ------------------------------------------------------------------ b) killed after a write's side effect, before its result commit
const bVariant = { "b-unsafe": { writeReplay: "unsafe", idempotency: "content" }, "b-none": { writeReplay: "unsafe", idempotency: "none" }, "b-safe": { writeReplay: "safe", idempotency: "task" } } as const;
if (scenario in bVariant && step === "start") {
  const v = bVariant[scenario as keyof typeof bVariant];
  const { root } = await open({
    onApprovalRequested: autoApprove,
    script: { retryInterruptedWrite: true },
    service: { ...v, afterSideEffect: async () => { mark("side_effect_done"); await sleep(60_000); } },
  });
  const sub = await root.submit({ type: "input", content: "write pay invoice 42" }, ctx);
  state("sub", sub.id);
  mark("submitted", { id: sub.id });
  await sub.wait(ctx);
}
if (scenario in bVariant && step === "resume") {
  const v = bVariant[scenario as keyof typeof bVariant];
  const { harness, root, service } = await open({ onApprovalRequested: autoApprove, script: { retryInterruptedWrite: true }, service: v });
  console.log(`  side effects before resume: ${JSON.stringify(niaro.sideEffects())}`);
  harness.resume();
  const { settled, items } = await finish(harness, root, state("sub"));
  const effects = niaro.sideEffects();
  const log = (niaro.db.prepare("SELECT line FROM log ORDER BY id").all() as { line: string }[]).map((r) => r.line);
  console.log(`  side effects after: ${JSON.stringify(effects)}`);
  console.log(`  our log:\n    ${log.join("\n    ")}`);
  const results = items.filter((e) => e.kind === "pi.tool-result").map((e) => JSON.stringify(e.model));
  check(`${scenario}: run completes`, settled.status === "done");
  if (scenario === "b-safe") {
    check("b-safe: Pi re-ran execute() after restart (replay: safe)", service.counters.writeCalls === 1);
    check("b-safe: no interrupted result; model sees the idempotent result", results.length === 1 && results[0]!.includes("idempotent replay"));
    check("b-safe: side effect executed once", effects.length === 1);
  } else {
    check(`${scenario}: model was told the write was interrupted`, results[0]!.includes("interrupted"));
    check(`${scenario}: the model retried the write (new tool call)`, results.length === 2);
    if (scenario === "b-unsafe") check("b-unsafe: content idempotency key: side effect executed once", effects.length === 1);
    else check("b-none: without a stable key the retry duplicates the side effect (the failure we must prevent)", effects.length === 2, `effects=${effects.length}`);
  }
}

// ------------------------------------------------------------------ c) killed while waiting for approval
if (scenario === "c" && step === "start") {
  const { root } = await open({ onApprovalRequested: (_c, r) => mark("approval_pending", r) });
  const sub = await root.submit({ type: "input", content: "write transfer 100 EUR" }, ctx);
  state("sub", sub.id);
  await sub.wait(ctx);
}
if (scenario === "c" && step === "resume") {
  const { harness, root, service } = await open({ onApprovalRequested: (_c, r) => approvalsSeen.push(r) });
  // Before scheduling anything: pending approvals come from storage alone (task memos).
  const inspected = await harness.inspect(ctx);
  const pending = inspected.tasks.map((t) => t.record).filter((r) => r.kind === "pi.tool" && r.memos?.["niaro.approval"]);
  console.log(`  scheduling=${inspected.scheduling}; pending approvals from storage: ${JSON.stringify(pending.map((r) => ({ task: r.id, status: r.state.status, memo: r.memos!["niaro.approval"] })))}`);
  check("c: approval still pending after restart", pending.length === 1);
  const req = pending[0]!.memos!["niaro.approval"] as ApprovalRequest;
  harness.resume();
  await sleep(300);
  check("c: still waiting after resume, nothing executed", service.counters.writeCalls === 0 && approvalsSeen.length === 1);
  check("c: re-run hook got the same durable request (memo first-writer-wins)", approvalsSeen[0]?.requestedAt === req.requestedAt);
  await root.commit(async (tx) => {
    (await tx.doc(Approvals, root.id)).decisions[req.callId] = { approved: true, by: "user-ada" };
  }, ctx);
  const { settled } = await finish(harness, root, state("sub"));
  check("c: approving continues the run", settled.status === "done");
  check("c: write executed exactly once", service.counters.writeCalls === 1 && niaro.sideEffects().length === 1);
}

// ------------------------------------------------------------------ d) duplicate submission with the same requestId
if (scenario === "d" && step === "start") {
  const { root } = await open({ script: { tokensPerSecond: 8 } });
  const [s1, s2] = await Promise.all([
    root.submit({ type: "input", content: "read Ada", requestId: "req-d-1" }, ctx),
    root.submit({ type: "input", content: "read Ada", requestId: "req-d-1" }, ctx),
  ]);
  state("sub", s1.id);
  mark("submitted", { first: s1.id, concurrentDuplicate: s2.id });
  await s1.wait(ctx);
}
if (scenario === "d" && step === "resume") {
  const { harness, root, service } = await open({});
  // The client retries after the crash (it never saw an answer).
  const again = await root.submit({ type: "input", content: "read Ada", requestId: "req-d-1" }, ctx);
  console.log(`  resubmitted after restart -> submission ${again.id} (original ${state("sub")})`);
  const { settled, items } = await finish(harness, root, String(again.id));
  check("d: same requestId returns the original submission", again.id === state("sub"));
  check("d: processed once (one user entry, one final answer)", items.filter((e) => e.kind === "pi.user").length === 1 && assistantStops(items).filter((s) => s === "stop").length === 1);
  check("d: run done", settled.status === "done");
  console.log(`  read_contact executions in this process: ${service.counters.read}`);
}

await opened?.harness.close(ctx);
niaro.db.close();
