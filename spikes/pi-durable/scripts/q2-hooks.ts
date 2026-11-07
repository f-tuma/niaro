/**
 * Q2: Niaro policy as Pi hooks on a fake service (deterministic scripted model).
 *   1. approval: write waits for a durable decision; approve -> executes once
 *   2. approval: reject -> model told, no execution
 *   3. access: a service the member lost access to is refused before dispatch
 *   4. budget: per-run cap; reserve before each model call, refuse over cap, settle after
 * (Restart while waiting for approval is Q3c.)
 */
import { mkdirSync, rmSync } from "node:fs";
import { MemoryStorage, UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { check, ctx, printTranscript, transcript } from "../src/kit.ts";
import { Approvals, NiaroDb, type ApprovalRequest } from "../src/policy.ts";
import { openNiaro } from "../src/setup.ts";

const dir = new URL("../.data/q2/", import.meta.url).pathname;
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

async function decide(root: Conversation, callId: string, approved: boolean, reason?: string) {
  await root.commit(async (tx) => {
    (await tx.doc(Approvals, root.id)).decisions[callId] = { approved, by: "user-ada", ...(reason ? { reason } : {}) };
  }, ctx);
}

const finalText = (items: Awaited<ReturnType<typeof transcript>>) =>
  items.filter((e) => e.kind === "pi.assistant" && (e.model?.[0] as any)?.stopReason === "stop").length;

{
  console.log("\n=== Q2.1 approval: write waits for a durable decision, approve ===");
  const niaro = new NiaroDb(dir + "approve.sqlite");
  niaro.grant("user-ada", "notes.write");
  const pending: ApprovalRequest[] = [];
  const { harness, root, service } = await openNiaro({ storage: new MemoryStorage(), niaro, onApprovalRequested: (_c, r) => pending.push(r) });
  const sub = await root.submit({ type: "input", content: "write buy milk" }, ctx);
  while (pending.length === 0) await new Promise((r) => setTimeout(r, 20));
  const inspected = await harness.inspect(ctx);
  const tool = inspected.tasks.find((t) => t.record.kind === "pi.tool");
  console.log(`  pending approval: ${JSON.stringify(pending[0])}`);
  console.log(`  durable memo on the tool task (harness.inspect): ${JSON.stringify(tool?.record.memos)}`);
  console.log(`  write executed before decision: ${service.counters.writeCalls}`);
  await new Promise((r) => setTimeout(r, 200));
  check("write does not run while waiting", service.counters.writeCalls === 0);
  await decide(root, pending[0]!.callId, true);
  const settled = await sub.wait(ctx);
  const items = await printTranscript(root);
  check("approved write executed once", service.counters.writeCalls === 1 && niaro.sideEffects().length === 1);
  check("run answered once", settled.status === "done" && finalText(items) === 1);
  await harness.close(ctx);
}

{
  console.log("\n=== Q2.2 approval: reject ===");
  const niaro = new NiaroDb(dir + "reject.sqlite");
  niaro.grant("user-ada", "notes.write");
  const pending: ApprovalRequest[] = [];
  const { harness, root, service } = await openNiaro({ storage: new MemoryStorage(), niaro, onApprovalRequested: (_c, r) => pending.push(r) });
  const sub = await root.submit({ type: "input", content: "write delete everything" }, ctx);
  while (pending.length === 0) await new Promise((r) => setTimeout(r, 20));
  await decide(root, pending[0]!.callId, false, "not now");
  await sub.wait(ctx);
  const items = await printTranscript(root);
  const result = items.find((e) => e.kind === "pi.tool-result")?.model?.[0] as any;
  check("rejected write not executed", service.counters.writeCalls === 0 && niaro.sideEffects().length === 0);
  check("model got an error result naming the rejection", result?.isError === true && JSON.stringify(result.content).includes("rejected by user-ada: not now"));
  await harness.close(ctx);
}

{
  console.log("\n=== Q2.3 access: member loses access to a service mid-conversation ===");
  const niaro = new NiaroDb(dir + "access.sqlite");
  niaro.grant("user-ada", "notes.read");
  const { harness, root, service } = await openNiaro({ storage: new MemoryStorage(), niaro });
  await (await root.submit({ type: "input", content: "read Ada" }, ctx)).wait(ctx);
  niaro.revoke("user-ada", "notes.read"); // an administrator removes the service from the member
  await (await root.submit({ type: "input", content: "read Bob" }, ctx)).wait(ctx);
  const items = await printTranscript(root);
  const results = items.filter((e) => e.kind === "pi.tool-result").map((e) => e.model?.[0] as any);
  check("first read executed, second refused before execute()", service.counters.read === 1);
  check("refusal reported to the model as a blocked tool result", results[1]?.isError === true && JSON.stringify(results[1].content).includes("access_denied"));
  await harness.close(ctx);
}

{
  console.log("\n=== Q2.4 hard budget: reserve before each call, refuse over the cap, settle after ===");
  const niaro = new NiaroDb(dir + "budget.sqlite");
  niaro.grant("user-ada", "notes.read");
  // Scripted model price: $1/Mtok in, $4/Mtok out, max 200 output tokens -> one reservation is roughly 2.5k micro-USD.
  const capMicros = 3_000;
  const { harness, root, service } = await openNiaro({ storage: new MemoryStorage(), niaro, capMicros });
  const settled = await (await root.submit({ type: "input", content: "read Ada" }, ctx)).wait(ctx);
  await printTranscript(root);
  console.log(`  settled: ${settled.status}${settled.status === "unanswered" ? " reason=" + (settled as any).reason : ""}`);
  const live = await harness.snapshot((await import("@earendil-works/pi-durable")).LiveDoc, root.id, ctx);
  console.log(`  pi.live.runFailure: ${JSON.stringify(live?.runFailure)}`);
  console.log("  our ledger (attempt rows):");
  for (const a of niaro.attempts()) console.log(`    ${JSON.stringify(a)}`);
  const usage = await harness.snapshot(UsageDoc, root.id, ctx);
  console.log(`  pi.usage: ${JSON.stringify(usage?.models)}`);
  const rows = niaro.attempts() as any[];
  check("first call reserved+settled with actual cost", rows[0]?.status === "settled" && rows[0].cost_micros > 0);
  check("second call refused before dispatch", rows[1]?.status === "refused");
  check("tool still ran once (the refused call was the follow-up model call)", service.counters.read === 1);
  check("run ends unanswered with model_error, not retried", settled.status === "unanswered" && rows.length === 2);
  const piTokens = Object.values(usage?.models ?? {}).reduce((s, u: any) => s + u.totalTokens, 0);
  const piCost = Object.values(usage?.models ?? {}).reduce((s, u: any) => s + u.cost.total, 0);
  check("Pi usage counts the settled call's tokens", piTokens === rows[0].input_tokens + rows[0].output_tokens, `pi=${piTokens} ours=${rows[0].input_tokens + rows[0].output_tokens}`);
  // pi-ai's calculateCost() fills message.usage.cost in place; our settle callback runs before Pi records the
  // message, so pi.usage carries our tariff cost too (faux itself reports cost 0, totalFromProvider=false).
  check("Pi usage cost equals our settled cost", Math.round(piCost * 1e6) === rows[0].cost_micros, `pi=${(piCost * 1e6).toFixed(1)} ours=${rows[0].cost_micros}`);
  await harness.close(ctx);
}
