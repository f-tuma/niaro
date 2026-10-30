import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createTrustHarness } from "./agent-trust/harness";
import type {
  DomainMessageContext,
  NativeAttachmentInput,
} from "../apps/server-identity/mastra-domain";

test("SIGKILL during paid continuity before alias creation reopens as unknown with no provider/action replay or synthetic parent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "niaro-attachment-crash-")),
    script = join(dir, "worker.mts"),
    ready = join(dir, "ready.json");
  const harness = resolve("tests/agent-trust/harness.ts"),
    domain = resolve("apps/server-identity/mastra-domain.ts");
  writeFileSync(
    script,
    `
import assert from 'node:assert/strict';import{writeFileSync}from'node:fs';import{createHash,randomUUID}from'node:crypto';
import{createTrustHarness}from ${JSON.stringify(harness)};import{nativeAttachmentMessageHash}from ${JSON.stringify(domain)};
const sha=s=>createHash('sha256').update(s).digest('hex');const root=${JSON.stringify(dir)};
const h=createTrustHarness({directory:root,cleanupDirectory:false});const runtime=h.runtime({...h.context,attachmentGenerationAllowed:()=>true});
const generation=randomUUID(),session=sha('session');
function binding(id,text){const c={conversationId:'conversation-1',conversationSession:session,requestHash:sha(id),outerCommandId:id};const input={scope:h.scope,conversationId:c.conversationId,conversationSession:session,generation,commandId:id,outerCommandId:id,logicalMessageId:id,requestHash:c.requestHash,messageHash:nativeAttachmentMessageHash(text,'en',c),evidenceDigest:sha('synthetic'),handoffId:randomUUID()};return{input,context:{...c,attachment:input}};}
h.onChat(()=>h.call('ask_user',{question:'TEST prior question'}));const first=binding('TEST-crash-root','TEST ask');await runtime.message(first.input.commandId,'TEST ask','en',[],new AbortController().signal,undefined,undefined,'UTC',first.context);
const next=binding('TEST-crash-alias','TEST response');writeFileSync(root+'/input.json',JSON.stringify(next));
h.onDecision(body=>{if(body.questions?.route.criteria.continue_work){const b=h.attachmentState(next.input.commandId);assert.equal(b.phase.state,'preparing');const key=sha(JSON.stringify([h.scope.serverId,h.scope.workspaceId,h.scope.userId,next.input.commandId]));assert.equal(h.catalog.turn(key,h.scope.workspaceId,h.scope.userId),undefined);writeFileSync(root+'/ready.json',JSON.stringify({paidCalls:h.requests.length,actions:h.serviceRequests.filter(r=>r.method==='POST').length}));Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return 'continue_work';});
await runtime.message(next.input.commandId,'TEST response','en',[],new AbortController().signal,undefined,undefined,'UTC',next.context);throw Error('CRASH CUT NOT REACHED');
`,
  );
  const child = spawn(process.execPath, ["--import", "tsx", script], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NODE_ENV: "test" },
  });
  let stderr = "";
  child.stderr.on("data", (b) => {
    stderr += String(b);
  });
  let h: ReturnType<typeof createTrustHarness> | undefined;
  try {
    const deadline = Date.now() + 20000;
    while (
      !existsSync(ready) &&
      Date.now() < deadline &&
      child.exitCode === null
    )
      await delay(20);
    assert.ok(existsSync(ready), stderr);
    const cut = JSON.parse(readFileSync(ready, "utf8"));
    assert.ok(cut.paidCalls > 0);
    assert.equal(cut.actions, 0);
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    const [, signal] = await exited;
    assert.equal(signal, "SIGKILL");
    h = createTrustHarness({
      directory: dir,
      reuseConfiguration: true,
      cleanupDirectory: false,
    });
    const { input, context } = JSON.parse(
      readFileSync(join(dir, "input.json"), "utf8"),
    ) as { input: NativeAttachmentInput; context: DomainMessageContext };
    h.onChat(() => {
      throw Error("PROVIDER REPLAY FORBIDDEN");
    });
    h.onDecision(() => {
      throw Error("DECISION REPLAY FORBIDDEN");
    });
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: () => true,
    });
    assert.equal(
      h.catalog.nativeTurns(h.scope.workspaceId, h.scope.userId).length,
      1,
    );
    assert.equal(h.attachmentState(input.commandId)?.phase.state, "preparing");
    assert.deepEqual(await runtime.readAttachmentOutcome!(input), {
      status: "unknown",
    });
    assert.equal(await runtime.readTask!(input.commandId), null);
    assert.equal(
      await runtime.ensureSettled!({
        commandId: input.commandId,
        outerCommandId: input.outerCommandId,
        requestHash: input.requestHash,
      }),
      false,
    );
    await runtime.sealAttachmentAdmission!(input);
    const retired = h.attachmentState(input.commandId)!;
    assert.equal(retired.phase.state, "retired");
    if (retired.phase.state !== "retired") throw Error("retired");
    assert.equal(retired.phase.proofId, null);
    assert.equal(retired.phase.preparationStarted, true);
    await assert.rejects(
      runtime.message(
        input.commandId,
        "TEST response",
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        context,
      ),
      { code: "attachment_retry_required" },
    );
    assert.deepEqual(await runtime.readAttachmentOutcome!(input), {
      status: "unknown",
    });
    assert.equal(h.requests.length, 0);
    assert.equal(h.serviceRequests.length, 0);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGKILL");
    await h?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
