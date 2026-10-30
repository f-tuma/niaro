import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID, createHash } from "node:crypto";
import { createTrustHarness } from "./agent-trust/harness";
import {
  NativeAttachmentBindingSchema,
  nativeAttachmentMessageHash,
  type DomainMessageContext,
  type NativeAttachmentInput,
} from "../apps/server-identity/mastra-domain";

import { nativeQuestionId } from "../apps/server-identity/mastra-domain";
import { purgeNativeAttachmentGeneration } from "../apps/server-identity/mastra-runtime";

import { FixtureStorage } from "../apps/fixture-server/storage";
import { ModelService } from "../apps/fixture-server/model-service";
import { loadAttachmentConfiguration } from "../apps/server-attachments/schema";
import { attachmentDigest } from "../apps/server-attachments/store";
import { ATTACHMENT_PROFILE } from "../packages/protocol/attachments";
import { syntheticS3 } from "./helpers/storage-s3";
import { join } from "node:path";
import type { MobileRuntime } from "../apps/server-identity/mobile";

import { DatabaseSync } from "node:sqlite";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function binding(
  h: ReturnType<typeof createTrustHarness>,
  id: string,
  text: string,
  extra: DomainMessageContext = {},
) {
  const context: DomainMessageContext = {
    conversationId: "conversation-1",
    conversationSession: sha("TEST-session"),
    requestHash: sha(id + text),
    outerCommandId: id,
    ...extra,
  };
  const input: NativeAttachmentInput = {
    scope: h.scope,
    conversationId: context.conversationId!,
    conversationSession: context.conversationSession!,
    generation: randomUUID(),
    commandId: id,
    outerCommandId: id,
    logicalMessageId: id,
    requestHash: context.requestHash!,
    messageHash: nativeAttachmentMessageHash(text, "en", context),
    evidenceDigest: sha("synthetic evidence"),
    handoffId: randomUUID(),
  };
  return { context: { ...context, attachment: input }, input };
}
test("actual native adapter commits strict sidecar/root association, pins outcome and exact replay makes no paid call", async () => {
  const h = createTrustHarness();
  try {
    h.onChat(() => ({ content: "TEST attachment answer" }));
    const id = "TEST-attachment-native",
      text = "TEST interpret synthetic evidence",
      b = binding(h, id, text),
      runtime = h.runtime({
        ...h.context,
        attachmentGenerationAllowed: () => true,
      });
    const answer = await runtime.message(
      id,
      text,
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      b.context,
    );
    assert.equal(answer?.reply, "TEST attachment answer");
    const count = h.requests.length;
    const saved = NativeAttachmentBindingSchema.parse(
      h.db.prepare("SELECT data FROM agent_service_attachment_binding").get() &&
        JSON.parse(
          String(
            h.db
              .prepare("SELECT data FROM agent_service_attachment_binding")
              .get()!.data,
          ),
        ),
    );
    assert.equal(saved.phase.state, "linked");
    if (saved.phase.state !== "linked") throw Error("not linked");
    assert.equal(saved.phase.rootCommandId, id);
    assert.equal(saved.phase.outcome?.result.reply, answer!.reply);
    assert.deepEqual(await runtime.readAttachmentOutcome!(b.input), {
      status: "recorded",
      nativeRunId: saved.phase.runId,
      result: saved.phase.outcome!.result,
    });
    assert.equal(
      (
        await runtime.message(
          id,
          text,
          "en",
          [],
          new AbortController().signal,
          undefined,
          undefined,
          "UTC",
          b.context,
        )
      )?.reply,
      answer!.reply,
    );
    assert.equal(h.requests.length, count);
    await assert.rejects(
      runtime.readAttachmentOutcome!({
        ...b.input,
        evidenceDigest: sha("changed"),
      }),
      { code: "idempotency_conflict" },
    );
    assert.equal(h.requests.length, count);
    assert.equal(
      h.catalog.nativeTurns(h.scope.workspaceId, h.scope.userId).length,
      1,
    );
    assert.equal(h.commandState(id).kind, "mastra-1");
  } finally {
    await h.close();
  }
});

test("a sealed never-prepared admission permits one real retry root; concurrent proof reuse cannot spend", async () => {
  const h = createTrustHarness();
  let cut = true;
  try {
    const ctx = {
      ...h.context,
      attachmentGenerationAllowed: () => true,
      transaction: async <T>(run: () => Promise<T>): Promise<T> => {
        const value = await h.context.transaction(run);
        const row = h.db
          .prepare(
            "SELECT data FROM agent_service_attachment_binding WHERE json_extract(data,'$.phase.state')='pending' LIMIT 1",
          )
          .get();
        if (cut && row) {
          cut = false;
          throw Error("TEST AFTER PENDING COMMIT");
        }
        return value;
      },
    };
    const runtime = h.runtime(ctx),
      id = "TEST-pending-parent",
      text = "TEST positive proof",
      b = binding(h, id, text);
    await assert.rejects(
      runtime.message(
        id,
        text,
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        b.context,
      ),
      /AFTER PENDING/,
    );
    assert.equal(h.requests.length, 0);
    assert.equal(
      h.catalog.nativeTurns(h.scope.workspaceId, h.scope.userId).length,
      0,
    );
    assert.equal(h.attachmentState(id)?.phase.state, "pending");
    assert.deepEqual(await runtime.readAttachmentOutcome!(b.input), {
      status: "unknown",
    });
    assert.equal(
      await runtime.ensureSettled!({
        commandId: id,
        outerCommandId: id,
        requestHash: b.input.requestHash,
      }),
      false,
    );
    await runtime.sealAttachmentAdmission!(b.input);
    const proof = await runtime.readAttachmentOutcome!(b.input);
    assert.equal(proof.status, "not_dispatched");
    if (proof.status !== "not_dispatched") throw Error("proof");
    h.onChat(() => ({ content: "TEST first real retry result" }));
    const retryId = "TEST-pending-retry",
      next = {
        ...b.input,
        commandId: retryId,
        outerCommandId: retryId,
        requestHash: sha(retryId),
        handoffId: randomUUID(),
      };
    const context = {
      ...b.context,
      outerCommandId: retryId,
      requestHash: next.requestHash,
      logicalMessageId: id,
      retryOf: id,
      attachment: next,
      attachmentRetryProof: { commandId: id, proofId: proof.proofId },
    };
    const answer = await runtime.message(
      retryId,
      text,
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      context,
    );
    assert.equal(answer?.reply, "TEST first real retry result");
    const state = h.commandState(retryId);
    assert.equal(state.retryParentRunId, undefined);
    assert.equal(state.commandId, retryId);
    const count = h.requests.length,
      other = {
        ...next,
        commandId: "TEST-proof-racer",
        outerCommandId: "TEST-proof-racer",
        handoffId: randomUUID(),
        requestHash: sha("racer"),
      };
    await assert.rejects(
      runtime.message(
        other.commandId,
        text,
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        {
          ...context,
          outerCommandId: other.outerCommandId,
          requestHash: other.requestHash,
          attachment: other,
        },
      ),
      { code: "attachment_retry_required" },
    );
    assert.equal(h.requests.length, count);
    assert.equal(
      h.serviceRequests.filter((r) => r.method === "POST").length,
      0,
    );
  } finally {
    await h.close();
  }
});

test("validated explicit-task continuation promotes without decision inference and preserves the earlier alias outcome", async () => {
  const h = createTrustHarness();
  try {
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: () => true,
    });
    h.onChat(() =>
      h.call("ask_user", { question: "TEST attachment question" }),
    );
    const first = binding(h, "TEST-att-question", "TEST ask about evidence");
    const question = await runtime.message(
      first.input.commandId,
      "TEST ask about evidence",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      first.context,
    );
    const root = h.commandState(first.input.commandId);
    assert.equal(root.pending?.kind, "question");
    let decisions = 0;
    h.onDecision((body) => {
      if (body.questions?.route.criteria.continue_work) {
        decisions++;
        throw Error("EXPLICIT TASK MUST NOT INFER CONTINUITY");
      }
      return undefined;
    });
    h.onChat(() => ({ content: "TEST explicit attachment response" }));
    const next = binding(h, "TEST-att-explicit", "TEST response", {
      task: {
        workItemId: root.runId,
        inputRequestId: nativeQuestionId(root.runId, root.pending!.toolCallId),
        expectedInputRevision: 1,
      },
    });
    next.input.generation = first.input.generation;
    next.context.attachment = next.input;
    const answer = await runtime.message(
      next.input.commandId,
      "TEST response",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      next.context,
    );
    assert.equal(answer?.reply, "TEST explicit attachment response");
    assert.equal(decisions, 0);
    const b = h.attachmentState(next.input.commandId)!;
    assert.equal(b.phase.state, "linked");
    if (b.phase.state !== "linked") throw Error("linked");
    assert.equal(b.phase.rootCommandId, first.input.commandId);
    const earlier = await runtime.readAttachmentOutcome!(first.input);
    assert.equal(earlier.status, "recorded");
    if (earlier.status !== "recorded") throw Error("recorded");
    assert.equal(earlier.result.reply, question!.reply);
    assert.notEqual(earlier.result.reply, answer!.reply);
    assert.equal(
      h.catalog.nativeTurns(h.scope.workspaceId, h.scope.userId).length,
      1,
    );
  } finally {
    await h.close();
  }
});
test("promotion rollback leaves a typed preparing sidecar and no partial normal root or paid call", async () => {
  const h = createTrustHarness();
  try {
    const ctx = {
      ...h.context,
      attachmentGenerationAllowed: () => true,
      transaction: <T>(run: () => Promise<T>) =>
        h.context.transaction(async () => {
          const value = await run();
          if (
            h.db
              .prepare(
                "SELECT 1 FROM agent_service_attachment_binding WHERE json_extract(data,'$.phase.state')='linked'",
              )
              .get()
          )
            throw Error("TEST LINK ROLLBACK");
          return value;
        }),
    };
    const runtime = h.runtime(ctx),
      b = binding(h, "TEST-link-rollback", "TEST no partial root");
    await assert.rejects(
      runtime.message(
        b.input.commandId,
        "TEST no partial root",
        "en",
        [],
        new AbortController().signal,
        undefined,
        undefined,
        "UTC",
        b.context,
      ),
      /LINK ROLLBACK/,
    );
    assert.equal(
      h.attachmentState(b.input.commandId)?.phase.state,
      "preparing",
    );
    assert.equal(
      h.catalog.nativeTurns(h.scope.workspaceId, h.scope.userId).length,
      0,
    );
    assert.equal(h.requests.length, 0);
    assert.deepEqual(await runtime.readAttachmentOutcome!(b.input), {
      status: "unknown",
    });
  } finally {
    await h.close();
  }
});
test("exact-generation native retirement scrubs old source and pinned outcome while a fresh fixed-chat generation survives", async () => {
  const h = createTrustHarness();
  try {
    const allowed = new Set<string>(),
      runtime = h.runtime({
        ...h.context,
        attachmentGenerationAllowed: (g) => allowed.has(g),
      });
    const a = binding(h, "TEST-old-native", "TEST OLD SOURCE CANARY");
    allowed.add(a.input.generation);
    h.onChat(() => ({ content: "TEST OLD ANSWER CANARY" }));
    await runtime.message(
      a.input.commandId,
      "TEST OLD SOURCE CANARY",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      a.context,
    );
    const old = h.commandState(a.input.commandId);
    const b = binding(h, "TEST-new-native", "TEST FRESH SOURCE", {
      conversationSession: sha("fresh-session"),
    });
    allowed.add(b.input.generation);
    h.onChat(() => ({ content: "TEST fresh answer" }));
    await runtime.message(
      b.input.commandId,
      "TEST FRESH SOURCE",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      b.context,
    );
    const fresh = h.commandState(b.input.commandId),
      count = h.requests.length;
    assert.notEqual(old.threadId, fresh.threadId);
    allowed.delete(a.input.generation);
    assert.deepEqual(await runtime.readAttachmentOutcome!(a.input), {
      status: "unknown",
    });
    assert.equal(await runtime.readTask!(a.input.commandId), null);
    await purgeNativeAttachmentGeneration(
      h.controller,
      h.scope,
      h.target.organizationId,
      a.input.generation,
      () => true,
      (fn) => h.context.serial(async () => fn()),
      () => [a.input.commandId],
    );
    const retired = h.attachmentState(a.input.commandId)!;
    assert.equal(retired.phase.state, "retired");
    assert.ok(!JSON.stringify(retired).includes("OLD ANSWER CANARY"));
    assert.ok(
      !JSON.stringify(
        h.db.prepare("SELECT data FROM agent_service_turn").all(),
      ).includes("OLD SOURCE CANARY"),
    );
    assert.equal(h.commandState(b.input.commandId).runId, fresh.runId);
    assert.ok((await h.nativeMessages(fresh.threadId)).length > 0);
    assert.equal(h.requests.length, count);
    assert.equal(
      h.serviceRequests.filter((r) => r.method === "POST").length,
      0,
    );
  } finally {
    await h.close();
  }
});
test("two-stage production publication appends one assistant with no new receipt/user source; rollback and replay spend nothing", async () => {
  const h = createTrustHarness(),
    s3 = await syntheticS3();
  let rollback = false;
  const store = new FixtureStorage(
    join(h.root, "attachment-workflow"),
    h.scope.serverId,
    Date.now,
    (point) => {
      if (rollback && point === "events")
        throw Error("TEST PUBLICATION ROLLBACK");
    },
    undefined,
    loadAttachmentConfiguration({ NIARO_ATTACHMENTS_ENABLED: "true" }),
  );
  try {
    store.initializeObjectStorage({ state: "configured", config: s3.config });
    const scope = h.scope,
      generation =
        store.snapshot(scope).conversations[0]!.attachmentGeneration!,
      draft = store.attachments.createDraft(scope, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        target: {
          conversationId: "conversation-1",
          expectedGeneration: generation,
          mode: "current",
        },
      }).draft;
    const bytes = Buffer.from("SYNTHETIC prepared original"),
      upload = store.attachments.createUpload(scope, draft.draftId, {
        profile: ATTACHMENT_PROFILE,
        requestId: randomUUID(),
        expectedRevision: 1,
        filename: "source.txt",
        mediaType: "text/plain",
        size: bytes.length,
        sha256: sha(bytes.toString()),
      }),
      c = store.attachments.beginReceive(scope, upload.upload.contentId);
    store.attachments.markPutting(scope, c.id, c.token!);
    await store.attachments
      .objectStore()
      .put(store.attachments.handle(c), bytes);
    store.attachments.finishTransfer(scope, c.id, c.token!);
    const command = {
      type: "message.send" as const,
      commandId: "TEST-publication",
      idempotencyKey: "TEST-publication",
      conversationId: "conversation-1",
      language: "en" as const,
      text: "",
      attachments: {
        profile: ATTACHMENT_PROFILE,
        draftId: draft.draftId,
        draftRevision: upload.draft.revision,
        generation,
        items: [{ contentId: c.id, sha256: c.sha256 }],
      },
    };
    const accepted = store.acceptAttachmentMessage(scope, command),
      row = store.attachments.db
        .prepare("SELECT id FROM attachment_attempts WHERE command_id=?")
        .get(command.commandId)!;
    const id = String(row.id),
      text = "TEST source-addressable prepared fixture";
    const acceptedSources = store.profileRefs(scope, 0);
    assert.equal(acceptedSources.length, 1, "attachment acceptance indexes its user source in the workflow transaction");
    const context = {
      conversationId: command.conversationId,
      conversationSession: sha("TEST publication session"),
      requestHash: attachmentDigest(command),
      outerCommandId: command.commandId,
    };
    const input: NativeAttachmentInput = {
      scope,
      conversationId: command.conversationId,
      conversationSession: context.conversationSession,
      generation,
      commandId: command.idempotencyKey,
      outerCommandId: command.commandId,
      logicalMessageId: command.commandId,
      requestHash: context.requestHash,
      messageHash: nativeAttachmentMessageHash(text, "en", context),
      evidenceDigest: sha("TEST prepared evidence"),
      handoffId: randomUUID(),
    };
    // A future local processor may reach waiting_retry. Default production has no such processor or dispatcher.
    store.attachments.db
      .prepare(
        "UPDATE attachment_attempts SET state='waiting_retry' WHERE id=?",
      )
      .run(id);
    const token = store.attachments.recordHandoff(
      scope,
      id,
      input,
      1,
      accepted.snapshot.conversations[0]!.revision,
    );
    h.onChat(() => ({ content: "TEST durable assistant result" }));
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: (g) =>
        store.attachmentGenerationAllowed(scope, g),
    });
    await runtime.message(
      input.commandId,
      text,
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      { ...context, attachment: input },
    );
    const count = h.requests.length;
    const model = new ModelService(store, undefined),
      access = {
        run: async <T>(fn: () => T) => fn(),
        integrations: runtime,
      } as MobileRuntime;
    rollback = true;
    await assert.rejects(
      model.publishAttachmentResult(scope, id, token, access),
      /PUBLICATION ROLLBACK/,
    );
    assert.equal(store.snapshot(scope).conversations[0]!.messages.length, 1);
    assert.equal(
      store.attachments.db
        .prepare("SELECT count(*) AS n FROM attachment_publications")
        .get()!.n,
      0,
    );
    rollback = false;
    const published = await model.publishAttachmentResult(
      scope,
      id,
      token,
      access,
    );
    assert.equal(published.conversations[0]!.messages.length, 2);
    assert.equal(
      published.conversations[0]!.messages[1]!.replyToCommandId,
      command.commandId,
    );
    assert.equal(
      published.conversations[0]!.messages[0]!.processing!.state,
      "published",
    );
    await model.publishAttachmentResult(scope, id, token, access);
    assert.equal(store.snapshot(scope).conversations[0]!.messages.length, 2);
    assert.equal(
      store.attachments.db.prepare("SELECT count(*) AS n FROM receipts").get()!
        .n,
      1,
    );
    assert.equal(h.requests.length, count);
    assert.deepEqual(store.profileRefs(scope, 0), acceptedSources, "assistant-only publication and replay never create a memory source");
    store.execute(scope, {
      type: "conversation.delete",
      conversationId: "conversation-1",
      commandId: "TEST-delete-published",
      idempotencyKey: "TEST-delete-published",
    });
    await assert.rejects(
      model.publishAttachmentResult(scope, id, token, access),
    );
    assert.equal(h.requests.length, count);
  } finally {
    store.close();
    await h.close();
    await s3.close();
  }
});

test("generation task locator follows authoritative archive movement and fails closed for a missing locator", async () => {
  const h = createTrustHarness();
  try {
    let locator: string | undefined = "conversation-1";
    const old = binding(h, "TEST-generation-locator", "TEST source");
    h.onChat(() => h.call("ask_user", { question: "TEST retained question" }));
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: () => true,
      attachmentGenerationConversation: () => locator,
    });
    await runtime.message(
      old.input.commandId,
      "TEST source",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      old.context,
    );
    locator = "archived-9";
    assert.equal(
      (await runtime.readTask!(old.input.commandId))?.conversationId,
      "archived-9",
    );
    assert.equal(
      h.commandState(old.input.commandId).conversationId,
      "conversation-1",
    );
    const count = h.requests.length;
    locator = undefined;
    assert.equal(await runtime.readTask!(old.input.commandId), null);
    assert.equal((await runtime.tasks!()).length, 0);
    assert.equal(h.requests.length, count);
  } finally {
    await h.close();
  }
});
test("erase-only native retirement removes a suspended question checkpoint without resuming provider or actions", async () => {
  const h = createTrustHarness();
  try {
    const b = binding(h, "TEST-paused-erase", "TEST PAUSED SOURCE");
    let allowed = true;
    const runtime = h.runtime({
      ...h.context,
      attachmentGenerationAllowed: () => allowed,
    });
    h.onChat(() => h.call("ask_user", { question: "TEST PAUSED QUESTION" }));
    await runtime.message(
      b.input.commandId,
      "TEST PAUSED SOURCE",
      "en",
      [],
      new AbortController().signal,
      undefined,
      undefined,
      "UTC",
      b.context,
    );
    const state = h.commandState(b.input.commandId),
      calls = h.requests.length;
    const before = new DatabaseSync(
      join(h.root, "identity.sqlite.mastra.sqlite"),
      { readOnly: true },
    );
    try {
      assert.ok(
        Number(
          before
            .prepare(
              "SELECT count(*) AS n FROM mastra_workflow_snapshot WHERE run_id=?",
            )
            .get(state.runId)!.n,
        ) > 0,
      );
    } finally {
      before.close();
    }
    allowed = false;
    await purgeNativeAttachmentGeneration(
      h.controller,
      h.scope,
      h.target.organizationId,
      b.input.generation,
      () => true,
      (fn) => h.context.serial(async () => fn()),
      () => [b.input.commandId],
    );
    const after = new DatabaseSync(
      join(h.root, "identity.sqlite.mastra.sqlite"),
      { readOnly: true },
    );
    try {
      const rows = after
        .prepare(
          "SELECT workflow_name,snapshot FROM mastra_workflow_snapshot WHERE run_id=?",
        )
        .all(state.runId);
      assert.ok(
        rows.every((row) => row.workflow_name === "niaro-native-retirement-v1"),
      );
      assert.ok(!JSON.stringify(rows).includes("TEST PAUSED"));
    } finally {
      after.close();
    }
    assert.equal(h.requests.length, calls);
    assert.equal(
      h.serviceRequests.filter((r) => r.method === "POST").length,
      0,
    );
    assert.equal(await runtime.readTask!(b.input.commandId), null);
  } finally {
    await h.close();
  }
});
